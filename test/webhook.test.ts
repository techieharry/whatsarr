import { test } from 'node:test';
import { strict as assert } from 'node:assert';

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
const { router, makeCoalescer, buildReadyText } = await import('../src/webhook.ts');

const GROUP = '120363111111111111@g.us';

// ---- MockReq/MockRes/fakeSeerr harness (mirrors dashboard.test.ts) ----

function mkReq(opts: { url: string; method?: string; body?: string; headers?: Record<string, any>; remote?: string }) {
  const body = opts.body;
  const req: any = {
    url: opts.url,
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
    on(event: string, cb: (...args: any[]) => void) {
      queueMicrotask(() => { if (event === 'data' && body !== undefined) cb(body); });
      queueMicrotask(() => queueMicrotask(() => { if (event === 'end') cb(); }));
    },
  };
  return req;
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v;
      return res;
    },
    end(body?: string) { if (body !== undefined) res.body = body; res.ended = true; },
    setHeader(name: string, value: string) { res.headers[name.toLowerCase()] = value; },
  };
  return res;
}

function fakeSeerr() {
  return {
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    search: async () => [],
    createRequest: async () => ({ id: 1 }),
    getMediaInfo: async () => null,
    getTvDetails: async () => ({ numberOfSeasons: 1, seasons: [] }),
    listPendingRequests: async () => [],
    approveRequest: async () => ({ id: 1 }),
    declineRequest: async () => ({ id: 1 }),
    retryRequest: async () => ({ id: 1 }),
  } as any;
}

// Capturing send spy. throwFor makes a specific target's send hard-fail.
function makeSend(opts: { throwFor?: string } = {}) {
  const calls: { to: string; content: { text: string; mentions?: string[] } }[] = [];
  const send = async (to: string, content: { text: string; mentions?: string[] }) => {
    if (opts.throwFor && to === opts.throwFor) throw new Error('send boom');
    calls.push({ to, content });
    return null;
  };
  return { send, calls };
}

function mkDeps(store: any, send: any): any {
  return {
    store,
    send,
    seerr: fakeSeerr(),
    syncthing: { isConfigured: () => false, getCompletion: async () => null, getFolderStatus: async () => null },
    getConnectionStatus: () => ({ connected: true, uptimeSec: 1 }),
    drainPending: async () => {},
    reconnectWa: async () => {},
    shutdown: () => {},
    // No coalescer: router() lazily makes a windowMs:0 one → immediate flush →
    // production notifyReady runs synchronously within the request. This drives
    // the real fan-out path without exporting internals.
  };
}

// deps with a configured Syncthing returning a fixed completion (cross-server ping)
function mkDepsSync(store: any, send: any, completion: any): any {
  const d = mkDeps(store, send);
  d.syncthing = { isConfigured: () => true, getCompletion: async () => completion, getFolderStatus: async () => null };
  return d;
}

function mediaAvailableReq(mediaType: string, tmdbId: number, subject: string) {
  return mkReq({
    url: '/webhook',
    method: 'POST',
    remote: '127.0.0.1',
    body: JSON.stringify({
      notification_type: 'MEDIA_AVAILABLE',
      subject,
      media: { media_type: mediaType, tmdbId, name: subject },
    }),
  });
}

// ----------------- buildReadyText unit -----------------

test('buildReadyText: group movie → @mention + plain ready text', () => {
  assert.equal(buildReadyText('Dune', GROUP, '15551234567', null), '@15551234567 Dune is now ready on Plex.');
});

test('buildReadyText: DM movie → plain text, no mention', () => {
  assert.equal(buildReadyText('Dune', null, '15551234567', null), 'Dune is now ready on Plex.');
});

test('buildReadyText: TV all/null → no season clause', () => {
  assert.equal(buildReadyText('Show', null, '1', 'all'), 'Show is now ready on Plex.');
  assert.equal(buildReadyText('Show', null, '1', null), 'Show is now ready on Plex.');
});

test('buildReadyText: TV specific seasons → (season(s) …) clause', () => {
  assert.equal(buildReadyText('Show', null, '1', [2]), 'Show (season 2) is now ready on Plex.');
  assert.equal(buildReadyText('Show', GROUP, '99', [1, 3]), '@99 Show (seasons 1, 3) is now ready on Plex.');
});

