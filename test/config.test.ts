import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// config.ts calls required() at import, so set the mandatory vars first.
process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'stub';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';

const { resolveSyncthingFolders } = await import('../src/config.ts');

test('resolveSyncthingFolders: explicit plural list wins', () => {
  assert.deepEqual(resolveSyncthingFolders('movies, tv ,docs', 'single'), ['movies', 'tv', 'docs']);
});

test('resolveSyncthingFolders: falls back to singular folderId when plural unset', () => {
  assert.deepEqual(resolveSyncthingFolders('', 'US_media'), ['US_media']);
});

test('resolveSyncthingFolders: empty when neither set', () => {
  assert.deepEqual(resolveSyncthingFolders('', ''), []);
});

test('resolveSyncthingFolders: blank/whitespace CSV falls back to folderId', () => {
  assert.deepEqual(resolveSyncthingFolders(' , , ', 'fb'), ['fb']);
});
