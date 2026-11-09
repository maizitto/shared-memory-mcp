/** Owner review in the real local Workers runtime and D1 SQLite. Fictional identities; no remote bindings. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
const root = fileURLToPath(new URL('../../', import.meta.url));
const t = JSON.parse(await readFile(join(root, 'fixtures/memory-sharing/second-brain.json'), 'utf8')).texts;
const ORIGIN = 'https://memory.example';
let directory, child, base, logs = '';
const pause = ms => new Promise(r => setTimeout(r, ms));

async function send(input) {
  const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200, await r.clone().text()); return r.json();
}
/** Cookie jar over harness responses; SameSite is not modelled here. */
class Browser {
  jar = new Map();
  async go(path, { method = 'GET', form, origin = ORIGIN, headers = {}, github } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method === 'POST') { if (origin) h.origin = origin; h['content-type'] ??= 'application/x-www-form-urlencoded'; }
    const r = await send({ path, method, headers: h, github, ...(method === 'POST' && { body: new URLSearchParams(form ?? {}).toString() }) });
    for (const c of r.cookies) {
      const pair = c.split(';')[0], name = pair.slice(0, pair.indexOf('='));
      if (/Max-Age=0/i.test(c)) this.jar.delete(name); else this.jar.set(name, pair.slice(name.length + 1));
    }
    return { ...r, location: new Headers(r.headers).get('location') };
  }
}
async function login(github) {
  const browser = new Browser(), start = await browser.go('/review/login', { method: 'POST' });
  assert.equal(start.status, 303, start.body);
  const state = new URL(start.location).searchParams.get('state');
  const callback = await browser.go(`/review/github/callback?${new URLSearchParams({ code: 'synthetic-code', state })}`, { github });
  return { browser, state, callback };
}
const approveForms = html => [...html.matchAll(/<form method="post" action="\/review\/approve">(.*?)<\/form>/gs)]
  .map(m => Object.fromEntries([...m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(x => [x[1], x[2]])));
async function tool(name, args, token = 'synthetic-writer') {
  const r = await send({ path: '/mcp', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(r.status, 200, r.body); return JSON.parse(r.body).result;
}
const data = async p => { const r = await p; assert.equal(r.isError, false, JSON.stringify(r.structuredContent)); return r.structuredContent; };
const command = (request_id = 'req-1', content = t.preference, expected_version = 0) => ({ collection: 'shared', request_id, fact_id: 'preference', operation: 'put',
  expected_version, content, source: 'fictional-review-workerd', observed_at: '2020-01-01T00:00:00Z', valid_from: '2020-01-01T00:00:00Z' });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'shared-memory-review-')); await mkdir(join(directory, 'config'), { recursive: true });
  // Two free ports: HTTP and the inspector, whose default 9229 collides when several runtimes start together.
  const free = async () => { const server = net.createServer(); await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); }); const { port } = server.address(); await new Promise(r => server.close(r)); return port; };
  const port = await free(), inspector = await free(); base = `http://127.0.0.1:${port}/`;
  child = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector),
    '--config', join(root, 'test/workerd/review/wrangler.json'), '--persist-to', join(directory, 'state')],
  { cwd: root, detached: true, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', XDG_CONFIG_HOME: join(directory, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { logs = (logs + d).slice(-16000); });
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base, { method: 'POST', body: '{"action":"reset"}', signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await pause(150);
  }
  throw new Error(`workerd startup failed: ${logs}`);
}, { timeout: 40000 });
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await exited; }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => { assert.equal((await send({ action: 'reset' })).reset, true); });

test('real workerd: unauthenticated review writes nothing and foreign login posts are refused', async () => {
  await data(tool('propose_fact', command()));
  const browser = new Browser(), page = await browser.go('/review');
  assert.equal(page.status, 200); assert.match(page.body, /Sign in with GitHub/); assert.doesNotMatch(page.body, /Aurora/);
  assert.equal((await browser.go('/review/login', { method: 'POST', origin: 'https://evil.example' })).status, 403);
  const counts = await send({ action: 'counts' });
  for (const table of ['memory_review_logins', 'memory_review_sessions', 'memory_review_budget', 'memory_approvals']) assert.equal(counts[table], 0);
});

