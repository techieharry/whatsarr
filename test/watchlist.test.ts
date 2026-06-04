import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// config.ts (imported transitively by sync.ts) validates these at load.
process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.ADMIN_NUMBERS = '15555550100';
process.env.PLEX_TOKEN = 'test-token';   // enables the Pass-free plex path in this file's process
process.env.LOG_LEVEL = 'silent';

const { parsePlexWatchlist, parseLetterboxd, parseFeed } = await import('../src/watchlist/rss.ts');
const { parseWatchlistSources, validateFeedUrl, parsePlexFriendMap, config } = await import('../src/config.ts');
const { parse } = await import('../src/parser/commands.ts');
const { syncWatchlists } = await import('../src/watchlist/sync.ts');
const { makePlexClient } = await import('../src/watchlist/plex.ts');
const { handleMessage } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');

// ---------- fixtures ----------

const PLEX_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Plex Watchlist</title>
  <item>
    <title>Dune: Part Two (2024)</title>
    <category>movie</category>
    <guid>plex://movie/abc123</guid>
    <link>https://watch.plex.tv/movie/dune-part-two</link>
    <guid>imdb://tt15239678</guid>
  </item>
  <item>
    <title>Severance</title>
    <category>show</category>
    <guid>plex://show/def456</guid>
  </item>
  <item>
    <title>The Matrix (1999)</title>
    <category>movie</category>
    <guid>plex://movie/xyz789</guid>
    <link>https://www.themoviedb.org/movie/603</link>
  </item>
</channel></rss>`;

const LETTERBOXD_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:tmdb="https://themoviedb.org" xmlns:letterboxd="https://letterboxd.com" version="2.0"><channel>
  <item>
    <title>Sinners, 2025</title>
    <link>https://letterboxd.com/film/sinners/</link>
    <guid>letterboxd-sinners</guid>
    <tmdb:movieId>1233413</tmdb:movieId>
    <letterboxd:filmTitle>Sinners</letterboxd:filmTitle>
    <letterboxd:filmYear>2025</letterboxd:filmYear>
  </item>
  <item>
    <title><![CDATA[Heat, 1995]]></title>
    <link>https://letterboxd.com/film/heat/</link>
    <guid>letterboxd-heat</guid>
  </item>
</channel></rss>`;

// Build a Letterboxd-style list feed from spec objects (for cap/path tests).
function letterboxdFeed(items: { title: string; year?: number; tmdb?: number; guid: string }[]): string {
  const body = items.map(it => `
    <item>
      <title>${it.title}${it.year ? `, ${it.year}` : ''}</title>
      <link>https://letterboxd.com/film/${it.guid}/</link>
      <guid>${it.guid}</guid>
      ${it.tmdb ? `<tmdb:movieId>${it.tmdb}</tmdb:movieId>` : ''}
      <letterboxd:filmTitle>${it.title}</letterboxd:filmTitle>
      ${it.year ? `<letterboxd:filmYear>${it.year}</letterboxd:filmYear>` : ''}
    </item>`).join('');
  return `<?xml version="1.0"?><rss xmlns:tmdb="t" xmlns:letterboxd="l" version="2.0"><channel>${body}</channel></rss>`;
}

