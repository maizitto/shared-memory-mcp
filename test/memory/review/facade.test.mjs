/** Opt-in memory routes, in Node with real SQLite. Entry-point routing needs workerd: see facade.workerd.mjs. Fictional data only. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LocalD1 } from '../testkit.mjs';
import { installReviewSchema, migrationSql } from '../../../src/memory/review/schema.mjs';
import { handleMemoryRoute, isMemoryRoute } from '../../../src/memory/review/facade.mjs';
import { hash } from '../../../src/memory/ledger.mjs';
import { grantPrincipal, reviewConfig } from '../../../src/memory/review/identity.mjs';

const t = JSON.parse(readFileSync(new URL('../../../fixtures/memory-sharing/second-brain.json', import.meta.url))).texts;
const migration = new URL('../../../src/memory/migrations/0001_shared_memory_review.sql', import.meta.url);
const ORIGIN = 'https://coach.example';
const WRITER = `pmm_${'w'.repeat(43)}`, READER = `pmm_${'r'.repeat(43)}`, REVOKED = `pmm_${'x'.repeat(43)}`;
let db, env, github;

const fakeGithub = () => async url => {
  github.calls++;
  if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic-github-token', scope: '' });
  if (url === 'https://api.github.com/user') return Response.json({ id: 12345 });
  throw new Error('unexpected external fetch');
};
const request = (path, { method = 'GET', headers = {}, body } = {}) => new Request(ORIGIN + path, { method, headers, body });
async function mcp(token, method, params, extra = {}) {
  const r = await handleMemoryRoute(request('/memory/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env);
  return { status: r.status, body: await r.json().catch(() => null) };
}
const tool = async (token, name, args) => (await mcp(token, 'tools/call', { name, arguments: args })).body.result.structuredContent;
const command = (request_id = 'req-1', content = t.preference, expected_version = 0) => ({ collection: 'synthetic', request_id, fact_id: 'preference', operation: 'put',
  expected_version, content, source: 'fictional-facade-test', observed_at: '2020-01-01T00:00:00Z', valid_from: '2020-01-01T00:00:00Z' });

beforeEach(async () => {
  db = await new LocalD1().init(); await installReviewSchema(db);
  for (const [id, token, scopes, revoked] of [['writer', WRITER, 'memory:read memory:write', null], ['reader', READER, 'memory:read', null], ['revoked', REVOKED, 'memory:read memory:write', 1]])
  {
    db.raw.prepare('INSERT INTO memory_clients(id,label,token_sha256,scopes,created_at_ms,revoked_at_ms) VALUES(?,?,?,?,?,?)').run(id, id, await hash(token), scopes, Date.now(), revoked);
    db.raw.prepare("INSERT INTO memory_client_grants(client_id,collection_id,scopes) VALUES(?,'synthetic',?)").run(id, scopes);
  }
  github = { calls: 0 };
  env = { DB: db, OAUTH_ENABLED: 'true', MEMORY_PUBLIC_ORIGIN: ORIGIN, GITHUB_OWNER_ID: '12345', GITHUB_CLIENT_ID: 'synthetic-app', GITHUB_CLIENT_SECRET: 'synthetic-not-a-secret',
    MEMORY_REVIEW_ENABLED: 'true', MEMORY_REVIEW_COLLECTIONS: 'synthetic' };
});
afterEach(() => db.close());

test('the committed migration is generated from the schema, applies once and refuses same-named tables', () => {
  const sql = readFileSync(migration, 'utf8');
  assert.equal(sql, migrationSql()); assert.doesNotMatch(sql, /IF NOT EXISTS|\bfit_|\bcoach_|mcp_clients|\bDROP\b|\bALTER\b/);
  // Every top-level statement only creates a memory_* object; nothing existing is altered.
  for (const line of sql.split('\n').filter(l => /^[A-Z]/.test(l) && l !== 'END;')) assert.match(line, /^CREATE (TABLE|INDEX|TRIGGER) memory_/);
  const raw = new DatabaseSync(':memory:'); raw.exec(sql);
  const names = raw.prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'memory%' ORDER BY name").all().map(r => `${r.type}:${r.name}`);
  assert.equal(names.filter(n => n.startsWith('table:')).length, 10); assert.equal(names.filter(n => n.startsWith('trigger:')).length, 4);
  assert.throws(() => raw.exec(sql), /already exists/); raw.close();
});

test('memory routes are exactly /review, /review/* and /memory/mcp', () => {
  assert.deepEqual(['/review', '/review/x', '/memory/mcp', '/mcp', '/reviewer', '/memory', '/memory/mcp/x'].map(isMemoryRoute), [true, true, true, false, false, false, false]);
});

test('misconfiguration throws so that the entry point fails closed', async () => {
  for (const key of ['MEMORY_REVIEW_COLLECTIONS', 'GITHUB_OWNER_ID', 'GITHUB_CLIENT_SECRET', 'MEMORY_PUBLIC_ORIGIN'])
    await assert.rejects(handleMemoryRoute(request('/review'), { ...env, [key]: undefined }));
});

test('/memory/mcp accepts only registered, unrevoked pmm_ tokens, no browser origin, and only configured collections', async () => {
  for (const token of [null, REVOKED, `pmm_${'z'.repeat(43)}`, `cmm_${'w'.repeat(43)}`, WRITER.slice(0, -1)]) assert.equal((await mcp(token, 'tools/list')).status, 401);
  assert.equal((await mcp(WRITER, 'tools/list', undefined, { origin: ORIGIN })).status, 403);
  const tools = (await mcp(WRITER, 'tools/list')).body.result.tools.map(x => x.name);
  assert.deepEqual(tools, ['propose_fact', 'put_fact', 'delete_fact', 'get_fact', 'list_facts', 'search_facts']);
  assert.equal((await tool(READER, 'propose_fact', command())).error, 'FORBIDDEN');
  assert.equal((await tool(WRITER, 'propose_fact', { ...command(), collection: 'shared' })).error, 'FORBIDDEN');
  const p = await tool(WRITER, 'propose_fact', command());
  assert.equal(p.status, 'pending'); assert.equal(p.review_url, `${ORIGIN}/review?p=${p.proposal_id}`);
  const again = await tool(WRITER, 'propose_fact', command());
  assert.equal(again.proposal_id, p.proposal_id); assert.equal(again.review_url, p.review_url);
  assert.equal(db.raw.prepare('SELECT creator FROM memory_proposals').get().creator, 'connection:writer');
  assert.equal(db.raw.prepare('SELECT owner_id FROM memory_proposals').get().owner_id, 'github-12345');
  assert.equal((await tool(WRITER, 'put_fact', { collection: 'synthetic', proposal_id: p.proposal_id })).error, 'APPROVAL_REQUIRED');
});

test('limiter bindings guard every memory route and fail closed', async () => {
  const keys = [];
  const limiter = success => ({ async limit({ key }) { keys.push(key); return { success }; } });
  const guarded = { ...env, AUTH_GUARDS_REQUIRED: 'true', AUTH_LOGIN_LIMIT: limiter(true), AUTH_API_LIMIT: limiter(true) };
  env = guarded;
  assert.equal((await handleMemoryRoute(request('/review'), env)).status, 200);
  assert.equal((await handleMemoryRoute(request('/review/github/callback'), env)).status, 400);
  assert.equal((await mcp(null, 'tools/list')).status, 401);
  assert.deepEqual(keys, ['memory-review', 'memory-review-login', 'memory-mcp']);
  env = { ...guarded, AUTH_API_LIMIT: limiter(false) }; assert.equal((await mcp(WRITER, 'tools/list')).status, 429);
  assert.equal((await handleMemoryRoute(request('/review'), env)).status, 429);
  env = { ...guarded, AUTH_LOGIN_LIMIT: undefined }; assert.equal((await handleMemoryRoute(request('/review/login', { method: 'POST' }), env)).status, 503);
  env = { ...guarded, AUTH_API_LIMIT: { async limit() { throw new Error('limiter outage'); } } }; assert.equal((await mcp(WRITER, 'tools/list')).status, 503);
});

test('through the entry point: writer proposes, owner approves after GitHub login, writer commits, reader reads', async () => {
  const p = await tool(WRITER, 'propose_fact', command());
  const jar = new Map(), go = async (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (options.method === 'POST') { headers.set('origin', ORIGIN); headers.set('content-type', 'application/x-www-form-urlencoded'); }
    const r = await handleMemoryRoute(request(path, { ...options, headers }), env, { githubFetcher: fakeGithub() });
    for (const c of r.headers.getSetCookie()) { const pair = c.split(';')[0], name = pair.slice(0, pair.indexOf('=')); if (/Max-Age=0/.test(c)) jar.delete(name); else jar.set(name, pair.slice(name.length + 1)); }
    return { status: r.status, location: r.headers.get('location'), body: await r.text() };
  };
  const start = await go('/review/login', { method: 'POST', body: '' });
  const to = new URL(start.location);
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/review/github/callback`); assert.equal(to.searchParams.get('client_id'), 'synthetic-app');
  assert.equal((await go(`/review/github/callback?code=synthetic-code&state=${to.searchParams.get('state')}`)).status, 200);
  const page = (await go('/review')).body;
  for (const text of ['synthetic / preference: new fact', t.preference, 'fictional-facade-test', 'connection:writer', p.digest]) assert.ok(page.includes(text), text);
  const values = Object.fromEntries([...page.matchAll(/name="(csrf|collection|proposal_id|expected_digest)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
  assert.equal((await go('/review/approve', { method: 'POST', body: new URLSearchParams(values).toString() })).status, 303);
  const saved = await tool(WRITER, 'put_fact', { collection: 'synthetic', proposal_id: p.proposal_id });
  assert.equal(saved.status, 'stored'); assert.equal(saved.committed_version, 1);
  const fact = await tool(READER, 'get_fact', { collection: 'synthetic', id: 'preference' });
  assert.equal(fact.content, t.preference); assert.equal(fact.actor, 'connection:writer');
  assert.equal((await tool(READER, 'search_facts', { collection: 'synthetic', query: 'Aurora mattino', mode: 'lexical' })).candidates[0].id, 'preference');
  assert.equal((await tool(READER, 'search_facts', { collection: 'synthetic', query: 'Aurora mattino' })).error, 'SEMANTIC_UNAVAILABLE');
  assert.equal(github.calls, 2);
});

test('grant adapter: per collection, capped by the client scopes and by the configured collections', () => {
  const config = reviewConfig({ ...env, MEMORY_PUBLIC_ORIGIN: ORIGIN, MEMORY_REVIEW_COLLECTIONS: 'synthetic,atleta' });
  const p = grantPrincipal(config, { id: 'hermes', scopes: 'memory:read' }, [
    { collection_id: 'atleta', scopes: 'memory:read memory:write memory:approve' }, { collection_id: 'synthetic', scopes: 'memory:write' },
    { collection_id: 'private', scopes: 'memory:read' }]);
  assert.deepEqual(p, { owner_id: 'github-12345', subject: 'connection:hermes', grants: { atleta: ['memory:read'] } });
  assert.deepEqual(grantPrincipal(config, { id: 'new', scopes: 'memory:read memory:write' }, []).grants, {});
  assert.equal(grantPrincipal(config, { id: '../x', scopes: 'memory:read' }, []), null);
});

test('what AI clients actually send: plain dates, offsets, no dates, no request_id; errors carry a hint', async () => {
  const base = { collection: 'synthetic', operation: 'put', expected_version: 0, content: 'Prova di scrittura da ChatGPT', source: 'test' };
  const dated = await tool(WRITER, 'propose_fact', { ...base, fact_id: 'prova.data', observed_at: '2026-10-23' });
  assert.equal(dated.status, 'pending'); assert.equal(dated.command.observed_at, '2026-10-23T00:00:00.000Z'); assert.equal(dated.command.valid_from, '2026-10-23T00:00:00.000Z');
  const offset = await tool(WRITER, 'propose_fact', { ...base, fact_id: 'prova.offset', observed_at: '2026-10-23T10:15:00+02:00', valid_from: '2026-10-23T10:15' });
  assert.equal(offset.command.observed_at, '2026-10-23T08:15:00.000Z'); assert.equal(offset.command.valid_from, '2026-10-23T10:15:00.000Z');
  // No dates and no request_id: today's date, and a key derived from the proposal, so a retry is the same proposal.
  const bare = await tool(WRITER, 'propose_fact', { ...base, fact_id: 'prova.chatgpt' }), retry = await tool(WRITER, 'propose_fact', { ...base, fact_id: 'prova.chatgpt' });
  assert.equal(bare.status, 'pending'); assert.equal(retry.proposal_id, bare.proposal_id); assert.match(bare.command.request_id, /^auto-[0-9a-f]{32}$/);
  assert.equal(bare.command.observed_at, `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  for (const value of ['23/10/2026', '2026-02-30', '2026-10-23T25:00:00Z', '2026-10-23T10:00:00+15:00', 'oggi']) {
    const r = await tool(WRITER, 'propose_fact', { ...base, fact_id: 'prova.errore', observed_at: value });
    assert.equal(r.error, 'INVALID_TIME', value); assert.match(r.hint, /ISO 8601, e\.g\. 2026-10-23/);
  }
  assert.match((await tool(WRITER, 'propose_fact', { ...base, fact_id: 'bad id' })).hint, /letters, digits/);
  const schema = (await mcp(WRITER, 'tools/list')).body.result.tools.find(t => t.name === 'propose_fact').inputSchema;
  assert.deepEqual(schema.required, ['collection', 'fact_id', 'operation', 'expected_version']); assert.match(schema.properties.observed_at.description, /Default: today/);
});

test('bearer access expires from issuance and rejects future timestamps without changing grants', async () => {
  const before = db.raw.prepare('SELECT COUNT(*) AS n FROM memory_client_grants').get().n;
  db.raw.prepare('UPDATE memory_clients SET created_at_ms=? WHERE id=?').run(Date.now()-31*86400000,'writer');
  assert.equal((await mcp(WRITER,'tools/list')).status,401);
  db.raw.prepare('UPDATE memory_clients SET created_at_ms=? WHERE id=?').run(Date.now()+86400000,'writer');
  assert.equal((await mcp(WRITER,'tools/list')).status,401);
  db.raw.prepare('UPDATE memory_clients SET created_at_ms=? WHERE id=?').run(Date.now(),'writer');
  assert.equal((await mcp(WRITER,'tools/list')).status,200);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM memory_client_grants').get().n,before);
});
