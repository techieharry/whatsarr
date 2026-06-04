import { createServer, type IncomingMessage as IM, type ServerResponse } from 'node:http';
import { config } from './config.ts';
import { log } from './log.ts';
import type { Store, ActiveSubscriber } from './state/store.ts';
import * as seerrModule from './seerr/client.ts';
import * as syncthingModule from './syncthing/client.ts';
import { authGate, maybeSetTokenCookie } from './dashboard/auth.ts';
import { dashboardRoute } from './dashboard/routes.ts';

const log_ = log.child({ mod: 'webhook' });

type SendFn = (jid: string, content: { text: string; mentions?: string[] }) => Promise<unknown>;

export type ReadyEvent = { mediaType: string; tmdbId: number; title: string };

export type Coalescer = {
  enqueue(ev: ReadyEvent): void;          // buffer ev under key `${mediaType}:${tmdbId}`; arm timer if none
  flushNow(key?: string): Promise<void>;  // test hook: synchronously flush one key (or all)
  pending(): string[];                    // test hook: buffered keys, no wall-clock wait
  dispose(): void;                         // clear all timers (server close / test teardown)
};

export function makeCoalescer(opts: {
  windowMs: number;                                          // prod ~45_000; tests 0
  flush: (ev: ReadyEvent) => Promise<void>;                  // = ev => notifyReady(deps, ev)
  setTimer?: (fn: () => void, ms: number) => unknown;        // default: setTimeout (handle.unref())
  clearTimer?: (h: unknown) => void;                         // default: clearTimeout
}): Coalescer {
  const buffer = new Map<string, ReadyEvent>();
  const timers = new Map<string, unknown>();
  const setTimer = opts.setTimer ?? ((fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof (h as any).unref === 'function') (h as any).unref();
    return h;
  });
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as any));

  function keyOf(ev: ReadyEvent): string {
    return `${ev.mediaType}:${ev.tmdbId}`;
  }

  async function doFlush(key: string): Promise<void> {
    const ev = buffer.get(key);
    buffer.delete(key);
    timers.delete(key);
    if (!ev) return;
    await opts.flush(ev);
  }

  return {
    enqueue(ev: ReadyEvent) {
      const key = keyOf(ev);
      buffer.set(key, ev);  // last-wins on title
      // Fixed window from the first event: leave an existing timer in place so a
      // burst within the window collapses to exactly one flush.
      if (!timers.has(key)) {
        const h = setTimer(() => {
          void doFlush(key).catch(e => log_.error({ err: e?.message, key }, 'coalescer flush failed'));
        }, opts.windowMs);
        timers.set(key, h);
      }
    },
    async flushNow(key?: string) {
      if (key !== undefined) {
        const h = timers.get(key);
        if (h !== undefined) clearTimer(h);
        await doFlush(key);
        return;
      }
      for (const k of [...buffer.keys()]) {
        const h = timers.get(k);
        if (h !== undefined) clearTimer(h);
        await doFlush(k);
      }
    },
    pending() {
      return [...buffer.keys()];
    },
    dispose() {
      for (const h of timers.values()) clearTimer(h);
      timers.clear();
      buffer.clear();
    },
  };
}

export type WebhookDeps = {
  send: SendFn;
  store: Store;
  seerr: typeof seerrModule;
  syncthing: typeof syncthingModule;
  getConnectionStatus: () => { connected: boolean; uptimeSec: number };
  drainPending?: () => Promise<void>;
  reconnectWa?: () => Promise<void>;
  shutdown?: () => void;
  coalescer?: Coalescer;
};

// Per-IP fixed-window rate limiter. Pure + injectable so it can be unit-tested
// without global state. Returns true if the request is allowed. limit <= 0
// disables (always allowed). State is mutated in place by the caller's Map.
export type RateState = Map<string, { count: number; windowStart: number }>;
export function rateLimitOk(state: RateState, ip: string, now: number, limit: number, windowMs: number): boolean {
  if (limit <= 0) return true;
  const e = state.get(ip);
  if (!e || now - e.windowStart >= windowMs) {
    state.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= limit) return false;
  e.count += 1;
  return true;
}

