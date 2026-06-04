import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.LOG_LEVEL = 'silent';

const { parseFilmLinks, hasFilmLink } = await import('../src/links.ts');
const { parse } = await import('../src/parser/commands.ts');
const { handleMessage } = await import('../src/handler.ts');
const { Store } = await import('../src/state/store.ts');

const GROUP = '120363111111111111@g.us';
const MEMBER = '15555550101';
function qmsg(text: string, quotedText?: string) {
  return { fromJid: GROUP, senderJid: `${MEMBER}@s.whatsapp.net`, senderNumber: MEMBER, text, isGroup: true, quotedText } as any;
}

// ---------- parseFilmLinks ----------

test('parseFilmLinks: film + review forms, de-kebab, dedup, non-film ignored', () => {
  assert.deepEqual(parseFilmLinks('https://letterboxd.com/cinephile/film/backrooms/'), [{ source: 'letterboxd', title: 'backrooms', mediaType: 'movie' }]);
  assert.deepEqual(parseFilmLinks('loved it https://letterboxd.com/cinephile/film/the-bear/12345/'), [{ source: 'letterboxd', title: 'the bear', mediaType: 'movie' }]);
  assert.deepEqual(parseFilmLinks('https://letterboxd.com/film/dune-part-two/'), [{ source: 'letterboxd', title: 'dune part two', mediaType: 'movie' }]);
  assert.equal(parseFilmLinks('a https://letterboxd.com/x/film/heat/ b https://letterboxd.com/y/film/heat/').length, 1);  // dedup by slug
  assert.deepEqual(parseFilmLinks('https://letterboxd.com/cinephile/list/faves/'), []);      // a list, not a film
  assert.deepEqual(parseFilmLinks('https://letterboxd.com/cinephile/watchlist/'), []);        // watchlist, not a film
  assert.deepEqual(parseFilmLinks('no links here'), []);
  assert.equal(hasFilmLink('see https://letterboxd.com/x/film/sinners/'), true);
  assert.equal(hasFilmLink('nope'), false);
});

test('parseFilmLinks: rejects host look-alikes, accepts real subdomains', () => {
  assert.deepEqual(parseFilmLinks('https://evilletterboxd.com/x/film/malware/'), []);
  assert.deepEqual(parseFilmLinks('myletterboxd.com/film/spoof/'), []);
  assert.equal(parseFilmLinks('https://www.letterboxd.com/cinephile/film/sinners/').length, 1);
});

test('parseFilmLinks: de-kebabs in full (no year stripping — protects real title numbers)', () => {
  assert.equal(parseFilmLinks('https://letterboxd.com/x/film/dune-2021/')[0]!.title, 'dune 2021');
  assert.equal(parseFilmLinks('https://letterboxd.com/x/film/blade-runner-2049/')[0]!.title, 'blade runner 2049');
});

// ---------- parser ----------

test('parse: !links variants', () => {
  assert.deepEqual(parse('!links'), { kind: 'links', op: 'status' });
  assert.deepEqual(parse('!links off'), { kind: 'links', op: 'off' });
  assert.deepEqual(parse('!links on'), { kind: 'links', op: 'on' });
  assert.deepEqual(parse('!links mute'), { kind: 'links', op: 'off' });
});

// ---------- store opt-out ----------

test('store: links opt-out set / clear', () => {
  const store = new Store(':memory:');
  assert.equal(store.isLinksOptedOut('1'), false);
  store.setLinksOptOut('1', true);
  assert.equal(store.isLinksOptedOut('1'), true);
  store.setLinksOptOut('1', false);
  assert.equal(store.isLinksOptedOut('1'), false);
  store.close();
});

// ---------- handler: quote-reply queue ----------

