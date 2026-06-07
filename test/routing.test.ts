import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveRouteWith,
  parseRoutingConfig,
  loadRoutingConfig,
  type RoutingConfig,
} from '../src/routing/config.ts';

// A small, self-contained fixture. These tests assert on the RESOLVER LOGIC and
// the config VALIDATION — not on any particular deployment's library layout,
// which lives in the gitignored routing.config.json.
const FIXTURE: RoutingConfig = parseRoutingConfig({
  movies: {
    western: { rootFolder: '/m/Western', profileId: 1, profileName: 'HD' },
    anime: { rootFolder: '/m/Anime', profileId: 2, profileName: 'Anime' },
    foreign: { rootFolder: '/m/Curated/Foreign', profileId: 1, profileName: 'HD' },
  },
  tv: {
    western: { rootFolder: '/t/Western', profileId: 1, profileName: 'HD' },
  },
  forbiddenPath: 'Curated',
});

test('defaults a null category to western', () => {
  const r = resolveRouteWith(FIXTURE, 'movie', null);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.category, 'western');
    assert.equal(r.route.profileId, 1);
    assert.equal(r.route.rootFolder, '/m/Western');
  }
});

test('resolves a mapped movie category', () => {
  const r = resolveRouteWith(FIXTURE, 'movie', 'anime');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.route.profileId, 2);
    assert.equal(r.route.rootFolder, '/m/Anime');
  }
});

test('returns ok:false when a category has no route for that media type', () => {
  const r = resolveRouteWith(FIXTURE, 'tv', 'anime'); // fixture has no tv.anime
  assert.equal(r.ok, false);
});

test('throws when a resolved route matches the forbidden-path guard', () => {
  assert.throws(() => resolveRouteWith(FIXTURE, 'movie', 'foreign'), /forbidden path/);
});

test('no forbidden guard configured => never throws', () => {
  const cfg = parseRoutingConfig({
    movies: { western: { rootFolder: '/x/Curated', profileId: 1, profileName: 'HD' } },
    tv: {},
  });
  const r = resolveRouteWith(cfg, 'movie', null);
  assert.equal(r.ok, true);
});

test('parseRoutingConfig rejects a non-integer profileId', () => {
  assert.throws(
    () =>
      parseRoutingConfig({
        movies: { western: { rootFolder: '/x', profileId: 'seven', profileName: 'HD' } },
        tv: {},
      }),
    /profileId must be an integer/,
  );
});

test('parseRoutingConfig rejects an empty rootFolder', () => {
  assert.throws(
    () =>
      parseRoutingConfig({
        movies: { western: { rootFolder: '', profileId: 1, profileName: 'HD' } },
        tv: {},
      }),
    /rootFolder is required/,
  );
});

test('parseRoutingConfig requires at least one route', () => {
  assert.throws(() => parseRoutingConfig({ movies: {}, tv: {} }), /at least one route/);
});

test('parseRoutingConfig rejects an invalid forbiddenPath regex', () => {
  assert.throws(
    () =>
      parseRoutingConfig({
        movies: { western: { rootFolder: '/x', profileId: 1, profileName: 'HD' } },
        tv: {},
        forbiddenPath: '(',
      }),
    /not a valid regular expression/,
  );
});

test('the shipped routing.config.example.json is valid and default-resolves', () => {
  const path = fileURLToPath(new URL('../routing.config.example.json', import.meta.url));
  const cfg = parseRoutingConfig(JSON.parse(readFileSync(path, 'utf8')), 'example');
  assert.ok(Object.keys(cfg.movies).length > 0);
  assert.ok(Object.keys(cfg.tv).length > 0);
  const r = resolveRouteWith(cfg, 'movie', null);
  assert.equal(r.ok, true); // 'western' must exist so a fresh clone boots
});

test('loadRoutingConfig() loads the ambient config without throwing', () => {
  const cfg = loadRoutingConfig();
  assert.ok(cfg.movies && cfg.tv);
});