// Fake Seerr surface for the orchestrator.
function makeSeerr(opts: {
  search?: Record<string, any[]>;
  mediaInfo?: Record<number, { status: number }>;
  failOn?: Set<number>;        // throws a non-transient (terminal) error
  transientOn?: Set<number>;   // throws a transient (retryable) error
  created?: any[];
} = {}) {
  const created = opts.created ?? [];
  return {
    created,
    search: async (q: string) => opts.search?.[q] ?? [],
    getMediaInfo: async (_t: 'movie' | 'tv', id: number) =>
      opts.mediaInfo?.[id] ? { status: opts.mediaInfo[id]!.status, downloadStatus: [] } : null,
    createRequest: async (args: any) => {
      created.push(args);
      if (opts.failOn?.has(args.mediaId)) throw new Error('seerr boom');
      if (opts.transientOn?.has(args.mediaId)) { const e: any = new Error('connect ECONNREFUSED'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
      return { id: 9000 + args.mediaId };
    },
  };
}

const SRC = { type: 'letterboxd' as const, url: 'http://feed', owner: '1', label: 'LB' };

// Fake Pass-free Plex client (injected like seerr/fetchText).
function makeFakePlex(opts: {
  friends?: { id: string; username: string }[];
  friendWatchlists?: Record<string, { id: string; title: string; type: 'movie' | 'tv' }[]>;
  self?: { id: string; title: string; type: 'movie' | 'tv' }[];
  enrich?: Record<string, { tmdbId: number | null; imdbId: string | null; year: number | null }>;
} = {}) {
  const enrichCalls: string[] = [];
  return {
    enrichCalls,
    listFriends: async () => opts.friends ?? [],
    friendWatchlist: async (id: string) => opts.friendWatchlists?.[id] ?? [],
    selfWatchlist: async () => opts.self ?? [],
    enrich: async (nodeId: string) => { enrichCalls.push(nodeId); return opts.enrich?.[nodeId] ?? { tmdbId: null, imdbId: null, year: null }; },
  };
}

// ---------- RSS parsing ----------

test('parsePlexWatchlist: movie with year + imdb fallback id, no tmdb', () => {
  const items = parsePlexWatchlist(PLEX_FEED);
  const dune = items[0]!;
  assert.equal(dune.title, 'Dune: Part Two');
  assert.equal(dune.year, 2024);
  assert.equal(dune.type, 'movie');
  assert.equal(dune.tmdbId, null);            // Plex RSS often omits tmdb
  assert.equal(dune.imdbId, 'tt15239678');    // scavenged from the 2nd <guid>
  assert.equal(dune.guid, 'plex://movie/abc123');  // first <guid> wins
});

test('parsePlexWatchlist: category=show → tv', () => {
  const items = parsePlexWatchlist(PLEX_FEED);
  const sev = items[1]!;
  assert.equal(sev.title, 'Severance');
  assert.equal(sev.type, 'tv');
  assert.equal(sev.year, null);
});

test('parsePlexWatchlist: tmdb scavenged from themoviedb.org link', () => {
  const items = parsePlexWatchlist(PLEX_FEED);
  const matrix = items[2]!;
  assert.equal(matrix.title, 'The Matrix');
  assert.equal(matrix.year, 1999);
  assert.equal(matrix.tmdbId, 603);
});

test('parseLetterboxd: rich item uses filmTitle/filmYear/tmdb:movieId', () => {
  const items = parseLetterboxd(LETTERBOXD_FEED);
  const sinners = items[0]!;
  assert.equal(sinners.title, 'Sinners');
  assert.equal(sinners.year, 2025);
  assert.equal(sinners.type, 'movie');
  assert.equal(sinners.tmdbId, 1233413);
  assert.equal(sinners.guid, 'letterboxd-sinners');
});

test('parseLetterboxd: bare item falls back to title "Name, Year" parse (CDATA)', () => {
  const items = parseLetterboxd(LETTERBOXD_FEED);
  const heat = items[1]!;
  assert.equal(heat.title, 'Heat');
  assert.equal(heat.year, 1995);
  assert.equal(heat.tmdbId, null);
});

test('parseFeed dispatches by type', () => {
  assert.equal(parseFeed('plex', PLEX_FEED).length, 3);
  assert.equal(parseFeed('letterboxd', LETTERBOXD_FEED).length, 2);
});

// ---------- config.parseWatchlistSources ----------

test('parseWatchlistSources: empty → []', () => {
  assert.deepEqual(parseWatchlistSources(''), []);
  assert.deepEqual(parseWatchlistSources('   '), []);
});

test('parseWatchlistSources: valid, normalizes owner number + defaults label + validates url', () => {
  const out = parseWatchlistSources('[{"type":"plex","url":"https://rss.plex.tv/abc","owner":"+1 555-555-0101"},{"type":"letterboxd","url":"https://letterboxd.com/u/list/x/rss/","owner":"1","label":"Mine"}]');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { type: 'plex', url: 'https://rss.plex.tv/abc', owner: '15555550101', label: 'plex:15555550101' });
  assert.equal(out[1]!.label, 'Mine');
});

test('parseWatchlistSources: rejects bad type / missing url / missing owner / bad url host+scheme / non-array / bad json', () => {
  assert.throws(() => parseWatchlistSources('[{"type":"discord","url":"https://rss.plex.tv/x","owner":"1"}]'), /type must be/);
  assert.throws(() => parseWatchlistSources('[{"type":"plex","owner":"1"}]'), /url is required/);
  assert.throws(() => parseWatchlistSources('[{"type":"plex","url":"https://rss.plex.tv/x"}]'), /owner/);
  assert.throws(() => parseWatchlistSources('[{"type":"plex","url":"http://rss.plex.tv/x","owner":"1"}]'), /https/);
  assert.throws(() => parseWatchlistSources('[{"type":"plex","url":"https://evil.com/x","owner":"1"}]'), /not allowed/);
  assert.throws(() => parseWatchlistSources('{"type":"plex"}'), /must be a JSON array/);
  assert.throws(() => parseWatchlistSources('not json'), /not valid JSON/);
});

test('validateFeedUrl: accepts the two hosts over https; rejects scheme/host/garbage', () => {
  assert.equal(validateFeedUrl('plex', 'https://rss.plex.tv/abc'), 'https://rss.plex.tv/abc');
  assert.equal(validateFeedUrl('letterboxd', 'https://letterboxd.com/u/list/x/rss/'), 'https://letterboxd.com/u/list/x/rss/');
  assert.throws(() => validateFeedUrl('plex', 'http://rss.plex.tv/abc'), /https/);
  assert.throws(() => validateFeedUrl('plex', 'https://letterboxd.com/x'), /not allowed/);  // wrong host for type
  assert.throws(() => validateFeedUrl('letterboxd', 'https://evil.com/x'), /not allowed/);
  assert.throws(() => validateFeedUrl('plex', 'not a url'), /valid URL/);
});

// ---------- orchestrator ----------

test('sync: resolves via embedded tmdb AND via search fallback; writes audit + subscription + seen', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ search: { Heat: [{ id: 949, mediaType: 'movie', releaseDate: '1995-12-15' }] } });
  const summary = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => LETTERBOXD_FEED, sources: [SRC], maxPerRun: 10 });

  assert.equal(summary.requested, 2);
  assert.equal(summary.unresolved, 0);
  // Sinners via embedded tmdb 1233413; Heat via search → 949.
  assert.deepEqual(seerr.created.map(c => c.mediaId).sort((a, b) => a - b), [949, 1233413]);
  assert.ok(store.hasWatchlistItem('LB', 'letterboxd-sinners'));
  assert.ok(store.hasWatchlistItem('LB', 'letterboxd-heat'));
  // subscription written under the owner, DM-routed (groupJid null)
  const subs = store.findActiveSubscribers('movie', 1233413);
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.subscriberNumber, '1');
  assert.equal(subs[0]!.groupJid, null);
  // audit row tagged as watchlist-originated
  const audit = store.listAudit({});
  assert.ok(audit.some(a => a.command.startsWith('watchlist:LB') && a.seerrMediaId === 1233413));
  store.close();
});

