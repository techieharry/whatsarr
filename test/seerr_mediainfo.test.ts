import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Fictional placeholders → identical in the public mirror, no sanitization.
process.env.SEERR_URL = 'http://stub';
process.env.SEERR_API_KEY = 'k';
process.env.ALLOWED_GROUPS = '120363111111111111@g.us';
process.env.LOG_LEVEL = 'silent';

const { getMediaInfo } = await import('../src/seerr/client.ts');

const origFetch = globalThis.fetch;
function stubMediaInfo(mediaInfo: any) {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ mediaInfo }),
    text: async () => '',
  })) as any;
}
function restore() { globalThis.fetch = origFetch; }

test('getMediaInfo: HD request → HD tier', async () => {
  stubMediaInfo({ status: 3, externalServiceId: 100, serverId: 0, downloadStatus: [] });
  const i = await getMediaInfo('movie', 1);
  assert.deepEqual(i, { status: 3, downloadStatus: [], externalServiceId: 100, serverId: 0 });
  restore();
});

test('getMediaInfo: 4k-only request → 4k tier coherently (status, id, server all from 4k)', async () => {
  // HD tier UNKNOWN/empty; the real state lives in the 4k tier. Must NOT report
  // HD status 1 while pointing at the 4k id (that wasted a priority + lied).
  stubMediaInfo({
    status: 1, status4k: 5,
    externalServiceId: null, serverId: null,
    externalServiceId4k: 959, server4kId: 1,
    downloadStatus: [], downloadStatus4k: [],
  });
  const i = await getMediaInfo('movie', 1);
  assert.equal(i!.status, 5);              // 4k AVAILABLE, not HD UNKNOWN(1)
  assert.equal(i!.externalServiceId, 959); // the 4k *arr id
  assert.equal(i!.serverId, 1);            // the 4k server
  restore();
});

test('getMediaInfo: both tiers present → prefers the HD id', async () => {
  stubMediaInfo({
    status: 3, status4k: 3,
    externalServiceId: 100, serverId: 0,
    externalServiceId4k: 959, server4kId: 1,
    downloadStatus: [],
  });
  const i = await getMediaInfo('movie', 1);
  assert.equal(i!.externalServiceId, 100); // HD wins when it has a real id
  assert.equal(i!.serverId, 0);
  assert.equal(i!.status, 3);
  restore();
});

test('getMediaInfo: no mediaInfo → null', async () => {
  globalThis.fetch = (async () => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => ({}), text: async () => '',
  })) as any;
  assert.equal(await getMediaInfo('movie', 1), null);
  restore();
});
