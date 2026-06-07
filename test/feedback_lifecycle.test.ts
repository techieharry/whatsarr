import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Stub config BEFORE importing handler. Fictional/placeholder identifiers only.
process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.ADMIN_NUMBERS = '+15555550100';
process.env.COMMAND_PREFIX = '!';
process.env.WEBHOOK_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

const { handleMessage } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');
const { parse } = await import('../src/parser/commands.ts');

const GROUP = '120363111111111111@g.us';
const ADMIN_NUM = '15555550100';
const ADMIN_JID = '15555550100@s.whatsapp.net';
const MEMBER_NUM = '15551112222';
const MEMBER_JID = '15551112222@s.whatsapp.net';

function fakeSeerr() {
  return {
    search: async () => [],
    createRequest: async () => ({ id: 1 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async () => null,
    getTvDetails: async () => ({ numberOfSeasons: 1, seasons: [] }),
    listPendingRequests: async () => [],
    approveRequest: async (id: number) => ({ id }),
    declineRequest: async (id: number) => ({ id }),
    retryRequest: async (id: number) => ({ id }),
  };
}
function freshStore() { return new Store(':memory:'); }

// ---------- parser ----------
test('parse !resolve <id> <note>', () => {
  assert.deepEqual(parse('!resolve 5 fixed the webhook'), {
    kind: 'feedbackAdmin', op: 'resolve', id: 5, note: 'fixed the webhook',
  });
});
test('parse !wontfix <id> (no note)', () => {
  assert.deepEqual(parse('!wontfix 7'), { kind: 'feedbackAdmin', op: 'wontfix', id: 7, note: null });
});
test('parse !resolve with no id -> incomplete', () => {
  assert.equal(parse('!resolve').kind, 'incomplete');
});
test('parse !resolve with non-numeric id -> incomplete', () => {
  assert.equal(parse('!resolve abc').kind, 'incomplete');
});
test('parse !open -> list', () => {
  assert.deepEqual(parse('!open'), { kind: 'feedbackAdmin', op: 'open', id: null, note: null });
});

// ---------- store ----------
test('store: resolveFeedback transitions, returns reporter row, counts open', () => {
  const store = freshStore();
  const id = store.recordFeedback({ kind: 'issue', senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, groupJid: GROUP, body: 'x broke', report: null });
  assert.equal(store.countOpenFeedback(), 1);
  const row = store.resolveFeedback(id, 'resolved', ADMIN_NUM, 'fixed');
  assert.ok(row);
  assert.equal(row!.prevStatus, 'open');
  assert.equal(row!.status, 'resolved');
  assert.equal(row!.senderJid, MEMBER_JID);
  assert.equal(store.countOpenFeedback(), 0);
  assert.equal(store.listFeedback(undefined, 50, 'open').length, 0);
  const all = store.listFeedback();
  assert.equal(all[0]!.status, 'resolved');
  assert.equal(all[0]!.resolution, 'fixed');
  store.close();
});
test('store: resolveFeedback on unknown id -> null', () => {
  const store = freshStore();
  assert.equal(store.resolveFeedback(99999, 'resolved', ADMIN_NUM, null), null);
  store.close();
});

// ---------- handler ----------
test('handler: !issue ack surfaces the #id and DMs the admin', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() } as any,
    { fromJid: GROUP, senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, text: '!issue ready DM never arrived', isGroup: true } as any,
  );
  const id = store.listFeedback()[0]!.id;
  const ack = replies.find(r => r.to === GROUP);
  assert.ok(ack && ack.text.includes('#' + id));
  assert.ok(replies.some(r => r.to === ADMIN_JID));
  store.close();
});

test('handler: admin !resolve marks resolved + DMs the reporter (close the loop)', async () => {
  const store = freshStore();
  const id = store.recordFeedback({ kind: 'issue', senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, groupJid: GROUP, body: 'x broke', report: null });
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUM, text: `!resolve ${id} pushed a fix`, isGroup: false } as any,
  );
  assert.equal(store.listFeedback()[0]!.status, 'resolved');
  assert.ok(replies.some(r => r.to === ADMIN_JID && /resolved/.test(r.text)));
  const reporterDm = replies.find(r => r.to === MEMBER_JID);
  assert.ok(reporterDm, 'reporter should get a close-the-loop DM');
  assert.ok(reporterDm!.text.includes('#' + id));
  assert.match(reporterDm!.text, /resolved/);
  assert.match(reporterDm!.text, /pushed a fix/);
  store.close();
});

test('handler: admin !wontfix dismisses + DMs reporter', async () => {
  const store = freshStore();
  const id = store.recordFeedback({ kind: 'feedback', senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, groupJid: GROUP, body: 'meh', report: null });
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUM, text: `!wontfix ${id} out of scope`, isGroup: false } as any,
  );
  assert.equal(store.listFeedback()[0]!.status, 'wontfix');
  assert.ok(replies.some(r => r.to === MEMBER_JID && /won't fix/.test(r.text)));
  store.close();
});

test('handler: non-admin !resolve in group is silently dropped, status unchanged', async () => {
  const store = freshStore();
  const id = store.recordFeedback({ kind: 'feedback', senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, groupJid: GROUP, body: 'nice', report: null });
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() } as any,
    { fromJid: GROUP, senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, text: `!resolve ${id}`, isGroup: true } as any,
  );
  assert.deepEqual(replies, []);
  assert.equal(store.listFeedback()[0]!.status, 'open');
  store.close();
});

test('handler: cold non-admin !resolve in DM is dropped (cannot resolve)', async () => {
  const store = freshStore();
  const id = store.recordFeedback({ kind: 'feedback', senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, groupJid: GROUP, body: 'hi', report: null });
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() } as any,
    { fromJid: MEMBER_JID, senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, text: `!resolve ${id}`, isGroup: false } as any,
  );
  assert.deepEqual(replies, []);
  assert.equal(store.listFeedback()[0]!.status, 'open');
  store.close();
});

test('handler: admin !open lists open items', async () => {
  const store = freshStore();
  store.recordFeedback({ kind: 'issue', senderJid: MEMBER_JID, senderNumber: MEMBER_NUM, groupJid: GROUP, body: 'aaa', report: null });
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() } as any,
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUM, text: '!open', isGroup: false } as any,
  );
  assert.ok(replies.some(r => /open items/.test(r.text)));
  store.close();
});
