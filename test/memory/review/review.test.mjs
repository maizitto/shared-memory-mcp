/** Owner review in Node with real SQLite. Fictional GitHub, owner and content only. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalD1 } from '../testkit.mjs';
import { installReviewSchema } from '../../../src/memory/review/schema.mjs';
import { STYLE, STYLE_HASH } from '../../../src/memory/review/page.mjs';
import { createHash } from 'node:crypto';
import { createReviewApp, DAILY_LOGINS, LOGIN_TTL_MS, SESSION_TTL_MS } from '../../../src/memory/review/app.mjs';
import { reviewConfig, clientPrincipal, reviewerPrincipal } from '../../../src/memory/review/identity.mjs';
import { challenge } from '../../../src/platform/github.mjs';
import { proposeFact, approveProposal, commitProposal, getFact, listFacts, MemoryError } from '../../../src/memory/ledger.mjs';
import { searchFacts } from '../../../src/memory/indexer.mjs';

const t = JSON.parse(readFileSync(new URL('../../../fixtures/memory-sharing/second-brain.json', import.meta.url))).texts;
const ORIGIN = 'https://memory.example';
const settings = { MEMORY_PUBLIC_ORIGIN: ORIGIN, GITHUB_OWNER_ID: '12345', GITHUB_CLIENT_ID: 'synthetic-app', GITHUB_CLIENT_SECRET: 'synthetic-not-a-secret', MEMORY_REVIEW_COLLECTIONS: 'shared' };
const config = reviewConfig({ ...settings, DB: {} });
const grant = (scope, connectionId, userId = 'github-12345') => clientPrincipal(config, { userId, scope, props: { connectionId } });
// A token that also claims memory:approve: the adapter must drop it.
const writer = grant(['memory:read', 'memory:write', 'memory:approve'], 'conn-writer');
const reader = grant(['memory:read'], 'conn-reader');
const put = (request_id = 'req-1', content = t.preference, expected_version = 0, extra = {}) => ({ collection: 'shared', request_id, fact_id: 'preference', operation: 'put', expected_version, content,
  source: 'fictional-review-test', observed_at: '2020-01-01T00:00:00Z', valid_from: '2020-01-01T00:00:00Z', ...extra });
const error = code => e => e instanceof MemoryError && e.code === code;
const count = table => db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const offline = { embedding: { fingerprint: 'offline', async embed() { throw new Error('offline'); } }, vectors: {} };
let db, now, gh, app;

function fakeGithub() {
  const state = { calls: [], user: 12345 };
  state.fetch = async (url, options) => {
    state.calls.push(url);
    if (state.mode === 'unavailable') return new Response('', { status: 503 });
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(options.body);
      assert.equal(options.redirect, 'manual'); assert.equal(body.get('redirect_uri'), `${ORIGIN}/review/github/callback`); assert.equal(body.get('code'), 'synthetic-code');
      state.verifier = body.get('code_verifier');
      return Response.json({ access_token: 'synthetic-github-token', scope: '' });
    }
    if (url === 'https://api.github.com/user') return Response.json({ id: state.user });
    throw new Error('unexpected external fetch');
  };
  return state;
}
/** Minimal cookie jar. It does not model SameSite; that browser behaviour is checked separately. */
class Browser {
  jar = new Map();
  async go(path, { method = 'GET', form, origin = ORIGIN, headers = {}, body } = {}) {
    const h = new Headers(headers);
    if (this.jar.size) h.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (method === 'POST') {
      if (origin) h.set('origin', origin);
      if (!h.has('content-type')) h.set('content-type', 'application/x-www-form-urlencoded');
      body ??= new URLSearchParams(form ?? {}).toString();
    }
    const r = await app.fetch(new Request(ORIGIN + path, { method, headers: h, body }));
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(';')[0], name = pair.slice(0, pair.indexOf('='));
      if (/Max-Age=0/i.test(c)) this.jar.delete(name); else this.jar.set(name, pair.slice(name.length + 1));
    }
    return { status: r.status, headers: r.headers, cookies: r.headers.getSetCookie(), body: await r.text() };
  }
}
async function login(browser = new Browser()) {
  const start = await browser.go('/review/login', { method: 'POST' });
  assert.equal(start.status, 303, start.body);
  const to = new URL(start.headers.get('location'));
  const callback = await browser.go(`/review/github/callback?${new URLSearchParams({ code: 'synthetic-code', state: to.searchParams.get('state') })}`);
  return { browser, start, to, callback };
}
const approveForms = html => [...html.matchAll(/<form method="post" action="\/review\/approve">(.*?)<\/form>/gs)]
  .map(m => Object.fromEntries([...m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(x => [x[1], x[2]])));
async function signedIn() { const s = await login(); assert.equal(s.callback.status, 200, s.callback.body); return s.browser; }

beforeEach(async () => {
  db = await new LocalD1().init(); await installReviewSchema(db);
  now = Date.now(); gh = fakeGithub();
  app = createReviewApp({ ...settings, DB: db }, { githubFetcher: gh.fetch, clock: () => now });
});
afterEach(() => db.close());

test('configuration requires an https origin, numeric owner, credentials and valid collections', () => {
  assert.equal(config.callback, 'https://memory.example/review/github/callback'); assert.deepEqual(config.collections, ['shared']);
  for (const value of ['http://memory.example', 'https://memory.example/x', 'https://u@memory.example']) assert.throws(() => reviewConfig({ ...settings, DB: {}, MEMORY_PUBLIC_ORIGIN: value }));
  for (const value of ['', '0', 'owner', '9007199254740993']) assert.throws(() => reviewConfig({ ...settings, DB: {}, GITHUB_OWNER_ID: value }));
  for (const value of ['', 'a,a', 'shared,', '../x']) assert.throws(() => reviewConfig({ ...settings, DB: {}, MEMORY_REVIEW_COLLECTIONS: value }));
  for (const key of ['DB', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) assert.throws(() => reviewConfig({ ...settings, DB: {}, [key]: undefined }));
});

test('identity adapter drops memory:approve from tokens; only the configured GitHub owner reviews', async () => {
  assert.deepEqual(writer.scopes, ['memory:read', 'memory:write']); assert.equal(writer.owner_id, 'github-12345'); assert.equal(writer.subject, 'connection:conn-writer');
  assert.equal(grant(['memory:approve'], 'conn-x'), null); assert.equal(grant(['memory:read'], 'conn-x', 'github-77777'), null);
  assert.equal(grant(['memory:read'], '../bad'), null); assert.equal(clientPrincipal(config, null), null);
  assert.equal(reviewerPrincipal(config, '77777'), null); assert.equal(reviewerPrincipal(config, 12345), null);
  assert.deepEqual(reviewerPrincipal(config, '12345'), { owner_id: 'github-12345', subject: 'github-12345:review', scopes: ['memory:approve', 'memory:purge', 'memory:export'], collections: ['shared'] });
  const p = await proposeFact(db, writer, put());
  await assert.rejects(approveProposal(db, writer, { collection: 'shared', proposal_id: p.proposal_id, expected_digest: p.digest }), error('FORBIDDEN'));
});

test('unauthenticated GET shows only the login form and writes nothing; foreign login posts are refused', async () => {
  await proposeFact(db, writer, put());
  const browser = new Browser(), r = await browser.go('/review');
  assert.equal(r.status, 200); assert.match(r.body, /Sign in with GitHub/); assert.doesNotMatch(r.body, /Aurora/);
  assert.match(r.headers.get('content-security-policy'), /form-action 'self' https:\/\/github\.com;/); assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await browser.go('/review/login', { method: 'POST', origin: 'https://evil.example' })).status, 403);
  assert.equal((await browser.go('/review/login', { method: 'POST', origin: null })).status, 403);
  assert.equal((await browser.go('/review/login', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await browser.go('/review/login')).status, 405);
  for (const table of ['memory_review_logins', 'memory_review_sessions', 'memory_review_budget']) assert.equal(count(table), 0);
  assert.equal(gh.calls.length, 0);
});

test('login uses PKCE S256, binds state to the starting browser and is single use', async () => {
  const { browser, start, to, callback } = await login();
  assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/review/github/callback`); assert.equal(to.searchParams.get('scope'), '');
  assert.equal(to.searchParams.get('client_id'), 'synthetic-app'); assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('code_challenge'), await challenge(gh.verifier));
  assert.match(start.cookies[0], /^__Host-memory-review-login=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  const stored = db.raw.prepare('SELECT * FROM memory_review_logins').get();
  assert.notEqual(stored.state_sha256, to.searchParams.get('state')); assert.ok(stored.used_at_ms);
  assert.equal(callback.status, 200); assert.match(callback.body, /href="\/review"/);
  assert.ok(callback.cookies.some(c => /^__Host-memory-review-login=; Max-Age=0/.test(c)));
  assert.ok(callback.cookies.some(c => /^__Host-memory-review=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; Secure; HttpOnly; SameSite=Strict$/.test(c)));
  const session = db.raw.prepare('SELECT * FROM memory_review_sessions').get();
  assert.equal(session.github_id, '12345'); assert.equal(session.token_sha256.length, 64); assert.ok(!callback.cookies.join().includes(session.token_sha256));
  // The same callback again, even with a restored binding cookie, is refused without calling GitHub.
  const replay = new Browser(); replay.jar.set('__Host-memory-review-login', /=([^;]+)/.exec(start.cookies[0])[1]);
  const calls = gh.calls.length, again = await replay.go(`/review/github/callback?${new URLSearchParams({ code: 'synthetic-code', state: to.searchParams.get('state') })}`);
  assert.equal(again.status, 400); assert.equal(gh.calls.length, calls); assert.equal(count('memory_review_sessions'), 1);
  assert.equal((await browser.go('/review')).status, 200);
});

test('a callback in another browser, an expired state, another account or GitHub outage create no session', async () => {
  const victim = new Browser(), attacker = new Browser();
  const start = await attacker.go('/review/login', { method: 'POST' }), state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await victim.go(`/review/github/callback?code=synthetic-code&state=${state}`)).status, 400);
  now += LOGIN_TTL_MS + 1;
  assert.equal((await attacker.go(`/review/github/callback?code=synthetic-code&state=${state}`)).status, 400);
  assert.equal(gh.calls.length, 0);
  gh.user = 77777; assert.equal((await login()).callback.status, 403);
  gh.mode = 'unavailable'; assert.equal((await login()).callback.status, 503);
  assert.equal(count('memory_review_sessions'), 0);
});

test('owner sees collection, version, content, source, validity and digest; markup is escaped; other owners are absent', async () => {
  const p = await proposeFact(db, writer, put('req-1', t.preference, 0, { source: '<img src=x onerror=alert(1)>', expires_at: '2030-01-01T00:00:00Z' }));
  await proposeFact(db, { owner_id: 'github-77777', subject: 'other', scopes: ['memory:write'], collections: ['shared'] }, put('foreign', t.stale));
  await proposeFact(db, { owner_id: 'github-12345', subject: 'private-writer', scopes: ['memory:write'], collections: ['private'] }, { ...put('private', t.corrected), collection: 'private' });
  const r = await (await signedIn()).go('/review');
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-security-policy'), `default-src 'none'; style-src '${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  for (const text of ['shared / preference: new fact', 'from v0 to v1; current: none', t.preference, 'connection:conn-writer', 'Valid from</dt><dd>2020-01-01T00:00:00.000Z', 'Valid until</dt><dd>2030-01-01T00:00:00.000Z', p.digest, '&#60;img src=x onerror=alert(1)&#62;'])
    assert.ok(r.body.includes(text), text);
  assert.doesNotMatch(r.body, /<img|<script/); assert.ok(!r.body.includes(t.stale)); assert.ok(!r.body.includes(t.corrected));
  const forms = approveForms(r.body);
  assert.equal(forms.length, 1); assert.deepEqual(Object.keys(forms[0]), ['csrf', 'collection', 'proposal_id', 'expected_digest']);
  assert.equal(forms[0].proposal_id, p.proposal_id); assert.equal(forms[0].expected_digest, p.digest);
});

test('approval requires a same-origin form, its session CSRF token and the exact digest', async () => {
  const p = await proposeFact(db, writer, put()), browser = await signedIn(), [form] = approveForms((await browser.go('/review')).body);
  const post = (values, options = {}, who = browser) => who.go('/review/approve', { method: 'POST', form: values, ...options });
  assert.equal((await post(form, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(form, { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await post(form, {}, new Browser())).status, 401);
  assert.equal((await post({ ...form, csrf: 'f'.repeat(64) })).status, 403);
  const other = await signedIn(), [otherForm] = approveForms((await other.go('/review')).body);
  assert.equal((await post({ ...form, csrf: otherForm.csrf })).status, 403);
  assert.equal((await post({ ...form, expected_digest: '0'.repeat(64) })).status, 409);
  assert.equal((await post({ ...form, collection: 'private' })).status, 403);
  assert.equal((await post({ ...form, approved: 'true' })).status, 400);
  assert.equal((await browser.go('/review/approve', { method: 'POST', body: new URLSearchParams([...Object.entries(form), ['proposal_id', p.proposal_id]]).toString() })).status, 400);
  assert.equal((await browser.go('/review/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })).status, 415);
  assert.equal((await browser.go('/review/approve', { method: 'POST', body: 'x='.padEnd(17000, 'y') })).status, 413);
  assert.equal(count('memory_approvals'), 0);
  const ok = await post(form);
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/review?done=1');
  const approval = db.raw.prepare('SELECT * FROM memory_approvals').get();
  assert.equal(approval.digest, p.digest); assert.equal(approval.approved_by, 'github-12345:review');
  assert.equal((await post(form)).status, 303); assert.equal(count('memory_approvals'), 1);
  // Approving saved it: the fact is readable at once and the page confirms it.
  assert.equal((await getFact(db, reader, { collection: 'shared', id: 'preference' })).content, t.preference);
  assert.match((await browser.go('/review?done=1')).body, /Saved 1 fact\./);
});

test('end to end: writer proposes, owner approves in the browser, writer commits, second client reads', async () => {
  const p = await proposeFact(db, writer, put());
  await assert.rejects(commitProposal(db, writer, { collection: 'shared', proposal_id: p.proposal_id }, 'put'), error('APPROVAL_REQUIRED'));
  const browser = await signedIn(), [form] = approveForms((await browser.go('/review')).body);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form })).status, 303);
  // The writer's confirmation replays the receipt written at approval.
  const saved = await commitProposal(db, writer, { collection: 'shared', proposal_id: p.proposal_id }, 'put');
  assert.equal(saved.status, 'stored'); assert.equal(saved.committed_version, 1); assert.equal(saved.replayed, true);
  const fact = await getFact(db, reader, { collection: 'shared', id: 'preference' });
  assert.equal(fact.content, t.preference); assert.equal(fact.version, 1); assert.equal(fact.actor, 'connection:conn-writer');
  assert.equal((await listFacts(db, reader, { collection: 'shared' })).facts.length, 1);
  assert.equal((await searchFacts(db, reader, { collection: 'shared', query: 'Aurora mattino', mode: 'lexical' }, offline)).candidates[0].id, 'preference');
  await assert.rejects(proposeFact(db, reader, put('reader-attempt', t.stale, 1)), error('FORBIDDEN'));
  const after = (await browser.go('/review')).body;
  assert.match(after, /Pending \(0\)/); assert.doesNotMatch(after, /Approved but not saved/);
});

test('stale versions and deleted IDs are shown as not approvable and refused on POST', async () => {
  const browser = await signedIn(), approveAll = async () => { for (const form of approveForms((await browser.go('/review')).body)) assert.equal((await browser.go('/review/approve', { method: 'POST', form })).status, 303); };
  const first = await proposeFact(db, writer, put()); await approveAll(); await commitProposal(db, writer, { collection: 'shared', proposal_id: first.proposal_id }, 'put');
  const a = await proposeFact(db, writer, put('edit-a', t.corrected, 1)), b = await proposeFact(db, writer, put('edit-b', t.stale, 1));
  const before = approveForms((await browser.go('/review')).body), formB = before.find(f => f.proposal_id === b.proposal_id);
  assert.equal(before.length, 2);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form: before.find(f => f.proposal_id === a.proposal_id) })).status, 303);
  await commitProposal(db, writer, { collection: 'shared', proposal_id: a.proposal_id }, 'put');
  const page = (await browser.go('/review')).body;
  assert.match(page, /starts from version 1, but the current version is 2/); assert.equal(approveForms(page).length, 0);
  assert.ok(page.includes(`Current content (v2)</h4><pre>${t.corrected}`));
  assert.equal((await browser.go('/review/approve', { method: 'POST', form: formB })).status, 409);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_approvals WHERE proposal_id=?').get(b.proposal_id).n, 0);
  const del = await proposeFact(db, writer, { collection: 'shared', request_id: 'delete-1', fact_id: 'preference', operation: 'delete', expected_version: 2 });
  assert.match((await browser.go('/review')).body, /logical deletion[\s\S]*Content to be hidden \(v2\)/);
  await approveAll(); await commitProposal(db, writer, { collection: 'shared', proposal_id: del.proposal_id }, 'delete');
  await proposeFact(db, writer, put('reuse', t.stale, 3));
  assert.match((await browser.go('/review')).body, /this ID was deleted/);
});