test('sync: second run skips already-seen items (idempotent)', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ search: { Heat: [{ id: 949, mediaType: 'movie', releaseDate: '1995-12-15' }] } });
  const deps = { store, seerr: seerr as any, fetchText: async () => LETTERBOXD_FEED, sources: [SRC], maxPerRun: 10 };
  await syncWatchlists(deps);
  const second = await syncWatchlists(deps);
  assert.equal(second.requested, 0);
  assert.equal(second.skippedSeen, 2);
  assert.equal(seerr.created.length, 2);  // no new requests on the 2nd pass
  store.close();
});

test('sync: skips items already available on Plex', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({
    search: { Heat: [{ id: 949, mediaType: 'movie', releaseDate: '1995-12-15' }] },
    mediaInfo: { 1233413: { status: 5 } },   // Sinners already AVAILABLE
  });
  const summary = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => LETTERBOXD_FEED, sources: [SRC], maxPerRun: 10 });
  assert.equal(summary.skippedAvailable, 1);
  assert.equal(summary.requested, 1);                 // only Heat
  assert.deepEqual(seerr.created.map(c => c.mediaId), [949]);
  store.close();
});

test('sync: unresolved item (no tmdb, no search match) is recorded, not requested', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ search: {} });  // Heat search returns nothing
  const feed = letterboxdFeed([{ title: 'Obscure Film', year: 2011, guid: 'obscure' }]);
  const summary = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.requested, 0);
  assert.equal(seerr.created.length, 0);
  assert.ok(store.hasWatchlistItem('LB', 'obscure'));   // recorded so we don't re-search every poll
  store.close();
});

test('sync: maxPerRun caps new requests per run; remainder trickles next run', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr();
  const feed = letterboxdFeed([
    { title: 'A', year: 2001, tmdb: 11, guid: 'a' },
    { title: 'B', year: 2002, tmdb: 22, guid: 'b' },
    { title: 'C', year: 2003, tmdb: 33, guid: 'c' },
  ]);
  const deps = { store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 2 };
  const run1 = await syncWatchlists(deps);
  assert.equal(run1.requested, 2);
  assert.equal(run1.capped, true);
  assert.ok(!store.hasWatchlistItem('LB', 'c'));   // 3rd left unseen
  const run2 = await syncWatchlists(deps);
  assert.equal(run2.requested, 1);                 // C picked up
  assert.equal(run2.capped, false);
  assert.deepEqual(seerr.created.map(c => c.mediaId), [11, 22, 33]);
  store.close();
});