test('buildReadyText: appends the cross-server clause when provided (empty = unchanged)', () => {
  assert.equal(buildReadyText('Dune', null, '1', null, '⏳ Still syncing to US (98%, 3 items left).'),
    'Dune is now ready on Plex. ⏳ Still syncing to US (98%, 3 items left).');
  assert.equal(buildReadyText('Dune', null, '1', null, ''), 'Dune is now ready on Plex.');
});

// ----------------- cross-server ready ping (Syncthing) -----------------

test('webhook: ready ping appends cross-server status — pending sync to remote', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 301, seasons: null });
  const { send, calls } = makeSend();
  const deps = mkDepsSync(store, send, { completion: 98.4, needBytes: 1200, needItems: 3, needDeletes: 0, globalBytes: 1000 });
  await router(mediaAvailableReq('movie', 301, 'Backrooms'), mkRes(), deps);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.content.text, /Backrooms is now ready on Plex\./);
  assert.match(calls[0]!.content.text, /Still syncing to .+ \(98%, 3 items left\)/);
  store.close();
});

test('webhook: ready ping cross-server — in-sync says "Synced to … too"', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 302, seasons: null });
  const { send, calls } = makeSend();
  const deps = mkDepsSync(store, send, { completion: 100, needBytes: 0, needItems: 0, needDeletes: 0, globalBytes: 1000 });
  await router(mediaAvailableReq('movie', 302, 'Heat'), mkRes(), deps);
  assert.match(calls[0]!.content.text, /Heat is now ready on Plex\. ✓ Synced to .+ too\./);
  store.close();
});

test('webhook: ready ping cross-server — Syncthing unconfigured → no clause', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 303, seasons: null });
  const { send, calls } = makeSend();
  await router(mediaAvailableReq('movie', 303, 'Sinners'), mkRes(), mkDeps(store, send));  // isConfigured:false
  assert.equal(calls[0]!.content.text, 'Sinners is now ready on Plex.');
  store.close();
});

test('webhook: ready ping cross-server — getCompletion throws → best-effort, ping still sends', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 304, seasons: null });
  const { send, calls } = makeSend();
  const deps = mkDeps(store, send);
  deps.syncthing = { isConfigured: () => true, getCompletion: async () => { throw new Error('boom'); }, getFolderStatus: async () => null };
  await router(mediaAvailableReq('movie', 304, 'Nope'), mkRes(), deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.content.text, 'Nope is now ready on Plex.');   // clause omitted, ping intact
  store.close();
});

// ----------------- notify fan-out (via router + lazy windowMs:0 coalescer) -----------------

test('webhook: two subscribers for (tv,id) → one MEDIA_AVAILABLE → send twice, both marked notified', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'tv', tmdbId: 42, seasons: 'all' });
  store.addSubscription({ subscriberJid: 'b@s.whatsapp.net', subscriberNumber: '2', groupJid: null, mediaType: 'tv', tmdbId: 42, seasons: 'all' });
  const { send, calls } = makeSend();
  const deps = mkDeps(store, send);

  const res = mkRes();
  await router(mediaAvailableReq('tv', 42, 'My Show'), res, deps);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.to).sort(), ['a@s.whatsapp.net', 'b@s.whatsapp.net']);
  assert.equal(store.findActiveSubscribers('tv', 42).length, 0);  // both marked notified
  store.close();
});

test('webhook: group vs DM routing — group sub @mention to groupJid; DM sub plain text to jid', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'g@s.whatsapp.net', subscriberNumber: '111', groupJid: GROUP, mediaType: 'movie', tmdbId: 7, seasons: null });
  store.addSubscription({ subscriberJid: 'd@s.whatsapp.net', subscriberNumber: '222', groupJid: null, mediaType: 'movie', tmdbId: 7, seasons: null });
  const { send, calls } = makeSend();
  const deps = mkDeps(store, send);

  await router(mediaAvailableReq('movie', 7, 'Dune'), mkRes(), deps);

  const groupCall = calls.find(c => c.to === GROUP)!;
  const dmCall = calls.find(c => c.to === 'd@s.whatsapp.net')!;
  assert.ok(groupCall);
  assert.deepEqual(groupCall.content.mentions, ['g@s.whatsapp.net']);
  assert.match(groupCall.content.text, /@111 Dune is now ready on Plex/);
  assert.ok(dmCall);
  assert.equal(dmCall.content.mentions, undefined);
  assert.match(dmCall.content.text, /^Dune is now ready on Plex/);
  store.close();
});