const RATE_WINDOW_MS = 60_000;

export function startWebhook(deps: WebhookDeps): () => void {
  if (!config.webhook.enabled) {
    log_.info('webhook disabled');
    return () => {};
  }

  // Rate-limit state lives in the server closure (not module scope) so it never
  // leaks across test invocations of router(). Reaped opportunistically when an
  // IP's window has rolled over inside rateLimitOk.
  const rlState: RateState = new Map();

  // Coalescer lives in the server closure (matches the rlState idiom) so it never
  // leaks across test invocations. Repeat MEDIA_AVAILABLE for the same media
  // within the window collapse to one fan-out. The flush closure reads
  // depsWithCoalescer, which is assigned before any flush can fire.
  const depsWithCoalescer: WebhookDeps = { ...deps };
  const coalescer = makeCoalescer({
    windowMs: config.webhook.readyCoalesceMs,
    flush: ev => notifyReady(depsWithCoalescer, ev),
  });
  depsWithCoalescer.coalescer = coalescer;

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'POST' && path === '/webhook') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!rateLimitOk(rlState, ip, Date.now(), config.webhook.rateLimit, RATE_WINDOW_MS)) {
        log_.warn({ ip, limit: config.webhook.rateLimit }, 'webhook rate limit exceeded');
        try { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('rate limited'); } catch {}
        return;
      }
    }
    router(req, res, depsWithCoalescer).catch(e => {
      log_.error({ err: e?.message }, 'unhandled webhook error');
      try { res.writeHead(500); res.end(); } catch {}
    });
  });

  server.listen(config.webhook.port, config.webhook.bind, () => {
    log_.info(
      { bind: config.webhook.bind, port: config.webhook.port, secret: !!config.seerr.webhookSecret },
      'webhook listening',
    );
  });

  return () => { coalescer.dispose(); server.close(); };
}

export async function router(req: IM, res: ServerResponse, deps: WebhookDeps): Promise<void> {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  if (req.method === 'POST' && path === '/webhook') {
    await handleSeerrWebhook(req, res, deps);
    return;
  }

  if (path === '/dashboard' || path.startsWith('/dashboard/') || path.startsWith('/api/')) {
    maybeSetTokenCookie(req, res, config.dashboard.token);
    const gate = authGate(req, res, config.dashboard.token);
    if (!gate.ok) {
      res.writeHead(gate.status, { 'content-type': 'text/plain' });
      res.end(gate.body);
      return;
    }
    await dashboardRoute(req, res, {
      store: deps.store,
      seerr: deps.seerr,
      syncthing: deps.syncthing,
      getConnectionStatus: deps.getConnectionStatus,
      syncthingFolders: config.syncthing.folders,
      send: (to, content) => deps.send(to, content),
      drainPending: deps.drainPending ?? (async () => {}),
      reconnectWa: deps.reconnectWa ?? (async () => {}),
      shutdown: deps.shutdown ?? (() => {}),
    });
    return;
  }

  res.writeHead(404).end();
}

