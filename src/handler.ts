import { config, validateFeedUrl } from './config.ts';
import { log } from './log.ts';
import { parse, type ParsedCommand, type Category, type AdminAction } from './parser/commands.ts';
import { resolveRoute, type MediaType, type Route } from './routing/table.ts';
import type { Store, AwaitingKind } from './state/store.ts';
import * as seerrModule from './seerr/client.ts';
import * as syncthingModule from './syncthing/client.ts';
import * as arrModule from './arr/client.ts';
import { isAllowedGroup, isAdmin } from './auth/groups.ts';
import { runValidation, runDiagnosis, formatValidation, formatDiagnosis } from './diagnostics.ts';
import type { PlexClient } from './watchlist/plex.ts';
import { parseFilmLinks } from './links.ts';

const log_ = log.child({ mod: 'handler' });

export type IncomingMessage = {
  fromJid: string;        // group JID for groups; sender's personal JID for DMs
  senderJid: string;      // always sender's personal JID
  senderNumber: string;   // digits only
  text: string;
  isGroup: boolean;
  quotedText?: string;    // text of the quoted message when this is a quote-reply (for film-link queue)
};

export type Reply = {
  to: string;
  text: string;
  mentions?: string[];
  imageUrl?: string;  // when set, send as image with `text` as caption
};

export type Deps = {
  store: Store;
  seerr: Pick<typeof seerrModule,
    'search' | 'createRequest' | 'status' | 'getMediaInfo' | 'getTvDetails'
    | 'listPendingRequests' | 'approveRequest' | 'declineRequest' | 'retryRequest'>;
  syncthing?: Pick<typeof syncthingModule, 'isConfigured' | 'getCompletion' | 'getFolderStatus'>;
  // Optional shutdown hook — wired by the index runtime so !shutdown can trigger
  // a graceful exit. Tests pass undefined; the admin handler reports the gap.
  shutdown?: () => void;
  // Optional Plex client (Pass-free watchlist path) — wired when PLEX_TOKEN is
  // set. Used by the !watchlist add plex-friend flow to validate friendship.
  plex?: PlexClient;
  // Optional Sonarr/Radarr client for !prioritize (force-search). Wired by the
  // index runtime; auto-discovers the *arr creds from Seerr. Tests pass a mock.
  arr?: Pick<typeof arrModule, 'isConfigured' | 'forceSearch'>;
};

type ConfirmPayload = {
  tmdbId: number;
  mediaType: MediaType;
  route: Route;
  display: string;
  title: string;
  groupJid: string | null;
  posterPath?: string | null;
  overview?: string | null;
  seasons?: 'all' | number[];   // populated by season picker for TV
  lastReEmitAt?: number;
};

type SeasonPayload = {
  tmdbId: number;
  route: Route;
  display: string;
  title: string;
  groupJid: string | null;
  posterPath?: string | null;
  overview?: string | null;
  numberOfSeasons: number | null;  // null if Seerr lookup failed; we still let them try
  lastReEmitAt?: number;
};

type DisambigPayload = {
  title: string;
  category: Category | null;
  groupJid: string | null;
  senderNumber: string;
  lastReEmitAt?: number;
};

type PickCandidate = {
  tmdbId: number;
  display: string;
  posterPath?: string | null;
  overview?: string | null;
  status?: number | null;  // Seerr mediaInfo.status, if known
};

// Seerr media status: 1 UNKNOWN, 2 PENDING, 3 PROCESSING (downloading),
// 4 PARTIALLY_AVAILABLE, 5 AVAILABLE.
function availabilityHint(status: number | null | undefined): string | null {
  switch (status) {
    case 5: return 'already on Plex ✓';
    case 3: return 'already downloading';
    case 2: return 'already requested';
    case 4: return 'partially on Plex';
    default: return null;
  }
}

function shouldBlockRequest(status: number | null | undefined): boolean {
  // 5 already there, 3 already in flight, 2 already queued. 4 (partial) is
  // allowed through — TV with missing episodes is a legitimate re-request.
  return status === 5 || status === 3 || status === 2;
}

function blockedReply(display: string, status: number): string {
  if (status === 5) return `*${display}* is already on Plex.`;
  if (status === 3) return `*${display}* is already downloading. Try !queue for progress.`;
  if (status === 2) return `*${display}* is already requested (pending approval).`;
  return `*${display}* cannot be requested right now.`;
}

type PickPayload = {
  candidates: PickCandidate[];
  mediaType: MediaType;
  route: Route;
  title: string;
  groupJid: string | null;
  lastReEmitAt?: number;
};

type AnnouncePayload = {
  body: string;
  fromJid: string;   // where to ack + re-prompt (the channel the admin invoked from)
  lastReEmitAt?: number;
};

const TOP_N = 3;
const RE_EMIT_COOLDOWN_MS = 30_000;
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';

function posterUrl(posterPath: string | null | undefined): string | undefined {
  return posterPath ? `${TMDB_POSTER_BASE}${posterPath}` : undefined;
}

function trimOverview(s: string | null | undefined, max = 220): string | null {
  if (!s) return null;
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastDot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastDot > max * 0.5 ? cut.slice(0, lastDot + 1) : cut).trim() + (lastDot > max * 0.5 ? '' : '…');
}

function buildConfirmReply(
  to: string,
  mentions: string[] | undefined,
  p: ConfirmPayload,
  senderNumber: string,
): Reply {
  const overview = trimOverview(p.overview);
  const inGroup = mentions !== undefined;
  const head = inGroup
    ? `@${senderNumber} Found: *${p.display}*`
    : `Found: *${p.display}*`;
  const lines = [
    head,
    ...(overview ? ['', `_${overview}_`] : []),
    '',
    `Route: ${p.route.profileName}`,
    inGroup
      ? `Only @${senderNumber} can reply YES to queue, NO to skip.`
      : `Reply YES to queue, NO to skip.`,
  ];
  return {
    to,
    text: lines.join('\n'),
    mentions,
    imageUrl: posterUrl(p.posterPath),
  };
}

function buildPickerText(senderNumber: string, candidates: PickCandidate[], inGroup: boolean): string {
  const choices = candidates.map((_, i) => i + 1).join(', ');
  const items = candidates.map((c, i) => {
    const hint = availabilityHint(c.status);
    return hint ? `${i + 1}. *${c.display}* — _${hint}_` : `${i + 1}. *${c.display}*`;
  });
  const replyHint = `Reply ${choices} for one — or e.g. \`1,3\` for several — or NO.`;
  if (inGroup) {
    return [
      `@${senderNumber} pick:`,
      ...items,
      '',
      `Only @${senderNumber} can reply. ${replyHint}`,
    ].join('\n');
  }
  return [`pick:`, ...items, '', replyHint].join('\n');
}

// Parse "1", "1,3", "1, 3, 5", "  2  " against an inclusive range.
// Returns null on any invalid/out-of-range/empty input, or duplicates.
// Empty / multiple-zero / non-numeric tokens all → null.
export function parsePickList(input: string, max: number): number[] | null {
  const tokens = input.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) return null;
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1 || n > max) return null;
    if (seen.has(n)) return null;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// Parse season selectors: "all", "latest", "1", "1-3", "1,3,5".
