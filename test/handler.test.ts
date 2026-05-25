import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Stub config BEFORE importing handler (which imports config)
process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us,120363222222222222@g.us';
process.env.ADMIN_NUMBERS = '+15555550100';
process.env.COMMAND_PREFIX = '!';
process.env.REQUESTS_PER_DAY = '5';
process.env.WEBHOOK_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

const { handleMessage } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');

const ALLOWED_GROUP = '120363111111111111@g.us';
const OTHER_GROUP = '120363999999999999@g.us';
const ADMIN_JID = '15555550100@s.whatsapp.net';
const RANDOM_JID = '15551234567@s.whatsapp.net';

function fakeSeerr(opts: { searchResults?: any[]; createRequestId?: number; throw?: string; mediaInfo?: (mt: string, id: number) => any; tvDetails?: (id: number) => any } = {}) {
  return {
    search: async () => opts.searchResults ?? [{ id: 12345, mediaType: 'movie', title: 'Test Movie', releaseDate: '2024-01-01' }],
    createRequest: async () => ({ id: opts.createRequestId ?? 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async (mt: string, id: number) => opts.mediaInfo ? opts.mediaInfo(mt, id) : null,
    getTvDetails: async (id: number) => opts.tvDetails ? opts.tvDetails(id) : { numberOfSeasons: 1, seasons: [{ seasonNumber: 1, episodeCount: 10 }] },
  };
}

function freshStore() { return new Store(':memory:'); }

test('group: unauthorized group → silent drop', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: OTHER_GROUP, senderJid: RANDOM_JID, senderNumber: '15551234567', text: '!movie dune', isGroup: true },
  );
  assert.deepEqual(replies, []);
  store.close();
});

test('group: allowed group + missing prefix → silent drop', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: RANDOM_JID, senderNumber: '15551234567', text: 'just chatting', isGroup: true },
  );
  assert.deepEqual(replies, []);
  store.close();
});

test('DM: random number with no state → silent drop', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: RANDOM_JID, senderJid: RANDOM_JID, senderNumber: '15551234567', text: '!movie dune', isGroup: false },
  );
  assert.deepEqual(replies, []);
  store.close();
});

test('DM: admin → bare text treated as !req <text>, sets disambig state', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'chimp empire', isGroup: false },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /MOVIE or TV/);
  const state = store.getState(ADMIN_JID);
  assert.equal(state?.awaiting, 'movie_or_tv');
  store.close();
});

test('group: !movie → single group reply with confirm prompt, sets confirm state', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie dune part two', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.to, ALLOWED_GROUP);
  assert.match(replies[0]!.text, /Found: \*?Test Movie/);
  assert.match(replies[0]!.text, /can reply YES|Reply YES/);
  assert.deepEqual(replies[0]!.mentions, [ADMIN_JID]);
  const state = store.getState(ADMIN_JID);
  assert.equal(state?.awaiting, 'confirm');
  store.close();
});

test('confirm flow: YES from group creates Seerr request, audits, single group reply', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie dune part two', isGroup: true },
  );
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'YES', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.to, ALLOWED_GROUP);
  assert.match(replies[0]!.text, /queued by/);
  assert.equal(store.getState(ADMIN_JID), null);
  assert.equal(store.getQuota('15555550100'), 1);
  const requester = store.findRequester('movie', 12345);
  assert.equal(requester?.senderJid, ADMIN_JID);
  assert.equal(requester?.groupJid, ALLOWED_GROUP);
  store.close();
});

test('confirm flow: YES via DM still works (admin path), DM reply', async () => {
  const store = freshStore();
  // Admin requests via DM (no group)
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie dune part two', isGroup: false },
  );
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'YES', isGroup: false },
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.to, ADMIN_JID);
  assert.match(replies[0]!.text, /queued by/);
  store.close();
});