test('real workerd: writer proposes over MCP, owner approves the exact digest in a browser session, second client reads', async () => {
  const tools = JSON.parse((await send({ path: '/mcp', method: 'POST', headers: { authorization: 'Bearer synthetic-writer', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).body).result.tools.map(x => x.name);
  assert.equal(tools.some(name => /approv|review/.test(name)), false);
  const p = await data(tool('propose_fact', command()));
  assert.equal((await tool('put_fact', { collection: 'shared', proposal_id: p.proposal_id })).structuredContent.error, 'APPROVAL_REQUIRED');
  // A bearer token, even one whose grant claims memory:approve, is not a review session.
  const bearerOnly = await send({ path: '/review/approve', method: 'POST', headers: { authorization: 'Bearer synthetic-writer', origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'f'.repeat(64), collection: 'shared', proposal_id: p.proposal_id, expected_digest: p.digest }).toString() });
  assert.equal(bearerOnly.status, 401);
  const { browser, callback } = await login();
  assert.equal(callback.status, 200, callback.body); assert.equal(callback.githubFetches, 2);
  assert.ok(callback.cookies.some(c => /^__Host-memory-review=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; Secure; HttpOnly; SameSite=Strict$/.test(c)));
  const review = await browser.go('/review');
  for (const text of ['shared / preference: new fact', 'from v0 to v1; current: none', t.preference, 'fictional-review-workerd', 'connection:conn-writer', p.digest]) assert.ok(review.body.includes(text), text);
  const [form] = approveForms(review.body);
  assert.equal(form.expected_digest, p.digest);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form: { ...form, expected_digest: '0'.repeat(64) } })).status, 409);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form })).status, 303);
  const [approval] = await send({ action: 'approvals' });
  assert.equal(approval.digest, p.digest); assert.equal(approval.approved_by, 'github-12345:review'); assert.ok(approval.consumed_at_ms > 0); // approving saves
  const saved = await data(tool('put_fact', { collection: 'shared', proposal_id: p.proposal_id }));
  assert.equal(saved.status, 'stored'); assert.equal(saved.committed_version, 1); assert.equal(saved.replayed, true);
  const fact = await data(tool('get_fact', { collection: 'shared', id: 'preference' }, 'synthetic-reader'));
  assert.equal(fact.content, t.preference); assert.equal(fact.version, 1); assert.equal(fact.actor, 'connection:conn-writer');
  const found = await data(tool('search_facts', { collection: 'shared', query: 'Aurora mattino', mode: 'lexical' }, 'synthetic-reader'));
  assert.equal(found.candidates[0].id, 'preference');
  assert.equal((await tool('propose_fact', command('reader-try', t.stale, 1), 'synthetic-reader')).structuredContent.error, 'FORBIDDEN');
  const foreign = await send({ path: '/mcp', method: 'POST', headers: { authorization: 'Bearer synthetic-foreign', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(foreign.status, 401);
  assert.equal((await send({ action: 'approvals' }))[0].consumed_at_ms > 0, true);
});

test('real workerd: another GitHub account, a replayed callback and an outage create no session or approval', async () => {
  await data(tool('propose_fact', command()));
  assert.equal((await login('other-user')).callback.status, 403);
  assert.equal((await login('unavailable')).callback.status, 503);
  const { browser, state, callback } = await login();
  assert.equal(callback.status, 200);
  const replay = await new Browser().go(`/review/github/callback?${new URLSearchParams({ code: 'synthetic-code', state })}`);
  assert.equal(replay.status, 400); assert.equal(replay.githubFetches, 0);
  const counts = await send({ action: 'counts' });
  assert.equal(counts.memory_review_sessions, 1); assert.equal(counts.memory_approvals, 0); assert.equal(counts.memory_review_logins, 3);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form: { ...approveForms((await browser.go('/review')).body)[0], csrf: '0'.repeat(64) } })).status, 403);
});