// Returns 'all' | number[] on success, null on failure.
export function parseSeasonSelector(input: string, opts: { numberOfSeasons: number | null }): 'all' | number[] | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'all' || s === '*') return 'all';
  if (s === 'latest' || s === 'last') {
    if (!opts.numberOfSeasons || opts.numberOfSeasons < 1) return null;
    return [opts.numberOfSeasons];
  }
  // Range "a-b"
  const rangeM = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeM) {
    const a = Number.parseInt(rangeM[1]!, 10);
    const b = Number.parseInt(rangeM[2]!, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null;
    if (opts.numberOfSeasons && b > opts.numberOfSeasons) return null;
    const out: number[] = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  // Comma list or single
  const tokens = s.split(/[\s,]+/).filter(Boolean);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) return null;
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    if (opts.numberOfSeasons && n > opts.numberOfSeasons) return null;
    if (seen.has(n)) return null;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

function buildSeasonPrompt(senderNumber: string, p: SeasonPayload): Reply {
  const inGroup = !!p.groupJid;
  const head = inGroup ? `@${senderNumber} Found: *${p.display}*` : `Found: *${p.display}*`;
  const overview = trimOverview(p.overview);
  const seasonsLine = p.numberOfSeasons
    ? `It has *${p.numberOfSeasons}* season${p.numberOfSeasons === 1 ? '' : 's'}.`
    : `(season count unknown — try anyway)`;
  const examples = p.numberOfSeasons && p.numberOfSeasons >= 2
    ? `\`all\`, \`latest\`, \`1\`, \`1-${p.numberOfSeasons}\`, \`1,3\``
    : `\`all\`, \`latest\`, \`1\``;
  const lines = [
    head,
    ...(overview ? ['', `_${overview}_`] : []),
    '',
    seasonsLine,
    inGroup
      ? `@${senderNumber} which seasons? Reply ${examples}, or NO.`
      : `Which seasons? Reply ${examples}, or NO.`,
  ];
  return {
    to: p.groupJid ?? '',  // caller overrides
    text: lines.join('\n'),
    mentions: inGroup ? undefined : undefined,
    imageUrl: posterUrl(p.posterPath),
  };
}

export async function handleMessage(deps: Deps, msg: IncomingMessage): Promise<Reply[]> {
  // ---- Auth ----
  if (msg.isGroup) {
    if (!isAllowedGroup(msg.fromJid)) {
      log_.debug({ from: msg.fromJid }, 'silent drop: unauthorized group');
      return [];
    }
  } else {
    const hasState = !!deps.store.getState(msg.senderJid);
    if (!hasState && !isAdmin(msg.senderNumber)) {
      log_.debug({ sender: msg.senderJid }, 'silent drop: unauthorized DM');
      return [];
    }
  }

  const text = msg.text.trim();
  const startsWithPrefix = text.startsWith(config.whatsapp.commandPrefix);

  // ---- Film-link quote-reply queue ----
  // The bot reacts 🎬 to a shared Letterboxd film link (index.ts, a quiet signal,
  // never a reply). To queue it, a member quote-replies that message with `q` /
  // `!q`. We re-derive the film from the QUOTED text, so nothing was stored.
  // Keyword is ONLY `q` (not `queue` — that's the real !queue command).
  // Opt-out (!links off) silences only the ambient react; this explicit pull is
  // always honored (pull, not push).
  if (msg.quotedText) {
    const kw = text.toLowerCase().replace(/^!/, '').trim();
    if (kw === 'q') {
      const links = parseFilmLinks(msg.quotedText);
      if (links.length) {
        // An explicit quote-reply queue cancels any in-flight prompt first, so it
        // can't silently overwrite (or be polluted by) the member's prior state —
        // mirrors the "!command cancels prior prompt" contract just below.
        if (deps.store.getState(msg.senderJid)) {
          deps.store.clearState(msg.senderJid);
          log_.debug({ sender: msg.senderJid }, 'state cleared by link-queue');
        }
        return await handleRequest(deps, msg, { kind: 'request', mediaTypeHint: links[0]!.mediaType, category: null, title: links[0]!.title });
      }
    }
  }

  // ---- State-driven response (YES/NO/MOVIE/TV/numbers) ----
  // If the user types a new !command, treat that as cancelling the prior
  // prompt and starting fresh — most natural intent.
  const state = deps.store.getState(msg.senderJid);
  if (state && !startsWithPrefix) {
    const reply = await handleStateResponse(deps, msg, state, text);
    if (reply !== null) return reply;
    // If state didn't match, fall through to normal command handling
  } else if (state && startsWithPrefix) {
    deps.store.clearState(msg.senderJid);
    log_.debug({ sender: msg.senderJid }, 'state cleared by new !command');
  }

  // ---- Prefix enforcement ----
  // Groups: prefix required; otherwise silent drop (chatter)
  // DMs: prefix optional — bare text from admin treated as !req <text>
  let parseInput = text;
  if (msg.isGroup) {
    if (!text.startsWith(config.whatsapp.commandPrefix)) return [];
  } else {
    if (!text.startsWith(config.whatsapp.commandPrefix)) {
      parseInput = `${config.whatsapp.commandPrefix}req ${text}`;
    }
  }

  const parsed = parse(parseInput, config.whatsapp.commandPrefix);

  if (parsed.kind === 'unknown') {
    if (msg.isGroup) return [];
    return [reply(msg.senderJid, `Didn't understand that. Try !help.`)];
  }
  if (parsed.kind === 'incomplete') {
    const hint = parsed.cmd === 'movie' || parsed.cmd === 'film'
      ? `Try \`!movie <title>\` — e.g. \`!movie inception\`. \`!help\` for more.`
      : parsed.cmd === 'tv' || parsed.cmd === 'show' || parsed.cmd === 'series'
      ? `Try \`!tv <title>\` — e.g. \`!tv the bear\`. \`!help\` for more.`
      : `Need a title. Try \`!${parsed.cmd} <title>\`. \`!help\` for more.`;
    if (msg.isGroup) {
      return [reply(msg.fromJid, `@${msg.senderNumber} ${hint}`, [msg.senderJid])];
    }
    return [reply(msg.senderJid, hint)];
  }
  if (parsed.kind === 'help') {
    return [reply(msg.fromJid, helpText(isAdmin(msg.senderNumber)))];
  }
  if (parsed.kind === 'status') {
    try {
      const s = await deps.seerr.status();
      return [reply(msg.fromJid, `Seerr v${s.version}, OK${s.updateAvailable ? ' (update available)' : ''}.`)];
    } catch {
      return [reply(msg.fromJid, `Seerr unreachable.`)];
    }
  }
  if (parsed.kind === 'queue') {
    return await handleQueue(deps, msg);
  }
  if (parsed.kind === 'sync') {
    return await handleSync(deps, msg);
  }
  if (parsed.kind === 'prioritize') {
    return await handlePrioritize(deps, msg, parsed);
  }
  if (parsed.kind === 'feedback') {
    return await handleFeedback(deps, msg, parsed.body);
  }
  if (parsed.kind === 'issue') {
    return await handleIssue(deps, msg, parsed.body);
  }
  if (parsed.kind === 'admin') {
    return await handleAdmin(deps, msg, parsed);
  }
  if (parsed.kind === 'map') {
    return handleMap(deps, msg, parsed);
  }
  if (parsed.kind === 'watchlist') {
    return await handleWatchlist(deps, msg, parsed);
  }
  if (parsed.kind === 'announce') {
    return handleAnnounce(deps, msg, parsed.body);
  }
  if (parsed.kind === 'links') {
    return handleLinks(deps, msg, parsed);
  }
  if (parsed.kind === 'request') {
    return await handleRequest(deps, msg, parsed);
  }
  return [];
}

async function handleAdmin(
  deps: Deps,
  msg: IncomingMessage,
  parsed: Extract<ParsedCommand, { kind: 'admin' }>,
): Promise<Reply[]> {
  // Auth gate. Silent drop in groups (don't advertise admin commands to members);
  // explicit refusal in DMs from non-admins (they've already passed the DM allow
  // check by virtue of having state, so a clear "no" is more honest than silence).
  if (!isAdmin(msg.senderNumber)) {
    log_.warn({ sender: msg.senderNumber, action: parsed.action }, 'admin command from non-admin');
    if (msg.isGroup) return [];
    return [reply(msg.senderJid, `Admin only.`)];
  }

  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const prefix = msg.isGroup ? `@${msg.senderNumber} ` : '';

  if (parsed.action === 'pending') {
    let rows;
    try {
      rows = await deps.seerr.listPendingRequests(20);
    } catch (e: any) {
      log_.error({ err: e?.message }, 'listPendingRequests failed');
      return [reply(replyTo, `${prefix}Couldn't fetch pending: ${e?.message ?? 'unknown error'}`, mentions)];
    }
    if (rows.length === 0) {
      return [reply(replyTo, `${prefix}No pending requests.`, mentions)];
    }
    const lines = [`${prefix}*pending requests (${rows.length}):*`];
    for (const r of rows) {
      lines.push(`• \`${r.id}\` — *${r.title}* (${r.mediaType}) — by ${r.requestedBy}`);
    }
    lines.push('');
    lines.push(`Reply \`!approve <id>\` or \`!deny <id>\`.`);
    return [reply(replyTo, lines.join('\n'), mentions)];
  }

  if (parsed.action === 'approve' || parsed.action === 'deny') {
    const id = parsed.requestId!;
    try {
      if (parsed.action === 'approve') await deps.seerr.approveRequest(id);
      else await deps.seerr.declineRequest(id);
    } catch (e: any) {
      log_.error({ err: e?.message, id, action: parsed.action }, 'seerr decision failed');
      return [reply(replyTo, `${prefix}Couldn't ${parsed.action} #${id}: ${e?.message ?? 'unknown error'}`, mentions)];
    }
    const verb = parsed.action === 'approve' ? 'approved' : 'denied';
    return [reply(replyTo, `${prefix}Request #${id} ${verb} ✓`, mentions)];
  }

  if (parsed.action === 'shutdown') {
    if (!deps.shutdown) {
      return [reply(replyTo, `${prefix}Shutdown not wired (no service hook).`, mentions)];
    }
    // Send the ack first, THEN fire shutdown after a tick so the reply has a
    // chance to leave the socket. A configured service manager (NSSM / systemd /
    // Docker restart policy) brings the process back up shortly after.
    setImmediate(() => {
      log_.warn({ requester: msg.senderNumber }, 'shutdown requested by admin');
      try { deps.shutdown!(); } catch (e: any) { log_.error({ err: e?.message }, 'shutdown hook threw'); }
    });
    return [reply(replyTo, `${prefix}Shutting down — service should auto-restart in ~5s.`, mentions)];
  }

  return [];
}

// Admin: manage the WhatsApp-number → Seerr-user-id mapping. Unmapped numbers
// fall back to SEERR_DEFAULT_USER_ID, so this is purely additive — it just lets
// the operator attribute a household member's requests to their own Seerr user.
function handleMap(
  deps: Deps,
  msg: IncomingMessage,
  parsed: Extract<ParsedCommand, { kind: 'map' }>,
): Reply[] {
  if (!isAdmin(msg.senderNumber)) {
    log_.warn({ sender: msg.senderNumber, op: parsed.op }, 'map command from non-admin');
    if (msg.isGroup) return [];
    return [reply(msg.senderJid, `Admin only.`)];
  }

  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const prefix = msg.isGroup ? `@${msg.senderNumber} ` : '';
  const defaultUser = config.seerr.defaultUserId;

  if (parsed.op === 'list') {
    const rows = deps.store.listUserMap();
    if (rows.length === 0) {
      return [reply(replyTo, `${prefix}No user mappings — all requests use the default Seerr user (#${defaultUser}). Set one with \`!map <number> <seerr user id>\`.`, mentions)];
    }
    const lines = [`${prefix}*WhatsApp → Seerr user map (${rows.length}):*`];
    for (const r of rows) lines.push(`• \`${r.senderNumber}\` → Seerr user #${r.seerrUserId}`);
    return [reply(replyTo, lines.join('\n'), mentions)];
  }

  if (parsed.op === 'unset') {
    deps.store.deleteSeerrUserId(parsed.number!);
    return [reply(replyTo, `${prefix}Removed mapping for \`${parsed.number}\` — now uses default Seerr user (#${defaultUser}).`, mentions)];
  }

  // set
  deps.store.setSeerrUserId(parsed.number!, parsed.seerrUserId!);
  return [reply(replyTo, `${prefix}Mapped \`${parsed.number}\` → Seerr user #${parsed.seerrUserId}. Their future requests will be attributed to that account.`, mentions)];
}

// Watchlist auto-sync self-service. Any allow-listed member can register their
// own Plex Watchlist / Letterboxd list feed; the poller (src/watchlist/sync.ts)
// then auto-requests new items under that member's number. `add`/`remove`
// operate on the sender's own feeds (admins can manage any); the guide/list are
// open to all. Because non-admin DMs are silent-dropped, members run this in the
// group — hence the Plex-URL privacy nudge on add.
async function handleWatchlist(
  deps: Deps,
  msg: IncomingMessage,
  parsed: Extract<ParsedCommand, { kind: 'watchlist' }>,
): Promise<Reply[]> {
  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const prefix = msg.isGroup ? `@${msg.senderNumber} ` : '';
  const owner = msg.senderNumber;
  const admin = isAdmin(msg.senderNumber);

  if (parsed.op === 'guide') {
    return [reply(replyTo, watchlistGuide(prefix), mentions)];
  }

  if (parsed.op === 'add') {
    if (!config.watchlist.selfService && !admin) {
      return [reply(replyTo, `${prefix}Self-service watchlist sign-up is off — ask an admin to add your feed.`, mentions)];
    }

    // Pass-free Plex path: the 3rd token is the member's Plex USERNAME (no feed,
    // no credential). Validate friendship against the owner token at add-time so
    // a typo / un-friended account fails loudly with the fix instructions.
    if (parsed.wlType === 'plex-friend') {
      if (!deps.plex || !config.plex.token) {
        return [reply(replyTo, `${prefix}Pass-free Plex sync isn't set up yet (no owner token). Ask the admin to set PLEX_TOKEN.`, mentions)];
      }
      const username = parsed.url!.trim();
      let friends;
      try {
        friends = await deps.plex.listFriends();
      } catch (e: any) {
        return [reply(replyTo, `${prefix}Couldn't reach Plex to verify just now — try again in a bit.`, mentions)];
      }
      const friend = friends.find(f => f.username.toLowerCase() === username.toLowerCase());
      if (!friend) {
        return [reply(replyTo, `${prefix}I can't see a Plex friend named *${username}*. Two one-time steps in the Plex app: (1) accept the server owner's *friend request*, and (2) set your *Watchlist visibility to "Friends Only"* (not Private). Then run this again.`, mentions)];
      }
      const have = deps.store.countWatchlistSourcesByOwner(owner);
      if (have >= config.watchlist.maxSourcesPerMember) {
        return [reply(replyTo, `${prefix}You're at the feed limit (${config.watchlist.maxSourcesPerMember}). Remove one with \`!watchlist remove <id>\` first.`, mentions)];
      }
      const { id, inserted } = deps.store.addWatchlistSource({ type: 'plex-friend', url: `plexfriend://${friend.id}`, owner, label: `plex-friend:${username}` });
      if (!inserted) {
        return [reply(replyTo, `${prefix}Your Plex watchlist is already linked.`, mentions)];
      }
      return [reply(replyTo, `${prefix}Linked your Plex watchlist (#${id}, friend *${username}*) ✓ No Plex Pass needed. I'll import new titles within ~${config.watchlist.pollMinutes} min (up to ${config.limits.requestsPerDay}/day) and DM you when they're ready — just keep your Watchlist set to "Friends Only".`, mentions)];
    }

    let url: string;
    try {
      url = validateFeedUrl(parsed.wlType!, parsed.url!);
    } catch (e: any) {
      const hint = parsed.wlType === 'plex'
        ? 'Expected an `https://rss.plex.tv/…` URL (app.plex.tv → Watchlist → Generate RSS Feed).'
        : 'Expected an `https://letterboxd.com/<you>/list/<list>/rss/` URL.';
      return [reply(replyTo, `${prefix}Can't add that feed: ${e?.message ?? 'invalid URL'}. ${hint}`, mentions)];
    }
    const count = deps.store.countWatchlistSourcesByOwner(owner);
    if (count >= config.watchlist.maxSourcesPerMember) {
      return [reply(replyTo, `${prefix}You're at the feed limit (${config.watchlist.maxSourcesPerMember}). Remove one with \`!watchlist remove <id>\` first.`, mentions)];
    }
    const label = `${parsed.wlType}:${owner}#${count + 1}`;
    const { id, inserted } = deps.store.addWatchlistSource({ type: parsed.wlType!, url, owner, label });
    if (!inserted) {
      return [reply(replyTo, `${prefix}That feed is already on your list.`, mentions)];
    }
    const note = parsed.wlType === 'plex'
      ? `\n_Tip: your Plex RSS link is private — delete your message above now that I've saved it._`
      : '';
    return [reply(
      replyTo,
      `${prefix}Added your ${parsed.wlType} feed (#${id}) ✓ I'll import new titles within ~${config.watchlist.pollMinutes} min — routed, deduped, and I'll DM you when they're on Plex (up to ${config.limits.requestsPerDay}/day).${note}`,
      mentions,
    )];
  }

  if (parsed.op === 'list') {
    const rows = admin ? deps.store.listWatchlistSources() : deps.store.listWatchlistSourcesByOwner(owner);
    if (rows.length === 0) {
      return [reply(replyTo, `${prefix}No watchlist feeds yet. Add one with \`!watchlist add <plex|letterboxd> <url>\` — \`!watchlist\` for help.`, mentions)];
    }
    const lines = [`${prefix}*watchlist feeds${admin ? ' (all)' : ''}:*`];
    for (const r of rows) {
      lines.push(`• \`${r.id}\` ${r.type}${admin ? ` — ${r.owner}` : ''} — ${redactFeedUrl(r.url)}`);
    }
    lines.push('', `Remove one with \`!watchlist remove <id>\`.`);
    return [reply(replyTo, lines.join('\n'), mentions)];
  }

  // remove
  const src = deps.store.getWatchlistSource(parsed.id!);
  if (!src) return [reply(replyTo, `${prefix}No feed #${parsed.id}.`, mentions)];
  if (src.owner !== owner && !admin) {
    return [reply(replyTo, `${prefix}Feed #${parsed.id} isn't yours.`, mentions)];
  }
  deps.store.deleteWatchlistSource(parsed.id!);
  return [reply(replyTo, `${prefix}Removed feed #${parsed.id} (${src.type}). Already-imported titles stay queued.`, mentions)];
}

function watchlistGuide(prefix: string): string {
  const lines = [
    `${prefix}*Auto-request from your watchlist* 🎬`,
    `Link a watchlist and I'll request new titles automatically — routed, de-duplicated, with a DM when they're on Plex (up to ${config.limits.requestsPerDay}/day).`,
    '',
  ];
  // The no-Pass path only works when the owner has configured a Plex token.
  if (config.plex.token) {
    lines.push(
      '*Plex Watchlist — no Plex Pass needed:*',
      '1. In Plex: accept the owner\'s *friend request* + set your *Watchlist to "Friends Only"*',
      '2. `!watchlist add plex-friend <your plex username>`',
      '',
      '*Plex Watchlist — with Plex Pass (RSS):*',
    );
  } else {
    lines.push('*Plex Watchlist* (movies + shows — needs Plex Pass):');
  }
  lines.push(
    '1. app.plex.tv → Watchlist → "..." → *Generate RSS Feed*',
    '2. `!watchlist add plex <the https://rss.plex.tv/… url>`',
    '_(that link is private — delete your message once I confirm)_',
    '',
    '*Letterboxd* (movies — use a public *list*, not the watchlist):',
    '1. Make a public list, open it → RSS feed URL',
    '2. `!watchlist add letterboxd https://letterboxd.com/<you>/list/<list>/rss/`',
    '',
    '`!watchlist list` — your feeds · `!watchlist remove <id>` — drop one',
  );
  return lines.join('\n');
}

// Friendly name for a group JID in admin-facing prompts (falls back to the JID
// when no GROUP_LABELS entry is configured).
function groupLabel(jid: string): string {
  return config.whatsapp.groupLabels[jid] ?? jid;
}

// The "which group?" picker the admin gets before a multi-group announcement.
// Lists each group, then a final "all/both" option; a short body preview reminds
// them what they're about to send.
function buildAnnounceTargetPrompt(groups: string[], body: string): string {
  const preview = body.replace(/\s+/g, ' ').trim();
  const shown = preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
  const allWord = groups.length === 2 ? 'both' : 'all';
  const lines = [`📣 Announce to which group?`, `> ${shown}`, ``];
  groups.forEach((g, i) => lines.push(`${i + 1}. ${groupLabel(g)}`));
  lines.push(`${groups.length + 1}. ${allWord}`);
  lines.push(``, `Reply with a number — or NO to cancel.`);
  return lines.join('\n');
}

// Post the body to the chosen groups + ack the admin (unless they invoked from
// one of the targets, where the broadcast is already visible). Body keeps its
// formatting — the bot posts as itself, one reply per group.
function sendAnnouncement(msg: IncomingMessage, body: string, targets: string[]): Reply[] {
  const replies: Reply[] = targets.map(g => reply(g, body));
  if (!targets.includes(msg.fromJid)) {
    const where = targets.length === 1
      ? groupLabel(targets[0]!)
      : `${targets.length} groups`;
    replies.push(reply(msg.fromJid, `📣 Announcement sent to ${where}.`));
  }
  log_.info({ admin: msg.senderNumber, groups: targets.length }, 'announcement sent');
  return replies;
}

// Admin: broadcast a message to allow-listed group(s). With a single allowed
// group there's nothing to choose, so it sends immediately. With several, the
// admin first picks a target (one group or all) via a numbered reply — the body
// is stashed in conversation state and dispatched in handleStateResponse.
// Silent-drop for non-admins in a group; explicit refusal in DM.
function handleAnnounce(deps: Deps, msg: IncomingMessage, body: string): Reply[] {
  if (!isAdmin(msg.senderNumber)) {
    log_.warn({ sender: msg.senderNumber }, 'announce from non-admin');
    if (msg.isGroup) return [];
    return [reply(msg.senderJid, `Admin only.`)];
  }
  const groups = config.whatsapp.allowedGroups;
  if (groups.length === 0) {
    return [reply(msg.fromJid, `No allowed groups configured to announce to.`)];
  }
  if (groups.length === 1) {
    return sendAnnouncement(msg, body, groups);
  }
  const ttl = Date.now() + config.limits.confirmTtlMinutes * 60_000;
  const payload: AnnouncePayload = { body, fromJid: msg.fromJid };
  deps.store.setState(msg.senderJid, { awaiting: 'announce_target', payload, expiresAt: ttl });
  return [reply(msg.fromJid, buildAnnounceTargetPrompt(groups, body))];
}

// Per-member toggle for the ambient film-link 🎬 suggestion (index.ts reacts to
// shared Letterboxd links; this silences it for the sender). Available to anyone.
function handleLinks(
  deps: Deps,
  msg: IncomingMessage,
  parsed: Extract<ParsedCommand, { kind: 'links' }>,
): Reply[] {
  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const prefix = msg.isGroup ? `@${msg.senderNumber} ` : '';
  if (parsed.op === 'status') {
    const off = deps.store.isLinksOptedOut(msg.senderNumber);
    return [reply(replyTo, off
      ? `${prefix}Film-link suggestions are *off* for you. \`!links on\` to re-enable.`
      : `${prefix}Film-link suggestions are *on*: share a Letterboxd film link and I'll add a 🎬 — quote-reply it with \`q\` to queue. \`!links off\` to silence.`, mentions)];
  }
  deps.store.setLinksOptOut(msg.senderNumber, parsed.op === 'off');
  return [reply(replyTo, parsed.op === 'off'
    ? `${prefix}Film-link suggestions silenced 🔕 — I won't react to your shared links.`
    : `${prefix}Film-link suggestions back on 🎬 — quote-reply a film link with \`q\` to queue.`, mentions)];
}

// Don't echo a full Plex rss.plex.tv URL (a bearer secret) back into the chat.
function redactFeedUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname === 'rss.plex.tv' ? `${u.hostname}/…(private)` : url;
  } catch {
    return url;
  }
}

