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
process.env.SYNCTHING_FOLDERS = 'movies,tv';

const { Store } = await import('../src/state/store.ts');
const { authGate, maybeSetTokenCookie } = await import('../src/dashboard/auth.ts');
const { dashboardRoute } = await import('../src/dashboard/routes.ts');
const { router } = await import('../src/webhook.ts');
const { isCommandName, runCommand, COMMAND_NAMES } = await import('../src/dashboard/commands.ts');

type MockReq = {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress: string };
  on: (event: string, cb: (...args: any[]) => void) => void;
};

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => MockRes;
  end: (body?: string) => void;
  setHeader: (name: string, value: string) => void;
};

function mkReq(opts: Partial<MockReq> & { url: string; method?: string; body?: string }): MockReq {
  const body = opts.body;
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  const req: MockReq = {
    url: opts.url,
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
    socket: opts.socket ?? { remoteAddress: '10.0.0.1' },
    on(event: string, cb: (...args: any[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      // Fire on next microtask after both 'data' and 'end' are wired.
      queueMicrotask(() => {
        if (event === 'data' && body !== undefined) cb(body);
      });
      queueMicrotask(() => queueMicrotask(() => {
        if (event === 'end') cb();
      }));
    },
  };
  return req;
}

function mkRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v;
      return res;
    },
    end(body?: string) {
      if (body !== undefined) res.body = body;
      res.ended = true;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
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

function fakeSyncthing(opts: { configured?: boolean; ping?: boolean; completion?: any; status?: any; throwOnId?: string } = {}) {
  return {
    isConfigured: () => opts.configured ?? true,
    ping: async () => opts.ping ?? true,
    getCompletion: async (id: string) => {
      if (opts.throwOnId && id === opts.throwOnId) throw new Error('boom');
      return opts.completion ?? { completion: 100, needBytes: 0, needItems: 0, needDeletes: 0, globalBytes: 0 };
    },
    getFolderStatus: async (id: string) => {
      if (opts.throwOnId && id === opts.throwOnId) throw new Error('boom');
      return opts.status ?? { state: 'idle', stateChanged: '', globalBytes: 0, globalFiles: 0, inSyncBytes: 0, inSyncFiles: 0, needBytes: 0, needFiles: 0, needDeletes: 0, errors: 0 };
    },
  } as any;
}

function mkDeps(store: any, overrides: any = {}) {
  return {
    send: overrides.send ?? (async () => null),
    store,
    seerr: overrides.seerr ?? fakeSeerr(),
    syncthing: overrides.syncthing ?? fakeSyncthing(),
    getConnectionStatus: overrides.getConnectionStatus ?? (() => ({ connected: true, uptimeSec: 42 })),
    drainPending: overrides.drainPending ?? (async () => {}),
    reconnectWa: overrides.reconnectWa ?? (async () => {}),
    shutdown: overrides.shutdown ?? (() => {}),
  };
}

// ----------------- listAudit filter coverage -----------------

test('listAudit: empty store returns []', () => {
  const store = new Store(':memory:');
  assert.deepEqual(store.listAudit(), []);
});

test('listAudit: returns rows DESC ts', () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a@s.whatsapp.net', senderNumber: '1', groupJid: null, command: 'first', status: 'queued' });
  store.audit({ senderJid: 'a@s.whatsapp.net', senderNumber: '1', groupJid: null, command: 'second', status: 'queued' });
  const rows = store.listAudit();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.command, 'second');
  assert.equal(rows[1]!.command, 'first');
});

test('listAudit: filter by status', () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'q1', status: 'queued' });
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'f1', status: 'failed' });
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'q2', status: 'queued' });
  const rows = store.listAudit({ status: 'failed' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.command, 'f1');
});

test('listAudit: filter by senderNumber', () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'one', status: 'queued' });
  store.audit({ senderJid: 'b', senderNumber: '2', groupJid: null, command: 'two', status: 'queued' });
  const rows = store.listAudit({ senderNumber: '2' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.senderNumber, '2');
});

test('listAudit: filter by groupJid', () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: 'g1@g.us', command: 'one', status: 'queued' });
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'dm', status: 'queued' });
  const rows = store.listAudit({ groupJid: 'g1@g.us' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.groupJid, 'g1@g.us');
});