test('session expiry and logout end review rights', async () => {
  await proposeFact(db, writer, put());
  const browser = await signedIn(), [form] = approveForms((await browser.go('/review')).body);
  now += SESSION_TTL_MS;
  assert.match((await browser.go('/review')).body, /Sign in with GitHub/);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form })).status, 401);
  now -= SESSION_TTL_MS;
  const second = await signedIn(), [current] = approveForms((await second.go('/review')).body);
  assert.equal((await second.go('/review/logout', { method: 'POST', form: { csrf: 'f'.repeat(64) } })).status, 403);
  const old = second.jar.get('__Host-memory-review'), out = await second.go('/review/logout', { method: 'POST', form: { csrf: current.csrf } });
  assert.equal(out.status, 303); assert.ok(out.cookies.some(c => /^__Host-memory-review=; Max-Age=0/.test(c)));
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_review_sessions WHERE revoked_at_ms IS NOT NULL').get().n, 1);
  // A copied cookie stays useless after logout because the server-side session is revoked.
  second.jar.set('__Host-memory-review', old);
  assert.match((await second.go('/review')).body, /Sign in with GitHub/);
  assert.equal((await second.go('/review/approve', { method: 'POST', form: current })).status, 401);
  assert.equal(count('memory_approvals'), 0);
});