test('webhook: season detail — [2] → /season 2.*ready/; all → no (season clause', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'x@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'tv', tmdbId: 88, seasons: [2] });
  const { send, calls } = makeSend();
  await router(mediaAvailableReq('tv', 88, 'Severance'), mkRes(), mkDeps(store, send));
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.content.text, /season 2.*ready on Plex/);
  store.close();

  const store2 = new Store(':memory:');
  store2.addSubscription({ subscriberJid: 'y@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'tv', tmdbId: 89, seasons: 'all' });
  const r2 = makeSend();
  await router(mediaAvailableReq('tv', 89, 'Show2'), mkRes(), mkDeps(store2, r2.send));
  assert.equal(r2.calls.length, 1);
  assert.doesNotMatch(r2.calls[0]!.content.text, /\(season/);
  assert.match(r2.calls[0]!.content.text, /is now ready on Plex/);
  store2.close();
});

test('webhook: auto-clear — second MEDIA_AVAILABLE for same media does not re-notify', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 5, seasons: null });
  const { send, calls } = makeSend();
  const deps = mkDeps(store, send);

  await router(mediaAvailableReq('movie', 5, 'Dune'), mkRes(), deps);
  assert.equal(calls.length, 1);

  await router(mediaAvailableReq('movie', 5, 'Dune'), mkRes(), deps);
  assert.equal(calls.length, 1);  // not re-notified
  store.close();
});

test('webhook: send-failure → enqueuePending with right target/text, sub still marked notified', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'fail@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 5, seasons: null });
  const { send } = makeSend({ throwFor: 'fail@s.whatsapp.net' });

  await router(mediaAvailableReq('movie', 5, 'Dune'), mkRes(), mkDeps(store, send));

  assert.equal(store.countPending(), 1);
  const p = store.listPending()[0]!;
  assert.equal(p.targetJid, 'fail@s.whatsapp.net');
  assert.match(p.text, /Dune is now ready on Plex/);
  assert.equal(store.findActiveSubscribers('movie', 5).length, 0);  // marked, no double-fire
  store.close();
});

test('webhook: back-compat — no subscription but queued audit → findRequester path notifies once, marks nothing', async () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'old@s.whatsapp.net', senderNumber: '1', groupJid: null, command: 'movie x', seerrMediaType: 'movie', seerrMediaId: 321, status: 'queued' });
  const { send, calls } = makeSend();

  await router(mediaAvailableReq('movie', 321, 'Old Movie'), mkRes(), mkDeps(store, send));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, 'old@s.whatsapp.net');
  assert.equal(store.findActiveSubscribers('movie', 321).length, 0);  // nothing to mark, no throw
  store.close();
});

test('webhook: MEDIA_AVAILABLE missing media_type/tmdbId → 202, no send, no throw', async () => {
  const store = new Store(':memory:');
  const { send, calls } = makeSend();
  const res = mkRes();
  const req = mkReq({
    url: '/webhook',
    method: 'POST',
    remote: '127.0.0.1',
    body: JSON.stringify({ notification_type: 'MEDIA_AVAILABLE', subject: 'X', media: {} }),
  });
  await router(req, res, mkDeps(store, send));
  assert.equal(res.statusCode, 202);
  assert.equal(calls.length, 0);
  store.close();
});

// ----------------- coalescer mechanism (injected, no wall-clock sleep) -----------------

test('coalescer: two enqueues for same media within window → one flush; lone other key flushes independently', async () => {
  const flushed: { mediaType: string; tmdbId: number; title: string }[] = [];
  const c = makeCoalescer({ windowMs: 60_000, flush: async ev => { flushed.push(ev); } });

  c.enqueue({ mediaType: 'movie', tmdbId: 5, title: 'Dune' });
  c.enqueue({ mediaType: 'movie', tmdbId: 5, title: 'Dune (re-fire)' });  // same key, last-wins title
  c.enqueue({ mediaType: 'tv', tmdbId: 99, title: 'Other' });             // different key
  assert.deepEqual(c.pending().sort(), ['movie:5', 'tv:99']);

  await c.flushNow('movie:5');
  assert.equal(flushed.length, 1);                 // exactly one flush for the burst, not 2
  assert.equal(flushed[0]!.title, 'Dune (re-fire)');  // last-wins
  assert.deepEqual(c.pending(), ['tv:99']);        // other key still buffered, independent

  await c.flushNow('tv:99');
  assert.equal(flushed.length, 2);
  c.dispose();
});