test('listAudit: filter by since (time window)', async () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'old', status: 'queued' });
  await new Promise(r => setTimeout(r, 5));
  const cutoff = Date.now();
  await new Promise(r => setTimeout(r, 5));
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'new', status: 'queued' });
  const rows = store.listAudit({ since: cutoff });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.command, 'new');
});

test('listAudit: filter by until (upper bound)', async () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'old', status: 'queued' });
  await new Promise(r => setTimeout(r, 5));
  const cutoff = Date.now();
  await new Promise(r => setTimeout(r, 5));
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'new', status: 'queued' });
  const rows = store.listAudit({ until: cutoff });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.command, 'old');
});

test('listAudit: combined filters', () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: 'g@g.us', command: 'a', status: 'queued' });
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: 'g@g.us', command: 'b', status: 'failed' });
  store.audit({ senderJid: 'a', senderNumber: '2', groupJid: 'g@g.us', command: 'c', status: 'failed' });
  const rows = store.listAudit({ status: 'failed', senderNumber: '1', groupJid: 'g@g.us' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.command, 'b');
});

test('listAudit: limit defaults to 50', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 60; i++) store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: `c${i}`, status: 'queued' });
  assert.equal(store.listAudit().length, 50);
});

test('listAudit: respects custom limit', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 10; i++) store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: `c${i}`, status: 'queued' });
  assert.equal(store.listAudit({ limit: 3 }).length, 3);
});

test('listAudit: offset paging', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 5; i++) store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: `c${i}`, status: 'queued' });
  const page1 = store.listAudit({ limit: 2, offset: 0 });
  const page2 = store.listAudit({ limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.notEqual(page1[0]!.id, page2[0]!.id);
});

test('listAudit: exposes all audit columns', () => {
  const store = new Store(':memory:');
  const id = store.audit({
    senderJid: 'a@s.whatsapp.net',
    senderNumber: '15551234567',
    groupJid: 'g@g.us',
    command: '!movie dune',
    resolvedRoute: 'movies/western',
    seerrMediaType: 'movie',
    seerrMediaId: 438631,
    seerrRequestId: 99,
    status: 'queued',
  });
  const rows = store.listAudit();
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.id, id);
  assert.equal(typeof r.ts, 'number');
  assert.equal(r.senderJid, 'a@s.whatsapp.net');
  assert.equal(r.senderNumber, '15551234567');
  assert.equal(r.groupJid, 'g@g.us');
  assert.equal(r.command, '!movie dune');
  assert.equal(r.resolvedRoute, 'movies/western');
  assert.equal(r.seerrMediaType, 'movie');
  assert.equal(r.seerrMediaId, 438631);
  assert.equal(r.seerrRequestId, 99);
  assert.equal(r.status, 'queued');
  assert.equal(r.retryAttempts, 0);
  assert.equal(r.lastRetryAt, null);
});

// ----------------- authGate -----------------

test('authGate: empty token → 503 disabled', () => {
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, '');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 503);
});

test('authGate: empty token → 503 even from loopback', () => {
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, '');
  assert.equal(r.ok, false);
});

test('authGate: no token header → 401', () => {
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 401);
});

test('authGate: wrong bearer → 401', () => {
  const req = mkReq({ url: '/api/heartbeat', headers: { authorization: 'Bearer wrong' }, socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, false);
});

test('authGate: correct bearer → ok', () => {
  const req = mkReq({ url: '/api/heartbeat', headers: { authorization: 'Bearer secret' }, socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, true);
});

test('authGate: cookie token accepted', () => {
  const req = mkReq({ url: '/api/heartbeat', headers: { cookie: 'whatsarr_token=secret; foo=bar' }, socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, true);
});

test('authGate: wrong cookie token → 401', () => {
  const req = mkReq({ url: '/api/heartbeat', headers: { cookie: 'whatsarr_token=wrong' }, socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, false);
});

test('authGate: loopback 127.0.0.1 bypasses check', () => {
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, true);
});

test('authGate: loopback ::1 bypasses check', () => {
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '::1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, true);
});

test('authGate: loopback ::ffff:127.0.0.1 bypasses check', () => {
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '::ffff:127.0.0.1' } });
  const res = mkRes();
  const r = authGate(req as any, res as any, 'secret');
  assert.equal(r.ok, true);
});

