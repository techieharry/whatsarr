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

const { handleMessage, parsePickList, parseSeasonSelector } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');
const { parse } = await import('../src/parser/commands.ts');

const ALLOWED_GROUP = '120363111111111111@g.us';
const ADMIN_JID = '15555550100@s.whatsapp.net';
const USER_JID = '15551234567@s.whatsapp.net';
const USER_NUM = '15551234567';

function fakeSeerr(opts: {
  searchResults?: any[];
  createRequestId?: number;
  tvDetails?: (id: number) => any;
  throwOnCreate?: boolean;
  pending?: any[];
  approveCalls?: number[];
  declineCalls?: number[];
} = {}) {
  return {
    search: async () => opts.searchResults ?? [],
    createRequest: async () => {
      if (opts.throwOnCreate) throw new Error('seerr down');
      return { id: opts.createRequestId ?? 999 };
    },
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async () => null,
    getTvDetails: async (id: number) => opts.tvDetails ? opts.tvDetails(id) : { numberOfSeasons: 5, seasons: [{ seasonNumber: 1, episodeCount: 10 }] },
    listPendingRequests: async () => opts.pending ?? [],
    approveRequest: async (id: number) => { opts.approveCalls?.push(id); return { id }; },
    declineRequest: async (id: number) => { opts.declineCalls?.push(id); return { id }; },
    retryRequest: async (id: number) => ({ id }),
  };
}
function s() { return new Store(':memory:'); }

// ---------- parser pure-fn tests ----------

test('parsePickList: single number', () => {
  assert.deepEqual(parsePickList('1', 3), [1]);
});
test('parsePickList: comma list', () => {
  assert.deepEqual(parsePickList('1,3', 3), [1, 3]);
});
test('parsePickList: comma list with spaces', () => {
  assert.deepEqual(parsePickList('1, 2, 3', 3), [1, 2, 3]);
});
test('parsePickList: out of range → null', () => {
  assert.equal(parsePickList('5', 3), null);
});
test('parsePickList: duplicate → null', () => {
  assert.equal(parsePickList('1,1', 3), null);
});
test('parsePickList: non-numeric → null', () => {
  assert.equal(parsePickList('1,a', 3), null);
});
test('parsePickList: empty → null', () => {
  assert.equal(parsePickList('', 3), null);
});

test('parseSeasonSelector: all', () => {
  assert.equal(parseSeasonSelector('all', { numberOfSeasons: 5 }), 'all');
});
test('parseSeasonSelector: latest → last season', () => {
  assert.deepEqual(parseSeasonSelector('latest', { numberOfSeasons: 5 }), [5]);
});
test('parseSeasonSelector: latest with unknown count → null', () => {
  assert.equal(parseSeasonSelector('latest', { numberOfSeasons: null }), null);
});
test('parseSeasonSelector: range', () => {
  assert.deepEqual(parseSeasonSelector('1-3', { numberOfSeasons: 5 }), [1, 2, 3]);
});
test('parseSeasonSelector: range past total → null', () => {
  assert.equal(parseSeasonSelector('1-7', { numberOfSeasons: 5 }), null);
});
test('parseSeasonSelector: comma list', () => {
  assert.deepEqual(parseSeasonSelector('1,3,5', { numberOfSeasons: 5 }), [1, 3, 5]);
});
test('parseSeasonSelector: single', () => {
  assert.deepEqual(parseSeasonSelector('2', { numberOfSeasons: 5 }), [2]);
});
test('parseSeasonSelector: gibberish → null', () => {
  assert.equal(parseSeasonSelector('whenever', { numberOfSeasons: 5 }), null);
});

// ---------- !feedback / !issue parser ----------

test('parser: !feedback <body>', () => {
  assert.deepEqual(parse('!feedback the bot is great'), { kind: 'feedback', body: 'the bot is great' });
});
test('parser: !fb alias', () => {
  assert.deepEqual(parse('!fb works'), { kind: 'feedback', body: 'works' });
});
test('parser: !feedback with no body → incomplete', () => {
  assert.equal(parse('!feedback').kind, 'incomplete');
});
test('parser: !issue <body>', () => {
  assert.deepEqual(parse('!issue ready DM never arrived'), { kind: 'issue', body: 'ready DM never arrived' });
});
test('parser: !bug / !report aliases for issue', () => {
  assert.equal(parse('!bug X').kind, 'issue');
  assert.equal(parse('!report Y').kind, 'issue');
});