test('confirm flow: NO clears state, no quota bump, single group reply', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie dune', isGroup: true },
  );
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'NO', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.to, ALLOWED_GROUP);
  assert.match(replies[0]!.text, /Skipped/);
  assert.equal(store.getState(ADMIN_JID), null);
  assert.equal(store.getQuota('15555550100'), 0);
  store.close();
});

test('quota: hitting daily limit blocks new requests', async () => {
  const store = freshStore();
  for (let i = 0; i < 5; i++) store.bumpQuota('15555550100');
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie dune', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /daily limit/);
  store.close();
});

test('dedup: duplicate within window blocks', async () => {
  const store = freshStore();
  store.recordDedup('15555550100', 'movie', 'dune');
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie dune', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /already requested/);
  store.close();
});

test('routing: !movie asian → rejected (TV-only category)', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie asian foo', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Can't request/);
  store.close();
});

test('multi-result: picker reply with numbered list, pick state set', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [
      { id: 11, mediaType: 'movie', title: 'The Matrix', releaseDate: '1999-03-31', posterPath: '/a.jpg', overview: 'A hacker discovers reality.' },
      { id: 12, mediaType: 'movie', title: 'The Matrix Reloaded', releaseDate: '2003-05-15', posterPath: '/b.jpg' },
      { id: 13, mediaType: 'movie', title: 'The Matrix Resurrections', releaseDate: '2021-12-22', posterPath: '/c.jpg' },
    ],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
  };
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie matrix', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.to, ALLOWED_GROUP);
  assert.match(replies[0]!.text, /pick:/);
  assert.match(replies[0]!.text, /1\. \*?The Matrix \(1999\)\*?/);
  assert.match(replies[0]!.text, /2\. \*?The Matrix Reloaded \(2003\)\*?/);
  assert.match(replies[0]!.text, /3\. \*?The Matrix Resurrections \(2021\)\*?/);
  assert.match(replies[0]!.text, /Reply 1, 2, 3/);
  assert.equal(replies[0]!.imageUrl, undefined);  // picker is text-only
  const state = store.getState(ADMIN_JID);
  assert.equal(state?.awaiting, 'pick');
  store.close();
});

test('pick: reply 2 transitions to confirm with poster image', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [
      { id: 11, mediaType: 'movie', title: 'The Matrix', releaseDate: '1999-03-31', posterPath: '/a.jpg' },
      { id: 12, mediaType: 'movie', title: 'The Matrix Reloaded', releaseDate: '2003-05-15', posterPath: '/b.jpg', overview: 'Neo and the rebel leaders…' },
      { id: 13, mediaType: 'movie', title: 'The Matrix Resurrections', releaseDate: '2021-12-22', posterPath: '/c.jpg' },
    ],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
  };
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie matrix', isGroup: true },
  );
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '2', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.to, ALLOWED_GROUP);
  assert.match(replies[0]!.text, /Found: \*?The Matrix Reloaded \(2003\)\*?/);
  assert.match(replies[0]!.text, /can reply YES|Reply YES/);
  assert.equal(replies[0]!.imageUrl, 'https://image.tmdb.org/t/p/w500/b.jpg');
  const state = store.getState(ADMIN_JID);
  assert.equal(state?.awaiting, 'confirm');
  store.close();
});

test('pick: reply NO clears state, no confirm', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [
      { id: 11, mediaType: 'movie', title: 'The Matrix', releaseDate: '1999-03-31' },
      { id: 12, mediaType: 'movie', title: 'The Matrix Reloaded', releaseDate: '2003-05-15' },
    ],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
  };
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie matrix', isGroup: true },
  );
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'NO', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Skipped/);
  assert.equal(store.getState(ADMIN_JID), null);
  store.close();
});

test('pick: gibberish reply re-emits full picker, state preserved', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [
      { id: 11, mediaType: 'movie', title: 'A', releaseDate: '2000-01-01' },
      { id: 12, mediaType: 'movie', title: 'B', releaseDate: '2001-01-01' },
    ],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
  };
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie a', isGroup: true },
  );
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '5', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /pick:/);
  assert.match(replies[0]!.text, /1\. \*?A \(2000\)\*?/);
  assert.match(replies[0]!.text, /2\. \*?B \(2001\)\*?/);
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'pick');
  store.close();
});

