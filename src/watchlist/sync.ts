// Watchlist auto-sync orchestrator. On a schedule (driven by index.ts) it pulls
// each configured Plex Watchlist / Letterboxd list RSS feed and funnels NEW
// items through the same path a chat request takes: resolve → route → audit →
// createRequest → subscribe. That reuse is deliberate — synced requests inherit
// per-category routing, the audit trail, the per-member daily quota, and the
// multi-subscriber "now ready" notification rather than bypassing them.
//
// Sources come from two places, merged: operator-seeded config.watchlist.sources
// (env) and member self-service feeds in the DB (store.listWatchlistSources()).
//
// Identity: each source declares an `owner` WhatsApp number. Synced requests are
// audited/attributed under that number (via user_map / SEERR_DEFAULT_USER_ID)
// and the "ready" DM goes to it (groupJid null → DM).
//
// Idempotency + recovery: a processed item is recorded in watchlist_item
// (keyed source+guid) so later polls skip it. Crucially, only TERMINAL outcomes
// are recorded — a genuine search miss ('unresolved'), an already-available item
// ('available'), a created request ('queued'), or a non-transient rejection
// ('failed'). TRANSIENT failures (Seerr down, network) are left unrecorded so
// the next poll retries them — otherwise an outage overlapping a poll would
// silently and permanently drop every new item.
//
// maxPerRun bounds how many NEW (unseen) items are resolved against Seerr per
// poll, so a large backlog trickles in instead of bursting load onto Sonarr.

import { config, type WatchlistSource } from '../config.ts';
import { log } from '../log.ts';
import { resolveRoute, type MediaType } from '../routing/table.ts';
import type { Store } from '../state/store.ts';
import * as seerrModule from '../seerr/client.ts';
import { isTransientSeerrError } from '../seerr/client.ts';
import { parseFeed, type WatchlistItem } from './rss.ts';
import type { PlexClient } from './plex.ts';

const log_ = log.child({ mod: 'watchlist' });

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 8 * 1024 * 1024;  // guard against a huge/HTML-200 body
// A browser-like UA — some feed hosts (notably Letterboxd behind Cloudflare)
// 403 default library/curl agents.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 whatsarr-watchlist';

export type WatchlistStore = Pick<
  Store,
  'hasWatchlistItem' | 'recordWatchlistItem' | 'getSeerrUserId' | 'audit' | 'updateAudit'
  | 'addSubscription' | 'getQuota' | 'bumpQuota' | 'listWatchlistSources'
>;

export type WatchlistSeerr = Pick<typeof seerrModule, 'search' | 'createRequest' | 'getMediaInfo'>;

export type WatchlistDeps = {
  store: WatchlistStore;
  seerr: WatchlistSeerr;
  // Injectable for tests; defaults to a real HTTP GET.
  fetchText?: (url: string) => Promise<string>;
  // Pass-free Plex path (owner token). Undefined ⇒ plex-friend/plex-self sources
  // are skipped. Injected as a fake in tests.
  plex?: PlexClient;
  // Default merges env + DB + plex sources; overridable for tests.
  sources?: WatchlistSource[];
  maxPerRun?: number;
};

export type SyncSummary = {
  requested: number;
  skippedSeen: number;
  skippedAvailable: number;
  skippedQuota: number;
  unresolved: number;
  failed: number;       // terminal + transient request failures (transient are retried next poll)
  capped: boolean;
};