test('parser: !sync / !syncstatus aliases', () => {
  assert.deepEqual(parse('!sync'), { kind: 'sync' });
  assert.deepEqual(parse('!syncstatus'), { kind: 'sync' });
});

// ---------- !sync handler ----------

function fakeSyncthing(opts: { configured?: boolean; completion?: any; status?: any; throwOn?: 'completion' | 'status' } = {}) {
  return {
    isConfigured: () => opts.configured !== false,
    getCompletion: async () => {
      if (opts.throwOn === 'completion') throw new Error('boom completion');
      return opts.completion ?? { completion: 100, needBytes: 0, needItems: 0, needDeletes: 0, globalBytes: 1024 * 1024 * 1024 * 1024 };
    },
    getFolderStatus: async () => {
      if (opts.throwOn === 'status') throw new Error('boom status');
      return opts.status ?? { state: 'idle', stateChanged: '', globalBytes: 1024 * 1024 * 1024 * 1024, globalFiles: 100, inSyncBytes: 1024 * 1024 * 1024 * 1024, inSyncFiles: 100, needBytes: 0, needFiles: 0, needDeletes: 0, errors: 0 };
    },
  };
}

test('!sync: when remote is at 100% → "in sync ✓"', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr(), syncthing: fakeSyncthing() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!sync', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /in sync ✓/);
  assert.match(replies[0]!.text, /1\.00 TB/);
  store.close();
});

test('!sync: when remote has bytes pending → percent + human-readable pending', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr(), syncthing: fakeSyncthing({
      completion: { completion: 99.43, needBytes: 74_000_000_000, needItems: 19, needDeletes: 0, globalBytes: 13_000_000_000_000 },
    }) },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!sync', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /99\.43%/);
  assert.match(replies[0]!.text, /68\.92 GB|68\.91 GB|69 GB|68\.\d+ GB/);  // 74_000_000_000 bytes ≈ 68.9 GB (binary)
  assert.match(replies[0]!.text, /19 items pending/);
  store.close();
});

test('!sync: when syncthing not configured → graceful message', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr(), syncthing: fakeSyncthing({ configured: false }) },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!sync', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /not configured/);
  store.close();
});

test('!sync: when syncthing unreachable → graceful error', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr(), syncthing: fakeSyncthing({ throwOn: 'completion' }) },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!sync', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /unreachable/);
  store.close();
});

test('!sync: errors > 0 → adds local-error callout', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr(), syncthing: fakeSyncthing({
      completion: { completion: 50, needBytes: 1_000_000_000, needItems: 5, needDeletes: 0, globalBytes: 2_000_000_000 },
      status: { state: 'syncing', stateChanged: '', globalBytes: 2_000_000_000, globalFiles: 10, inSyncBytes: 1_000_000_000, inSyncFiles: 5, needBytes: 1_000_000_000, needFiles: 5, needDeletes: 0, errors: 3 },
    }) },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!sync', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /50\.00%/);
  assert.match(replies[0]!.text, /local has 3 errors/);
  store.close();
});

test('!sync: works in DM (admin)', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr(), syncthing: fakeSyncthing() },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!sync', isGroup: false },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /in sync/);
  store.close();
});

// ---------- multi-select flow ----------

test('pick: reply "1,3" queues both, single summary reply, no confirm state', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [
      { id: 1, mediaType: 'movie', title: 'A', releaseDate: '2000-01-01' },
      { id: 2, mediaType: 'movie', title: 'B', releaseDate: '2001-01-01' },
      { id: 3, mediaType: 'movie', title: 'C', releaseDate: '2002-01-01' },
    ],
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie x', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '1,3', isGroup: true });
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Queued by @15555550100.*A \(2000\).*C \(2002\)/);
  assert.equal(store.getState(ADMIN_JID), null);
  assert.equal(store.getQuota('15555550100'), 2);
  store.close();
});