test('sync: createRequest failure is recorded as failed (audit + seen), not counted as requested', async () => {
  const store = new Store(':memory:');
  // Sinners (tmdb 1233413) → createRequest throws. Heat (no tmdb) → no search
  // match → unresolved. So: 0 requested, 1 failed, 1 unresolved.
  const seerr = makeSeerr({ failOn: new Set([1233413]) });
  const summary = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => LETTERBOXD_FEED, sources: [SRC], maxPerRun: 10 });
  assert.equal(summary.requested, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unresolved, 1);
  const audit = store.listAudit({ status: 'failed' });
  assert.ok(audit.some(a => a.seerrMediaId === 1233413));
  assert.ok(store.hasWatchlistItem('LB', 'letterboxd-sinners'));   // failed item recorded (no infinite retry)
  store.close();
});

test('sync: owner mapped to a Seerr user → createRequest gets that userId', async () => {
  const store = new Store(':memory:');
  store.setSeerrUserId('1', 42);
  const seerr = makeSeerr();
  const feed = letterboxdFeed([{ title: 'Mapped', year: 2020, tmdb: 555, guid: 'm' }]);
  await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(seerr.created[0]!.userId, 42);
  store.close();
});

test('sync: unmapped owner → createRequest userId undefined (client falls back to default)', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr();
  const feed = letterboxdFeed([{ title: 'Unmapped', year: 2020, tmdb: 556, guid: 'u' }]);
  await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(seerr.created[0]!.userId, undefined);
  store.close();
});

test('sync: feed fetch failure is swallowed (one bad source does not throw)', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr();
  const summary = await syncWatchlists({
    store,
    seerr: seerr as any,
    fetchText: async () => { throw new Error('HTTP 403'); },
    sources: [SRC],
    maxPerRun: 10,
  });
  assert.deepEqual(summary, { requested: 0, skippedSeen: 0, skippedAvailable: 0, skippedQuota: 0, unresolved: 0, failed: 0, capped: false });
  store.close();
});

// ---------- orchestrator: review-hardening behaviors ----------

test('sync: TRANSIENT createRequest failure is NOT recorded seen (retried next poll)', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ transientOn: new Set([1233413]) });
  const r1 = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => LETTERBOXD_FEED, sources: [SRC], maxPerRun: 10 });
  assert.equal(r1.failed, 1);
  assert.ok(!store.hasWatchlistItem('LB', 'letterboxd-sinners'));  // left unseen → retryable
  // next poll retries it (now succeeds) → requested
  const seerr2 = makeSeerr();
  const r2 = await syncWatchlists({ store, seerr: seerr2 as any, fetchText: async () => LETTERBOXD_FEED, sources: [SRC], maxPerRun: 10 });
  assert.ok(seerr2.created.some(c => c.mediaId === 1233413));
  assert.ok(store.hasWatchlistItem('LB', 'letterboxd-sinners'));
  store.close();
});

test('sync: TRANSIENT search failure leaves item unseen (no unresolved row written)', async () => {
  const store = new Store(':memory:');
  const seerr = {
    created: [] as any[],
    search: async () => { const e: any = new Error('fetch failed'); throw e; },
    getMediaInfo: async () => null,
    createRequest: async (a: any) => { (seerr.created).push(a); return { id: 1 }; },
  };
  const feed = letterboxdFeed([{ title: 'Bare Title', year: 2009, guid: 'bare' }]);  // no tmdb → needs search
  const r = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(r.unresolved, 0);   // a thrown search is transient, NOT a genuine miss
  assert.equal(r.requested, 0);
  assert.ok(!store.hasWatchlistItem('LB', 'bare'));   // unseen → retried next poll
  store.close();
});

test('sync: fail-closed — year given but no year/title match → unresolved (no wrong request)', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ search: { Heat: [
    { id: 1, mediaType: 'movie', title: 'Heatwave', releaseDate: '1986-01-01' },
    { id: 2, mediaType: 'movie', title: 'Some Heat', releaseDate: '2000-01-01' },
  ] } });
  const feed = letterboxdFeed([{ title: 'Heat', year: 1995, guid: 'heat' }]);  // no tmdb
  const r = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(r.unresolved, 1);
  assert.equal(r.requested, 0);
  assert.equal(seerr.created.length, 0);  // did NOT request the popularity-first wrong result
  store.close();
});

