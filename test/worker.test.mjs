import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalD1 } from './memory/testkit.mjs';
import entry from '../src/worker.mjs';

const origin = 'https://memory.example';
const limiter = { async limit() { return { success: true }; } };
const config = db => ({ DB: db, MEMORY_ENABLED: 'true', MEMORY_REVIEW_ENABLED: 'true',
  AUTH_GUARDS_REQUIRED: 'true', AUTH_LOGIN_LIMIT: limiter, AUTH_API_LIMIT: limiter,
  MEMORY_PUBLIC_ORIGIN: origin, GITHUB_OWNER_ID: '12345', GITHUB_CLIENT_ID: 'fictional-app',
  GITHUB_CLIENT_SECRET: 'fictional-secret', MEMORY_REVIEW_COLLECTIONS: 'shared' });

test('fresh schema and standalone entry refuse disabled configuration, foreign hosts and private test routes', async () => {
  const db = new LocalD1();
  try {
    const sql = await readFile(new URL('../migrations/0001_bootstrap.sql', import.meta.url), 'utf8');
    db.raw.exec(sql);
    assert.throws(() => db.raw.exec(sql), /already exists/);
    const env = config(db);
    assert.equal((await entry.fetch(new Request(origin + '/review'), env)).status, 200);
    assert.equal((await entry.fetch(new Request(origin + '/memory/mcp', { method: 'POST' }), env)).status, 401);
    for (const tweak of [{ MEMORY_ENABLED: 'false' }, { AUTH_GUARDS_REQUIRED: 'false' },
      { AUTH_API_LIMIT: undefined }, { GITHUB_CLIENT_SECRET: undefined }]) {
      assert.equal((await entry.fetch(new Request(origin + '/review'), { ...env, ...tweak })).status, 503);
    }
    assert.equal((await entry.fetch(new Request('https://foreign.example/review'), env)).status, 400);
    for (const path of ['/operator', '/test', '/mcp', '/health']) {
      assert.equal((await entry.fetch(new Request(origin + path), env)).status, 404);
    }
    assert.deepEqual(await entry.scheduled({}, { ...env, MEMORY_SEARCH_ENABLED: 'false' }), undefined);
  } finally { db.close(); }
});