test('maybeSetTokenCookie: sets cookie when ?token= matches', () => {
  const req = mkReq({ url: '/dashboard/?token=secret', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  maybeSetTokenCookie(req as any, res as any, 'secret');
  assert.match(res.headers['set-cookie'] ?? '', /whatsarr_token=secret/);
  assert.match(res.headers['set-cookie'] ?? '', /HttpOnly/);
  assert.match(res.headers['set-cookie'] ?? '', /SameSite=Lax/);
});

test('maybeSetTokenCookie: no-op when ?token= absent', () => {
  const req = mkReq({ url: '/dashboard/', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  maybeSetTokenCookie(req as any, res as any, 'secret');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('maybeSetTokenCookie: no-op when token mismatched', () => {
  const req = mkReq({ url: '/dashboard/?token=wrong', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  maybeSetTokenCookie(req as any, res as any, 'secret');
  assert.equal(res.headers['set-cookie'], undefined);
});

// ----------------- route handlers via router -----------------

test('router: GET /health still works', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/health', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
});

test('router: unknown route → 404', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/nope', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 404);
});

test('router: /api/heartbeat requires auth (no token)', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 401);
});

test('router: /api/heartbeat with bearer token returns shape', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({
    url: '/api/heartbeat',
    headers: { authorization: 'Bearer secret-test-token' },
    socket: { remoteAddress: '10.0.0.1' },
  });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(typeof j.connected, 'boolean');
  assert.equal(typeof j.uptimeSec, 'number');
  assert.equal(typeof j.pendingCount, 'number');
  assert.equal(typeof j.retryCount, 'number');
});

test('router: /api/heartbeat from loopback works without token', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/heartbeat', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
});

test('router: /api/overview returns diagnosis + connection', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/overview', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.ok(j.diagnosis);
  assert.ok(j.connection);
  assert.equal(typeof j.diagnosis.uptimeSec, 'number');
  assert.ok(Array.isArray(j.diagnosis.validation.checks));
  assert.equal(typeof j.connection.connected, 'boolean');
});

test('router: /api/audit returns rows + total', async () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'x', status: 'queued' });
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'y', status: 'failed' });
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/audit', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.total, 2);
  assert.equal(j.rows.length, 2);
});

test('router: /api/audit?status=failed filters', async () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'x', status: 'queued' });
  store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: 'y', status: 'failed' });
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/audit?status=failed', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.total, 1);
  assert.equal(j.rows[0].command, 'y');
});

test('router: /api/audit?user=N filters by senderNumber', async () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a', senderNumber: '111', groupJid: null, command: 'x', status: 'queued' });
  store.audit({ senderJid: 'b', senderNumber: '222', groupJid: null, command: 'y', status: 'queued' });
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/audit?user=222', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.total, 1);
  assert.equal(j.rows[0].senderNumber, '222');
});

test('router: /api/audit limit + offset paging', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 5; i++) store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: `c${i}`, status: 'queued' });
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/audit?limit=2&offset=1', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.total, 5);
  assert.equal(j.rows.length, 2);
});

test('router: /api/pending returns rows + total', async () => {
  const store = new Store(':memory:');
  store.enqueuePending('a@s.whatsapp.net', 'hello');
  store.enqueuePending('b@s.whatsapp.net', 'world');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/pending', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.total, 2);
  assert.equal(j.rows.length, 2);
});

test('router: /api/feedback returns all kinds by default', async () => {
  const store = new Store(':memory:');
  store.recordFeedback({ kind: 'feedback', senderJid: 'a', senderNumber: '1', groupJid: null, body: 'thanks', report: null });
  store.recordFeedback({ kind: 'issue', senderJid: 'b', senderNumber: '2', groupJid: null, body: 'broken', report: 'r' });
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/feedback', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.rows.length, 2);
});

test('router: /api/feedback?kind=issue filters', async () => {
  const store = new Store(':memory:');
  store.recordFeedback({ kind: 'feedback', senderJid: 'a', senderNumber: '1', groupJid: null, body: 'thanks', report: null });
  store.recordFeedback({ kind: 'issue', senderJid: 'b', senderNumber: '2', groupJid: null, body: 'broken', report: null });
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/feedback?kind=issue', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.rows.length, 1);
  assert.equal(j.rows[0].kind, 'issue');
});