test('duplicate session cookies and unknown paths are refused', async () => {
  const browser = await signedIn(), value = browser.jar.get('__Host-memory-review');
  const r = await app.fetch(new Request(`${ORIGIN}/review`, { headers: { cookie: `__Host-memory-review=${value}; __Host-memory-review=${value}` } }));
  assert.match(await r.text(), /Sign in with GitHub/);
  assert.equal((await browser.go('/review/other')).status, 404);
  assert.equal((await app.fetch(new Request('https://evil.example/review'))).status, 400);
});

test('daily login budget bounds unauthenticated D1 writes', async () => {
  for (let i = 0; i < DAILY_LOGINS; i++) assert.equal((await new Browser().go('/review/login', { method: 'POST' })).status, 303);
  assert.equal((await new Browser().go('/review/login', { method: 'POST' })).status, 429);
  assert.equal(count('memory_review_logins'), DAILY_LOGINS);
});

const formsFor = (html, action) => [...html.matchAll(new RegExp(`<form method="post" action="${action.replace(/\//g, '\\/')}">(.*?)</form>`, 'gs'))]
  .map(m => Object.fromEntries([...m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(x => [x[1], x[2]])));
const allText = () => JSON.stringify(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory%'").all()
  .map(({ name }) => db.raw.prepare(`SELECT * FROM ${name}`).all()));
async function stored(browser) {
  const p = await proposeFact(db, writer, put());
  const [form] = approveForms((await browser.go('/review')).body);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form })).status, 303);
  await commitProposal(db, writer, { collection: 'shared', proposal_id: p.proposal_id }, 'put');
  return p;
}

