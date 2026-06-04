import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Stub config BEFORE importing handler (which imports config)
process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.ADMIN_NUMBERS = '+15555550100';
process.env.COMMAND_PREFIX = '!';
process.env.REQUESTS_PER_DAY = '5';
process.env.WEBHOOK_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

const { handleMessage } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');

const ALLOWED_GROUP = '120363111111111111@g.us';
const ADMIN_JID = '15555550100@s.whatsapp.net';
const ADMIN_NUMBER = '15555550100';

function freshStore() { return new Store(':memory:'); }

function fakeSeerr(opts: { searchResults?: any[]; createRequestId?: number; throw?: string; tvDetails?: (id: number) => any } = {}) {
  return {
    search: async () => opts.searchResults ?? [{ id: 12345, mediaType: 'movie', title: 'Test Movie', releaseDate: '2024-01-01' }],
    createRequest: async () => {
      if (opts.throw) throw new Error(opts.throw);
      return { id: opts.createRequestId ?? 999 };
    },
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async () => null,
    getTvDetails: async (id: number) => opts.tvDetails ? opts.tvDetails(id) : { numberOfSeasons: 3, seasons: [{ seasonNumber: 1, episodeCount: 10 }] },
    listPendingRequests: async () => [],
    approveRequest: async (id: number) => ({ id }),
    declineRequest: async (id: number) => ({ id }),
    retryRequest: async (id: number) => ({ id }),
  };
}

// ----------------- store-level -----------------

test('subscription: addSubscription → findActiveSubscribers round-trips seasons (all / list / null)', () => {
  const store = freshStore();
  store.addSubscription({ subscriberJid: 'a@s', subscriberNumber: '1', groupJid: null, mediaType: 'tv', tmdbId: 100, seasons: 'all' });
  store.addSubscription({ subscriberJid: 'b@s', subscriberNumber: '2', groupJid: 'g@g.us', mediaType: 'tv', tmdbId: 100, seasons: [1, 3] });
  store.addSubscription({ subscriberJid: 'c@s', subscriberNumber: '3', groupJid: null, mediaType: 'movie', tmdbId: 200, seasons: null });

  const tv = store.findActiveSubscribers('tv', 100);
  assert.equal(tv.length, 2);
  assert.equal(tv[0]!.seasons, 'all');
  assert.deepEqual(tv[1]!.seasons, [1, 3]);
  assert.equal(tv[1]!.groupJid, 'g@g.us');

  const movie = store.findActiveSubscribers('movie', 200);
  assert.equal(movie.length, 1);
  assert.equal(movie[0]!.seasons, null);
  assert.equal(movie[0]!.groupJid, null);
  store.close();
});

test('subscription: two subscribers for same media → both returned, ordered created_at ASC, id ASC', () => {
  const store = freshStore();
  const id1 = store.addSubscription({ subscriberJid: 'a@s', subscriberNumber: '1', groupJid: null, mediaType: 'tv', tmdbId: 7, seasons: 'all' });
  const id2 = store.addSubscription({ subscriberJid: 'b@s', subscriberNumber: '2', groupJid: null, mediaType: 'tv', tmdbId: 7, seasons: 'all' });
  const subs = store.findActiveSubscribers('tv', 7);
  assert.equal(subs.length, 2);
  assert.equal(subs[0]!.id, id1);
  assert.equal(subs[1]!.id, id2);
  store.close();
});

test('subscription: markSubscriptionsNotified clears rows; second call returns []', () => {
  const store = freshStore();
  const id1 = store.addSubscription({ subscriberJid: 'a@s', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 5, seasons: null });
  const id2 = store.addSubscription({ subscriberJid: 'b@s', subscriberNumber: '2', groupJid: null, mediaType: 'movie', tmdbId: 5, seasons: null });
  assert.equal(store.findActiveSubscribers('movie', 5).length, 2);
  store.markSubscriptionsNotified([id1, id2]);
  assert.equal(store.findActiveSubscribers('movie', 5).length, 0);
  // Idempotent: marking already-notified again is harmless and they stay gone.
  store.markSubscriptionsNotified([id1, id2]);
  assert.equal(store.findActiveSubscribers('movie', 5).length, 0);
  store.close();
});

test('subscription: markSubscriptionsNotified([]) is a no-op (no throw)', () => {
  const store = freshStore();
  const id = store.addSubscription({ subscriberJid: 'a@s', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 9, seasons: null });
  assert.doesNotThrow(() => store.markSubscriptionsNotified([]));
  // The existing active row is untouched.
  assert.equal(store.findActiveSubscribers('movie', 9).length, 1);
  assert.equal(store.findActiveSubscribers('movie', 9)[0]!.id, id);
  store.close();
});

test('subscription: hasAnySubscription is true once a row exists (active OR notified)', () => {
  const store = freshStore();
  assert.equal(store.hasAnySubscription('movie', 4242), false);
  const id = store.addSubscription({ subscriberJid: 'a@s', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 4242, seasons: null });
  assert.equal(store.hasAnySubscription('movie', 4242), true);
  store.markSubscriptionsNotified([id]);
  assert.equal(store.hasAnySubscription('movie', 4242), true);  // still true after notify
  store.close();
});