// Human-readable bytes. Uses binary (1024) units to match Syncthing's own UI.
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

async function handleSync(deps: Deps, msg: IncomingMessage): Promise<Reply[]> {
  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const prefix = msg.isGroup ? `@${msg.senderNumber} ` : '';
  const remoteLabel = config.syncthing.remoteLabel || 'remote';

  if (!deps.syncthing || !deps.syncthing.isConfigured()) {
    return [reply(replyTo, `${prefix}Syncthing not configured.`, mentions)];
  }

  let completion;
  let status;
  try {
    [completion, status] = await Promise.all([
      deps.syncthing.getCompletion(),
      deps.syncthing.getFolderStatus(),
    ]);
  } catch (e: any) {
    log_.error({ err: e?.message }, 'syncthing query failed');
    return [reply(replyTo, `${prefix}Syncthing unreachable: ${e?.message ?? 'unknown error'}`, mentions)];
  }

  // 99.99% with 0 bytes pending == effectively done; treat as in-sync.
  const isDone = completion.completion >= 100 || completion.needBytes === 0;
  const lines: string[] = [];

  if (isDone) {
    lines.push(`${prefix}*${remoteLabel}* is in sync ✓ (${formatBytes(status.globalBytes)} total)`);
  } else {
    const pct = completion.completion.toFixed(2);
    const pending = `${formatBytes(completion.needBytes)} / ${completion.needItems} item${completion.needItems === 1 ? '' : 's'} pending`;
    lines.push(`${prefix}*${remoteLabel}* sync: ${pct}% — ${pending}`);
  }

  // Local folder health — only call out if anomalous
  if (status.errors > 0) {
    lines.push(`_local has ${status.errors} error${status.errors === 1 ? '' : 's'} — check Syncthing UI._`);
  } else if (status.state !== 'idle' && status.state !== 'syncing') {
    lines.push(`_local state: ${status.state}_`);
  }

  return [reply(replyTo, lines.join('\n'), mentions)];
}