test('router: /api/syncthing when not configured returns {configured:false}', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store, { syncthing: fakeSyncthing({ configured: false }) });
  const req = mkReq({ url: '/api/syncthing', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.configured, false);
});

test('router: /api/syncthing returns folder cards', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store, { syncthing: fakeSyncthing({ configured: true, ping: true }) });
  const req = mkReq({ url: '/api/syncthing', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.configured, true);
  assert.equal(j.ping, true);
  assert.equal(j.folders.length, 2);
  assert.equal(j.folders[0].id, 'movies');
  assert.equal(j.folders[1].id, 'tv');
  assert.ok(j.folders[0].completion);
  assert.ok(j.folders[0].status);
});

test('router: /api/syncthing tolerates per-folder error', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store, { syncthing: fakeSyncthing({ configured: true, throwOnId: 'movies' }) });
  const req = mkReq({ url: '/api/syncthing', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  const movies = j.folders.find((f: any) => f.id === 'movies');
  assert.ok(movies.error);
  assert.equal(movies.completion, null);
});

test('router: /dashboard/ returns HTML with bootstrap injection', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/dashboard/', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /window\.__WHATSARR__/);
  assert.match(res.body, /apiBase/);
  assert.match(res.body, /"writeActions":true/);
  assert.match(res.body, /pollIntervals/);
});

test('router: /dashboard/app.js → application/javascript', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/dashboard/app.js', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/javascript/);
});

test('router: /dashboard/app.css → text/css', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/dashboard/app.css', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/css/);
});

test('router: /dashboard/?token=… sets cookie on response', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/dashboard/?token=secret-test-token', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'] ?? '', /whatsarr_token=secret-test-token/);
});

test('router: dashboard cookie auth carries across requests', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({
    url: '/api/heartbeat',
    headers: { cookie: 'whatsarr_token=secret-test-token' },
    socket: { remoteAddress: '10.0.0.1' },
  });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
});

test('dashboardRoute: unknown /api/* path falls through to 404', async () => {
  const store = new Store(':memory:');
  const req = mkReq({ url: '/api/nope', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await dashboardRoute(req as any, res as any, {
    store,
    seerr: fakeSeerr(),
    syncthing: fakeSyncthing(),
    getConnectionStatus: () => ({ connected: true, uptimeSec: 1 }),
    syncthingFolders: [],
    send: async () => null,
    drainPending: async () => {},
    reconnectWa: async () => {},
    shutdown: () => {},
  });
  assert.equal(res.statusCode, 404);
});

// ----------------- commands table CRUD -----------------

test('store.enqueueCommand: returns id, row visible via listCommands', () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('vacuum_db');
  assert.ok(id > 0);
  const rows = store.listCommands();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, id);
  assert.equal(rows[0]!.name, 'vacuum_db');
  assert.equal(rows[0]!.status, 'queued');
  assert.equal(rows[0]!.argsJson, null);
});

test('store.enqueueCommand: persists args as JSON', () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('send_test_dm', { to: '+1@s.whatsapp.net', text: 'hi' });
  const rows = store.listCommands();
  assert.equal(rows[0]!.id, id);
  assert.equal(rows[0]!.argsJson, JSON.stringify({ to: '+1@s.whatsapp.net', text: 'hi' }));
});

test('store.markCommandRunning: flips status + sets started_at', () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('vacuum_db');
  store.markCommandRunning(id);
  const r = store.listCommands()[0]!;
  assert.equal(r.status, 'running');
  assert.equal(typeof r.startedAt, 'number');
  assert.equal(r.finishedAt, null);
});

test('store.completeCommand: flips to succeeded + sets result + finished_at', () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('vacuum_db');
  store.markCommandRunning(id);
  store.completeCommand(id, 'ok');
  const r = store.listCommands()[0]!;
  assert.equal(r.status, 'succeeded');
  assert.equal(r.result, 'ok');
  assert.equal(typeof r.finishedAt, 'number');
  assert.equal(r.error, null);
});

test('store.failCommand: flips to failed + records error', () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('vacuum_db');
  store.markCommandRunning(id);
  store.failCommand(id, 'boom');
  const r = store.listCommands()[0]!;
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'boom');
  assert.equal(typeof r.finishedAt, 'number');
});

