import makeWASocket, {
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  jidNormalizedUser,
  isJidGroup,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { config } from './config.ts';
import { log } from './log.ts';
import { Store } from './state/store.ts';
import * as seerr from './seerr/client.ts';
import * as syncthing from './syncthing/client.ts';
import * as arr from './arr/client.ts';
import { handleMessage, type IncomingMessage as InMsg } from './handler.ts';
import { startWebhook } from './webhook.ts';
import { sendWithRetry, isTransientSendError } from './sender.ts';
import { syncWatchlists } from './watchlist/sync.ts';
import { makePlexClient, type PlexClient } from './watchlist/plex.ts';
import { isAllowedGroup } from './auth/groups.ts';
import { hasFilmLink } from './links.ts';

const log_ = log.child({ mod: 'index' });

// Pass-free Plex watchlist reader — only built when an owner token is set. One
// token reads the owner's own + friends' watchlists; shared by the poller and
// the !watchlist add plex-friend validation.
const plexClient: PlexClient | undefined = config.plex.token
  ? makePlexClient({
      token: config.plex.token,
      clientId: config.plex.clientId,
      discoverHost: config.plex.discoverHost,
      communityHost: config.plex.communityHost,
    })
  : undefined;

const MAX_PENDING_ATTEMPTS = 8;     // ~ minutes of retries before we give up
const DRAIN_INTERVAL_MS = 60_000;   // safety net in case 'open' event was missed
const SUBSCRIPTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;  // reap notified subs after 30d

// Failed-request retry policy. Seerr marks requests Failed when its axios
// call to Sonarr times out (10s hardcoded in Seerr; Sonarr's own skyhook call
// occasionally spikes to 14s+). Retry the original request via Seerr's
// /retry endpoint with exponential backoff. Most retries succeed because
// skyhook recovers within minutes.
const RETRY_INTERVAL_MS = 60_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];  // before attempt N (0-indexed)

// Delay the first watchlist poll after connect so startup isn't competing with
// history sync / drain; the configured interval governs every poll after that.
const WATCHLIST_INITIAL_DELAY_MS = 10_000;
// Reap watchlist_item seen-rows older than this (re-seeing just re-requests,
// absorbed by the availability check) to keep the table bounded.
const WATCHLIST_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

let stopWebhook: (() => void) | null = null;
let store: Store | null = null;
let currentSock: WASocket | null = null;
let drainTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let watchlistTimer: NodeJS.Timeout | null = null;
const startTime = Date.now();
const getConnectionStatus = () => ({
  connected: currentSock !== null,
  uptimeSec: Math.floor((Date.now() - startTime) / 1000),
});