async function handleFeedback(deps: Deps, msg: IncomingMessage, body: string): Promise<Reply[]> {
  const v = await runValidation(deps.store);
  const report = formatValidation(v);
  deps.store.recordFeedback({
    kind: 'feedback',
    senderJid: msg.senderJid,
    senderNumber: msg.senderNumber,
    groupJid: msg.isGroup ? msg.fromJid : null,
    body,
    report,
  });
  const replies: Reply[] = [];
  const ack = msg.isGroup
    ? `@${msg.senderNumber} thanks — logged. Validation: ${v.ok ? 'all good ✓' : 'see DM ✗'}`
    : `Thanks — logged.\n\n${report}`;
  replies.push(reply(msg.fromJid, ack, msg.isGroup ? [msg.senderJid] : undefined));
  // Always DM admin(s) with the full body + validation result
  for (const adminJid of adminJidsToNotify(msg)) {
    replies.push(reply(adminJid, [
      `*feedback* from @${msg.senderNumber}${msg.isGroup ? ' (group)' : ' (DM)'}`,
      '',
      `> ${body}`,
      '',
      report,
    ].join('\n')));
  }
  return replies;
}

async function handleIssue(deps: Deps, msg: IncomingMessage, body: string): Promise<Reply[]> {
  const d = await runDiagnosis(deps.store);
  const report = formatDiagnosis(d);
  deps.store.recordFeedback({
    kind: 'issue',
    senderJid: msg.senderJid,
    senderNumber: msg.senderNumber,
    groupJid: msg.isGroup ? msg.fromJid : null,
    body,
    report,
  });
  const replies: Reply[] = [];
  const ack = msg.isGroup
    ? `@${msg.senderNumber} got it — issue logged${d.validation.ok ? ' (system looks healthy)' : ' (admin pinged with diagnosis)'}.`
    : `Got it — issue logged.\n\n${report}`;
  replies.push(reply(msg.fromJid, ack, msg.isGroup ? [msg.senderJid] : undefined));
  for (const adminJid of adminJidsToNotify(msg)) {
    replies.push(reply(adminJid, [
      `*issue* from @${msg.senderNumber}${msg.isGroup ? ' (group)' : ' (DM)'}`,
      '',
      `> ${body}`,
      '',
      report,
    ].join('\n')));
  }
  return replies;
}

