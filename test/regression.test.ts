import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Regression: a REAL request writes BOTH a queued audit row AND a subscription
// row, and a second MEDIA_AVAILABLE for the same media must NOT re-notify (the
// findRequester fallback must stay quiet once a subscription row exists).

process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.ADMIN_NUMBERS = '+15555550100';
process.env.COMMAND_PREFIX = '!';
process.env.REQUESTS_PER_DAY = '5';
process.env.WEBHOOK_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.DASHBOARD_TOKEN = 'secret-test-token';
process.env.SEERR_WEBHOOK_SECRET = '';

const { Store } = await import('../src/state/store.ts');
const { router } = await import('../src/webhook.ts');

function mkReq(opts: { mediaType: string; tmdbId: number; subject: string }) {
  const body = JSON.stringify({
    notification_type: 'MEDIA_AVAILABLE',
    subject: opts.subject,
    media: { media_type: opts.mediaType, tmdbId: opts.tmdbId, name: opts.subject },
  });
  return {
    url: '/webhook',
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event: string, cb: (...args: any[]) => void) {
      queueMicrotask(() => { if (event === 'data') cb(body); });
      queueMicrotask(() => queueMicrotask(() => { if (event === 'end') cb(); }));
    },
  } as any;
}

function mkRes() {
  const res: any = {
    statusCode: 0, headers: {}, body: '', ended: false,
    writeHead(s: number, h?: Record<string, string>) { res.statusCode = s; if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v; return res; },
    end(b?: string) { if (b !== undefined) res.body = b; res.ended = true; },
    setHeader(n: string, v: string) { res.headers[n.toLowerCase()] = v; },
  };
  return res;
}

function mkDeps(store: any, calls: any[]): any {
  return {
    store,
    send: async (to: string, content: any) => { calls.push({ to, content }); return null; },
    seerr: {} as any,
    syncthing: { isConfigured: () => false, getCompletion: async () => null, getFolderStatus: async () => null },
    getConnectionStatus: () => ({ connected: true, uptimeSec: 1 }),
  };
}

test('regression(HIGH): real request (queued audit + subscription) does not re-notify on a 2nd MEDIA_AVAILABLE', async () => {
  const store = new Store(':memory:');
  // Mirror exactly what handler.ts writes on a successful createRequest:
  store.audit({ senderJid: 'u@s.whatsapp.net', senderNumber: '1', groupJid: null, command: 'movie x', seerrMediaType: 'movie', seerrMediaId: 901, seerrRequestId: 555, status: 'queued' });
  store.addSubscription({ subscriberJid: 'u@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 901, seasons: null });

  const calls: any[] = [];
  const deps = mkDeps(store, calls);

  await router(mkReq({ mediaType: 'movie', tmdbId: 901, subject: 'X' }), mkRes(), deps);
  assert.equal(calls.length, 1);  // first window notifies the subscription

  // Second window (Seerr legitimately re-fires later). The subscription is now
  // marked notified; the findRequester fallback must NOT fire because a
  // subscription row exists (status='queued' audit notwithstanding).
  await router(mkReq({ mediaType: 'movie', tmdbId: 901, subject: 'X' }), mkRes(), deps);
  assert.equal(calls.length, 1);  // NOT re-notified
  store.close();
});