test('coalescer: injected setTimer stub fires flush once for a burst', async () => {
  const flushed: any[] = [];
  let fired: (() => void) | null = null;
  const c = makeCoalescer({
    windowMs: 1000,
    flush: async ev => { flushed.push(ev); },
    setTimer: (fn) => { fired = fn; return 1; },
    clearTimer: () => {},
  });
  c.enqueue({ mediaType: 'movie', tmdbId: 1, title: 'A' });
  c.enqueue({ mediaType: 'movie', tmdbId: 1, title: 'B' });  // within window, no new timer
  assert.ok(fired);
  fired!();                                  // simulate the single timer firing
  await Promise.resolve();                   // let doFlush settle
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.title, 'B');
  c.dispose();
});

test('coalescer: dispose clears buffer and timers', () => {
  const c = makeCoalescer({ windowMs: 60_000, flush: async () => {}, setTimer: () => 1, clearTimer: () => {} });
  c.enqueue({ mediaType: 'movie', tmdbId: 1, title: 'A' });
  assert.equal(c.pending().length, 1);
  c.dispose();
  assert.equal(c.pending().length, 0);
});

test('coalescer: missing coalescer on deps → router degrades to immediate flush', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 77, seasons: null });
  const { send, calls } = makeSend();
  // mkDeps intentionally sets no coalescer.
  await router(mediaAvailableReq('movie', 77, 'Dune'), mkRes(), mkDeps(store, send));
  assert.equal(calls.length, 1);
  store.close();
});

// ----------------- consolidation END-TO-END (shared long-window coalescer on deps) -----------------

test('webhook: two MEDIA_AVAILABLE for same media within window → ONE fan-out, send-count == subscriber-count', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'a@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'tv', tmdbId: 500, seasons: 'all' });
  store.addSubscription({ subscriberJid: 'b@s.whatsapp.net', subscriberNumber: '2', groupJid: null, mediaType: 'tv', tmdbId: 500, seasons: 'all' });
  const { send, calls } = makeSend();
  const deps = mkDeps(store, send);
  // Real production wiring: one shared long-window coalescer whose flush runs the
  // actual notifyReady fan-out (via router's MEDIA_AVAILABLE → enqueue path).
  const coalescer = makeCoalescer({ windowMs: 60_000, flush: ev => router(mediaAvailableReqFlushProbe(ev), mkRes(), { ...deps, coalescer: undefined }) });
  deps.coalescer = coalescer;

  // Two POSTs for the same media land within the window → both buffer under one key.
  await router(mediaAvailableReq('tv', 500, 'My Show'), mkRes(), deps);
  await router(mediaAvailableReq('tv', 500, 'My Show'), mkRes(), deps);
  assert.deepEqual(coalescer.pending(), ['tv:500']);  // collapsed to one buffered key
  assert.equal(calls.length, 0);                       // nothing sent yet (window open)

  await coalescer.flushNow();                           // window elapses → single fan-out
  assert.equal(calls.length, 2);                        // == subscriber count, NOT 2× (4)
  assert.deepEqual(calls.map(c => c.to).sort(), ['a@s.whatsapp.net', 'b@s.whatsapp.net']);
  assert.equal(store.findActiveSubscribers('tv', 500).length, 0);
  coalescer.dispose();
  store.close();
});

// Helper: turn a buffered ReadyEvent back into a MEDIA_AVAILABLE request so the
// shared-coalescer test exercises the real router → notifyReady path on flush.
function mediaAvailableReqFlushProbe(ev: { mediaType: string; tmdbId: number; title: string }) {
  return mediaAvailableReq(ev.mediaType, ev.tmdbId, ev.title);
}

// ----------------- per-subscriberJid dedup + mergeSeasons (the "S1 + S2" branch) -----------------