async function start(): Promise<void> {
  if (!store) store = new Store(config.storage.dbPath);

  const { state, saveCreds } = await useMultiFileAuthState(config.storage.authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log_.info({ version, isLatest }, 'starting baileys');

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
    // Skip the slow / unreliable history sync that was causing AwaitingInitialSync
    // to time out every ~4 min and force a code-408 reconnect. We don't need
    // backfill — bot only reacts to new messages.
    syncFullHistory: false,
    // Default is true, but make it explicit so future changes don't accidentally
    // flip it. Tells WA to route new messages to us, not just to the phone.
    markOnlineOnConnect: true,
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      log_.info({ user: sock.user?.id }, 'connected');
      if (!stopWebhook) {
        stopWebhook = startWebhook({
          send: (jid, content) => sendViaCurrentSock(jid, content),
          store: store!,
          seerr,
          syncthing,
          getConnectionStatus,
          drainPending,
          reconnectWa,
          shutdown: requestShutdown,
        });
      }
      // periodic state cleanup
      setInterval(() => {
        store!.cleanupExpiredState();
        // Bound retention of subscriber identifiers: drop subscriptions notified
        // more than 30 days ago (active rows are never reaped).
        store!.reapNotifiedSubscriptions(Date.now() - SUBSCRIPTION_RETENTION_MS);
        // Bound the watchlist seen-set the same way.
        store!.reapWatchlistItems(Date.now() - WATCHLIST_RETENTION_MS);
      }, 60_000).unref();
      // drain any notifications that piled up while we were disconnected
      drainPending().catch(e => log_.error({ err: e?.message }, 'drain on open failed'));
      if (!drainTimer) {
        drainTimer = setInterval(
          () => drainPending().catch(e => log_.error({ err: e?.message }, 'periodic drain failed')),
          DRAIN_INTERVAL_MS,
        );
        drainTimer.unref();
      }
      if (!retryTimer) {
        retryTimer = setInterval(
          () => retryFailedRequests().catch(e => log_.error({ err: e?.message }, 'periodic retry failed')),
          RETRY_INTERVAL_MS,
        );
        retryTimer.unref();
      }
      // Watchlist auto-sync. Runs on its own cadence — independent of WA traffic —
      // but is started here so it shares the connected lifecycle. Started whenever
      // polling is enabled (pollMinutes > 0), since members can add feeds at
      // runtime via !watchlist even when no feeds exist at boot. An initial kick
      // fires shortly after connect, then on the configured interval.
      if (!watchlistTimer && config.watchlist.pollMinutes > 0) {
        setTimeout(
          () => runWatchlistSync().catch(e => log_.error({ err: e?.message }, 'initial watchlist sync failed')),
          WATCHLIST_INITIAL_DELAY_MS,
        ).unref();
        watchlistTimer = setInterval(
          () => runWatchlistSync().catch(e => log_.error({ err: e?.message }, 'periodic watchlist sync failed')),
          config.watchlist.pollMinutes * 60_000,
        );
        watchlistTimer.unref();
      }
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log_.warn({ code, shouldReconnect }, 'disconnected');
      if (shouldReconnect) {
        setTimeout(() => start().catch(e => log_.error({ err: e?.message }, 'reconnect failed')), 2000);
      } else {
        log_.fatal('logged out — re-pair via npm run discover');
        process.exit(1);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await processMessage(sock, m);
      } catch (e: any) {
        log_.error({ err: e?.message }, 'processMessage threw');
      }
    }
  });
}

// Resolves a participant JID to its phone-number form. If the raw JID is already
// a PN (`@s.whatsapp.net`), returns it unchanged. If it's a LID (`@lid`), first
// tries `participantAlt` from the message key (Baileys' fast path), then falls
// back to `signalRepository.lidMapping.getPNForLID()`. Returns the original LID
// JID if no PN mapping is known — better to deliver with a cosmetic-only flaw
// than to drop the message.
async function resolveSenderPnJid(
  sock: WASocket,
  raw: string,
  participantAlt: string | undefined,
): Promise<string> {
  if (!raw.endsWith('@lid')) return raw;
  if (participantAlt) return participantAlt;
  try {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(raw);
    if (pn) return pn;
  } catch (e: any) {
    log_.warn({ lid: raw, err: e?.message }, 'lidMapping.getPNForLID threw');
  }
  log_.debug({ lid: raw }, 'no PN mapping for LID; degrading to LID JID');
  return raw;
}

async function processMessage(sock: WASocket, m: WAMessage): Promise<void> {
  if (m.key.fromMe) return;
  const text = extractText(m);
  if (!text) return;
  const remoteJid = m.key.remoteJid;
  if (!remoteJid) return;

  const isGroup = isJidGroup(remoteJid);
  const senderJidRaw = isGroup ? m.key.participant : remoteJid;
  if (!senderJidRaw) return;
  // In LID-addressed groups, m.key.participant is a `@lid` identity. We need the
  // phone-number JID for auth (isAdmin), self-DM-skip, and the mention prefix.
  // Baileys puts the PN in m.key.participantAlt when known; if missing, look it
  // up via the signal repository's LID↔PN cache. Fall back to the raw JID — that
  // keeps the message flowing even if the mapping isn't resolvable yet (cosmetic
  // degradation only).
  const senderJid = jidNormalizedUser(await resolveSenderPnJid(sock, senderJidRaw, m.key.participantAlt));
  const senderNumber = senderJid.split('@')[0]!.split(':')[0]!;

  const inMsg: InMsg = {
    fromJid: remoteJid,
    senderJid,
    senderNumber,
    text,
    isGroup: !!isGroup,
    quotedText: extractQuotedText(m),
  };

  const replies = await handleMessage({ store: store!, seerr, syncthing, shutdown: requestShutdown, plex: plexClient, arr }, inMsg);
  for (const r of replies) {
    await sendReply(sock, r);
  }

  // Ambient film-link signal: react 🎬 to a freshly-shared Letterboxd link so a
  // member can quote-reply `q` to queue it — a quiet, ignorable nudge, never a
  // chat reply. Best-effort; transient (nothing stored).
  await maybeReactFilmLink(sock, m, inMsg);
}

