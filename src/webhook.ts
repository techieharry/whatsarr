import { createServer, type IncomingMessage as IM, type ServerResponse } from 'node:http';
import { config } from './config.ts';
import { log } from './log.ts';
import type { Store } from './state/store.ts';

const log_ = log.child({ mod: 'webhook' });

type SendFn = (jid: string, content: { text: string; mentions?: string[] }) => Promise<unknown>;

export function startWebhook(send: SendFn, store: Store): () => void {
  if (!config.webhook.enabled) {
    log_.info('webhook disabled');
    return () => {};
  }

  const server = createServer((req, res) => {
    handle(req, res, send, store).catch(e => {
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

  return () => server.close();
}

async function handle(req: IM, res: ServerResponse, send: SendFn, store: Store) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end();
    return;
  }
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
    const requester = store.findRequester(mediaType, tmdbId);
    if (!requester) {
      log_.warn({ mediaType, tmdbId }, 'no audit row for ready notification');
      res.writeHead(202).end();
      return;
    }
    const title = payload.subject ?? payload.media?.name ?? '(unknown)';
    const target = requester.groupJid ?? requester.senderJid;
    const text = requester.groupJid
      ? `@${requester.senderNumber} ${title} is now ready on Plex.`
      : `${title} is now ready on Plex.`;
    const mentions = requester.groupJid ? [requester.senderJid] : undefined;
    try {
      await send(target, { text, mentions });
      log_.info({ to: target, title, inGroup: !!requester.groupJid }, 'ready notification sent');
    } catch (e: any) {
      // The injected `send` already retries + enqueues on transient failure.
      // If we land here it's a non-transient send error (e.g. unknown JID).
      // Last-ditch: enqueue anyway so it survives a restart and can be drained
      // when the situation changes.
      store.enqueuePending(target, text, mentions);
      log_.error({ err: e?.message, to: target }, 'ready notification send hard-failed; enqueued');
    }
  }

  res.writeHead(200).end();
}

function readBody(req: IM): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1_000_000) reject(new Error('body too large')); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