test('sync: fail-closed — year unknown + multiple same-type matches → unresolved', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ search: { Ambi: [
    { id: 1, mediaType: 'movie', title: 'Ambi', releaseDate: '1990-01-01' },
    { id: 2, mediaType: 'movie', title: 'Ambi', releaseDate: '2015-01-01' },
  ] } });
  const feed = letterboxdFeed([{ title: 'Ambi', guid: 'ambi' }]);  // no year, no tmdb
  const r = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(r.unresolved, 1);
  assert.equal(r.requested, 0);
  store.close();
});

test('sync: year-drift tolerated — exact title match accepted despite wrong year', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ search: { Heat: [{ id: 7, mediaType: 'movie', title: 'Heat', releaseDate: '1986-01-01' }] } });
  const feed = letterboxdFeed([{ title: 'Heat', year: 1995, guid: 'heat' }]);  // feed year off, single exact title
  const r = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(r.requested, 1);
  assert.deepEqual(seerr.created.map(c => c.mediaId), [7]);
  store.close();
});

test('sync: respects per-owner daily quota (skippedQuota, left unseen)', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 5; i++) store.bumpQuota('1');   // exhaust default REQUESTS_PER_DAY=5
  const seerr = makeSeerr();
  const feed = letterboxdFeed([{ title: 'A', year: 2001, tmdb: 11, guid: 'a' }]);
  const r = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, sources: [SRC], maxPerRun: 10 });
  assert.equal(r.skippedQuota, 1);
  assert.equal(r.requested, 0);
  assert.equal(seerr.created.length, 0);
  assert.ok(!store.hasWatchlistItem('LB', 'a'));   // unseen → retried after quota resets
  store.close();
});

// ---------- store: self-service source CRUD ----------

test('store: watchlist_source add/list/byOwner/count/get/delete + UNIQUE(owner,url)', () => {
  const store = new Store(':memory:');
  const a = store.addWatchlistSource({ type: 'plex', url: 'https://rss.plex.tv/a', owner: '1', label: 'p1' });
  assert.equal(a.inserted, true);
  const dup = store.addWatchlistSource({ type: 'plex', url: 'https://rss.plex.tv/a', owner: '1', label: 'p1' });
  assert.equal(dup.inserted, false);   // UNIQUE(owner_number, url)
  store.addWatchlistSource({ type: 'letterboxd', url: 'https://letterboxd.com/u/list/x/rss/', owner: '2', label: 'l2' });
  assert.equal(store.listWatchlistSources().length, 2);
  assert.equal(store.listWatchlistSourcesByOwner('1').length, 1);
  assert.equal(store.countWatchlistSourcesByOwner('1'), 1);
  assert.equal(store.getWatchlistSource(a.id)?.owner, '1');
  assert.equal(store.deleteWatchlistSource(a.id), true);
  assert.equal(store.getWatchlistSource(a.id), null);
  store.close();
});

test('store: reapWatchlistItems drops rows older than cutoff', () => {
  const store = new Store(':memory:');
  store.recordWatchlistItem({ source: 'LB', guid: 'g1', tmdbId: 1, mediaType: 'movie', status: 'queued', title: 'X' });
  assert.equal(store.reapWatchlistItems(Date.now() + 1000), 1);   // cutoff in the future → reaps it
  assert.ok(!store.hasWatchlistItem('LB', 'g1'));
  store.close();
});

// sync merges env + DB sources: a self-service DB feed is polled with no explicit sources arg
test('sync: picks up a DB-registered source when no explicit sources passed', async () => {
  const store = new Store(':memory:');
  store.addWatchlistSource({ type: 'letterboxd', url: 'https://letterboxd.com/me/list/x/rss/', owner: '1', label: 'DBFEED' });
  const seerr = makeSeerr();
  const feed = letterboxdFeed([{ title: 'Z', year: 2020, tmdb: 77, guid: 'z' }]);
  // no `sources` → syncWatchlists merges config.watchlist.sources (none) + store DB feeds
  const r = await syncWatchlists({ store, seerr: seerr as any, fetchText: async () => feed, maxPerRun: 10 });
  assert.equal(r.requested, 1);
  assert.ok(store.hasWatchlistItem('DBFEED', 'z'));
  store.close();
});

// ---------- parser: !watchlist ----------