function adminJidsToNotify(msg: IncomingMessage): string[] {
  // Admins are stored as bare numbers; DM JID is `<number>@s.whatsapp.net`.
  // Skip notifying the sender themselves (avoid double-DM if admin is the reporter).
  const out: string[] = [];
  for (const n of config.whatsapp.adminNumbers) {
    if (n === msg.senderNumber) continue;
    out.push(`${n}@s.whatsapp.net`);
  }
  return out;
}

function formatStatus(info: { status: number; downloadStatus: { size: number; sizeLeft: number }[] } | null, auditStatus: string): string {
  if (auditStatus === 'failed') return 'failed (queue rejected)';
  if (!info) return 'status unknown';
  switch (info.status) {
    case 1: return 'unknown';
    case 2: return 'pending approval';
    case 3: {
      const dl = info.downloadStatus?.[0];
      if (dl && dl.size > 0) {
        const pct = Math.max(0, Math.min(100, Math.round(((dl.size - dl.sizeLeft) / dl.size) * 100)));
        return `downloading ${pct}%`;
      }
      return 'processing';
    }
    case 4: return 'partial';
    case 5: return 'ready ✓';
    case 6: return 'blacklisted';
    case 7: return 'deleted';
    default: return `status ${info.status}`;
  }
}

async function handleQueue(deps: Deps, msg: IncomingMessage): Promise<Reply[]> {
  const rows = deps.store.getUserRequests(msg.senderNumber, 10);
  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  if (rows.length === 0) {
    return [reply(replyTo, `@${msg.senderNumber} you haven't requested anything yet. Try !movie <title>.`, mentions)];
  }
  const parts = await Promise.all(rows.map(async r => {
    if (!r.seerrMediaType || !r.seerrMediaId) return `• ${r.command} — ${r.status}`;
    const info = await deps.seerr.getMediaInfo(r.seerrMediaType as 'movie' | 'tv', r.seerrMediaId);
    return `• ${r.command} — ${formatStatus(info, r.status)}`;
  }));
  const header = msg.isGroup
    ? `@${msg.senderNumber} *your last ${rows.length} request${rows.length === 1 ? '' : 's'}:*`
    : `*your last ${rows.length} request${rows.length === 1 ? '' : 's'}:*`;
  const lines = [header, ...parts];
  return [reply(replyTo, lines.join('\n'), mentions)];
}

// !prioritize — bump request(s) to the front by forcing an immediate Sonarr/
// Radarr search (skip the RSS-sync wait). Member-facing with a tight per-day cap
// (one command = one priority, even when it fans out). A title can exist as BOTH
// a movie and a TV entry (e.g. an OVA + its compilation film); when the member
// has requested more than one form, all matching forms are pushed together.
// Targets the named title, or the sender's most recent real request.
async function handlePrioritize(
  deps: Deps,
  msg: IncomingMessage,
  parsed: Extract<ParsedCommand, { kind: 'prioritize' }>,
): Promise<Reply[]> {
  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const r = (text: string): Reply[] => [reply(replyTo, text, mentions)];

  if (config.limits.priorityPerDay <= 0 || !deps.arr) {
    return r(`@${msg.senderNumber} prioritize isn't enabled here.`);
  }
  const cap = config.limits.priorityPerDay;
  if (deps.store.getPriorityCount(msg.senderNumber) >= cap) {
    return r(`@${msg.senderNumber} you've used your ${cap} priorit${cap === 1 ? 'y' : 'ies'} for today — resets tomorrow.`);
  }

  // ---- Resolve candidate(s) ----
  type Candidate = { mediaType: 'movie' | 'tv'; tmdbId: number };
  let candidates: Candidate[];
  let display: string;
  if (parsed.title) {
    const results = (await deps.seerr.search(parsed.title))
      .filter(x => x.mediaType === 'movie' || x.mediaType === 'tv');
    if (!results.length) return r(`@${msg.senderNumber} couldn't find "${parsed.title}".`);
    // "Requested" = Seerr knows about it in EITHER quality tier (status >= 2).
    const isReq = (x: seerrModule.SearchResult) =>
      (x.mediaInfo?.status ?? 0) >= 2 || (x.mediaInfo?.status4k ?? 0) >= 2;
    const requested = results.filter(isReq);
    if (!requested.length) {
      const t = results[0]!;
      return r(`@${msg.senderNumber} *${t.title ?? t.name ?? parsed.title}* doesn't look requested yet — \`!movie\`/\`!tv\` it first.`);
    }
    // Anchor on the most-prioritizable requested hit (downloading > pending/
    // partial > available, considering BOTH quality tiers), then take every
    // requested entry that shares its (normalized) title — so a movie + its show
    // both get pushed, but a loosely-related "Inside <X>" that merely matched the
    // search does not.
    const score = (s?: number) => (s === 3 ? 4 : s === 2 || s === 4 ? 3 : s === 5 ? 2 : 0);
    const rank = (x: seerrModule.SearchResult) => Math.max(score(x.mediaInfo?.status), score(x.mediaInfo?.status4k));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const anchor = requested.slice().sort((a, b) => rank(b) - rank(a))[0]!;
    const key = norm(anchor.title ?? anchor.name ?? '');
    candidates = requested
      .filter(x => norm(x.title ?? x.name ?? '') === key)
      .map(x => ({ mediaType: x.mediaType === 'tv' ? 'tv' as const : 'movie' as const, tmdbId: x.id }));
    display = anchor.title ?? anchor.name ?? parsed.title;
  } else {
    const recent = deps.store
      .getUserRequests(msg.senderNumber, 10)
      .find(x => x.seerrMediaType && x.seerrMediaId && !/^prioritize\b/i.test(x.command));
    if (!recent) {
      return r(`@${msg.senderNumber} you have no recent request to prioritize. Try \`!prioritize <title>\`.`);
    }
    candidates = [{ mediaType: recent.seerrMediaType as 'movie' | 'tv', tmdbId: recent.seerrMediaId! }];
    display = cleanDisplay(recent.command);
  }

  // ---- Per-candidate: look up live status, force-search the prioritizable ones ----
  const searched: Candidate[] = [];
  const buckets = { available: 0, unavailable: 0, pending: 0, missing: 0 };
  let anyError = false;
  for (const c of candidates) {
    const info = await deps.seerr.getMediaInfo(c.mediaType, c.tmdbId);
    if (!info) { buckets.missing++; continue; }
    if (info.status === 5) { buckets.available++; continue; }
    if (info.status === 6 || info.status === 7) { buckets.unavailable++; continue; }   // blacklisted / deleted
    if (info.externalServiceId === null) { buckets.pending++; continue; }
    try {
      await deps.arr.forceSearch(c.mediaType, info.externalServiceId, info.serverId);
      searched.push(c);
    } catch (e: any) {
      anyError = true;
      log_.warn({ err: e?.message, tmdbId: c.tmdbId }, 'prioritize force-search failed');
    }
  }

  // ---- Report ----
  if (!searched.length) {
    if (anyError) return r(`@${msg.senderNumber} couldn't reach the downloader to prioritize *${display}* — try again in a minute.`);
    if (buckets.available) return r(`@${msg.senderNumber} *${display}* is already on Plex — nothing to prioritize. ✓`);
    if (buckets.unavailable) return r(`@${msg.senderNumber} *${display}* was removed/blacklisted — can't prioritize it.`);
    if (buckets.pending) return r(`@${msg.senderNumber} *${display}* isn't with the downloader yet (still pending approval). Try again once it's approved.`);
    return r(`@${msg.senderNumber} *${display}* doesn't look requested yet — \`!movie\`/\`!tv\` it first.`);
  }

  // One command = one priority, even when it fanned out to several entries.
  const left = cap - deps.store.bumpPriority(msg.senderNumber);
  for (const c of searched) {
    deps.store.audit({
      senderJid: msg.senderJid,
      senderNumber: msg.senderNumber,
      groupJid: msg.isGroup ? msg.fromJid : null,
      command: `prioritize ${display}`,
      seerrMediaType: c.mediaType,
      seerrMediaId: c.tmdbId,
      seerrRequestId: null,
      status: 'queued',
    });
  }
  const label = (mt: 'movie' | 'tv') => (mt === 'tv' ? 'show' : 'movie');
  const kinds = [...new Set(searched.map(c => label(c.mediaType)))];
  const suffix = kinds.length > 1 ? ` (${kinds.join(' + ')})` : '';
  const tail = left > 0 ? ` (${left} priorit${left === 1 ? 'y' : 'ies'} left today)` : ` (last one for today)`;
  return r(`🚀 @${msg.senderNumber} pushed *${display}*${suffix} to the front — searching for a release now.${tail}`);
}