test('pick: reply "1,2,3" with quota=5 already at 4 queues 1 and reports 2 skipped', async () => {
  const store = s();
  for (let i = 0; i < 4; i++) store.bumpQuota('15555550100');
  const seerr = fakeSeerr({
    searchResults: [
      { id: 1, mediaType: 'movie', title: 'A', releaseDate: '2000-01-01' },
      { id: 2, mediaType: 'movie', title: 'B', releaseDate: '2001-01-01' },
      { id: 3, mediaType: 'movie', title: 'C', releaseDate: '2002-01-01' },
    ],
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie x', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '1,2,3', isGroup: true });
  assert.match(replies[0]!.text, /Queued by @15555550100.*A \(2000\)/);
  assert.match(replies[0]!.text, /daily limit hit.*B \(2001\), C \(2002\)/);
  assert.equal(store.getQuota('15555550100'), 5);
  store.close();
});

test('pick: reply "1,2" skipping already-available, queues the rest', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [
      { id: 1, mediaType: 'movie', title: 'OnPlex', releaseDate: '2000-01-01', mediaInfo: { status: 5 } },
      { id: 2, mediaType: 'movie', title: 'New', releaseDate: '2001-01-01' },
    ],
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie x', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '1,2', isGroup: true });
  assert.match(replies[0]!.text, /already on Plex.*OnPlex \(2000\)/);
  assert.match(replies[0]!.text, /Queued.*New \(2001\)/);
  store.close();
});

// ---------- season picker ----------

test('single TV result → season picker, NOT confirm', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [{ id: 100, mediaType: 'tv', title: 'Breaking Bad', firstAirDate: '2008-01-20' }],
    tvDetails: () => ({ numberOfSeasons: 5, seasons: [] }),
  });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv breaking bad', isGroup: true });
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Breaking Bad \(2008\)/);
  assert.match(replies[0]!.text, /5\* season/);
  assert.match(replies[0]!.text, /which seasons/i);
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'season');
  store.close();
});

test('season picker: reply "1-3" queues seasons 1,2,3, no confirm step', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [{ id: 100, mediaType: 'tv', title: 'Breaking Bad', firstAirDate: '2008-01-20' }],
    tvDetails: () => ({ numberOfSeasons: 5, seasons: [] }),
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv breaking bad', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '1-3', isGroup: true });
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Breaking Bad \(2008\)\*? \(seasons 1, 2, 3\) queued/);
  assert.equal(store.getState(ADMIN_JID), null);
  assert.equal(store.getQuota('15555550100'), 1);
  store.close();
});

test('season picker: reply "all" → seasons all', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [{ id: 100, mediaType: 'tv', title: 'BB', firstAirDate: '2008-01-20' }],
    tvDetails: () => ({ numberOfSeasons: 5, seasons: [] }),
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv bb', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'all', isGroup: true });
  assert.match(replies[0]!.text, /all seasons.*queued/);
  store.close();
});

test('season picker: reply "latest" → last season', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [{ id: 100, mediaType: 'tv', title: 'BB', firstAirDate: '2008-01-20' }],
    tvDetails: () => ({ numberOfSeasons: 7, seasons: [] }),
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv bb', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'latest', isGroup: true });
  assert.match(replies[0]!.text, /season 7.*queued/);
  store.close();
});

test('season picker: gibberish re-emits prompt (first time)', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [{ id: 100, mediaType: 'tv', title: 'BB', firstAirDate: '2008-01-20' }],
    tvDetails: () => ({ numberOfSeasons: 5, seasons: [] }),
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv bb', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'whenever', isGroup: true });
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /which seasons/i);
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'season');
  store.close();
});

test('season picker: NO clears state, no quota', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [{ id: 100, mediaType: 'tv', title: 'BB', firstAirDate: '2008-01-20' }],
    tvDetails: () => ({ numberOfSeasons: 5, seasons: [] }),
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv bb', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'NO', isGroup: true });
  assert.match(replies[0]!.text, /Skipped \*?BB/);
  assert.equal(store.getState(ADMIN_JID), null);
  assert.equal(store.getQuota('15555550100'), 0);
  store.close();
});

test('pick: single TV pick routes to season picker', async () => {
  const store = s();
  const seerr = fakeSeerr({
    searchResults: [
      { id: 1, mediaType: 'tv', title: 'Show A', firstAirDate: '2010-01-01' },
      { id: 2, mediaType: 'tv', title: 'Show B', firstAirDate: '2011-01-01' },
    ],
    tvDetails: (id: number) => ({ numberOfSeasons: id === 1 ? 3 : 4, seasons: [] }),
  });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv show', isGroup: true });
  const replies = await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '2', isGroup: true });
  assert.match(replies[0]!.text, /Show B \(2011\)/);
  assert.match(replies[0]!.text, /4\* season/);
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'season');
  store.close();
});

