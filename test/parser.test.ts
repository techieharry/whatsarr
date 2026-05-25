import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parse } from '../src/parser/commands.ts';

test('!movie <title> -> default category', () => {
  assert.deepEqual(parse('!movie dune part two'), {
    kind: 'request', mediaTypeHint: 'movie', category: null, title: 'dune part two',
  });
});

test('!movie <category> <title>', () => {
  assert.deepEqual(parse('!movie bollywood laapataa ladies'), {
    kind: 'request', mediaTypeHint: 'movie', category: 'bollywood', title: 'laapataa ladies',
  });
});

test('!tv <title> -> default category', () => {
  assert.deepEqual(parse('!tv the bear'), {
    kind: 'request', mediaTypeHint: 'tv', category: null, title: 'the bear',
  });
});

test('!tv anime frieren', () => {
  assert.deepEqual(parse('!tv anime frieren'), {
    kind: 'request', mediaTypeHint: 'tv', category: 'anime', title: 'frieren',
  });
});

test('!tv asian squid game', () => {
  assert.deepEqual(parse('!tv asian squid game'), {
    kind: 'request', mediaTypeHint: 'tv', category: 'asian', title: 'squid game',
  });
});

test('!show is alias for !tv', () => {
  assert.deepEqual(parse('!show the bear'), {
    kind: 'request', mediaTypeHint: 'tv', category: null, title: 'the bear',
  });
});

test('!req <title> -> ambiguous mediaType', () => {
  assert.deepEqual(parse('!req chimp empire'), {
    kind: 'request', mediaTypeHint: 'ambiguous', category: null, title: 'chimp empire',
  });
});

test('!req with category -> still ambiguous, handler clarifies', () => {
  assert.deepEqual(parse('!req doc chimp empire'), {
    kind: 'request', mediaTypeHint: 'ambiguous', category: 'documentary', title: 'chimp empire',
  });
});

test('alias bolly -> bollywood', () => {
  assert.deepEqual(parse('!movie bolly 3 idiots'), {
    kind: 'request', mediaTypeHint: 'movie', category: 'bollywood', title: '3 idiots',
  });
});

test('alias kdrama -> asian', () => {
  assert.deepEqual(parse('!tv kdrama crash landing on you'), {
    kind: 'request', mediaTypeHint: 'tv', category: 'asian', title: 'crash landing on you',
  });
});

test('alias pak -> pakistani', () => {
  assert.deepEqual(parse('!movie pak the legend of maula jatt'), {
    kind: 'request', mediaTypeHint: 'movie', category: 'pakistani', title: 'the legend of maula jatt',
  });
});

test('alias intl -> foreign', () => {
  assert.deepEqual(parse('!movie intl parasite'), {
    kind: 'request', mediaTypeHint: 'movie', category: 'foreign', title: 'parasite',
  });
});

test('case insensitive command and category', () => {
  assert.deepEqual(parse('!MOVIE BOLLY 3 idiots'), {
    kind: 'request', mediaTypeHint: 'movie', category: 'bollywood', title: '3 idiots',
  });
});

test('extra whitespace collapsed', () => {
  assert.deepEqual(parse('  !movie    dune    part   two  '), {
    kind: 'request', mediaTypeHint: 'movie', category: null, title: 'dune part two',
  });
});

test('no prefix -> unknown', () => {
  assert.equal(parse('movie dune').kind, 'unknown');
});

test('unknown command -> unknown', () => {
  assert.equal(parse('!banana foo').kind, 'unknown');
});

test('command with no title -> incomplete', () => {
  const p = parse('!movie');
  assert.equal(p.kind, 'incomplete');
  if (p.kind === 'incomplete') assert.equal(p.cmd, 'movie');
});

test('command + category but no title -> incomplete', () => {
  const p = parse('!movie bollywood');
  assert.equal(p.kind, 'incomplete');
  if (p.kind === 'incomplete') assert.equal(p.cmd, 'movie');
});

test('!status', () => {
  assert.deepEqual(parse('!status'), { kind: 'status' });
});

test('!queue', () => {
  assert.deepEqual(parse('!queue'), { kind: 'queue' });
});

test('!mine is alias for !queue', () => {
  assert.deepEqual(parse('!mine'), { kind: 'queue' });
});

test('!sync', () => {
  assert.deepEqual(parse('!sync'), { kind: 'sync' });
});

test('!syncstatus is alias for !sync', () => {
  assert.deepEqual(parse('!syncstatus'), { kind: 'sync' });
});

test('!help', () => {
  assert.deepEqual(parse('!help'), { kind: 'help' });
});

test('custom prefix /', () => {
  assert.deepEqual(parse('/movie dune', '/'), {
    kind: 'request', mediaTypeHint: 'movie', category: null, title: 'dune',
  });
});

test('title with category-like word that is NOT first token stays in title', () => {
  // "western front" — "western" appears mid-title, not as category
  assert.deepEqual(parse('!movie all quiet on the western front'), {
    kind: 'request', mediaTypeHint: 'movie', category: null, title: 'all quiet on the western front',
  });
});
