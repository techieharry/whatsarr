import { createServer, type IncomingMessage as IM, type ServerResponse } from 'node:http';
import { config } from './config.ts';
import { log } from './log.ts';
import type { Store } from './state/store.ts';
import * as seerrModule from './seerr/client.ts';
import * as syncthingModule from './syncthing/client.ts';
import { authGate, maybeSetTokenCookie } from './dashboard/auth.ts';
import { dashboardRoute } from './dashboard/routes.ts';

const log_ = log.child({ mod: 'webhook' });

type SendFn = (jid: string, content: { text: string; mentions?: string[] }) => Promise<unknown>;

export type WebhookDeps = {
  send: SendFn;
  store: Store;
  seerr: typeof seerrModule;
  syncthing: typeof syncthingModule;
  getConnectionStatus: () => { connected: boolean; uptimeSec: number };
  drainPending?: () => Promise<void>;
  reconnectWa?: () => Promise<void>;
  shutdown?: () => void;
};

export function startWebhook(deps: WebhookDeps): () => void {
  if (!config.webhook.enabled) {
    log_.info('webhook disabled');
    return () => {};
  }

  const server = createServer((req, res) => {
    router(req, res, deps).catch(e => {
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
  const { send, store } = deps;
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