test('handler: quote-reply q on a Letterboxd film link triggers the request flow', async () => {
  const store = new Store(':memory:');
  const searched: string[] = [];
  const seerr = {
    search: async (q: string) => { searched.push(q); return [{ id: 438631, mediaType: 'movie', title: 'Backrooms', releaseDate: '2026-05-29' }]; },
    getMediaInfo: async () => null,
    createRequest: async () => ({ id: 1 }),
    getTvDetails: async () => null,
  };
  const replies = await handleMessage({ store, seerr } as any, qmsg('q', 'loved this https://letterboxd.com/cinephile/film/backrooms/'));
  assert.equal(searched.length, 1);
  assert.match(searched[0]!, /backrooms/i);
  assert.match(replies[0]!.text, /Backrooms/);   // confirm prompt for the resolved film
  store.close();
});

test('handler: !q also works (prefixed)', async () => {
  const store = new Store(':memory:');
  let searched = 0;
  const seerr = { search: async () => { searched++; return [{ id: 1, mediaType: 'movie', title: 'Heat', releaseDate: '1995-12-15' }]; }, getMediaInfo: async () => null };
  const replies = await handleMessage({ store, seerr } as any, qmsg('!q', 'https://letterboxd.com/x/film/heat/'));
  assert.equal(searched, 1);
  assert.match(replies[0]!.text, /Heat/);
  store.close();
});

test('handler: quote-reply q with no film link in quoted text is ignored (silent)', async () => {
  const store = new Store(':memory:');
  const seerr = { search: async () => { throw new Error('should not search'); } };
  const replies = await handleMessage({ store, seerr } as any, qmsg('q', 'just chatting, no link'));
  assert.equal(replies.length, 0);
  store.close();
});

test('handler: bare q (not a quote-reply) is dropped silently in a group', async () => {
  const store = new Store(':memory:');
  const seerr = { search: async () => { throw new Error('no'); } };
  const replies = await handleMessage({ store, seerr } as any, qmsg('q', undefined));
  assert.equal(replies.length, 0);
  store.close();
});

test('handler: quote-reply !queue is NOT hijacked — the real !queue command runs', async () => {
  const store = new Store(':memory:');
  let searched = false;
  const seerr = { search: async () => { searched = true; return []; }, getMediaInfo: async () => null };
  const replies = await handleMessage({ store, seerr } as any, qmsg('!queue', 'https://letterboxd.com/x/film/heat/'));
  assert.equal(searched, false);                       // film search NOT triggered
  assert.match(replies[0]!.text, /requested|request/i); // handleQueue (your recent requests) ran
  store.close();
});

test('handler: quote-reply q clears an in-flight prompt before queuing (no clobber)', async () => {
  const store = new Store(':memory:');
  const jid = `${MEMBER}@s.whatsapp.net`;
  store.setState(jid, { awaiting: 'confirm', payload: { stale: true }, expiresAt: Date.now() + 600000 });
  let searched = '';
  const seerr = { search: async (q: string) => { searched = q; return [{ id: 9, mediaType: 'movie', title: 'Heat', releaseDate: '1995-12-15' }]; }, getMediaInfo: async () => null };
  await handleMessage({ store, seerr } as any, qmsg('q', 'https://letterboxd.com/x/film/heat/'));
  assert.match(searched, /heat/i);                     // intercept fired (prior state didn't block it)
  const st = store.getState(jid);
  assert.ok(st && st.awaiting === 'confirm');
  assert.match(JSON.stringify(st!.payload), /Heat/);   // state is the NEW film, stale one gone
  store.close();
});

// ---------- handler: !links opt-out ----------

test('handler: !links off silences + status reflects it; !links on clears it', async () => {
  const store = new Store(':memory:');
  const seerr = {} as any;
  let r = await handleMessage({ store, seerr } as any, qmsg('!links off'));
  assert.match(r[0]!.text, /silenced/);
  assert.equal(store.isLinksOptedOut(MEMBER), true);
  r = await handleMessage({ store, seerr } as any, qmsg('!links'));
  assert.match(r[0]!.text, /\*off\*/);
  r = await handleMessage({ store, seerr } as any, qmsg('!links on'));
  assert.match(r[0]!.text, /back on/);
  assert.equal(store.isLinksOptedOut(MEMBER), false);
  store.close();
});