test('subscription: reapNotifiedSubscriptions drops old notified rows, keeps active', () => {
  const store = freshStore();
  const old = store.addSubscription({ subscriberJid: 'a@s', subscriberNumber: '1', groupJid: null, mediaType: 'movie', tmdbId: 1, seasons: null });
  const active = store.addSubscription({ subscriberJid: 'b@s', subscriberNumber: '2', groupJid: null, mediaType: 'movie', tmdbId: 2, seasons: null });
  store.markSubscriptionsNotified([old], 1000);  // notified far in the past
  const removed = store.reapNotifiedSubscriptions(2000);
  assert.equal(removed, 1);
  assert.equal(store.hasAnySubscription('movie', 1), false);   // old notified row reaped
  assert.equal(store.findActiveSubscribers('movie', 2).length, 1);  // active row untouched
  assert.equal(store.findActiveSubscribers('movie', 2)[0]!.id, active);
  store.close();
});

// ----------------- handler-level (all 3 sites) -----------------

test('subscription/handler: confirm/YES movie in group → one sub, groupJid=ALLOWED_GROUP, seasons=null (Site A)', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '!movie dune', isGroup: true },
  );
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: 'YES', isGroup: true },
  );
  const subs = store.findActiveSubscribers('movie', 12345);
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.subscriberJid, ADMIN_JID);
  assert.equal(subs[0]!.groupJid, ALLOWED_GROUP);
  assert.equal(subs[0]!.seasons, null);
  store.close();
});

test('subscription/handler: season-pick 1-3 → one sub, tv, seasons=[1,2,3] (Site C)', async () => {
  const store = freshStore();
  const seerr = fakeSeerr({
    searchResults: [{ id: 555, mediaType: 'tv', title: 'Some Show', firstAirDate: '2020-01-01' }],
    tvDetails: () => ({ numberOfSeasons: 5, seasons: [] }),
  });
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '!tv some show', isGroup: true },
  );
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'season');
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '1-3', isGroup: true },
  );
  const subs = store.findActiveSubscribers('tv', 555);
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0]!.seasons, [1, 2, 3]);
  assert.equal(subs[0]!.groupJid, ALLOWED_GROUP);
  store.close();
});

test('subscription/handler: multi-select batch 1,3 → one sub per picked tmdbId (Site B)', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [
      { id: 11, mediaType: 'movie', title: 'The Matrix', releaseDate: '1999-03-31' },
      { id: 12, mediaType: 'movie', title: 'The Matrix Reloaded', releaseDate: '2003-05-15' },
      { id: 13, mediaType: 'movie', title: 'The Matrix Resurrections', releaseDate: '2021-12-22' },
    ],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async () => null,
    getTvDetails: async () => ({ numberOfSeasons: 1, seasons: [] }),
    listPendingRequests: async () => [],
    approveRequest: async (id: number) => ({ id }),
    declineRequest: async (id: number) => ({ id }),
    retryRequest: async (id: number) => ({ id }),
  };
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '!movie matrix', isGroup: true },
  );
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'pick');
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '1,3', isGroup: true },
  );
  const s11 = store.findActiveSubscribers('movie', 11);
  const s13 = store.findActiveSubscribers('movie', 13);
  const s12 = store.findActiveSubscribers('movie', 12);
  assert.equal(s11.length, 1);
  assert.equal(s13.length, 1);
  assert.equal(s12.length, 0);  // not picked
  assert.equal(s11[0]!.groupJid, ALLOWED_GROUP);
  store.close();
});

test('subscription/handler: TV batch item → sub with seasons=all (Site B tv branch)', async () => {
  const store = freshStore();
  const seerr = {
    search: async () => [
      { id: 21, mediaType: 'tv', title: 'Show One', firstAirDate: '2020-01-01' },
      { id: 22, mediaType: 'tv', title: 'Show Two', firstAirDate: '2021-01-01' },
    ],
    createRequest: async () => ({ id: 999 }),
    status: async () => ({ version: '3.2.0', commitTag: 'x', updateAvailable: false }),
    getMediaInfo: async () => null,
    getTvDetails: async () => ({ numberOfSeasons: 2, seasons: [] }),
    listPendingRequests: async () => [],
    approveRequest: async (id: number) => ({ id }),
    declineRequest: async (id: number) => ({ id }),
    retryRequest: async (id: number) => ({ id }),
  };
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '!tv show', isGroup: true },
  );
  assert.equal(store.getState(ADMIN_JID)?.awaiting, 'pick');
  await handleMessage(
    { store, seerr },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '1,2', isGroup: true },
  );
  const s21 = store.findActiveSubscribers('tv', 21);
  const s22 = store.findActiveSubscribers('tv', 22);
  assert.equal(s21.length, 1);
  assert.equal(s22.length, 1);
  assert.equal(s21[0]!.seasons, 'all');  // batch TV forced to all seasons (handler.ts:855)
  assert.equal(s22[0]!.seasons, 'all');
  store.close();
});

test('subscription/handler: DM-origin confirm/YES → sub with groupJid=null', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '!movie dune', isGroup: false },
  );
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ADMIN_JID, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: 'YES', isGroup: false },
  );
  const subs = store.findActiveSubscribers('movie', 12345);
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.groupJid, null);
  store.close();
});

test('subscription/handler: createRequest throws → audit failed AND no subscription row (no orphan)', async () => {
  const store = freshStore();
  await handleMessage(
    { store, seerr: fakeSeerr() },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: '!movie dune', isGroup: true },
  );
  const replies = await handleMessage(
    { store, seerr: fakeSeerr({ throw: 'seerr exploded' }) },
    { fromJid: ALLOWED_GROUP, senderJid: ADMIN_JID, senderNumber: ADMIN_NUMBER, text: 'YES', isGroup: true },
  );
  assert.match(replies[0]!.text, /Failed to queue/);
  // Audit flipped to failed.
  const failed = store.listAudit({ status: 'failed' });
  assert.equal(failed.length, 1);
  // No subscription written on the catch path.
  assert.equal(store.findActiveSubscribers('movie', 12345).length, 0);
  store.close();
});