test('confirm: gibberish reply re-emits full confirm prompt with poster', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [{ id: 99, mediaType: 'movie', title: 'Solo', releaseDate: '2024-06-01', posterPath: '/x.jpg' }],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
  };
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie solo', isGroup: true },
  );
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '?', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Found: \*?Solo \(2024\)\*?/);
  assert.equal(replies[0]!.imageUrl, 'https://image.tmdb.org/t/p/w500/x.jpg');
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'confirm');
  store.close();
});

test('single result: skip picker, confirm prompt includes poster', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [{ id: 99, mediaType: 'movie', title: 'Solo Match', releaseDate: '2024-06-01', posterPath: '/x.jpg' }],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
  };
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie solo match', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.imageUrl, 'https://image.tmdb.org/t/p/w500/x.jpg');
  assert.match(replies[0]!.text, /Found: \*?Solo Match \(2024\)\*?/);
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'confirm');
  store.close();
});

test('!queue: empty audit -> haven\'t-requested message', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!queue', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /haven't requested/);
  store.close();
});

test('!queue: lists past requests with mapped statuses', async () => {
  const store = freshStore();
  store.audit({
    senderJid: ADMIN_JID, senderNumber: '15555550100', groupJid: ALLOWED_GROUP,
    command: 'movie alpha', resolvedRoute: 'a', seerrMediaType: 'movie', seerrMediaId: 100, seerrRequestId: 1, status: 'queued',
  });
  store.audit({
    senderJid: ADMIN_JID, senderNumber: '15555550100', groupJid: ALLOWED_GROUP,
    command: 'movie beta', resolvedRoute: 'a', seerrMediaType: 'movie', seerrMediaId: 200, seerrRequestId: 2, status: 'queued',
  });
  const seerr = fakeSeerr({
    mediaInfo: (_mt, id) => {
      if (id === 100) return { status: 5, downloadStatus: [] };
      if (id === 200) return { status: 3, downloadStatus: [{ size: 1000, sizeLeft: 250 }] };
      return null;
    },
  });
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!queue', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /your last 2 requests/);
  assert.match(replies[0]!.text, /movie alpha — ready/);
  assert.match(replies[0]!.text, /movie beta — downloading 75%/);
  store.close();
});

test('!queue: failed-status row shown as failed', async () => {
  const store = freshStore();
  store.audit({
    senderJid: ADMIN_JID, senderNumber: '15555550100', groupJid: ALLOWED_GROUP,
    command: 'movie gamma', resolvedRoute: 'a', seerrMediaType: 'movie', seerrMediaId: 300, status: 'failed',
  });
  const replies = await handleMessage(
    { store, seerr: fakeSeerr({ mediaInfo: () => null }) },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!queue', isGroup: true },
  );
  assert.match(replies[0]!.text, /movie gamma — failed/);
  store.close();
});

test('confirm + new !command cancels state, processes new request', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie alpha', isGroup: true },
  );
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'confirm');
  // Mid-confirm, user types a new !command — old state should be replaced
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie beta', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Found: \*?Test Movie/);  // new search ran (fakeSeerr default)
  // State now corresponds to the new request (still 'confirm' awaiting same single result)
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'confirm');
  store.close();
});

test('confirm + casual chat throttled: first re-emit fires, second within 30s suppressed', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie alpha', isGroup: true },
  );
  // First random chat -> full re-emit
  const r1 = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'lol', isGroup: true },
  );
  assert.equal(r1.length, 1);
  assert.match(r1[0]!.text, /Found: \*?Test Movie/);
  // Second random chat immediately after -> suppressed
  const r2 = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'huh', isGroup: true },
  );
  assert.deepEqual(r2, []);
  store.close();
});