test('parse: !watchlist variants', () => {
  assert.deepEqual(parse('!watchlist'), { kind: 'watchlist', op: 'guide', wlType: null, url: null, id: null });
  assert.deepEqual(parse('!wl guide'), { kind: 'watchlist', op: 'guide', wlType: null, url: null, id: null });
  assert.deepEqual(parse('!watchlist list'), { kind: 'watchlist', op: 'list', wlType: null, url: null, id: null });
  assert.deepEqual(parse('!watchlist add plex https://rss.plex.tv/x'), { kind: 'watchlist', op: 'add', wlType: 'plex', url: 'https://rss.plex.tv/x', id: null });
  assert.deepEqual(parse('!watchlist add lb https://letterboxd.com/u/list/x/rss/'), { kind: 'watchlist', op: 'add', wlType: 'letterboxd', url: 'https://letterboxd.com/u/list/x/rss/', id: null });
  assert.deepEqual(parse('!watchlist remove 3'), { kind: 'watchlist', op: 'remove', wlType: null, url: null, id: 3 });
  assert.equal(parse('!watchlist add plex').kind, 'incomplete');         // missing url
  assert.equal(parse('!watchlist remove abc').kind, 'incomplete');       // non-numeric id
});

// ---------- handler: !watchlist self-service ----------

const GROUP = '120363111111111111@g.us';
const MEMBER = '15555550101';
function grpMsg(text: string, number = MEMBER) {
  return { fromJid: GROUP, senderJid: `${number}@s.whatsapp.net`, senderNumber: number, text, isGroup: true };
}
function wlDeps(store: any) { return { store, seerr: {} as any, shutdown: undefined } as any; }

test('handler: !watchlist guide works for any allow-listed member', async () => {
  const store = new Store(':memory:');
  const replies = await handleMessage(wlDeps(store), grpMsg('!watchlist') as any);
  assert.match(replies[0]!.text, /Auto-request from your watchlist/);
  store.close();
});

test('handler: member self-service add stores the feed + confirms', async () => {
  const store = new Store(':memory:');
  const replies = await handleMessage(wlDeps(store), grpMsg('!watchlist add letterboxd https://letterboxd.com/me/list/x/rss/') as any);
  assert.match(replies[0]!.text, /Added your letterboxd feed/);
  assert.equal(store.countWatchlistSourcesByOwner(MEMBER), 1);
  store.close();
});

test('handler: add rejects a disallowed host (no feed stored)', async () => {
  const store = new Store(':memory:');
  const replies = await handleMessage(wlDeps(store), grpMsg('!watchlist add letterboxd https://evil.com/x') as any);
  assert.match(replies[0]!.text, /Can't add that feed/);
  assert.equal(store.countWatchlistSourcesByOwner(MEMBER), 0);
  store.close();
});

test('handler: add enforces per-member feed cap', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 5; i++) store.addWatchlistSource({ type: 'letterboxd', url: `https://letterboxd.com/me/list/x${i}/rss/`, owner: MEMBER, label: `l${i}` });
  const replies = await handleMessage(wlDeps(store), grpMsg('!watchlist add letterboxd https://letterboxd.com/me/list/extra/rss/') as any);
  assert.match(replies[0]!.text, /feed limit/);
  assert.equal(store.countWatchlistSourcesByOwner(MEMBER), 5);
  store.close();
});