async function handleSeerrWebhook(req: IM, res: ServerResponse, deps: WebhookDeps): Promise<void> {
  if (config.seerr.webhookSecret) {
    const got = req.headers['x-webhook-secret'];
    if (got !== config.seerr.webhookSecret) {
      log_.warn({ remote: req.socket.remoteAddress }, 'webhook secret mismatch');
      res.writeHead(401).end();
      return;
    }
  }

  const body = await readBody(req);
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400).end('invalid json');
    return;
  }

  const notif = payload.notification_type as string | undefined;
  log_.info({ notif }, 'webhook received');

  if (notif === 'MEDIA_AVAILABLE') {
    const mediaType = payload.media?.media_type as string | undefined;
    const tmdbId = Number(payload.media?.tmdbId);
    if (!mediaType || !Number.isFinite(tmdbId)) {
      log_.warn({ payload }, 'MEDIA_AVAILABLE missing media fields');
      res.writeHead(202).end();
      return;
    }
    const title = payload.subject ?? payload.media?.name ?? '(unknown)';
    if (deps.coalescer) {
      // Production path: buffer under the coalescer; the fan-out fires when the
      // window elapses. Returning 200 immediately is the correct Seerr ack.
      deps.coalescer.enqueue({ mediaType, tmdbId, title });
    } else {
      // No coalescer (e.g. a router() test that injects none) degrades to an
      // immediate, awaited fan-out — no throwaway timer to arm and cancel.
      await notifyReady(deps, { mediaType, tmdbId, title });
    }
  }

  res.writeHead(200).end();
}

// Fan-out a single ready event to every active subscriber for the media, then
// mark them notified so a repeat MEDIA_AVAILABLE does not re-notify (auto-clear).
async function notifyReady(deps: WebhookDeps, ev: ReadyEvent): Promise<void> {
  const { send, store } = deps;
  let subs = store.findActiveSubscribers(ev.mediaType, ev.tmdbId);

  if (subs.length === 0) {
    // Back-compat: requests made BEFORE this feature have no subscription row.
    // Gate the audit-based fallback on hasAnySubscription so it fires ONLY for
    // genuinely pre-migration media. Otherwise a post-feature request (which
    // wrote a subscription row that we have already marked notified) would be
    // re-notified via findRequester on every later MEDIA_AVAILABLE window — the
    // audit row stays status='queued' on the success path, so findRequester
    // would keep matching it and defeat auto-clear. See QA HIGH finding.
    if (store.hasAnySubscription(ev.mediaType, ev.tmdbId)) {
      // Already-notified subscriptions exist; nothing active left to notify.
      return;
    }
    const r = store.findRequester(ev.mediaType, ev.tmdbId);
    if (!r) { log_.warn({ mediaType: ev.mediaType, tmdbId: ev.tmdbId }, 'no subscriber/audit for ready'); return; }
    subs = [{ id: -1, subscriberJid: r.senderJid, subscriberNumber: r.senderNumber, groupJid: r.groupJid, seasons: null }];
  }

  // Dedup by subscriberJid (someone could hold S1 + S2 subs). Earliest row wins
  // for routing (group-origin preserved, since findActiveSubscribers is ordered
  // created_at ASC); merge season lists; collect all ids.
  type Merged = { subscriberNumber: string; groupJid: string | null; seasons: 'all' | number[] | null; ids: number[] };
  const byJid = new Map<string, Merged>();
  for (const sub of subs) {
    const existing = byJid.get(sub.subscriberJid);
    if (!existing) {
      byJid.set(sub.subscriberJid, {
        subscriberNumber: sub.subscriberNumber,
        groupJid: sub.groupJid,
        seasons: sub.seasons,
        ids: [sub.id],
      });
    } else {
      existing.ids.push(sub.id);
      existing.seasons = mergeSeasons(existing.seasons, sub.seasons);
    }
  }

  // Mark notified UP FRONT (before the await send loop) so that a concurrent
  // re-flush of the same media — e.g. a second MEDIA_AVAILABLE enqueued while a
  // send is still in flight — sees zero active subscribers and does not double-
  // send. On send failure the message still lands in enqueuePending below, so
  // nothing is lost. Synthetic id -1 (findRequester fallback) owns no real row.
  const idsToMark = [...byJid.values()].flatMap(m => m.ids.filter(id => id >= 0));
  store.markSubscriptionsNotified(idsToMark);  // no-op on empty (auto-clear)

  // Compute the cross-server "where is it" clause once for this event (one
  // Syncthing call, not one per subscriber). Best-effort; '' if unavailable.
  const crossServer = await crossServerStatus(deps);

  for (const [subscriberJid, m] of byJid) {
    // Route to the group only when we have a usable phone-number JID to @mention.
    // A LID-degraded subscriber (subscriber_jid ending in '@lid', captured when a
    // LID→PN mapping was unresolved at request time) would surface a meaningless
    // numeric prefix in the group, so fall back to a DM with no mention prefix.
    const isLid = subscriberJid.endsWith('@lid');
    const groupJid = isLid ? null : m.groupJid;
    const target = groupJid ?? subscriberJid;
    const text = buildReadyText(ev.title, groupJid, m.subscriberNumber, m.seasons, crossServer);
    const mentions = groupJid ? [subscriberJid] : undefined;
    try {
      await send(target, { text, mentions });
      log_.info({ to: target, title: ev.title, inGroup: !!groupJid }, 'ready notification sent');
    } catch (e: any) {
      // Same failure path as the dashboard/handler send: persist for drain.
      store.enqueuePending(target, text, mentions);
      log_.error({ err: e?.message, to: target }, 'ready notification send hard-failed; enqueued');
    }
  }

  // SHOULD #6 (deferred): "new season beyond original request" detection would
  // diff TMDb numberOfSeasons over time here. Out of scope for this fan-out.
  // NOTE (best-effort, bounded): season-list subscriptions (seasons=number[]) are
  // matched and cleared on ANY MEDIA_AVAILABLE for the tmdbId — the default Seerr
  // template carries no reliable per-season signal — so the wording reflects what
  // the subscriber requested, not necessarily the exact season that just landed.
}