test('the owner can reject a proposal from the page; its text disappears at once', async () => {
  const p = await proposeFact(db, writer, put()), browser = await signedIn();
  const [form] = formsFor((await browser.go('/review')).body, '/review/discard');
  assert.deepEqual(form, { csrf: form.csrf, collection: 'shared', proposal_id: p.proposal_id });
  assert.equal((await browser.go('/review/discard', { method: 'POST', form: { ...form, csrf: '0'.repeat(64) } })).status, 403);
  assert.equal((await browser.go('/review/discard', { method: 'POST', form, origin: 'https://evil.example' })).status, 403);
  assert.ok(allText().includes(t.preference));
  assert.equal((await browser.go('/review/discard', { method: 'POST', form })).status, 303);
  assert.ok(!allText().includes(t.preference)); assert.equal(count('memory_proposals'), 0);
  assert.equal((await browser.go('/review/discard', { method: 'POST', form })).status, 409);
  assert.match((await browser.go('/review')).body, /Pending \(0\)/);
});

test('definitive purge takes two steps: the first only shows what will be destroyed', async () => {
  const browser = await signedIn(); await stored(browser);
  const page = (await browser.go('/review')).body;
  assert.match(page, /Stored memory \(1\)/); assert.match(page, /current v1; saved versions: 1/);
  const [form] = formsFor(page, '/review/purge');
  const confirm = await browser.go('/review/purge', { method: 'POST', form });
  assert.equal(confirm.status, 200); assert.ok(confirm.body.includes(t.preference)); assert.match(confirm.body, /This cannot be undone[\s\S]*7 days/);
  assert.ok(allText().includes(t.preference)); assert.equal(count('memory_purges'), 0);
  const [final] = formsFor(confirm.body, '/review/purge/confirm');
  assert.equal(final.confirm, 'permanent');
  assert.equal((await browser.go('/review/purge/confirm', { method: 'POST', form: { ...final, confirm: 'si' } })).status, 400);
  assert.equal((await browser.go('/review/purge/confirm', { method: 'POST', form })).status, 400);
  assert.equal((await browser.go('/review/purge/confirm', { method: 'POST', form: { ...final, csrf: 'f'.repeat(64) } })).status, 403);
  assert.equal((await new Browser().go('/review/purge/confirm', { method: 'POST', form: final })).status, 401);
  assert.equal((await browser.go('/review/purge/confirm', { method: 'POST', form: final })).status, 303);
  assert.ok(!allText().includes(t.preference)); assert.equal(count('memory_purges'), 1);
  await assert.rejects(getFact(db, reader, { collection: 'shared', id: 'preference' }), error('NOT_FOUND'));
  assert.match((await browser.go('/review')).body, /Stored memory \(0\)/);
  assert.equal((await browser.go('/review/purge', { method: 'POST', form })).status, 404);
});

