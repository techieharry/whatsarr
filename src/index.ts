import makeWASocket, {
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  jidNormalizedUser,
  isJidGroup,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { config } from './config.ts';
import { log } from './log.ts';
import { Store } from './state/store.ts';
import * as seerr from './seerr/client.ts';
import * as syncthing from './syncthing/client.ts';
import { handleMessage, type IncomingMessage as InMsg } from './handler.ts';
import { startWebhook } from './webhook.ts';
import { sendWithRetry, isTransientSendError } from './sender.ts';

const log_ = log.child({ mod: 'index' });

const MAX_PENDING_ATTEMPTS = 8;     // ~ minutes of retries before we give up
const DRAIN_INTERVAL_MS = 60_000;   // safety net in case 'open' event was missed

let stopWebhook: (() => void) | null = null;
let store: Store | null = null;
let currentSock: WASocket | null = null;
let drainTimer: NodeJS.Timeout | null = null;

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
        stopWebhook = startWebhook(
          (jid, content) => sendViaCurrentSock(jid, content),
          store!,
        );
      }
      // periodic state cleanup
      setInterval(() => store!.cleanupExpiredState(), 60_000).unref();
      // drain any notifications that piled up while we were disconnected
      drainPending().catch(e => log_.error({ err: e?.message }, 'drain on open failed'));
      if (!drainTimer) {
        drainTimer = setInterval(
          () => drainPending().catch(e => log_.error({ err: e?.message }, 'periodic drain failed')),
          DRAIN_INTERVAL_MS,
        );
        drainTimer.unref();
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

async function processMessage(sock: WASocket, m: WAMessage): Promise<void> {
  if (m.key.fromMe) return;
  const text = extractText(m);
  if (!text) return;
  const remoteJid = m.key.remoteJid;
  if (!remoteJid) return;

  const isGroup = isJidGroup(remoteJid);
  const senderJidRaw = isGroup ? m.key.participant : remoteJid;
  if (!senderJidRaw) return;
  const senderJid = jidNormalizedUser(senderJidRaw);
  const senderNumber = senderJid.split('@')[0]!.split(':')[0]!;

  const inMsg: InMsg = {
    fromJid: remoteJid,
    senderJid,
    senderNumber,
    text,
    isGroup: !!isGroup,
  };

  const replies = await handleMessage({ store: store!, seerr, syncthing }, inMsg);
  for (const r of replies) {
    await sendReply(sock, r);
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

function extractText(m: WAMessage): string {
  const msg = m.message;
  if (!msg) return '';
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    ''
  );
}

process.on('SIGINT', () => { log_.info('SIGINT received, shutting down'); store?.close(); stopWebhook?.(); process.exit(0); });
process.on('SIGTERM', () => { log_.info('SIGTERM received, shutting down'); store?.close(); stopWebhook?.(); process.exit(0); });

start().catch(e => { log_.fatal({ err: e?.message }, 'startup failed'); process.exit(1); });