// Clean display title from a stored audit command: strip the leading verb, a
// watchlist:<label> prefix, and fall back to a generic label when only a bare
// TMDb id remains (numbered-picker rows store e.g. "movie 27205").
function cleanDisplay(command: string): string {
  const d = command
    .replace(/^(movie|tv|prioritize)\s+/i, '')
    .replace(/^watchlist:\S+\s+/i, '')
    .trim();
  return d && !/^\d+$/.test(d) ? d : 'your last request';
}

async function handleRequest(
  deps: Deps,
  msg: IncomingMessage,
  parsed: Extract<ParsedCommand, { kind: 'request' }>,
): Promise<Reply[]> {
  // Quota
  const used = deps.store.getQuota(msg.senderNumber);
  if (used >= config.limits.requestsPerDay) {
    return [reply(msg.fromJid, `@${msg.senderNumber} hit the daily limit (${config.limits.requestsPerDay}/day). Try again tomorrow.`, msg.isGroup ? [msg.senderJid] : undefined)];
  }

  // Dedup
  const dedupWindow = config.limits.dedupWindowHours * 3600 * 1000;
  const dedupKey = parsed.mediaTypeHint === 'ambiguous' ? 'either' : parsed.mediaTypeHint;
  if (deps.store.recentDedup(msg.senderNumber, dedupKey, parsed.title, dedupWindow)) {
    return [reply(msg.fromJid, `"${parsed.title}" was already requested in the last ${config.limits.dedupWindowHours}h.`)];
  }

  // Ambiguous mediaType?
  if (parsed.mediaTypeHint === 'ambiguous') {
    const payload: DisambigPayload = {
      title: parsed.title,
      category: parsed.category,
      groupJid: msg.isGroup ? msg.fromJid : null,
      senderNumber: msg.senderNumber,
    };
    deps.store.setState(msg.senderJid, {
      awaiting: 'movie_or_tv',
      payload,
      expiresAt: Date.now() + config.limits.confirmTtlMinutes * 60 * 1000,
    });
    const text = msg.isGroup
      ? `@${msg.senderNumber} is "${parsed.title}" a MOVIE or TV? Only you can answer.`
      : `is "${parsed.title}" a MOVIE or TV?`;
    return [reply(msg.fromJid, text, msg.isGroup ? [msg.senderJid] : undefined)];
  }

  // Resolve route
  let resolved;
  try {
    resolved = resolveRoute(parsed.mediaTypeHint, parsed.category);
  } catch (e: any) {
    log_.error({ err: e?.message }, 'forbidden path triggered');
    deps.store.audit({
      senderJid: msg.senderJid,
      senderNumber: msg.senderNumber,
      groupJid: msg.isGroup ? msg.fromJid : null,
      command: msg.text,
      status: 'route_forbidden',
    });
    return [reply(msg.fromJid, `Internal routing error.`)];
  }
  if (!resolved.ok) {
    return [reply(msg.fromJid, `Can't request "${parsed.title}" as ${parsed.mediaTypeHint}/${parsed.category} — ${resolved.reason}.`)];
  }

  // Search
  let results;
  try {
    results = await deps.seerr.search(parsed.title);
  } catch (e: any) {
    log_.error({ err: e?.message }, 'seerr search failed');
    return [reply(msg.fromJid, `Seerr is unreachable, try again later.`)];
  }
  const matching = results.filter(r => r.mediaType === parsed.mediaTypeHint).slice(0, TOP_N);
  if (matching.length === 0) {
    return [reply(msg.fromJid, `No ${parsed.mediaTypeHint} results for "${parsed.title}".`)];
  }

  const candidates: PickCandidate[] = matching.map(r => {
    const titleStr = r.title ?? r.name ?? '?';
    const yearStr = (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || '????';
    return {
      tmdbId: r.id,
      display: `${titleStr} (${yearStr})`,
      posterPath: r.posterPath ?? null,
      overview: r.overview ?? null,
      status: r.mediaInfo?.status ?? null,
    };
  });

  const ttl = Date.now() + config.limits.confirmTtlMinutes * 60 * 1000;
  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const mentionPrefix = msg.isGroup ? `@${msg.senderNumber} ` : '';

  // Single match → check availability, then either short-circuit, season-picker (TV), or confirm (movie)
  if (candidates.length === 1) {
    const c = candidates[0]!;
    if (shouldBlockRequest(c.status)) {
      return [reply(replyTo, `${mentionPrefix}${blockedReply(c.display, c.status!)}`, mentions)];
    }
    if (parsed.mediaTypeHint === 'tv') {
      return await enterSeasonPicker(deps, msg, {
        tmdbId: c.tmdbId,
        route: resolved.route,
        display: c.display,
        title: parsed.title,
        groupJid: msg.isGroup ? msg.fromJid : null,
        posterPath: c.posterPath ?? null,
        overview: c.overview ?? null,
      });
    }
    const payload: ConfirmPayload = {
      tmdbId: c.tmdbId,
      mediaType: parsed.mediaTypeHint,
      route: resolved.route,
      display: c.display,
      title: parsed.title,
      groupJid: msg.isGroup ? msg.fromJid : null,
      posterPath: c.posterPath,
      overview: c.overview,
    };
    deps.store.setState(msg.senderJid, { awaiting: 'confirm', payload, expiresAt: ttl });
    return [buildConfirmReply(replyTo, mentions, payload, msg.senderNumber)];
  }

  // Multiple matches → numbered picker
  const pickPayload: PickPayload = {
    candidates,
    mediaType: parsed.mediaTypeHint,
    route: resolved.route,
    title: parsed.title,
    groupJid: msg.isGroup ? msg.fromJid : null,
  };
  deps.store.setState(msg.senderJid, { awaiting: 'pick', payload: pickPayload, expiresAt: ttl });
  return [reply(replyTo, buildPickerText(msg.senderNumber, candidates, msg.isGroup), mentions)];
}

async function enterSeasonPicker(
  deps: Deps,
  msg: IncomingMessage,
  args: {
    tmdbId: number;
    route: Route;
    display: string;
    title: string;
    groupJid: string | null;
    posterPath: string | null;
    overview: string | null;
  },
): Promise<Reply[]> {
  // Best-effort: fetch season count so the prompt is informative and we can
  // validate user replies. Failure is OK — we still let them try.
  let numberOfSeasons: number | null = null;
  try {
    const details = await deps.seerr.getTvDetails(args.tmdbId);
    if (details && details.numberOfSeasons > 0) numberOfSeasons = details.numberOfSeasons;
  } catch (e: any) {
    log_.warn({ tmdbId: args.tmdbId, err: e?.message }, 'getTvDetails failed in season prompt');
  }
  const payload: SeasonPayload = {
    tmdbId: args.tmdbId,
    route: args.route,
    display: args.display,
    title: args.title,
    groupJid: args.groupJid,
    posterPath: args.posterPath,
    overview: args.overview,
    numberOfSeasons,
  };
  deps.store.setState(msg.senderJid, {
    awaiting: 'season',
    payload,
    expiresAt: Date.now() + config.limits.confirmTtlMinutes * 60 * 1000,
  });
  const replyTo = args.groupJid ?? msg.senderJid;
  const mentions = args.groupJid ? [msg.senderJid] : undefined;
  const r = buildSeasonPrompt(msg.senderNumber, payload);
  return [{ ...r, to: replyTo, mentions }];
}

// Multi-select queue: skip blocked items + dedup + quota; createRequest per
// picked item. For TV, defaults to seasons='all' (single-pick a TV item to
// pick seasons). Returns a single summary reply.
async function queueBatch(
  deps: Deps,
  msg: IncomingMessage,
  picks: { candidate: PickCandidate; mediaType: MediaType; route: Route; titleForDedup: string }[],
): Promise<Reply[]> {
  const replyTo = msg.fromJid;
  const mentions = msg.isGroup ? [msg.senderJid] : undefined;
  const queued: string[] = [];
  const skippedAvailable: string[] = [];
  const skippedDedup: string[] = [];
  const skippedQuota: string[] = [];
  const failed: { display: string; reason: string }[] = [];

  let used = deps.store.getQuota(msg.senderNumber);
  const dedupWindow = config.limits.dedupWindowHours * 3600 * 1000;

  for (const { candidate, mediaType, route, titleForDedup } of picks) {
    if (shouldBlockRequest(candidate.status)) {
      skippedAvailable.push(candidate.display);
      continue;
    }
    if (deps.store.recentDedup(msg.senderNumber, mediaType, titleForDedup, dedupWindow)) {
      skippedDedup.push(candidate.display);
      continue;
    }
    if (used >= config.limits.requestsPerDay) {
      skippedQuota.push(candidate.display);
      continue;
    }
    const auditId = deps.store.audit({
      senderJid: msg.senderJid,
      senderNumber: msg.senderNumber,
      groupJid: msg.isGroup ? msg.fromJid : null,
      command: `${mediaType} ${titleForDedup}`,
      resolvedRoute: route.rootFolder,
      seerrMediaType: mediaType,
      seerrMediaId: candidate.tmdbId,
      seerrRequestId: null,
      status: 'queued',
    });
    try {
      const result = await deps.seerr.createRequest({
        mediaType,
        mediaId: candidate.tmdbId,
        rootFolder: route.rootFolder,
        profileId: route.profileId,
        userId: deps.store.getSeerrUserId(msg.senderNumber) ?? undefined,
        seasons: mediaType === 'tv' ? 'all' : undefined,
      });
      deps.store.updateAudit(auditId, { seerrRequestId: result?.id ?? null });
      deps.store.addSubscription({
        subscriberJid: msg.senderJid,
        subscriberNumber: msg.senderNumber,
        groupJid: msg.isGroup ? msg.fromJid : null,
        mediaType,
        tmdbId: candidate.tmdbId,
        seasons: mediaType === 'tv' ? 'all' : null,
      });
      deps.store.bumpQuota(msg.senderNumber);
      used += 1;
      deps.store.recordDedup(msg.senderNumber, mediaType, titleForDedup);
      queued.push(candidate.display);
    } catch (e: any) {
      deps.store.updateAudit(auditId, { status: 'failed' });
      log_.error({ err: e?.message, tmdbId: candidate.tmdbId }, 'batch createRequest failed');
      failed.push({ display: candidate.display, reason: e?.message ?? 'unknown error' });
    }
  }

  deps.store.clearState(msg.senderJid);

  const lines: string[] = [];
  if (queued.length > 0) {
    lines.push(`*Queued by @${msg.senderNumber}:* ${queued.map(d => `*${d}*`).join(', ')}`);
  }
  if (skippedAvailable.length > 0) lines.push(`_Skipped (already on Plex):_ ${skippedAvailable.join(', ')}`);
  if (skippedDedup.length > 0) lines.push(`_Skipped (recent duplicate):_ ${skippedDedup.join(', ')}`);
  if (skippedQuota.length > 0) lines.push(`_Skipped (daily limit hit):_ ${skippedQuota.join(', ')}`);
  if (failed.length > 0) lines.push(`_Failed:_ ${failed.map(f => `${f.display} (${f.reason})`).join('; ')}`);
  if (lines.length === 0) lines.push(`No requests went through.`);
  if (picks.some(p => p.mediaType === 'tv') && queued.length > 0) {
    lines.push(`_TV items queued as all seasons. Single-select next time to pick seasons._`);
  }
  return [reply(replyTo, lines.join('\n'), mentions)];
}

async function handleStateResponse(
  deps: Deps,
  msg: IncomingMessage,
  state: { awaiting: AwaitingKind; payload: unknown; expiresAt: number },
  text: string,
): Promise<Reply[] | null> {
  const upper = text.toUpperCase().trim();

  if (state.awaiting === 'confirm') {
    const p = state.payload as ConfirmPayload;
    const replyTo = p.groupJid ?? msg.senderJid;
    const mentions = p.groupJid ? [msg.senderJid] : undefined;
    if (upper === 'YES' || upper === 'Y') {
      // Audit row written BEFORE createRequest so an immediate MEDIA_AVAILABLE
      // webhook (Seerr fires sync when the media is already on Plex) can find
      // the requester. seerrRequestId is filled in after the call returns.
      const auditId = deps.store.audit({
        senderJid: msg.senderJid,
        senderNumber: msg.senderNumber,
        groupJid: p.groupJid,
        command: `${p.mediaType} ${p.title}`,
        resolvedRoute: p.route.rootFolder,
        seerrMediaType: p.mediaType,
        seerrMediaId: p.tmdbId,
        seerrRequestId: null,
        status: 'queued',
      });
      try {
        const result = await deps.seerr.createRequest({
          mediaType: p.mediaType,
          mediaId: p.tmdbId,
          rootFolder: p.route.rootFolder,
          profileId: p.route.profileId,
          userId: deps.store.getSeerrUserId(msg.senderNumber) ?? undefined,
          seasons: p.mediaType === 'tv' ? 'all' : undefined,
        });
        deps.store.updateAudit(auditId, { seerrRequestId: result?.id ?? null });
        deps.store.addSubscription({
          subscriberJid: msg.senderJid,
          subscriberNumber: msg.senderNumber,
          groupJid: p.groupJid,
          mediaType: p.mediaType,
          tmdbId: p.tmdbId,
          seasons: p.mediaType === 'tv' ? 'all' : null,
        });
        deps.store.bumpQuota(msg.senderNumber);
        deps.store.recordDedup(msg.senderNumber, p.mediaType, p.title);
        deps.store.clearState(msg.senderJid);
        return [reply(replyTo, `*${p.display}* queued by @${msg.senderNumber}. You'll get a ping when it's on Plex.`, mentions)];
      } catch (e: any) {
        deps.store.updateAudit(auditId, { status: 'failed' });
        log_.error({ err: e?.message }, 'seerr request failed');
        return [reply(replyTo, `Failed to queue *${p.display}*: ${e?.message ?? 'unknown error'}`, mentions)];
      }
    }
    if (upper === 'NO' || upper === 'N') {
      deps.store.clearState(msg.senderJid);
      return [reply(replyTo, `Skipped *${p.display}*.`, mentions)];
    }
    // Anything else: re-emit the full prompt, but throttle to avoid spamming
    // the chat if the user is just talking. Cooldown only applies between
    // re-emits — the initial prompt always goes through (it was sent at
    // state creation time).
    if (p.lastReEmitAt && Date.now() - p.lastReEmitAt < RE_EMIT_COOLDOWN_MS) return [];
    deps.store.setState(msg.senderJid, {
      awaiting: 'confirm',
      payload: { ...p, lastReEmitAt: Date.now() },
      expiresAt: state.expiresAt,
    });
    return [buildConfirmReply(replyTo, mentions, p, msg.senderNumber)];
  }

  if (state.awaiting === 'movie_or_tv') {
    const p = state.payload as DisambigPayload;
    const replyTo = p.groupJid ?? msg.senderJid;
    const mentions = p.groupJid ? [msg.senderJid] : undefined;
    if (upper === 'MOVIE' || upper === 'M' || upper === 'TV' || upper === 'T') {
      const mediaType: MediaType = (upper === 'TV' || upper === 'T') ? 'tv' : 'movie';
      deps.store.clearState(msg.senderJid);
      const synth: IncomingMessage = {
        ...msg,
        fromJid: p.groupJid ?? msg.senderJid,
        isGroup: !!p.groupJid,
      };
      return await handleRequest(deps, synth, {
        kind: 'request',
        mediaTypeHint: mediaType,
        category: p.category,
        title: p.title,
      });
    }
    if (p.lastReEmitAt && Date.now() - p.lastReEmitAt < RE_EMIT_COOLDOWN_MS) return [];
    deps.store.setState(msg.senderJid, {
      awaiting: 'movie_or_tv',
      payload: { ...p, lastReEmitAt: Date.now() },
      expiresAt: state.expiresAt,
    });
    const text = p.groupJid
      ? `@${msg.senderNumber} is "${p.title}" a MOVIE or TV? Only you can answer.`
      : `is "${p.title}" a MOVIE or TV?`;
    return [reply(replyTo, text, mentions)];
  }

  if (state.awaiting === 'pick') {
    const p = state.payload as PickPayload;
    const replyTo = p.groupJid ?? msg.senderJid;
    const mentions = p.groupJid ? [msg.senderJid] : undefined;
    if (upper === 'NO' || upper === 'N') {
      deps.store.clearState(msg.senderJid);
      return [reply(replyTo, `Skipped.`, mentions)];
    }
    const picks = parsePickList(upper, p.candidates.length);
    if (picks && picks.length === 1) {
      const n = picks[0]!;
      const chosen = p.candidates[n - 1]!;
      if (shouldBlockRequest(chosen.status)) {
        deps.store.clearState(msg.senderJid);
        const prefix = p.groupJid ? `@${msg.senderNumber} ` : '';
        return [reply(replyTo, `${prefix}${blockedReply(chosen.display, chosen.status!)}`, mentions)];
      }
      if (p.mediaType === 'tv') {
        return await enterSeasonPicker(deps, msg, {
          tmdbId: chosen.tmdbId,
          route: p.route,
          display: chosen.display,
          title: p.title,
          groupJid: p.groupJid,
          posterPath: chosen.posterPath ?? null,
          overview: chosen.overview ?? null,
        });
      }
      const payload: ConfirmPayload = {
        tmdbId: chosen.tmdbId,
        mediaType: p.mediaType,
        route: p.route,
        display: chosen.display,
        title: p.title,
        groupJid: p.groupJid,
        posterPath: chosen.posterPath,
        overview: chosen.overview,
      };
      deps.store.setState(msg.senderJid, {
        awaiting: 'confirm',
        payload,
        expiresAt: Date.now() + config.limits.confirmTtlMinutes * 60 * 1000,
      });
      return [buildConfirmReply(replyTo, mentions, payload, msg.senderNumber)];
    }
    if (picks && picks.length > 1) {
      const batch = picks.map(n => ({
        candidate: p.candidates[n - 1]!,
        mediaType: p.mediaType,
        route: p.route,
        titleForDedup: `${p.candidates[n - 1]!.tmdbId}`,  // dedup per-TMDb-id when batch
      }));
      return await queueBatch(deps, msg, batch);
    }
    // Anything else: re-emit the full numbered list, throttled.
    if (p.lastReEmitAt && Date.now() - p.lastReEmitAt < RE_EMIT_COOLDOWN_MS) return [];
    deps.store.setState(msg.senderJid, {
      awaiting: 'pick',
      payload: { ...p, lastReEmitAt: Date.now() },
      expiresAt: state.expiresAt,
    });
    return [reply(replyTo, buildPickerText(msg.senderNumber, p.candidates, !!p.groupJid), mentions)];
  }

  if (state.awaiting === 'season') {
    const p = state.payload as SeasonPayload;
    const replyTo = p.groupJid ?? msg.senderJid;
    const mentions = p.groupJid ? [msg.senderJid] : undefined;
    if (upper === 'NO' || upper === 'N') {
      deps.store.clearState(msg.senderJid);
      return [reply(replyTo, `Skipped *${p.display}*.`, mentions)];
    }
    const seasons = parseSeasonSelector(text, { numberOfSeasons: p.numberOfSeasons });
    if (seasons !== null) {
      // Quota gate (same as confirm/YES path)
      const used = deps.store.getQuota(msg.senderNumber);
      if (used >= config.limits.requestsPerDay) {
        deps.store.clearState(msg.senderJid);
        return [reply(replyTo, `@${msg.senderNumber} hit the daily limit (${config.limits.requestsPerDay}/day). Try again tomorrow.`, mentions)];
      }
      const auditId = deps.store.audit({
        senderJid: msg.senderJid,
        senderNumber: msg.senderNumber,
        groupJid: p.groupJid,
        command: `tv ${p.title}`,
        resolvedRoute: p.route.rootFolder,
        seerrMediaType: 'tv',
        seerrMediaId: p.tmdbId,
        seerrRequestId: null,
        status: 'queued',
      });
      try {
        const result = await deps.seerr.createRequest({
          mediaType: 'tv',
          mediaId: p.tmdbId,
          rootFolder: p.route.rootFolder,
          profileId: p.route.profileId,
          userId: deps.store.getSeerrUserId(msg.senderNumber) ?? undefined,
          seasons,
        });
        deps.store.updateAudit(auditId, { seerrRequestId: result?.id ?? null });
        deps.store.addSubscription({
          subscriberJid: msg.senderJid,
          subscriberNumber: msg.senderNumber,
          groupJid: p.groupJid,
          mediaType: 'tv',
          tmdbId: p.tmdbId,
          seasons,            // 'all' | number[], already computed above
        });
        deps.store.bumpQuota(msg.senderNumber);
        deps.store.recordDedup(msg.senderNumber, 'tv', p.title);
        deps.store.clearState(msg.senderJid);
        const seasonStr = seasons === 'all' ? 'all seasons' : `season${seasons.length === 1 ? '' : 's'} ${seasons.join(', ')}`;
        return [reply(replyTo, `*${p.display}* (${seasonStr}) queued by @${msg.senderNumber}. You'll get a ping when episodes land.`, mentions)];
      } catch (e: any) {
        deps.store.updateAudit(auditId, { status: 'failed' });
        log_.error({ err: e?.message }, 'seerr request failed (season pick)');
        return [reply(replyTo, `Failed to queue *${p.display}*: ${e?.message ?? 'unknown error'}`, mentions)];
      }
    }
    // Unparseable response: re-emit (throttled)
    if (p.lastReEmitAt && Date.now() - p.lastReEmitAt < RE_EMIT_COOLDOWN_MS) return [];
    deps.store.setState(msg.senderJid, {
      awaiting: 'season',
      payload: { ...p, lastReEmitAt: Date.now() },
      expiresAt: state.expiresAt,
    });
    const r = buildSeasonPrompt(msg.senderNumber, p);
    return [{ ...r, to: replyTo, mentions }];
  }

  if (state.awaiting === 'announce_target') {
    const p = state.payload as AnnouncePayload;
    if (upper === 'NO' || upper === 'N') {
      deps.store.clearState(msg.senderJid);
      return [reply(p.fromJid, `Announcement cancelled.`)];
    }
    const groups = config.whatsapp.allowedGroups;
    let targets: string[] | null = null;
    if (upper === 'ALL' || upper === 'BOTH') {
      targets = groups;
    } else {
      const n = Number(upper);
      // 1..N pick a single group; N+1 is the "all/both" option.
      if (Number.isInteger(n) && n >= 1 && n <= groups.length) targets = [groups[n - 1]!];
      else if (n === groups.length + 1) targets = groups;
    }
    if (!targets) {
      // Unparseable selection: re-emit the picker (throttled).
      if (p.lastReEmitAt && Date.now() - p.lastReEmitAt < RE_EMIT_COOLDOWN_MS) return [];
      deps.store.setState(msg.senderJid, {
        awaiting: 'announce_target',
        payload: { ...p, lastReEmitAt: Date.now() },
        expiresAt: state.expiresAt,
      });
      return [reply(p.fromJid, buildAnnounceTargetPrompt(groups, p.body))];
    }
    deps.store.clearState(msg.senderJid);
    return sendAnnouncement(msg, p.body, targets);
  }

  return null;
}

function reply(to: string, text: string, mentions?: string[]): Reply {
  const r: Reply = { to, text };
  if (mentions) r.mentions = mentions;
  return r;
}

function helpText(forAdmin: boolean): string {
  const base = [
    '*whatsarr commands:*',
    '```',
    '!movie <title>             request a movie',
    '!movie <category> <title>  movie with category',
    '!tv <title>                request a TV show (bot asks seasons)',
    '!tv <category> <title>     TV with category',
    '!req <title>               bot asks movie or TV',
    '!queue                     your recent requests',
    '!prioritize [title]        push a request to the front (search now)',
    '!status                    Seerr health',
    '!sync                      Plex ↔ remote-server sync status',
    '!watchlist                 auto-request from your Plex/Letterboxd feed',
    '!links on/off              toggle 🎬 queue-from-shared-links suggestions',
    '!feedback <message>        send feedback (auto-validates the bot)',
    '!issue <description>       report a bug (auto-runs diagnosis)',
    '!help                      this message',
    '```',
    '*Picker:* when multiple matches, reply `1` for one or `1,3` for several.',
    '*Seasons (TV):* reply `all`, `latest`, `1`, `1-3`, or `1,3,5`.',
    '*Film links:* I add 🎬 to shared Letterboxd films — quote-reply with `q` to queue (`!links off` to mute).',
    '*Movie categories:* western (default), bollywood/bolly/hindi, pakistani/pak/urdu, foreign/intl, documentary/doc/docu, anime, animated/cartoon',
    '*TV categories:* western (default), documentary/doc/docu, bollywood/bolly/hindi, asian/kdrama/cdrama/jdrama, anime, animated/cartoon',
    '*Examples:*',
    '```',
    '!movie dune part two',
    '!movie bollywood laapataa ladies',
    '!tv anime frieren',
    '!tv asian squid game',
    '!feedback the picker is great',
    '!issue ready DM never arrived for dune part two',
    '```',
  ];
  if (forAdmin) {
    base.push(
      '',
      '*admin only:*',
      '```',
      '!pending                   list pending Seerr requests',
      '!approve <id>              approve a pending request',
      '!deny <id>                 decline a pending request',
      '!map                       list WhatsApp → Seerr user mappings',
      '!map <number> <userId>     attribute a number\'s requests to a Seerr user',
      '!unmap <number>            revert a number to the default Seerr user',
      '!announce <message>        broadcast (you pick which group, or all)',
      '!shutdown                  graceful exit (service auto-restarts)',
      '```',
    );
  }
  return base.join('\n');
}