// Text of the quoted message when this is a quote-reply (used for the film-link
// queue confirm). Mirrors extractText for the quoted payload.
function extractQuotedText(m: WAMessage): string | undefined {
  // Unwrap both layers (the carrier and the quoted payload) so quote-replies work
  // under disappearing/view-once messages too.
  const outer = normalizeMessageContent(m.message);
  const q = normalizeMessageContent(outer?.extendedTextMessage?.contextInfo?.quotedMessage);
  if (!q) return undefined;
  return q.conversation
    ?? q.extendedTextMessage?.text
    ?? q.imageMessage?.caption
    ?? q.videoMessage?.caption
    ?? undefined;
}

async function maybeReactFilmLink(sock: WASocket, m: WAMessage, inMsg: InMsg): Promise<void> {
  try {
    if (!inMsg.isGroup || !isAllowedGroup(inMsg.fromJid)) return;
    if (inMsg.text.startsWith(config.whatsapp.commandPrefix)) return;  // a command, not a share
    if (inMsg.quotedText) return;                                       // a quote-reply, not a fresh share
    if (!hasFilmLink(inMsg.text)) return;
    if (store!.isLinksOptedOut(inMsg.senderNumber)) return;
    await sock.sendMessage(inMsg.fromJid, { react: { text: '🎬', key: m.key } });
  } catch (e: any) {
    log_.debug({ err: e?.message }, 'film-link react failed (non-fatal)');
  }
}

async function sendReply(sock: WASocket, r: { to: string; text: string; mentions?: string[]; imageUrl?: string }): Promise<void> {
  if (r.imageUrl) {
    try {
      await sendWithRetry(sock, r.to, { image: { url: r.imageUrl }, caption: r.text, mentions: r.mentions });
      return;
    } catch (e: any) {
      log_.warn({ err: e?.message, to: r.to, imageUrl: r.imageUrl }, 'image send failed, falling back to text');
    }
  }
  try {
    await sendWithRetry(sock, r.to, { text: r.text, mentions: r.mentions });
  } catch (e: any) {
    log_.error({ err: e?.message, to: r.to }, 'sendMessage failed after retry');
  }
}

// Webhook delivery path. Tries to send via the live socket with retry; if that
// fails transiently (socket bouncing), enqueues for drain on next 'open'.
// Hard failures (e.g. bad JID) are logged and dropped — retrying won't help.
async function sendViaCurrentSock(to: string, content: { text: string; mentions?: string[] }): Promise<unknown> {
  if (!currentSock) {
    store!.enqueuePending(to, content.text, content.mentions);
    log_.warn({ to }, 'no socket; enqueued pending notification');
    return null;
  }
  try {
    await sendWithRetry(currentSock, to, content);
    return null;
  } catch (e: any) {
    if (isTransientSendError(e)) {
      store!.enqueuePending(to, content.text, content.mentions);
      log_.warn({ err: e?.message, to }, 'send failed transiently; enqueued for drain');
      return null;
    }
    throw e;
  }
}

async function drainPending(): Promise<void> {
  if (!store) return;
  if (!currentSock) return;
  const reaped = store.reapDeadPending(MAX_PENDING_ATTEMPTS);
  if (reaped > 0) log_.warn({ reaped, maxAttempts: MAX_PENDING_ATTEMPTS }, 'dropped dead pending notifications');
  const pending = store.listPending(50);
  if (pending.length === 0) return;
  log_.info({ count: pending.length }, 'draining pending notifications');
  for (const p of pending) {
    try {
      await sendWithRetry(currentSock, p.targetJid, { text: p.text, mentions: p.mentions });
      store.deletePending(p.id);
      log_.info({ id: p.id, to: p.targetJid }, 'pending notification delivered');
    } catch (e: any) {
      store.markPendingFailed(p.id, e?.message ?? String(e));
      log_.warn({ id: p.id, err: e?.message, attempts: p.attempts + 1 }, 'pending notification still failing');
      // socket likely dropped again — stop the loop, next 'open' will retry
      if (isTransientSendError(e)) break;
    }
  }
}