test('handler: remove enforces ownership (non-admin cannot remove another member\'s feed)', async () => {
  const store = new Store(':memory:');
  const other = store.addWatchlistSource({ type: 'plex', url: 'https://rss.plex.tv/a', owner: '9999', label: 'x' });
  const replies = await handleMessage(wlDeps(store), grpMsg(`!watchlist remove ${other.id}`) as any);
  assert.match(replies[0]!.text, /isn't yours/);
  assert.ok(store.getWatchlistSource(other.id));   // still present
  store.close();
});

test('handler: member can remove their own feed', async () => {
  const store = new Store(':memory:');
  const mine = store.addWatchlistSource({ type: 'letterboxd', url: 'https://letterboxd.com/me/list/x/rss/', owner: MEMBER, label: 'l' });
  const replies = await handleMessage(wlDeps(store), grpMsg(`!watchlist remove ${mine.id}`) as any);
  assert.match(replies[0]!.text, /Removed feed/);
  assert.equal(store.getWatchlistSource(mine.id), null);
  store.close();
});

// ---------- !announce (admin broadcast) ----------

const ADMIN = '15555550100';   // matches ADMIN_NUMBERS set at top

test('parse: !announce captures the body verbatim; bare !announce is incomplete', () => {
  assert.deepEqual(parse('!announce Hello everyone, new feature!'), { kind: 'announce', body: 'Hello everyone, new feature!' });
  assert.equal(parse('!announce').kind, 'incomplete');
});

test('handler: !announce (admin) broadcasts verbatim to every allowed group + acks', async () => {
  const store = new Store(':memory:');
  const msg = { fromJid: `${ADMIN}@s.whatsapp.net`, senderJid: `${ADMIN}@s.whatsapp.net`, senderNumber: ADMIN, text: '!announce New: !watchlist is live', isGroup: false };
  const replies = await handleMessage(wlDeps(store), msg as any);
  const groupTargets = replies.filter(r => config.whatsapp.allowedGroups.includes(r.to)).map(r => r.to);
  assert.deepEqual([...groupTargets].sort(), [...config.whatsapp.allowedGroups].sort());   // hits exactly the allowed groups
  assert.ok(replies.some(r => r.text === 'New: !watchlist is live'));                       // posted verbatim
  assert.ok(replies.some(r => /Announcement sent/.test(r.text)));                           // ack to the admin
  store.close();
});

test('handler: !announce from a non-admin is silently dropped (group)', async () => {
  const store = new Store(':memory:');
  const replies = await handleMessage(wlDeps(store), grpMsg('!announce spam', MEMBER) as any);
  assert.equal(replies.length, 0);
  store.close();
});

// ---------- Pass-free Plex (owner-token + friends) ----------

function wlDepsPlex(store: any, plex: any) { return { store, seerr: {} as any, plex, shutdown: undefined } as any; }

test('parsePlexFriendMap: valid + self sentinel + defaults; rejects bad', () => {
  const out = parsePlexFriendMap('[{"plexUsername":"alice","owner":"+1 416-555-1234"},{"plexUserId":"self","owner":"1","label":"Me"}]');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { plexUsername: 'alice', plexUserId: null, owner: '14165551234', label: 'plex:alice' });
  assert.equal(out[1]!.plexUserId, 'self');
  assert.equal(out[1]!.label, 'Me');
  assert.deepEqual(parsePlexFriendMap(''), []);
  assert.throws(() => parsePlexFriendMap('[{"owner":"1"}]'), /plexUsername or plexUserId/);
  assert.throws(() => parsePlexFriendMap('[{"plexUsername":"x"}]'), /owner/);
  assert.throws(() => parsePlexFriendMap('{"a":1}'), /must be a JSON array/);
  assert.throws(() => parsePlexFriendMap('nope'), /not valid JSON/);
});

test('plex client: parses friends, watchlist (show->tv), enrich (tmdb/imdb/year) via stubbed fetch', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url); const body = init?.body ? String(init.body) : '';
    const mk = (obj: any) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => obj } as any);
    if (u.includes('/library/metadata/')) return mk({ MediaContainer: { Metadata: [{ year: 2021, Guid: [{ id: 'tmdb://438631' }, { id: 'imdb://tt1160419' }] }] } });
    if (u.includes('community.plex.tv')) {
      if (body.includes('GetAllFriends')) return mk({ data: { allFriendsV2: [{ user: { id: 'U1', username: 'alice' } }] } });
      if (body.includes('GetWatchlistHub')) return mk({ data: { userV2: { watchlist: { nodes: [{ id: 'n1', title: 'Dune', type: 'movie' }, { id: 'n2', title: 'Sev', type: 'show' }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    return mk({});
  }) as any;
  try {
    const c = makePlexClient({ token: 't', clientId: 'whatsarr', discoverHost: 'https://discover.x', communityHost: 'https://community.plex.tv' });
    assert.deepEqual(await c.listFriends(), [{ id: 'U1', username: 'alice' }]);
    assert.deepEqual(await c.friendWatchlist('U1'), [{ id: 'n1', title: 'Dune', type: 'movie' }, { id: 'n2', title: 'Sev', type: 'tv' }]);
    const en = await c.enrich('n1');
    assert.equal(en.tmdbId, 438631); assert.equal(en.imdbId, 'tt1160419'); assert.equal(en.year, 2021);
  } finally { globalThis.fetch = orig; }
});

test('sync: plex-friend source requests enriched items (tv gets all seasons) + subscription/seen', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr();
  const plex = makeFakePlex({
    friendWatchlists: { u1: [{ id: 'n1', title: 'Dune', type: 'movie' }, { id: 'n2', title: 'Severance', type: 'tv' }] },
    enrich: { n1: { tmdbId: 438631, imdbId: null, year: 2021 }, n2: { tmdbId: 95396, imdbId: null, year: 2022 } },
  });
  const src = { type: 'plex-friend' as const, url: 'plexfriend://u1', owner: '1', label: 'pf:alice' };
  const r = await syncWatchlists({ store, seerr: seerr as any, plex: plex as any, sources: [src], maxPerRun: 10 });
  assert.equal(r.requested, 2);
  assert.deepEqual(seerr.created.map(c => c.mediaId).sort((a, b) => a - b), [95396, 438631]);
  assert.ok(seerr.created.some(c => c.mediaId === 95396 && c.mediaType === 'tv' && c.seasons === 'all'));
  assert.ok(store.hasWatchlistItem('pf:alice', 'n1'));
  assert.equal(store.findActiveSubscribers('movie', 438631).length, 1);
  // second run: all seen → enrich is NOT called again (N+1 only for unseen)
  const r2 = await syncWatchlists({ store, seerr: seerr as any, plex: plex as any, sources: [src], maxPerRun: 10 });
  assert.equal(r2.skippedSeen, 2);
  assert.equal(r2.requested, 0);
  assert.equal(plex.enrichCalls.length, 2);   // still 2 — no re-enrich of seen items
  store.close();
});

test('sync: plex-self source uses selfWatchlist', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr();
  const plex = makeFakePlex({ self: [{ id: 's1', title: 'Heat', type: 'movie' }], enrich: { s1: { tmdbId: 949, imdbId: null, year: 1995 } } });
  const r = await syncWatchlists({ store, seerr: seerr as any, plex: plex as any, sources: [{ type: 'plex-self' as const, url: 'plexself://', owner: '1', label: 'self' }], maxPerRun: 10 });
  assert.equal(r.requested, 1);
  assert.deepEqual(seerr.created.map(c => c.mediaId), [949]);
  store.close();
});

test('sync: plex item with no tmdb from enrich falls back to title+year search', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr({ search: { Heat: [{ id: 949, mediaType: 'movie', releaseDate: '1995-01-01' }] } });
  const plex = makeFakePlex({ friendWatchlists: { u1: [{ id: 'n1', title: 'Heat', type: 'movie' }] }, enrich: { n1: { tmdbId: null, imdbId: null, year: 1995 } } });
  const r = await syncWatchlists({ store, seerr: seerr as any, plex: plex as any, sources: [{ type: 'plex-friend' as const, url: 'plexfriend://u1', owner: '1', label: 'pf' }], maxPerRun: 10 });
  assert.equal(r.requested, 1);
  assert.deepEqual(seerr.created.map(c => c.mediaId), [949]);
  store.close();
});