test('webhook: same subscriberJid with two season rows → ONE send, merged seasons, BOTH ids marked', async () => {
  const store = new Store(':memory:');
  // Same person subscribed to S1, later S2, plus an 'all' row — all for one show.
  store.addSubscription({ subscriberJid: 'p@s.whatsapp.net', subscriberNumber: '7', groupJid: null, mediaType: 'tv', tmdbId: 600, seasons: [1] });
  store.addSubscription({ subscriberJid: 'p@s.whatsapp.net', subscriberNumber: '7', groupJid: null, mediaType: 'tv', tmdbId: 600, seasons: [2] });
  assert.equal(store.findActiveSubscribers('tv', 600).length, 2);
  const { send, calls } = makeSend();

  await router(mediaAvailableReq('tv', 600, 'Merged Show'), mkRes(), mkDeps(store, send));

  assert.equal(calls.length, 1);  // ONE message for the JID, not one per row
  assert.match(calls[0]!.content.text, /seasons 1, 2/);  // merged + sorted
  assert.equal(store.findActiveSubscribers('tv', 600).length, 0);  // BOTH ids cleared
  store.close();
});

test('webhook: same subscriberJid where one row is "all" → "all" subsumes, no season clause, all ids marked', async () => {
  const store = new Store(':memory:');
  store.addSubscription({ subscriberJid: 'q@s.whatsapp.net', subscriberNumber: '8', groupJid: null, mediaType: 'tv', tmdbId: 601, seasons: [1] });
  store.addSubscription({ subscriberJid: 'q@s.whatsapp.net', subscriberNumber: '8', groupJid: null, mediaType: 'tv', tmdbId: 601, seasons: 'all' });
  const { send, calls } = makeSend();

  await router(mediaAvailableReq('tv', 601, 'All Show'), mkRes(), mkDeps(store, send));

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!.content.text, /\(season/);  // 'all' subsumes the [1] list
  assert.match(calls[0]!.content.text, /is now ready on Plex/);
  assert.equal(store.findActiveSubscribers('tv', 601).length, 0);
  store.close();
});

// ----------------- LID-degraded subscriber routing guard -----------------

test('webhook: LID-degraded subscriber in group → falls back to DM, no @mention prefix', async () => {
  const store = new Store(':memory:');
  // subscriber_jid captured as a raw @lid (LID→PN mapping was unresolved at
  // request time); subscriber_number is the meaningless LID numeric prefix.
  store.addSubscription({ subscriberJid: '199999999999999@lid', subscriberNumber: '199999999999999', groupJid: GROUP, mediaType: 'movie', tmdbId: 700, seasons: null });
  const { send, calls } = makeSend();

  await router(mediaAvailableReq('movie', 700, 'Dune'), mkRes(), mkDeps(store, send));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, '199999999999999@lid');     // DM to the JID, NOT the group
  assert.equal(calls[0]!.content.mentions, undefined);    // no @mention into the group
  assert.equal(calls[0]!.content.text, 'Dune is now ready on Plex.');  // no numeric prefix
  store.close();
});

// ----------------- HIGH-finding regression: real (audit + subscription) request never re-notifies -----------------

test('webhook: real request (queued audit + subscription) → 2nd MEDIA_AVAILABLE does NOT re-notify', async () => {
  const store = new Store(':memory:');
  // Exactly what handler.ts writes on a successful createRequest:
  store.audit({ senderJid: 'u@s.whatsapp.net', senderNumber: '1', groupJid: null, command: 'movie x', seerrMediaType: 'movie', seerrMediaId: 800, seerrRequestId: 42, status: 'queued' });
  store.addSubscription({ subscriberJid: 'u@s.whatsapp.net', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 800, seasons: null });
  const { send, calls } = makeSend();
  const deps = mkDeps(store, send);

  await router(mediaAvailableReq('movie', 800, 'X'), mkRes(), deps);
  assert.equal(calls.length, 1);

  // Audit row is still status='queued' (success path never flips it), but the
  // subscription is marked notified and hasAnySubscription gates the fallback.
  await router(mediaAvailableReq('movie', 800, 'X'), mkRes(), deps);
  assert.equal(calls.length, 1);  // NOT re-notified — auto-clear holds for real requests
  store.close();
});
