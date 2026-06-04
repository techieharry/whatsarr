import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.ADMIN_NUMBERS = '+15555550100';
process.env.COMMAND_PREFIX = '!';
process.env.REQUESTS_PER_DAY = '5';
process.env.SEERR_DEFAULT_USER_ID = '1';
process.env.WEBHOOK_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

const { handleMessage } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');
const { parse } = await import('../src/parser/commands.ts');

const ALLOWED_GROUP = '120363111111111111@g.us';
const ADMIN_JID = '15555550100@s.whatsapp.net';
const ADMIN_NUM = '15555550100';
const USER_JID = '15551234567@s.whatsapp.net';
const USER_NUM = '15551234567';

// fakeSeerr that records the args every createRequest receives, so we can assert
// the resolved userId is threaded through the request flow.
function capturingSeerr(calls: any[]) {
  return {
    search: async () => [{ id: 42, mediaType: 'movie', title: 'Dune', releaseDate: '2021-01-01' }],
    createRequest: async (args: any) => { calls.push(args); return { id: 555 }; },
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async () => null,
    getTvDetails: async () => ({ numberOfSeasons: 1, seasons: [{ seasonNumber: 1, episodeCount: 10 }] }),
    listPendingRequests: async () => [],
    approveRequest: async (id: number) => ({ id }),
    declineRequest: async (id: number) => ({ id }),
    retryRequest: async (id: number) => ({ id }),
  };
}
function s() { return new Store(':memory:'); }

// ---------- parser ----------

test('parser: !map (bare) → list', () => {
  assert.deepEqual(parse('!map'), { kind: 'map', op: 'list', number: null, seerrUserId: null });
});
test('parser: !map list → list', () => {
  assert.deepEqual(parse('!map list'), { kind: 'map', op: 'list', number: null, seerrUserId: null });
});
test('parser: !map <number> <id> → set, strips + and dashes within the token', () => {
  assert.deepEqual(parse('!map +1-555-555-0101 3'), { kind: 'map', op: 'set', number: '15555550101', seerrUserId: 3 });
});
test('parser: !map with non-numeric userId → incomplete', () => {
  assert.equal(parse('!map 15555550101 abc').kind, 'incomplete');
});
test('parser: !map with number but no userId → incomplete', () => {
  assert.equal(parse('!map 15555550101').kind, 'incomplete');
});
test('parser: !map with userId < 1 → incomplete', () => {
  assert.equal(parse('!map 15555550101 0').kind, 'incomplete');
});
test('parser: !unmap <number> → unset', () => {
  assert.deepEqual(parse('!unmap +15555550101'), { kind: 'map', op: 'unset', number: '15555550101', seerrUserId: null });
});
test('parser: !unmap with no number → incomplete', () => {
  assert.equal(parse('!unmap').kind, 'incomplete');
});

// ---------- store ----------

test('store: set / get / upsert / delete / list user map', () => {
  const store = s();
  assert.equal(store.getSeerrUserId(USER_NUM), null);
  store.setSeerrUserId(USER_NUM, 7);
  assert.equal(store.getSeerrUserId(USER_NUM), 7);
  store.setSeerrUserId(USER_NUM, 9);                       // upsert, not duplicate
  assert.equal(store.getSeerrUserId(USER_NUM), 9);
  assert.deepEqual(
    store.listUserMap().map(r => ({ n: r.senderNumber, u: r.seerrUserId })),
    [{ n: USER_NUM, u: 9 }],
  );
  store.deleteSeerrUserId(USER_NUM);
  assert.equal(store.getSeerrUserId(USER_NUM), null);
  store.close();
});

// ---------- handler: !map admin command ----------

test('handler: !map set from admin records mapping + confirms', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: capturingSeerr([]) },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUM, text: `!map ${USER_NUM} 4`, isGroup: false },
  );
  assert.equal(store.getSeerrUserId(USER_NUM), 4);
  assert.match(replies[0]!.text, /Seerr user #4/);
  store.close();
});

test('handler: !map list from admin reports mappings', async () => {
  const store = s();
  store.setSeerrUserId(USER_NUM, 4);
  const replies = await handleMessage(
    { store, seerr: capturingSeerr([]) },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUM, text: '!map', isGroup: false },
  );
  assert.match(replies[0]!.text, new RegExp(USER_NUM));
  assert.match(replies[0]!.text, /#4/);
  store.close();
});

test('handler: !unmap from admin removes mapping', async () => {
  const store = s();
  store.setSeerrUserId(USER_NUM, 4);
  await handleMessage(
    { store, seerr: capturingSeerr([]) },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUM, text: `!unmap ${USER_NUM}`, isGroup: false },
  );
  assert.equal(store.getSeerrUserId(USER_NUM), null);
  store.close();
});

test('handler: !map from non-admin in group → silent drop, no mapping written', async () => {
  const store = s();
  const replies = await handleMessage(
    { store, seerr: capturingSeerr([]) },
    { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: `!map ${USER_NUM} 4`, isGroup: true },
  );
  assert.deepEqual(replies, []);
  assert.equal(store.getSeerrUserId(USER_NUM), null);
  store.close();
});

// ---------- integration: userId threads into createRequest ----------

test('integration: mapped user → createRequest gets the mapped userId', async () => {
  const store = s();
  store.setSeerrUserId(USER_NUM, 8);
  const calls: any[] = [];
  const seerr = capturingSeerr(calls);
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: '!movie dune', isGroup: true });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: 'YES', isGroup: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 8);
  store.close();
});

test('integration: unmapped user → createRequest userId undefined (client falls back to default)', async () => {
  const store = s();
  const calls: any[] = [];
  const seerr = capturingSeerr(calls);
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: '!movie dune', isGroup: true });
  await handleMessage({ store, seerr }, { fromJid: ALLOWED_GROUP, senderJid: USER_JID, senderNumber: USER_NUM, text: 'YES', isGroup: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, undefined);
  store.close();
});