// ---------- !feedback / !issue handler ----------

test('!feedback from group: ack + admin DM, stored in DB', async () => {
  const store = s();
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: '!feedback the picker is great', isGroup: true },
  );
  // 1 group ack + 1 admin DM (admin is not the sender)
  assert.equal(replies.length, 2);
  assert.equal(replies[0]!.to, ALLOWED_GROUP);
  assert.match(replies[0]!.text, /logged/);
  assert.equal(replies[1]!.to, '15555550100@s.whatsapp.net');
  assert.match(replies[1]!.text, /feedback.*from @15551234567/);
  assert.match(replies[1]!.text, /the picker is great/);
  assert.match(replies[1]!.text, /validation/);
  store.close();
});

test('!feedback from admin: no self-DM (skipped)', async () => {
  const store = s();
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!feedback works', isGroup: true },
  );
  // Only the group ack — admin is sender, so admin DM skipped
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.to, ALLOWED_GROUP);
  store.close();
});

test('!issue: ack + admin DM with diagnosis containing audit and pending counters', async () => {
  const store = s();
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: '!issue ready DM never arrived', isGroup: true },
  );
  assert.equal(replies.length, 2);
  assert.match(replies[0]!.text, /issue logged/);
  assert.equal(replies[1]!.to, '15555550100@s.whatsapp.net');
  assert.match(replies[1]!.text, /issue.*from @15551234567/);
  assert.match(replies[1]!.text, /ready DM never arrived/);
  assert.match(replies[1]!.text, /diagnosis/);
  assert.match(replies[1]!.text, /audit \(24h\)/);
  assert.match(replies[1]!.text, /pending notifications/);
  store.close();
});

test('!feedback / !issue without prefix: DMs require admin (silent drop for randoms)', async () => {
  const store = s();
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: USER_JID, senderJid: USER_JID, senderNumber: USER_NUM, text: '!feedback hi', isGroup: false },
  );
  // DM from random number with no state → silent drop
  assert.deepEqual(replies, []);
  store.close();
});

// ---------- pending-notification queue ----------

test('store.enqueuePending → listPending → deletePending round-trip', () => {
  const store = s();
  const id = store.enqueuePending('target@x', 'hello', ['m@x']);
  assert.equal(store.countPending(), 1);
  const list = store.listPending();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, id);
  assert.equal(list[0]!.targetJid, 'target@x');
  assert.equal(list[0]!.text, 'hello');
  assert.deepEqual(list[0]!.mentions, ['m@x']);
  store.deletePending(id);
  assert.equal(store.countPending(), 0);
  store.close();
});

test('store.markPendingFailed + reapDeadPending drops after maxAttempts', () => {
  const store = s();
  const id = store.enqueuePending('t@x', 'msg');
  for (let i = 0; i < 5; i++) store.markPendingFailed(id, 'err');
  const reaped = store.reapDeadPending(5);
  assert.equal(reaped, 1);
  assert.equal(store.countPending(), 0);
  store.close();
});

// ---------- admin commands ----------

test('parser: !pending → admin/pending', () => {
  const p = parse('!pending');
  assert.deepEqual(p, { kind: 'admin', action: 'pending', requestId: null });
});
test('parser: !approve 42 → admin/approve', () => {
  const p = parse('!approve 42');
  assert.deepEqual(p, { kind: 'admin', action: 'approve', requestId: 42 });
});
test('parser: !deny 7 → admin/deny', () => {
  const p = parse('!deny 7');
  assert.deepEqual(p, { kind: 'admin', action: 'deny', requestId: 7 });
});
test('parser: !decline 7 aliases !deny', () => {
  const p = parse('!decline 7');
  assert.deepEqual(p, { kind: 'admin', action: 'deny', requestId: 7 });
});
test('parser: !shutdown → admin/shutdown', () => {
  const p = parse('!shutdown');
  assert.deepEqual(p, { kind: 'admin', action: 'shutdown', requestId: null });
});
test('parser: !restart aliases !shutdown', () => {
  const p = parse('!restart');
  assert.deepEqual(p, { kind: 'admin', action: 'shutdown', requestId: null });
});
test('parser: !approve without id → incomplete', () => {
  const p = parse('!approve');
  assert.equal(p.kind, 'incomplete');
});
test('parser: !approve garbage → incomplete', () => {
  const p = parse('!approve foo');
  assert.equal(p.kind, 'incomplete');
});