test('confirm + casual chat after cooldown: re-emit fires again', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie alpha', isGroup: true },
  );
  // Trigger a re-emit, then back-date lastReEmitAt past the cooldown
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'lol', isGroup: true },
  );
  const s = store.getState(ADMIN_JID)!;
  const payload = s.payload as any;
  payload.lastReEmitAt = Date.now() - 31_000;
  store.setState(ADMIN_JID, { awaiting: s.awaiting, payload, expiresAt: s.expiresAt });
  // Now re-emit should fire
  const r = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: 'huh', isGroup: true },
  );
  assert.equal(r.length, 1);
  assert.match(r[0]!.text, /Found: \*?Test Movie/);
  store.close();
});

test('pick + new !command cancels state', async () => {
  const store = freshStore();
  const seerr = fakeSeerr({
    searchResults: [
      { id: 1, mediaType: 'movie', title: 'A', releaseDate: '2000-01-01' },
      { id: 2, mediaType: 'movie', title: 'B', releaseDate: '2001-01-01' },
    ],
  });
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie a', isGroup: true },
  );
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'pick');
  // New command while in pick → cancel + process
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!queue', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /haven't requested/);  // !queue ran successfully
  store.close();
});

test('availability: single result already on Plex → short-circuit, no confirm state', async () => {
  const store = freshStore();
  const seerr = fakeSeerr({
    searchResults: [{ id: 1, mediaType: 'movie', title: 'Old Hit', releaseDate: '2010-01-01', mediaInfo: { status: 5 } }],
  });
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie old hit', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /already on Plex/);
  assert.equal(store.getState(ADMIN_JID), null);
  store.close();
});

test('availability: single result already downloading → short-circuit', async () => {
  const store = freshStore();
  const seerr = fakeSeerr({
    searchResults: [{ id: 1, mediaType: 'movie', title: 'In Flight', releaseDate: '2020-01-01', mediaInfo: { status: 3 } }],
  });
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie in flight', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /already downloading/);
  assert.match(replies[0]!.text, /!queue/);
  assert.equal(store.getState(ADMIN_JID), null);
  store.close();
});

test('availability: picker shows hints, picking an available one short-circuits', async () => {
  const store = freshStore();
  const seerr = fakeSeerr({
    searchResults: [
      { id: 11, mediaType: 'movie', title: 'X', releaseDate: '2000-01-01', mediaInfo: { status: 5 } },
      { id: 12, mediaType: 'movie', title: 'Y', releaseDate: '2001-01-01' },
    ],
  });
  const r1 = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!movie x', isGroup: true },
  );
  assert.match(r1[0]!.text, /1\. \*?X \(2000\)\*? — _?already on Plex ✓_?/);
  assert.match(r1[0]!.text, /2\. \*?Y \(2001\)\*?/);
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'pick');
  // Pick the already-available one
  const r2 = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '1', isGroup: true },
  );
  assert.match(r2[0]!.text, /already on Plex/);
  assert.equal(store.getState(ADMIN_JID), null);  // state cleared, no confirm pending
  store.close();
});

test('availability: TV partially-available is allowed through (status 4) → season picker', async () => {
  const store = freshStore();
  const seerr = fakeSeerr({
    searchResults: [{ id: 1, mediaType: 'tv', title: 'Some Show', firstAirDate: '2020-01-01', mediaInfo: { status: 4 } }],
    tvDetails: () => ({ numberOfSeasons: 5, seasons: [] }),
  });
  const replies = await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!tv some show', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Found: \*?Some Show/);
  assert.match(replies[0]!.text, /5\* season/);
  assert.match(replies[0]!.text, /which seasons/i);
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'season');
  store.close();
});

test('!status returns Seerr version', async () => {
  const store = freshStore();
  const replies = await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: '15555550100', text: '!status', isGroup: true },
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /Seerr v3\.2\.0/);
  store.close();
});