test('sync: plex-friend source is skipped entirely when no plex client (token unset)', async () => {
  const store = new Store(':memory:');
  const seerr = makeSeerr();
  const r = await syncWatchlists({ store, seerr: seerr as any, sources: [{ type: 'plex-friend' as const, url: 'plexfriend://u1', owner: '1', label: 'pf' }], maxPerRun: 10 });
  assert.equal(r.requested, 0);
  assert.equal(seerr.created.length, 0);
  store.close();
});

test('handler: add plex-friend resolves a Plex friend (case-insensitive) + stores plexfriend:// source', async () => {
  const store = new Store(':memory:');
  const plex = makeFakePlex({ friends: [{ id: 'U123', username: 'Alice' }] });
  const replies = await handleMessage(wlDepsPlex(store, plex), grpMsg('!watchlist add plex-friend alice') as any);
  assert.match(replies[0]!.text, /Linked your Plex watchlist/);
  const rows = store.listWatchlistSourcesByOwner(MEMBER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'plex-friend');
  assert.equal(rows[0]!.url, 'plexfriend://U123');
  store.close();
});

test('handler: add plex-friend rejects an unknown/un-friended username with the fix steps', async () => {
  const store = new Store(':memory:');
  const plex = makeFakePlex({ friends: [{ id: 'U1', username: 'bob' }] });
  const replies = await handleMessage(wlDepsPlex(store, plex), grpMsg('!watchlist add plex-friend alice') as any);
  assert.match(replies[0]!.text, /can't see a Plex friend/i);
  assert.match(replies[0]!.text, /Friends Only/);
  assert.equal(store.countWatchlistSourcesByOwner(MEMBER), 0);
  store.close();
});

test('handler: add plex-friend with no plex client tells the user it is not set up', async () => {
  const store = new Store(':memory:');
  const replies = await handleMessage(wlDeps(store), grpMsg('!watchlist add plex-friend alice') as any);  // wlDeps = no plex
  assert.match(replies[0]!.text, /set up/i);
  assert.equal(store.countWatchlistSourcesByOwner(MEMBER), 0);
  store.close();
});

test('parse: !watchlist add plex-friend captures username; pf alias works', () => {
  assert.deepEqual(parse('!watchlist add plex-friend alice'), { kind: 'watchlist', op: 'add', wlType: 'plex-friend', url: 'alice', id: null });
  assert.deepEqual(parse('!watchlist add pf bob'), { kind: 'watchlist', op: 'add', wlType: 'plex-friend', url: 'bob', id: null });
});