test('admin: !pending from non-admin DM → "Admin only."', async () => {
  const store = s();
  store.setState(USER_JID, { awaiting: 'confirm', payload: {}, expiresAt: Date.now() + 60000 });  // grant DM allowance
  const seerr = fakeSeerr({ pending: [{ id: 1, status: 1, mediaType: 'movie', tmdbId: 1, title: 'X', requestedBy: 'u', createdAt: '' }] });
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: USER_JID, senderJid: USER_JID, senderNumber: USER_NUM, text: '!pending', isGroup: false },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Admin only/);
  store.close();
});

test('admin: !pending from admin → formatted list', async () => {
  const store = s();
  const seerr = fakeSeerr({
    pending: [
      { id: 17, status: 1, mediaType: 'movie', tmdbId: 11, title: 'Dune', requestedBy: 'alice', createdAt: '' },
      { id: 18, status: 1, mediaType: 'tv', tmdbId: 22, title: 'Severance', requestedBy: 'bob', createdAt: '' },
    ],
  });
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!pending', isGroup: false },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /pending requests \(2\)/);
  assert.match(replies[0]!.text, /`17`.*Dune.*movie.*alice/);
  assert.match(replies[0]!.text, /`18`.*Severance.*tv.*bob/);
  store.close();
});

test('admin: !pending in allowed group from non-admin → silent drop', async () => {
  const store = s();
  const seerr = fakeSeerr({ pending: [{ id: 1, status: 1, mediaType: 'movie', tmdbId: 1, title: 'X', requestedBy: 'u', createdAt: '' }] });
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: '!pending', isGroup: true },
  );
  assert.deepEqual(replies, []);
  store.close();
});

test('admin: !approve 42 calls seerr.approveRequest(42)', async () => {
  const store = s();
  const approveCalls: number[] = [];
  const seerr = fakeSeerr({ approveCalls });
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!approve 42', isGroup: false },
  );
  assert.deepEqual(approveCalls, [42]);
  assert.match(replies[0]!.text, /#42 approved/);
  store.close();
});

test('admin: !deny 7 calls seerr.declineRequest(7)', async () => {
  const store = s();
  const declineCalls: number[] = [];
  const seerr = fakeSeerr({ declineCalls });
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!deny 7', isGroup: false },
  );
  assert.deepEqual(declineCalls, [7]);
  assert.match(replies[0]!.text, /#7 denied/);
  store.close();
});

test('admin: !shutdown without shutdown hook → "not wired" reply', async () => {
  const store = s();
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!shutdown', isGroup: false },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /not wired/i);
  store.close();
});

test('admin: !shutdown with hook → acks then fires hook', async () => {
  const store = s();
  let fired = false;
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr, shutdown: () => { fired = true; } } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!shutdown', isGroup: false },
  );
  assert.match(replies[0]!.text, /Shutting down/);
  // hook fires on setImmediate; wait one microtask
  await new Promise(r => setImmediate(r));
  assert.equal(fired, true);
  store.close();
});

test('admin: !help from admin includes admin section', async () => {
  const store = s();
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!help', isGroup: false },
  );
  assert.match(replies[0]!.text, /admin only:/);
  assert.match(replies[0]!.text, /!approve <id>/);
  store.close();
});

test('admin: !help from non-admin omits admin section', async () => {
  const store = s();
  store.setState(USER_JID, { awaiting: 'confirm', payload: {}, expiresAt: Date.now() + 60000 });
  const seerr = fakeSeerr();
  const replies = await handleMessage(
    { store, seerr } as any,
    { fromJid: USER_JID, senderJid: USER_JID, senderNumber: USER_NUM, text: '!help', isGroup: false },
  );
  assert.doesNotMatch(replies[0]!.text, /admin only:/);
  store.close();
});

// ---------- failed-request retry loop ----------

