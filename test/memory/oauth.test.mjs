import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalD1 } from './testkit.mjs';
import { installOAuthSchema } from '../../src/auth/schema.mjs';
import { authConfig } from '../../src/auth/config.mjs';
import { scopeFits, prepareConnection, activateConnection, authorizedConnection, revokeConnection, claimUse, GRANT_TTL_MS } from '../../src/auth/registry.mjs';
import { dailyBudget, guardOAuth } from '../../src/auth/guard.mjs';
import { consentPage, consentCsp } from '../../src/auth/consent.mjs';
let db;
const origin = 'https://memory.example';
const limiter = { async limit() { return { success: true }; } };
const environment = () => ({ DB: db, OAUTH_KV: {}, MEMORY_OAUTH_ENABLED: 'true', MEMORY_PUBLIC_ORIGIN: origin,
  GITHUB_OWNER_ID: '12345', GITHUB_CLIENT_ID: 'fictional-app', GITHUB_CLIENT_SECRET: 'fictional-secret',
  MEMORY_REVIEW_COLLECTIONS: 'shared,writing', MEMORY_OAUTH_COLLECTIONS: 'shared,writing',
  AUTH_GUARDS_REQUIRED: 'true', AUTH_LOGIN_LIMIT: limiter, AUTH_API_LIMIT: limiter });
const grant = { userId: 'github-12345', clientId: 'fictional-client', resource: origin + '/memory/mcp',
  scope: 'memory:read memory:write', collections: ['shared','writing'], redirectUri: 'https://client.example/callback' };
const token = { ...grant, scope: ['memory:read','memory:write'] };
beforeEach(async () => { db = await new LocalD1().init(); await installOAuthSchema(db); });
afterEach(() => db.close());

test('OAuth needs explicit opt-in, KV and a collection allowlist inside owner review', () => {
  const env = environment(), c = authConfig(env);
  assert.equal(c.resource, origin + '/memory/mcp'); assert.equal(c.callback, origin + '/oauth/github/callback');
  for (const patch of [{ MEMORY_OAUTH_ENABLED:'false' }, { OAUTH_KV:null }, { MEMORY_OAUTH_COLLECTIONS:'' },
    { MEMORY_OAUTH_COLLECTIONS:'private' }, { MEMORY_OAUTH_COLLECTIONS:'shared,shared' }]) assert.throws(() => authConfig({ ...env, ...patch }));
});
test('OAuth scopes require read and never include approval, purge or export', () => {
  assert.equal(scopeFits('memory:read'), true); assert.equal(scopeFits('memory:read memory:write'), true);
  for (const value of ['', 'memory:write', 'memory:read memory:approve', 'memory:read memory:purge', 'memory:read memory:read']) assert.equal(scopeFits(value), false);
});
test('a pending connection is unusable; an active matching connection carries only approved collections', async () => {
  const id = await prepareConnection(db, grant), props = { connectionId:id }, config = authConfig(environment());
  assert.equal(await authorizedConnection(db,props,token,config), null);
  await activateConnection(db,id);
  assert.deepEqual((await authorizedConnection(db,props,token,config)).collections, ['shared','writing']);
  const narrower = authConfig({ ...environment(), MEMORY_OAUTH_COLLECTIONS:'shared' });
  assert.deepEqual((await authorizedConnection(db,props,token,narrower)).collections, ['shared']);
  const noOverlap = { ...config, collections:['ungranted'] };
  assert.equal(await authorizedConnection(db,props,token,noOverlap), null);
});
test('a valid provider token cannot cross owner, client, resource, scope or connection lifetime', async () => {
  const id = await prepareConnection(db,grant), props = { connectionId:id }, c = authConfig(environment()); await activateConnection(db,id);
  for (const patch of [{userId:'github-77777'},{clientId:'other-client'},{resource:'https://other.example/memory/mcp'},
    {scope:['memory:read','memory:approve']},{scope:['memory:write']}]) assert.equal(await authorizedConnection(db,props,{...token,...patch},c),null);
  assert.ok(await authorizedConnection(db,props,{...token,scope:['memory:read']},c));
  assert.equal(await authorizedConnection(db,props,token,c,Date.now()+GRANT_TTL_MS+1),null);
});
test('D1 revocation denies an otherwise valid provider token immediately', async () => {
  const id = await prepareConnection(db,grant); await activateConnection(db,id);
  assert.ok(await authorizedConnection(db,{connectionId:id},token,authConfig(environment())));
  assert.equal(await revokeConnection(db,id),true); assert.equal(await revokeConnection(db,id),false);
  assert.equal(await authorizedConnection(db,{connectionId:id},token,authConfig(environment())),null);
});
test('cross-location replay claims keep only digests and accept a nonce once', async () => {
  const nonce='fictional-browser-bound-consent';
  assert.equal(await claimUse(db,'consent',nonce),true); assert.equal(await claimUse(db,'consent',nonce),false);
  const stored=db.raw.prepare('SELECT * FROM memory_oauth_uses').get(); assert.equal(stored.digest.length,64); assert.ok(!JSON.stringify(stored).includes(nonce));
});
test('primary daily budgets are bounded and OAuth guards fail closed', async () => {
  const now=Date.parse('2026-11-08T12:00:00Z');
  assert.equal(await dailyBudget(db,'register',2,now),true); assert.equal(await dailyBudget(db,'register',2,now),true);
  assert.equal(await dailyBudget(db,'register',2,now),false); assert.equal(await dailyBudget(db,'register',2,now+86400000),true);
  const request=new Request(origin+'/authorize');
  assert.equal(await guardOAuth(request,environment()),null);
  assert.equal((await guardOAuth(request,{...environment(),AUTH_LOGIN_LIMIT:null})).status,503);
  assert.equal((await guardOAuth(request,{...environment(),AUTH_LOGIN_LIMIT:{async limit(){return {success:false};}}})).status,429);
});
test('consent escapes client data, discloses redirect identity and keeps approvals separate', () => {
  const html=consentPage({clientName:'<script>alert(1)</script>',clientDomain:'client.example',redirectHost:'127.0.0.1',redirectIsLoopback:true},'safe-handle',['shared'],['memory:read','memory:write']);
  assert.doesNotMatch(html,/<script>/); assert.match(html,/&#60;script&#62;/); assert.match(html,/127\.0\.0\.1/);
  assert.match(html,/separate owner review/); assert.match(html,/memory:write/); assert.match(html,/name="collection" value="shared"/);
  assert.match(consentCsp('http://127.0.0.1:43123/callback'),/http:\/\/127\.0\.0\.1:43123/);
  assert.throws(()=>consentCsp('custom-app:/callback'));
});
test('the OAuth migration is additive and refuses an untracked same-name schema', async () => {
  const fresh=new LocalD1();
  try {
    fresh.raw.exec(await readFile(new URL('../../migrations/0001_bootstrap.sql',import.meta.url),'utf8'));
    const tablesBefore=fresh.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    const sql=await readFile(new URL('../../migrations/0002_oauth.sql',import.meta.url),'utf8');fresh.raw.exec(sql);
    const tablesAfter=fresh.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    for(const name of tablesBefore)assert.ok(tablesAfter.includes(name));assert.throws(()=>fresh.raw.exec(sql),/already exists/);
  } finally {fresh.close();}
});
