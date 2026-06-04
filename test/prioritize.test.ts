import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Placeholder identifiers (kept fictional so this file is identical in the
// public mirror — no sanitization needed).
process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.ADMIN_NUMBERS = '+15555550100';
process.env.COMMAND_PREFIX = '!';
process.env.PRIORITY_PER_DAY = '2';
process.env.WEBHOOK_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

const { parse } = await import('../src/parser/commands.ts');
const { handleMessage } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');

const GROUP = '120363111111111111@g.us';
const MEMBER = '15555550100';

function grpMsg(text: string, number = MEMBER) {
  return { fromJid: GROUP, senderJid: `${number}@s.whatsapp.net`, senderNumber: number, text, isGroup: true } as any;
}

function mockArr(opts: { fail?: boolean } = {}) {
  const calls: { mediaType: string; itemId: number; serverId: number | null }[] = [];
  return {
    calls,
    isConfigured: async () => true,
    forceSearch: async (mediaType: 'movie' | 'tv', itemId: number, serverId: number | null) => {
      if (opts.fail) throw new Error('ECONNREFUSED');
      calls.push({ mediaType, itemId, serverId });
      return { commandId: 1, server: mediaType === 'movie' ? 'radarr' : 'sonarr' };
    },
  };
}

// `arr: null` means "no arr client wired"; otherwise a mock is used.
function mkDeps(store: any, opts: { arr?: any; search?: any[]; mediaInfo?: any } = {}) {
  return {
    store,
    seerr: {
      search: async () => opts.search ?? [],
      getMediaInfo: async () => (opts.mediaInfo === undefined ? null : opts.mediaInfo),
    } as any,
    arr: opts.arr === null ? undefined : (opts.arr ?? mockArr()),
  } as any;
}

const AVAILABLE = { status: 5, downloadStatus: [], externalServiceId: 10, serverId: 0 };
const PROCESSING = { status: 3, downloadStatus: [], externalServiceId: 55, serverId: 0 };
const PENDING_NO_ARR = { status: 2, downloadStatus: [], externalServiceId: null, serverId: null };
const MATRIX = [{ id: 603, mediaType: 'movie', title: 'The Matrix' }];

// ---------- parser ----------

test('parse: !prioritize variants', () => {
  assert.deepEqual(parse('!prioritize'), { kind: 'prioritize', title: null });
  assert.deepEqual(parse('!prioritize dune part two'), { kind: 'prioritize', title: 'dune part two' });
  assert.deepEqual(parse('!priority'), { kind: 'prioritize', title: null });
  assert.deepEqual(parse('!bump the matrix'), { kind: 'prioritize', title: 'the matrix' });
});

// ---------- handler ----------

test('prioritize: disabled when no arr client is wired', async () => {
  const store = new Store(':memory:');
  const replies = await handleMessage(mkDeps(store, { arr: null }), grpMsg('!prioritize the matrix'));
  assert.match(replies[0]!.text, /isn't enabled/);
  store.close();
});

test('prioritize <title>: not requested yet → tells them, no force-search, no quota', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const replies = await handleMessage(mkDeps(store, { arr, search: MATRIX, mediaInfo: null }), grpMsg('!prioritize the matrix'));
  assert.match(replies[0]!.text, /doesn't look requested/);
  assert.equal(arr.calls.length, 0);
  assert.equal(store.getPriorityCount(MEMBER), 0);
  store.close();
});

test('prioritize: already on Plex → no force-search, no quota', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const replies = await handleMessage(mkDeps(store, { arr, search: MATRIX, mediaInfo: AVAILABLE }), grpMsg('!prioritize the matrix'));
  assert.match(replies[0]!.text, /already on Plex/);
  assert.equal(arr.calls.length, 0);
  assert.equal(store.getPriorityCount(MEMBER), 0);
  store.close();
});

test('prioritize: requested but not handed to the downloader yet → no force-search', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const replies = await handleMessage(mkDeps(store, { arr, search: MATRIX, mediaInfo: PENDING_NO_ARR }), grpMsg('!prioritize the matrix'));
  assert.match(replies[0]!.text, /isn't with the downloader/);
  assert.equal(arr.calls.length, 0);
  store.close();
});

test('prioritize <movie>: force-searches Radarr + consumes one priority', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const replies = await handleMessage(mkDeps(store, { arr, search: MATRIX, mediaInfo: PROCESSING }), grpMsg('!prioritize the matrix'));
  assert.match(replies[0]!.text, /pushed \*The Matrix\* to the front/);
  assert.deepEqual(arr.calls, [{ mediaType: 'movie', itemId: 55, serverId: 0 }]);
  assert.equal(store.getPriorityCount(MEMBER), 1);
  store.close();
});

test('prioritize <tv>: force-searches Sonarr', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const search = [{ id: 1396, mediaType: 'tv', name: 'Breaking Bad' }];
  const mi = { status: 4, downloadStatus: [], externalServiceId: 7, serverId: 0 };
  const replies = await handleMessage(mkDeps(store, { arr, search, mediaInfo: mi }), grpMsg('!prioritize breaking bad'));
  assert.match(replies[0]!.text, /pushed \*Breaking Bad\*/);
  assert.deepEqual(arr.calls, [{ mediaType: 'tv', itemId: 7, serverId: 0 }]);
  store.close();
});

test('bare !prioritize: targets the most recent real request', async () => {
  const store = new Store(':memory:');
  store.audit({ senderJid: `${MEMBER}@s.whatsapp.net`, senderNumber: MEMBER, groupJid: GROUP, command: 'movie The Matrix', seerrMediaType: 'movie', seerrMediaId: 603, seerrRequestId: 1, status: 'queued' });
  const arr = mockArr();
  const replies = await handleMessage(mkDeps(store, { arr, mediaInfo: PROCESSING }), grpMsg('!prioritize'));
  assert.match(replies[0]!.text, /pushed \*The Matrix\* to the front/);
  assert.deepEqual(arr.calls, [{ mediaType: 'movie', itemId: 55, serverId: 0 }]);
  store.close();
});

test('bare !prioritize with no history → nudges to name a title', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const replies = await handleMessage(mkDeps(store, { arr }), grpMsg('!prioritize'));
  assert.match(replies[0]!.text, /no recent request/);
  assert.equal(arr.calls.length, 0);
  store.close();
});

test('prioritize: downloader unreachable → friendly error, no quota consumed', async () => {
  const store = new Store(':memory:');
  const arr = mockArr({ fail: true });
  const replies = await handleMessage(mkDeps(store, { arr, search: MATRIX, mediaInfo: PROCESSING }), grpMsg('!prioritize the matrix'));
  assert.match(replies[0]!.text, /couldn't reach the downloader/);
  assert.equal(store.getPriorityCount(MEMBER), 0);
  store.close();
});

test('prioritize: enforces the per-day cap (2), then refuses', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 2; i++) {
    const replies = await handleMessage(mkDeps(store, { arr: mockArr(), search: MATRIX, mediaInfo: PROCESSING }), grpMsg('!prioritize the matrix'));
    assert.match(replies[0]!.text, /pushed/);
  }
  assert.equal(store.getPriorityCount(MEMBER), 2);
  const arr3 = mockArr();
  const replies = await handleMessage(mkDeps(store, { arr: arr3, search: MATRIX, mediaInfo: PROCESSING }), grpMsg('!prioritize the matrix'));
  assert.match(replies[0]!.text, /used your 2 priorities/);
  assert.equal(arr3.calls.length, 0);   // capped → no force-search
  store.close();
});
