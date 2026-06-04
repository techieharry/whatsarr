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
// A requested title carries mediaInfo.status in the SEARCH result (that's how
// the handler decides it's requestable before the detail lookup); UNREQ has none.
const MATRIX = [{ id: 603, mediaType: 'movie', title: 'The Matrix', mediaInfo: { status: 3 } }];
const UNREQ = [{ id: 603, mediaType: 'movie', title: 'The Matrix' }];

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
  const replies = await handleMessage(mkDeps(store, { arr, search: UNREQ }), grpMsg('!prioritize the matrix'));
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
  const search = [{ id: 1396, mediaType: 'tv', name: 'Breaking Bad', mediaInfo: { status: 4 } }];
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

// Regression (live, 2026-06-04): a title can exist as BOTH a movie and a TV
// entry on TMDb. "Cyber City Oedo 808" = tv 64210 (unrequested, ranked first by
// Seerr) + movie 97187 (the REQUESTED, downloading one). Must prioritize the
// movie, not blindly trust search()[0].
test('prioritize <title>: dual movie+tv entry → picks the REQUESTED one, not search[0]', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const seerr = {
    search: async () => [
      { id: 64210, mediaType: 'tv', name: 'Cyber City Oedo 808' },                      // ranked first, NOT requested
      { id: 97187, mediaType: 'movie', title: 'Cyber City Oedo 808', mediaInfo: { status: 3 } }, // requested + downloading
    ],
    getMediaInfo: async (type: string, id: number) =>
      type === 'movie' && id === 97187
        ? { status: 3, downloadStatus: [], externalServiceId: 959, serverId: null }
        : null,
  } as any;
  const replies = await handleMessage({ store, seerr, arr } as any, grpMsg('!prioritize Cyber City Oedo 808'));
  assert.match(replies[0]!.text, /pushed \*Cyber City Oedo 808\* to the front/);
  assert.deepEqual(arr.calls, [{ mediaType: 'movie', itemId: 959, serverId: null }]);   // the MOVIE's *arr id
  store.close();
});

test('prioritize <title>: nothing requested across entries → falls back to top hit + "request it first"', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const seerr = {
    search: async () => [
      { id: 1, mediaType: 'tv', name: 'Foo' },
      { id: 2, mediaType: 'movie', title: 'Foo' },
    ],
    getMediaInfo: async () => null,
  } as any;
  const replies = await handleMessage({ store, seerr, arr } as any, grpMsg('!prioritize foo'));
  assert.match(replies[0]!.text, /doesn't look requested/);
  assert.equal(arr.calls.length, 0);
  store.close();
});

// Live follow-up (2026-06-04): the member then requested the TV form TOO, so both
// the movie (Radarr 959) AND the show (Sonarr 230) are downloading. One
// !prioritize must fan out to BOTH *arr, consuming a single priority.
test('prioritize <title>: BOTH movie + show requested → fans out to both *arr, one quota', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const seerr = {
    search: async () => [
      { id: 64210, mediaType: 'tv', name: 'Cyber City Oedo 808', mediaInfo: { status: 3 } },
      { id: 97187, mediaType: 'movie', title: 'Cyber City Oedo 808', mediaInfo: { status: 3 } },
    ],
    getMediaInfo: async (type: string, id: number) =>
      type === 'tv' && id === 64210 ? { status: 3, downloadStatus: [], externalServiceId: 230, serverId: null } :
      type === 'movie' && id === 97187 ? { status: 3, downloadStatus: [], externalServiceId: 959, serverId: null } : null,
  } as any;
  const replies = await handleMessage({ store, seerr, arr } as any, grpMsg('!prioritize Cyber City Oedo 808'));
  assert.match(replies[0]!.text, /pushed \*Cyber City Oedo 808\* \(show \+ movie\)/);
  assert.equal(arr.calls.length, 2);
  assert.ok(arr.calls.some(c => c.mediaType === 'tv' && c.itemId === 230));
  assert.ok(arr.calls.some(c => c.mediaType === 'movie' && c.itemId === 959));
  assert.equal(store.getPriorityCount(MEMBER), 1);   // ONE priority for the whole command
  store.close();
});

test('prioritize: blacklisted/deleted (status 6) → not force-searched, no quota', async () => {
  const store = new Store(':memory:');
  const arr = mockArr();
  const seerr = {
    search: async () => [{ id: 7, mediaType: 'movie', title: 'Nope', mediaInfo: { status: 6 } }],
    getMediaInfo: async () => ({ status: 6, downloadStatus: [], externalServiceId: 5, serverId: 0 }),
  } as any;
  const replies = await handleMessage({ store, seerr, arr } as any, grpMsg('!prioritize nope'));
  assert.match(replies[0]!.text, /removed\/blacklisted/);
  assert.equal(arr.calls.length, 0);
  assert.equal(store.getPriorityCount(MEMBER), 0);
  store.close();
});