async function defaultFetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Reject a Cloudflare/HTML interstitial returned with 200 before we parse it.
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !/(xml|rss|atom|text\/plain|octet-stream)/i.test(ct)) {
      throw new Error(`unexpected content-type "${ct}"`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
      throw new Error(`feed too large (${declared} bytes)`);
    }
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) throw new Error(`feed too large (${text.length} bytes)`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Seerr mediaInfo.status: 2 PENDING, 3 PROCESSING, 5 AVAILABLE — already handled,
// don't re-request. 4 PARTIALLY_AVAILABLE is left requestable (missing TV eps).
function alreadyHandled(status: number | null | undefined): boolean {
  return status === 2 || status === 3 || status === 5;
}

function displayOf(item: WatchlistItem): string {
  return item.year ? `${item.title} (${item.year})` : item.title;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

type Resolution = { kind: 'ok'; tmdbId: number } | { kind: 'miss' } | { kind: 'error' };

// Resolve a feed item to a Seerr-requestable TMDb id. Prefer the id embedded in
// the feed; otherwise search and FAIL CLOSED on ambiguity (a wrong auto-request
// is worse than a skip — the user can always ask in chat). 'miss' = genuine
// no-match (terminal); 'error' = transient (search threw → retry next poll).
async function resolveTmdbId(deps: WatchlistDeps, item: WatchlistItem): Promise<Resolution> {
  if (item.tmdbId && item.tmdbId > 0) return { kind: 'ok', tmdbId: item.tmdbId };
  let results;
  try {
    results = await deps.seerr.search(item.title);
  } catch (e: any) {
    log_.warn({ title: item.title, err: e?.message }, 'watchlist search failed (transient; will retry)');
    return { kind: 'error' };
  }
  const ofType = results.filter(r => r.mediaType === item.type);
  if (ofType.length === 0) return { kind: 'miss' };
  const wantTitle = norm(item.title);
  if (item.year != null) {
    const yearStr = String(item.year);
    const yearMatch = ofType.find(r => (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) === yearStr);
    if (yearMatch) return { kind: 'ok', tmdbId: yearMatch.id };
    // No year match: accept only an exact title match (handles year drift),
    // otherwise treat as unresolved rather than guessing a remake.
    const titleMatch = ofType.find(r => norm(r.title ?? r.name ?? '') === wantTitle);
    return titleMatch ? { kind: 'ok', tmdbId: titleMatch.id } : { kind: 'miss' };
  }
  // Year unknown: accept a single candidate, or a unique exact title match.
  if (ofType.length === 1) return { kind: 'ok', tmdbId: ofType[0]!.id };
  const exact = ofType.filter(r => norm(r.title ?? r.name ?? '') === wantTitle);
  return exact.length === 1 ? { kind: 'ok', tmdbId: exact[0]!.id } : { kind: 'miss' };
}

type RequestOutcome = 'ok' | 'terminal' | 'transient';

// Create the Seerr request + write audit/subscription, mirroring the chat path
// in handler.ts (kept separate to avoid coupling the live chat flow; the shared
// shape is documented at both sites). Returns:
//   'ok'        → request created, recorded seen
//   'terminal'  → non-transient rejection (e.g. duplicate/4xx), recorded seen
//   'transient' → retryable failure, NOT recorded (left for the next poll)
async function requestItem(
  deps: WatchlistDeps,
  source: WatchlistSource,
  item: WatchlistItem,
  tmdbId: number,
): Promise<RequestOutcome> {
  const mediaType: MediaType = item.type;
  const display = displayOf(item);
  const ownerJid = `${source.owner}@s.whatsapp.net`;

  // Watchlists carry no category → default route. resolveRoute can throw on a
  // FORBIDDEN_PATH match; the default ('western') never does, but guard anyway so
  // one bad item can't abort the whole poll.
  let resolved;
  try {
    resolved = resolveRoute(mediaType, null);
  } catch (e: any) {
    log_.error({ display, err: e?.message }, 'watchlist route forbidden');
    deps.store.recordWatchlistItem({ source: source.label, guid: item.guid, tmdbId, mediaType, status: 'failed', title: display });
    return 'terminal';
  }
  if (!resolved.ok) {
    log_.warn({ display, reason: resolved.reason }, 'watchlist route not resolvable');
    deps.store.recordWatchlistItem({ source: source.label, guid: item.guid, tmdbId, mediaType, status: 'failed', title: display });
    return 'terminal';
  }

  const auditId = deps.store.audit({
    senderJid: ownerJid,
    senderNumber: source.owner,
    groupJid: null,
    command: `watchlist:${source.label} ${display}`,
    resolvedRoute: resolved.route.rootFolder,
    seerrMediaType: mediaType,
    seerrMediaId: tmdbId,
    seerrRequestId: null,
    status: 'queued',
  });
  try {
    const result = await deps.seerr.createRequest({
      mediaType,
      mediaId: tmdbId,
      rootFolder: resolved.route.rootFolder,
      profileId: resolved.route.profileId,
      userId: deps.store.getSeerrUserId(source.owner) ?? undefined,
      seasons: mediaType === 'tv' ? 'all' : undefined,
    });
    deps.store.updateAudit(auditId, { seerrRequestId: result?.id ?? null });
    deps.store.addSubscription({
      subscriberJid: ownerJid,
      subscriberNumber: source.owner,
      groupJid: null,
      mediaType,
      tmdbId,
      seasons: mediaType === 'tv' ? 'all' : null,
    });
    deps.store.recordWatchlistItem({ source: source.label, guid: item.guid, tmdbId, mediaType, status: 'queued', title: display });
    log_.info({ source: source.label, display, tmdbId, mediaType }, 'watchlist item requested');
    return 'ok';
  } catch (e: any) {
    deps.store.updateAudit(auditId, { status: 'failed' });
    if (isTransientSeerrError(e)) {
      // Leave unrecorded so the next poll retries (no seen row written).
      log_.warn({ source: source.label, display, err: e?.message }, 'watchlist createRequest failed (transient; will retry)');
      return 'transient';
    }
    deps.store.recordWatchlistItem({ source: source.label, guid: item.guid, tmdbId, mediaType, status: 'failed', title: display });
    log_.error({ source: source.label, display, err: e?.message }, 'watchlist createRequest failed (terminal)');
    return 'terminal';
  }
}

// Process one fully-formed item: resolve -> availability -> quota -> request.
// Records ONLY terminal outcomes as seen; transient failures return without
// recording so the next poll retries. Shared by the RSS and Plex paths.
async function processItem(deps: WatchlistDeps, source: WatchlistSource, item: WatchlistItem, summary: SyncSummary, requestsPerDay: number): Promise<void> {
  const res = await resolveTmdbId(deps, item);
  if (res.kind === 'error') return;                    // transient: leave unseen
  if (res.kind === 'miss') {
    deps.store.recordWatchlistItem({ source: source.label, guid: item.guid, tmdbId: null, mediaType: item.type, status: 'unresolved', title: displayOf(item) });
    summary.unresolved++;
    log_.info({ source: source.label, title: item.title, year: item.year }, 'watchlist item unresolved (no confident tmdb match)');
    return;
  }
  const tmdbId = res.tmdbId;
  let info;
  try {
    info = await deps.seerr.getMediaInfo(item.type, tmdbId);
  } catch (e: any) {
    log_.warn({ source: source.label, title: item.title, err: e?.message }, 'watchlist getMediaInfo failed (transient; will retry)');
    return;                                             // transient: leave unseen
  }
  if (alreadyHandled(info?.status)) {
    deps.store.recordWatchlistItem({ source: source.label, guid: item.guid, tmdbId, mediaType: item.type, status: 'available', title: displayOf(item) });
    summary.skippedAvailable++;
    return;
  }
  // Per-member daily quota (same limit as chat) — at quota, leave unseen so it
  // retries after the day rolls.
  if (deps.store.getQuota(source.owner) >= requestsPerDay) {
    summary.skippedQuota++;
    return;
  }
  const outcome = await requestItem(deps, source, item, tmdbId);
  if (outcome === 'ok') { deps.store.bumpQuota(source.owner); summary.requested++; }
  else summary.failed++;                                // 'terminal' recorded seen; 'transient' left for retry
}

function plexIdFromUrl(url: string): string {
  return url.replace(/^plexfriend:\/\//, '');
}

// Build the effective source list (prod path; tests pass deps.sources): rss feeds
// from env + DB, plus the Pass-free Plex sources synthesized from DB plex-friend
// rows and the env PLEX_FRIEND_MAP (usernames resolved to ids via the owner
// token). Deduped so a friend mapped twice isn't double-tracked.
async function buildSources(deps: WatchlistDeps): Promise<WatchlistSource[]> {
  const out: WatchlistSource[] = [...config.watchlist.sources, ...deps.store.listWatchlistSources()];
  const envFriends = config.plex.friends;
  if (envFriends.length && deps.plex) {
    let friendList: { id: string; username: string }[] | null = null;
    for (const fm of envFriends) {
      if (fm.plexUsername === 'self' || fm.plexUserId === 'self') {
        out.push({ type: 'plex-self', url: 'plexself://', owner: fm.owner, label: fm.label });
        continue;
      }
      let id = fm.plexUserId;
      if (!id && fm.plexUsername) {
        if (!friendList) {
          try { friendList = await deps.plex.listFriends(); }
          catch (e: any) { log_.warn({ err: e?.message }, 'plex listFriends failed for env map'); friendList = []; }
        }
        id = friendList.find(f => f.username.toLowerCase() === fm.plexUsername!.toLowerCase())?.id ?? null;
        if (!id) { log_.warn({ username: fm.plexUsername }, 'plex friend not found for PLEX_FRIEND_MAP entry'); continue; }
      }
      if (id) out.push({ type: 'plex-friend', url: `plexfriend://${id}`, owner: fm.owner, label: fm.label });
    }
  }
  const seen = new Set<string>();
  return out.filter(s => {
    if (s.type !== 'plex-friend' && s.type !== 'plex-self') return true;
    const key = `${s.type}|${s.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function syncWatchlists(deps: WatchlistDeps): Promise<SyncSummary> {
  const sources = deps.sources ?? await buildSources(deps);
  const maxPerRun = deps.maxPerRun ?? config.watchlist.maxPerRun;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const requestsPerDay = config.limits.requestsPerDay;
  const summary: SyncSummary = { requested: 0, skippedSeen: 0, skippedAvailable: 0, skippedQuota: 0, unresolved: 0, failed: 0, capped: false };
  if (sources.length === 0) return summary;

  let processed = 0;  // unseen items resolved against Seerr/Plex this run (cap target)

  // Shared seen-check + cap + fail-soft. produceItem builds the WatchlistItem
  // lazily (for Plex it enriches — only AFTER the seen-check, so unchanged items
  // cost no metadata call). Returns true when the cap is hit (stop the run).
  const runItem = async (source: WatchlistSource, guid: string, produceItem: () => Promise<WatchlistItem | null>): Promise<boolean> => {
    if (deps.store.hasWatchlistItem(source.label, guid)) { summary.skippedSeen++; return false; }
    if (processed >= maxPerRun) { summary.capped = true; return true; }
    processed++;
    try {
      const item = await produceItem();
      if (item) await processItem(deps, source, item, summary, requestsPerDay);
    } catch (e: any) {
      log_.warn({ source: source.label, guid, err: e?.message }, 'watchlist item errored (left unseen)');
    }
    return false;
  };

  outer:
  for (const source of sources) {
    if (source.type === 'plex-friend' || source.type === 'plex-self') {
      if (!deps.plex) continue;   // owner token unset → skip the Pass-free path
      let nodes;
      try {
        nodes = source.type === 'plex-self'
          ? await deps.plex.selfWatchlist()
          : await deps.plex.friendWatchlist(plexIdFromUrl(source.url));
      } catch (e: any) {
        log_.warn({ source: source.label, err: e?.message }, 'plex watchlist fetch failed');
        continue;
      }
      log_.debug({ source: source.label, items: nodes.length }, 'plex watchlist fetched');
      for (const node of nodes) {
        const stop = await runItem(source, node.id, async () => {
          const en = await deps.plex!.enrich(node.id);   // N+1 — only for unseen items
          return { guid: node.id, title: node.title, year: en.year, type: node.type, tmdbId: en.tmdbId, imdbId: en.imdbId };
        });
        if (stop) break outer;
      }
      continue;
    }

    // RSS feed (plex / letterboxd). Redact the URL on failure — rss.plex.tv is a secret.
    let xml: string;
    try {
      xml = await fetchText(source.url);
    } catch (e: any) {
      log_.warn({ source: source.label, err: e?.message }, 'watchlist feed fetch failed');
      continue;
    }
    let items: WatchlistItem[];
    try {
      items = parseFeed(source.type, xml);
    } catch (e: any) {
      log_.warn({ source: source.label, err: e?.message }, 'watchlist feed parse failed');
      continue;
    }
    log_.debug({ source: source.label, items: items.length }, 'watchlist feed parsed');
    for (const item of items) {
      const stop = await runItem(source, item.guid, async () => item);
      if (stop) break outer;
    }
  }

  if (summary.requested || summary.unresolved || summary.failed || summary.capped) {
    log_.info(summary, 'watchlist sync complete');
  }
  return summary;
}