// Re-queue Seerr requests that landed as 'failed' (typically due to Seerr's
// 10s axios timeout on the Sonarr push, when Sonarr's downstream skyhook
// call exceeds it). Each row gets up to RETRY_MAX_ATTEMPTS retries with
// exponential backoff. On HTTP-level success we optimistically flip the audit
// back to 'queued' so the eventual MEDIA_AVAILABLE webhook can find the
// requester. Persistent-failure case (retry succeeds at HTTP but Sonarr
// re-fails downstream) is a known gap — user can fall back to !queue.
async function retryFailedRequests(): Promise<void> {
  if (!store) return;
  if (!currentSock) return;
  const candidates = store.listFailedForRetry(RETRY_MAX_ATTEMPTS, RETRY_BACKOFF_MS);
  if (candidates.length === 0) return;
  log_.info({ count: candidates.length }, 'retrying failed seerr requests');
  for (const c of candidates) {
    try {
      await seerr.retryRequest(c.seerrRequestId);
      store.markRetrySucceeded(c.auditId);
      log_.info({ auditId: c.auditId, seerrId: c.seerrRequestId, attempt: c.attempts + 1 }, 'retry succeeded');
    } catch (e: any) {
      store.markRetryFailed(c.auditId);
      log_.warn({ auditId: c.auditId, seerrId: c.seerrRequestId, attempt: c.attempts + 1, err: e?.message }, 'retry call failed');
    }
  }
}

// Poll configured Plex Watchlist / Letterboxd list feeds and auto-request new
// items through the shared request path. Does not need the WA socket (it talks
// to Seerr); the eventual "now ready" DM rides the normal webhook fan-out.
async function runWatchlistSync(): Promise<void> {
  if (!store) return;
  // syncWatchlists merges env + DB feeds + Pass-free Plex (friends) sources and
  // returns early if none.
  await syncWatchlists({ store, seerr, plex: plexClient });
}

function extractText(m: WAMessage): string {
  // normalizeMessageContent peels Baileys wrappers (ephemeral / view-once /
  // documentWithCaption / edited) so text isn't missed in disappearing-message
  // groups — without it, ALL command + link handling silently no-ops there.
  const msg = normalizeMessageContent(m.message);
  if (!msg) return '';
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    ''
  );
}

// Triggered from POST /api/commands {name: 'reconnect_wa'}. Closes the current
// Baileys socket (if any) and re-runs start() on the next tick. The existing
// 'connection.update' close handler also schedules a reconnect, but this
// closure handles the case where the socket is in some half-open state where
// no 'close' fires.
const reconnectWa = async (): Promise<void> => {
  if (currentSock) {
    try { currentSock.end(new Error('manual reconnect')); } catch {}
    currentSock = null;
  }
  setTimeout(() => start().catch(e => log_.error({ err: e?.message }, 'reconnect failed')), 1000);
};

function requestShutdown(): void {
  log_.info('graceful shutdown requested');
  try { store?.close(); } catch (e: any) { log_.warn({ err: e?.message }, 'store.close on shutdown threw'); }
  try { stopWebhook?.(); } catch (e: any) { log_.warn({ err: e?.message }, 'stopWebhook on shutdown threw'); }
  // Exit with 0 — NSSM is configured to auto-restart regardless of exit code.
  process.exit(0);
}

process.on('SIGINT', () => { log_.info('SIGINT received, shutting down'); requestShutdown(); });
process.on('SIGTERM', () => { log_.info('SIGTERM received, shutting down'); requestShutdown(); });

start().catch(e => { log_.fatal({ err: e?.message }, 'startup failed'); process.exit(1); });
