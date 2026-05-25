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

function fakeSeerr(opts: { searchResults?: any[]; createRequestId?: number; tvDetails?: (id: number) => any; throwOnCreate?: boolean } = {}) {
  return {
    search: async () => opts.searchResults ?? [],
    createRequest: async () => {
      if (opts.throwOnCreate) throw new Error('seerr down');
      return { id: opts.createRequestId ?? 999 };
    },
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async () => null,
    getTvDetails: async (id: number) => opts.tvDetails ? opts.tvDetails(id) : { numberOfSeasons: 5, seasons: [{ seasonNumber: 1, episodeCount: 10 }] },
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