test('store.listCommands: returns rows DESC ts', () => {
  const store = new Store(':memory:');
  store.enqueueCommand('vacuum_db');
  store.enqueueCommand('drain_pending');
  store.enqueueCommand('reconnect_wa');
  const rows = store.listCommands();
  assert.equal(rows.length, 3);
  // Most recent first.
  assert.equal(rows[0]!.name, 'reconnect_wa');
  assert.equal(rows[2]!.name, 'vacuum_db');
});

test('store.findAuditBySeerrRequestId: returns null when no row', () => {
  const store = new Store(':memory:');
  assert.equal(store.findAuditBySeerrRequestId(999), null);
});

test('store.findAuditBySeerrRequestId: finds row + most recent on dup', () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: 'a@s', senderNumber: '1', groupJid: 'g@g.us', command: 'old', seerrRequestId: 42, status: 'failed' });
  const id2 = store.audit({ senderJid: 'b@s', senderNumber: '2', groupJid: null, command: 'new', seerrRequestId: 42, status: 'queued' });
  const r = store.findAuditBySeerrRequestId(42);
  assert.ok(r);
  assert.equal(r!.id, id2);
  assert.equal(r!.senderNumber, '2');
  assert.equal(r!.groupJid, null);
});

// ----------------- commands runner -----------------

test('isCommandName: validates name set', () => {
  assert.ok(isCommandName('vacuum_db'));
  assert.ok(isCommandName('reconnect_wa'));
  assert.ok(isCommandName('drain_pending'));
  assert.ok(isCommandName('send_test_dm'));
  assert.ok(isCommandName('shutdown'));
  assert.equal(isCommandName('eat_homework'), false);
  assert.equal(isCommandName(''), false);
});

test('COMMAND_NAMES: covers documented set', () => {
  assert.deepEqual(
    [...COMMAND_NAMES].sort(),
    ['drain_pending', 'reconnect_wa', 'send_test_dm', 'shutdown', 'vacuum_db'],
  );
});

function mkCmdDeps(store: any, overrides: any = {}) {
  return {
    store,
    seerr: overrides.seerr ?? fakeSeerr(),
    send: overrides.send ?? (async () => null),
    drainPending: overrides.drainPending ?? (async () => {}),
    reconnectWa: overrides.reconnectWa ?? (async () => {}),
    shutdown: overrides.shutdown ?? (() => {}),
  } as any;
}

test('runCommand: reconnect_wa → succeeded, calls reconnectWa', async () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('reconnect_wa');
  let called = false;
  const deps = mkCmdDeps(store, { reconnectWa: async () => { called = true; } });
  const status = await runCommand(id, 'reconnect_wa', undefined, deps);
  assert.equal(status, 'succeeded');
  assert.equal(called, true);
  const r = store.listCommands()[0]!;
  assert.equal(r.status, 'succeeded');
  assert.equal(r.result, 'reconnect triggered');
});

test('runCommand: vacuum_db → succeeded, calls store.vacuum', async () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('vacuum_db');
  const deps = mkCmdDeps(store);
  const status = await runCommand(id, 'vacuum_db', undefined, deps);
  assert.equal(status, 'succeeded');
  const r = store.listCommands()[0]!;
  assert.equal(r.result, 'db vacuumed');
});

test('runCommand: drain_pending → succeeded, calls drainPending', async () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('drain_pending');
  let called = false;
  const deps = mkCmdDeps(store, { drainPending: async () => { called = true; } });
  const status = await runCommand(id, 'drain_pending', undefined, deps);
  assert.equal(status, 'succeeded');
  assert.equal(called, true);
});

test('runCommand: send_test_dm → succeeded, calls send', async () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('send_test_dm', { to: '+1@s.whatsapp.net', text: 'hi' });
  let captured: any = null;
  const deps = mkCmdDeps(store, {
    send: async (to: string, content: any) => { captured = { to, content }; return null; },
  });
  const status = await runCommand(id, 'send_test_dm', { to: '+1@s.whatsapp.net', text: 'hi' }, deps);
  assert.equal(status, 'succeeded');
  assert.equal(captured.to, '+1@s.whatsapp.net');
  assert.equal(captured.content.text, 'hi');
  const r = store.listCommands()[0]!;
  assert.equal(r.result, 'sent to +1@s.whatsapp.net');
});