// Merge two stored season selections. 'all' subsumes everything; otherwise union
// the explicit season lists.
function mergeSeasons(a: 'all' | number[] | null, b: 'all' | number[] | null): 'all' | number[] | null {
  if (a === 'all' || b === 'all') return 'all';
  if (a == null) return b;
  if (b == null) return a;
  const set = new Set<number>([...a, ...b]);
  return [...set].sort((x, y) => x - y);
}

// Ready-notification wording. Common case (movie / TV 'all' / null) is unchanged
// from the original inline text. Specific TV seasons get a "(season(s) …)" clause
// from the stored subscription (SHOULD #4) — not derived from the webhook payload.
export function buildReadyText(
  title: string,
  groupJid: string | null,
  subscriberNumber: string,
  seasons: 'all' | number[] | null,
  crossServer = '',   // optional cross-server sync clause (computed in notifyReady)
): string {
  let detail = '';
  if (Array.isArray(seasons) && seasons.length > 0) {
    const s = seasons.length === 1 ? '' : 's';
    detail = ` (season${s} ${seasons.join(', ')})`;
  }
  const base = groupJid
    ? `@${subscriberNumber} ${title}${detail} is now ready on Plex.`
    : `${title}${detail} is now ready on Plex.`;
  return crossServer ? `${base} ${crossServer}` : base;
}

// Best-effort "where is it" line for the ready ping: a download lands on the
// local Plex first, then Syncthing replicates it to the remote (US) box. We
// report the remote's folder-level completion (Syncthing has no reliable
// per-title signal). Empty string when Syncthing is unconfigured/unreachable —
// the ping always sends regardless.
async function crossServerStatus(deps: WebhookDeps): Promise<string> {
  const st = deps.syncthing;
  if (!st?.isConfigured?.()) return '';
  try {
    const c = await st.getCompletion();
    if (!c) return '';
    const label = config.syncthing.remoteLabel || 'remote';
    if (c.completion >= 100 || c.needBytes === 0) return `✓ Synced to ${label} too.`;
    const pct = Math.max(0, Math.min(100, Math.floor(c.completion)));
    return `⏳ Still syncing to ${label} (${pct}%, ${c.needItems} item${c.needItems === 1 ? '' : 's'} left).`;
  } catch (e: any) {
    log_.warn({ err: e?.message }, 'cross-server status for ready ping failed (non-fatal)');
    return '';
  }
}

function readBody(req: IM): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1_000_000) reject(new Error('body too large')); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
