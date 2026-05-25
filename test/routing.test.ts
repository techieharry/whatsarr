import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveRoute,
  MOVIE_ROUTES,
  TV_ROUTES,
  FORBIDDEN_PATH,
} from '../src/routing/table.ts';

test('movie default (null category) -> western, profile 7', () => {
  const r = resolveRoute('movie', null);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.category, 'western');
    assert.equal(r.route.profileId, 7);
    assert.match(r.route.rootFolder, /Requested Western Movies$/);
  }
});

test('movie bollywood -> bollywood path, profile 7', () => {
  const r = resolveRoute('movie', 'bollywood');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.route.rootFolder, /Requested Bollywood Movies$/);
    assert.equal(r.route.profileId, 7);
  }
});

test('movie pakistani -> pakistani path', () => {
  const r = resolveRoute('movie', 'pakistani');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.route.rootFolder, /Requested Pakistani Movies$/);
});

test('movie anime -> animated movies eastern, profile 11', () => {
  const r = resolveRoute('movie', 'anime');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.route.profileId, 11);
    assert.match(r.route.rootFolder, /Requested Animated Movies\\Eastern$/);
  }
});

test('movie animated -> animated movies western, profile 7', () => {
  const r = resolveRoute('movie', 'animated');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.route.profileId, 7);
    assert.match(r.route.rootFolder, /Requested Animated Movies\\Western$/);
  }
});

test('movie asian -> rejected (asian is TV-only)', () => {
  const r = resolveRoute('movie', 'asian');
  assert.equal(r.ok, false);
});

test('tv default -> western shows, profile 7 WEB-DL', () => {
  const r = resolveRoute('tv', null);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.category, 'western');
    assert.match(r.route.rootFolder, /Requested Western Shows$/);
    assert.equal(r.route.profileId, 7);
  }
});

test('tv asian -> asian shows', () => {
  const r = resolveRoute('tv', 'asian');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.route.rootFolder, /Requested Asian Shows$/);
});

test('tv anime -> animated shows eastern, profile 9 anime', () => {
  const r = resolveRoute('tv', 'anime');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.route.profileId, 9);
    assert.match(r.route.rootFolder, /Requested Animated Shows\\Eastern$/);
  }
});

test('tv pakistani -> rejected (no pakistani TV row)', () => {
  const r = resolveRoute('tv', 'pakistani');
  assert.equal(r.ok, false);
});

test('tv foreign -> rejected (no foreign TV row)', () => {
  const r = resolveRoute('tv', 'foreign');
  assert.equal(r.ok, false);
});

test('routing tables contain no forbidden paths', () => {
  for (const [cat, route] of Object.entries(MOVIE_ROUTES)) {
    if (route) {
      assert.doesNotMatch(
        route.rootFolder,
        FORBIDDEN_PATH,
        `MOVIE_ROUTES[${cat}] resolves to forbidden path: ${route.rootFolder}`,
      );
    }
  }
  for (const [cat, route] of Object.entries(TV_ROUTES)) {
    if (route) {
      assert.doesNotMatch(
        route.rootFolder,
        FORBIDDEN_PATH,
        `TV_ROUTES[${cat}] resolves to forbidden path: ${route.rootFolder}`,
      );
    }
  }
});