test('runCommand: send_test_dm validates non-empty {to,text}', async () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('send_test_dm', {});
  const deps = mkCmdDeps(store);
  const status = await runCommand(id, 'send_test_dm', {}, deps);
  assert.equal(status, 'failed');
  const r = store.listCommands()[0]!;
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /non-empty/);
});

test('runCommand: shutdown → succeeded, calls shutdown after marking done', async () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('shutdown');
  let shutdownAfterMarked = false;
  const deps = mkCmdDeps(store, {
    shutdown: () => {
      const r = store.listCommands()[0]!;
      if (r.status === 'succeeded') shutdownAfterMarked = true;
    },
  });
  const status = await runCommand(id, 'shutdown', undefined, deps);
  assert.equal(status, 'succeeded');
  assert.equal(shutdownAfterMarked, true);
  const r = store.listCommands()[0]!;
  assert.equal(r.result, 'shutting down');
});

test('runCommand: failure path calls failCommand with error message', async () => {
  const store = new Store(':memory:');
  const id = store.enqueueCommand('reconnect_wa');
  const deps = mkCmdDeps(store, {
    reconnectWa: async () => { throw new Error('socket-stuck'); },
  });
  const status = await runCommand(id, 'reconnect_wa', undefined, deps);
  assert.equal(status, 'failed');
  const r = store.listCommands()[0]!;
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'socket-stuck');
});

// ----------------- write endpoints: /api/seerr/request/:id/* -----------------

test('router: POST /api/seerr/request/:id/approve requires auth', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/seerr/request/42/approve', method: 'POST', socket: { remoteAddress: '10.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 401);
});

test('router: POST /api/seerr/request/:id/approve calls seerr.approveRequest + updates audit', async () => {
  const store = new Store(':memory:');
  const auditId = store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: '!movie x', seerrRequestId: 7, status: 'pending' });
  let approvedWith: number | null = null;
  const seerr = { ...fakeSeerr(), approveRequest: async (id: number) => { approvedWith = id; return { id }; } };
  const deps = mkDeps(store, { seerr });
  const req = mkReq({ url: '/api/seerr/request/7/approve', method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.id, 7);
  assert.equal(j.ok, true);
  assert.equal(approvedWith, 7);
  // Audit row updated to 'approved'.
  const row = store.listAudit().find(r => r.id === auditId)!;
  assert.equal(row.status, 'approved');
});