test('export downloads one collection, only within the owner session, and writes nothing', async () => {
  const browser = await signedIn(); await stored(browser);
  const before = allText(), r = await browser.go('/review/export?collection=shared');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="memory-shared-\d{4}-\d\d-\d\d\.json"$/);
  const data = JSON.parse(r.body);
  assert.equal(data.format, 'persistent-memory-export'); assert.equal(data.owner_id, 'github-12345'); assert.equal(data.facts[0].versions[0].payload.content, t.preference);
  assert.equal(allText(), before);
  assert.match((await browser.go('/review')).body, /href="\/review\/export\?collection=shared"/);
  assert.equal((await new Browser().go('/review/export?collection=shared')).status, 401);
  assert.equal((await browser.go('/review/export?collection=private')).status, 403);
  assert.equal((await browser.go('/review/export?collection=shared&collection=shared')).status, 400);
  assert.equal((await browser.go('/review/export?collection=shared&x=1')).status, 400);
  assert.equal((await browser.go('/review/export', { method: 'POST' })).status, 405);
});

test('the only stylesheet matches the hash allowed by the CSP', () => {
  assert.equal(`sha256-${createHash('sha256').update(STYLE).digest('base64')}`, STYLE_HASH);
});

test('approve all: exactly the approvable proposals shown, each bound to its digest; others are skipped', async () => {
  const browser = await signedIn();
  const a = await proposeFact(db, writer, put('all-a', t.preference, 0, { fact_id: 'doc.s01' }));
  const b = await proposeFact(db, writer, put('all-b', t.corrected, 0, { fact_id: 'doc.s02' }));
  const c = await proposeFact(db, writer, put('all-c', t.stale, 0, { fact_id: 'doc.s03' }));
  const page = (await browser.go('/review')).body, [form] = formsFor(page, '/review/approve-all');
  assert.match(page, /Approve and save all 3 pending proposals for shared/);
  const items = [...page.matchAll(/name="item" value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(items.sort(), [a, b, c].map(p => `${p.proposal_id}:${p.digest}`).sort());
  const body = items => new URLSearchParams([['csrf', form.csrf], ['collection', 'shared'], ...items.map(i => ['item', i])]).toString();
  assert.equal((await browser.go('/review/approve-all', { method: 'POST', body: body(items), origin: 'https://evil.example' })).status, 403);
  assert.equal((await browser.go('/review/approve-all', { method: 'POST', body: body(Array(61).fill(items[0])) })).status, 400);
  assert.equal((await browser.go('/review/approve-all', { method: 'POST', body: body([items[0], items[0]]) })).status, 400);
  // A forged digest and an unknown proposal are skipped; the rest are approved with their own digests.
  const forged = [`${a.proposal_id}:${'0'.repeat(64)}`, `${b.proposal_id}:${b.digest}`, `00000000-0000-0000-0000-000000000000:${c.digest}`];
  assert.equal((await browser.go('/review/approve-all', { method: 'POST', body: body(forged) })).status, 303);
  assert.deepEqual(db.raw.prepare('SELECT proposal_id,digest FROM memory_approvals').all().map(r => [r.proposal_id, r.digest]), [[b.proposal_id, b.digest]]);
  assert.equal((await browser.go('/review/approve-all', { method: 'POST', body: body(items) })).status, 303);
  assert.equal(count('memory_approvals'), 3);
  for (const p of [a, b, c]) assert.equal((await commitProposal(db, writer, { collection: 'shared', proposal_id: p.proposal_id }, 'put')).status, 'stored');
});

test('a document section up to 8000 characters fits in one fact; longer is refused', async () => {
  const long = 'Sezione di prova inventata. '.repeat(300).slice(0, 8000);
  assert.equal((await proposeFact(db, writer, put('long-ok', long, 0, { fact_id: 'doc.long' }))).status, 'pending');
  await assert.rejects(proposeFact(db, writer, put('long-ko', `${long}x`, 0, { fact_id: 'doc.longer' })), error('INVALID_TEXT'));
});

test('approve all writes in a few statements within D1 limits; a second proposal for the same fact stays approved, not saved', async () => {
  const browser = await signedIn(), ids = [];
  for (let i = 0; i < 45; i++) ids.push(await proposeFact(db, writer, put(`bulk-${i}`, t.preference, 0, { fact_id: `bulk.s${String(i).padStart(2, '0')}` })));
  const twin = await proposeFact(db, writer, put('bulk-twin', t.corrected, 0, { fact_id: 'bulk.s00' }));
  const [form] = formsFor((await browser.go('/review')).body, '/review/approve-all');
  const items = [...(await browser.go('/review')).body.matchAll(/name="item" value="([^"]+)"/g)].map(m => m[1]);
  assert.equal(items.length, 46);
  // Count statements and bound parameters while the batch runs (D1 Free: 100 parameters per query).
  let statements = 0, maxParams = 0; const prepare = db.prepare.bind(db);
  db.prepare = sql => { statements++; const st = prepare(sql), bind = st.bind; st.bind = (...v) => { maxParams = Math.max(maxParams, v.length); return bind(...v); }; return st; };
  const r = await browser.go('/review/approve-all', { method: 'POST', body: new URLSearchParams([['csrf', form.csrf], ['collection', 'shared'], ...items.map(i => ['item', i])]).toString() });
  db.prepare = prepare;
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/review?done=45');
  assert.ok(maxParams <= 100, `max bound parameters ${maxParams}`); assert.ok(statements <= 20, `statements ${statements}`);
  assert.equal(count('memory_facts'), 45);
  assert.equal(db.raw.prepare('SELECT status FROM memory_proposals WHERE id=?').get(twin.proposal_id).status, 'approved');
  assert.match((await browser.go('/review')).body, /Approved but not saved \(1\)[\s\S]*Reject and delete/);
});

test('a proposal link opens just that proposal, survives the GitHub sign-in, and reports when it is saved', async () => {
  const p = await proposeFact(db, writer, put());
  const browser = new Browser(), anonymous = await browser.go(`/review?p=${p.proposal_id}`);
  assert.match(anonymous.body, new RegExp(`name="p" value="${p.proposal_id}"`));
  const start = await browser.go('/review/login', { method: 'POST', form: { p: p.proposal_id } });
  assert.ok(start.cookies.some(c => c.startsWith(`__Host-memory-review-next=${p.proposal_id}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`)));
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const signed = await browser.go(`/review/github/callback?code=synthetic-code&state=${state}`);
  assert.match(signed.body, new RegExp(`href="/review\\?p=${p.proposal_id}"`)); assert.ok(signed.cookies.some(c => /^__Host-memory-review-next=; Max-Age=0/.test(c)));
  const focused = await browser.go(`/review?p=${p.proposal_id}`);
  assert.match(focused.body, new RegExp(`id="p-${p.proposal_id}"`)); assert.equal(approveForms(focused.body).length, 1);
  assert.doesNotMatch(focused.body, /Stored memory/);
  assert.equal((await browser.go('/review/approve', { method: 'POST', form: approveForms(focused.body)[0] })).status, 303);
  assert.match((await browser.go(`/review?p=${p.proposal_id}`)).body, /already been saved/);
  assert.equal((await browser.go('/review/login', { method: 'POST', form: { p: 'not-a-uuid' } })).cookies.some(c => c.startsWith('__Host-memory-review-next=not')), false);
});

test('review authority ends after 12 hours even if an older session row expires later', async () => {
  await proposeFact(db, writer, put());
  const browser = await signedIn();
  now += 16 * 60000; assert.equal(approveForms((await browser.go('/review')).body).length, 1);
  db.raw.prepare('UPDATE memory_review_sessions SET expires_at_ms=created_at_ms+?').run(30 * 86400000);
  now += 11 * 3600000; assert.match((await browser.go('/review')).body, /Proposals to review/);
  now += 3600000; assert.match((await browser.go('/review')).body, /Sign in with GitHub/);
});