function failedAuditFixture(store: any, opts: { senderJid?: string; senderNumber?: string; seerrId?: number } = {}) {
  const id = store.audit({
    senderJid: opts.senderJid ?? USER_JID,
    senderNumber: opts.senderNumber ?? USER_NUM,
    groupJid: null,
    command: 'movie test',
    resolvedRoute: '/media/movies/Western',
    seerrMediaType: 'movie',
    seerrMediaId: 99,
    seerrRequestId: opts.seerrId ?? 555,
    status: 'queued',
  });
  store.updateAudit(id, { status: 'failed' });
  return id;
}

test('retry: listFailedForRetry returns failed rows with no retries yet', () => {
  const store = s();
  failedAuditFixture(store);
  const list = store.listFailedForRetry(3, [60_000, 5*60_000, 30*60_000]);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.seerrRequestId, 555);
  assert.equal(list[0]!.attempts, 0);
  store.close();
});

test('retry: listFailedForRetry skips rows still in backoff window', () => {
  const store = s();
  const id = failedAuditFixture(store);
  store.markRetryFailed(id);  // attempts=1, last_retry_at=now
  const list = store.listFailedForRetry(3, [60_000, 5*60_000, 30*60_000]);
  assert.equal(list.length, 0);  // backoff[1] = 5min, just retried
  store.close();
});

test('retry: listFailedForRetry skips rows that exhausted maxAttempts', () => {
  const store = s();
  const id = failedAuditFixture(store);
  for (let i = 0; i < 3; i++) store.markRetryFailed(id);
  const list = store.listFailedForRetry(3, [60_000, 5*60_000, 30*60_000]);
  assert.equal(list.length, 0);
  store.close();
});

test('retry: listFailedForRetry skips rows without seerr_request_id', () => {
  const store = s();
  store.audit({
    senderJid: USER_JID, senderNumber: USER_NUM, groupJid: null,
    command: 'movie x', status: 'queued', seerrRequestId: null,
  });
  // Find that row and mark failed
  const rows = store.getUserRequests(USER_NUM, 5);
  assert.equal(rows.length, 1);
  // Need to update via audit id — fixture audit returns id; query for it
  const auditRow = (store as any).db.prepare('SELECT id FROM audit WHERE sender_number = ?').get(USER_NUM) as any;
  store.updateAudit(auditRow.id, { status: 'failed' });
  const list = store.listFailedForRetry(3, [60_000]);
  assert.equal(list.length, 0);
  store.close();
});

test('retry: markRetrySucceeded flips status to queued and bumps attempts', () => {
  const store = s();
  const id = failedAuditFixture(store);
  store.markRetrySucceeded(id);
  const row = (store as any).db.prepare('SELECT status, retry_attempts FROM audit WHERE id = ?').get(id) as any;
  assert.equal(row.status, 'queued');
  assert.equal(row.retry_attempts, 1);
  store.close();
});

test('retry: markRetryFailed bumps attempts without flipping status', () => {
  const store = s();
  const id = failedAuditFixture(store);
  store.markRetryFailed(id);
  const row = (store as any).db.prepare('SELECT status, retry_attempts FROM audit WHERE id = ?').get(id) as any;
  assert.equal(row.status, 'failed');
  assert.equal(row.retry_attempts, 1);
  store.close();
});

test('retry: backoff schedule honored — second retry waits 5min', () => {
  const store = s();
  const id = failedAuditFixture(store);
  // First retry — immediate
  let list = store.listFailedForRetry(3, [60_000, 5*60_000, 30*60_000]);
  assert.equal(list.length, 1);
  store.markRetrySucceeded(id);  // attempts=1

  // Same row was just flipped to 'queued', won't appear in list. Simulate
  // second Failed cycle: flip back to 'failed' manually.
  store.updateAudit(id, { status: 'failed' });

  // After 1 attempt, backoff[1] = 5min. We just retried; should be in backoff.
  list = store.listFailedForRetry(3, [60_000, 5*60_000, 30*60_000]);
  assert.equal(list.length, 0);

  // Backdate last_retry_at by 6 min — should now be eligible.
  (store as any).db.prepare('UPDATE audit SET last_retry_at = ? WHERE id = ?').run(Date.now() - 6 * 60_000, id);
  list = store.listFailedForRetry(3, [60_000, 5*60_000, 30*60_000]);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.attempts, 1);
  store.close();
});