test('router: POST /api/seerr/request/:id/deny calls seerr.declineRequest', async () => {
  const store = new Store(':memory:');
  let deniedWith: number | null = null;
  const seerr = { ...fakeSeerr(), declineRequest: async (id: number) => { deniedWith = id; return { id }; } };
  const deps = mkDeps(store, { seerr });
  const req = mkReq({ url: '/api/seerr/request/9/deny', method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.id, 9);
  assert.equal(deniedWith, 9);
});

test('router: POST /api/seerr/request/:id/retry calls seerr.retryRequest + marks audit retried', async () => {
  const store = new Store(':memory:');
  const auditId = store.audit({ senderJid: 'a', senderNumber: '1', groupJid: null, command: '!movie x', seerrRequestId: 11, status: 'failed' });
  let retryWith: number | null = null;
  const seerr = { ...fakeSeerr(), retryRequest: async (id: number) => { retryWith = id; return { id }; } };
  const deps = mkDeps(store, { seerr });
  const req = mkReq({ url: '/api/seerr/request/11/retry', method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  assert.equal(retryWith, 11);
  // markRetrySucceeded bumps retry_attempts and flips status to 'queued'.
  const row = store.listAudit().find(r => r.id === auditId)!;
  assert.equal(row.status, 'queued');
  assert.equal(row.retryAttempts, 1);
});

test('router: POST /api/seerr/request/:id/approve returns 502 on seerr failure', async () => {
  const store = new Store(':memory:');
  const seerr = { ...fakeSeerr(), approveRequest: async () => { throw new Error('seerr 500'); } };
  const deps = mkDeps(store, { seerr });
  const req = mkReq({ url: '/api/seerr/request/3/approve', method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 502);
  const j = JSON.parse(res.body);
  assert.equal(j.id, 3);
  assert.match(j.error, /seerr 500/);
});

// ----------------- write endpoints: /api/pending/:id/* -----------------

test('router: POST /api/pending/:id/retry sends + deletes on success', async () => {
  const store = new Store(':memory:');
  const id = store.enqueuePending('jid@s.whatsapp.net', 'hello');
  let sentTo: string | null = null;
  const deps = mkDeps(store, {
    send: async (to: string) => { sentTo = to; return null; },
  });
  const req = mkReq({ url: `/api/pending/${id}/retry`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.id, id);
  assert.equal(j.ok, true);
  assert.equal(sentTo, 'jid@s.whatsapp.net');
  assert.equal(store.countPending(), 0);
});

test('router: POST /api/pending/:id/retry returns 502 + marks failed on send error', async () => {
  const store = new Store(':memory:');
  const id = store.enqueuePending('jid@s.whatsapp.net', 'hello');
  const deps = mkDeps(store, {
    send: async () => { throw new Error('boom'); },
  });
  const req = mkReq({ url: `/api/pending/${id}/retry`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 502);
  const j = JSON.parse(res.body);
  assert.match(j.error, /boom/);
  // Still present, but attempts bumped.
  const row = store.listPending().find(r => r.id === id)!;
  assert.equal(row.attempts, 1);
});

test('router: POST /api/pending/:id/delete removes row', async () => {
  const store = new Store(':memory:');
  const id = store.enqueuePending('jid@s.whatsapp.net', 'hello');
  const deps = mkDeps(store);
  const req = mkReq({ url: `/api/pending/${id}/delete`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.id, id);
  assert.equal(j.deleted, true);
  assert.equal(store.countPending(), 0);
});

// ----------------- write endpoints: /api/commands -----------------

test('router: POST /api/commands rejects unknown name with 400', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({
    url: '/api/commands',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    body: JSON.stringify({ name: 'eat_homework' }),
  });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 400);
  const j = JSON.parse(res.body);
  assert.match(j.error, /unknown/);
});

test('router: POST /api/commands enqueues + returns 202 with id', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({
    url: '/api/commands',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    body: JSON.stringify({ name: 'vacuum_db' }),
  });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 202);
  const j = JSON.parse(res.body);
  assert.equal(typeof j.id, 'number');
  assert.equal(j.name, 'vacuum_db');
  assert.equal(j.status, 'queued');
  const rows = store.listCommands();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, j.id);
});

test('router: POST /api/commands runs async (status flips after microtask)', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({
    url: '/api/commands',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    body: JSON.stringify({ name: 'vacuum_db' }),
  });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  // Yield enough microtasks for the queued runner to fire.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const row = store.listCommands()[0]!;
  assert.equal(row.status, 'succeeded');
  assert.equal(row.result, 'db vacuumed');
});

test('router: POST /api/commands with malformed JSON → 400', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({
    url: '/api/commands',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    body: '{not json',
  });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 400);
  const j = JSON.parse(res.body);
  assert.match(j.error, /json/i);
});

test('router: POST /api/commands with body >8KB → 413', async () => {
  const store = new Store(':memory:');
  const deps = mkDeps(store);
  const req = mkReq({
    url: '/api/commands',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    body: '{"name":"vacuum_db","pad":"' + 'x'.repeat(9000) + '"}',
  });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 413);
});

// ----------------- GET /api/tasks -----------------

test('router: GET /api/tasks returns rows shape', async () => {
  const store = new Store(':memory:');
  store.enqueueCommand('vacuum_db');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/tasks', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.ok(Array.isArray(j.rows));
  assert.equal(j.rows.length, 1);
  assert.equal(j.rows[0].name, 'vacuum_db');
  assert.equal(j.rows[0].status, 'queued');
});

test('router: GET /api/tasks returns DESC ts', async () => {
  const store = new Store(':memory:');
  store.enqueueCommand('vacuum_db');
  store.enqueueCommand('drain_pending');
  store.enqueueCommand('reconnect_wa');
  const deps = mkDeps(store);
  const req = mkReq({ url: '/api/tasks', socket: { remoteAddress: '127.0.0.1' } });
  const res = mkRes();
  await router(req as any, res as any, deps as any);
  const j = JSON.parse(res.body);
  assert.equal(j.rows.length, 3);
  assert.equal(j.rows[0].name, 'reconnect_wa');
  assert.equal(j.rows[2].name, 'vacuum_db');
});
