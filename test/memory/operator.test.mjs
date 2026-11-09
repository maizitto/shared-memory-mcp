/** Operator boundaries: fictional files in a private temporary directory only. */
import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,chmod,rm,symlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {inspectConfig} from '../../scripts/doctor.mjs';
import {createKey,sealSql,openSnapshot,restoreSql,runBackupCli} from '../../scripts/backup.mjs';
import {withinLifetime,BEARER_TTL_MS} from '../../src/platform/credentials.mjs';
let dir,key,output;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'memory-operator-'));await chmod(dir,0o700);key=join(dir,'key');output=join(dir,'snapshot.smbak');});
afterEach(()=>rm(dir,{recursive:true,force:true}));
const base=async()=>{const c=JSON.parse(await readFile(new URL('../../config/wrangler.example.json',import.meta.url)));c.vars.MEMORY_PUBLIC_ORIGIN='https://memory.example';c.vars.GITHUB_CLIENT_ID='fictional-app';c.vars.MEMORY_ENABLED='true';c.d1_databases[0].database_id='11111111-1111-4111-8111-111111111111';return c;};
test('doctor rejects placeholders, exposed secrets and missing auth guards without printing values',async()=>{
  const template=JSON.parse(await readFile(new URL('../../config/wrangler.example.json',import.meta.url)));
  assert.equal(inspectConfig(template).ok,false);
  assert.equal(inspectConfig({vars:'invalid'}).ok,false);
  const c=await base();assert.equal(inspectConfig(c).ok,true);
  c.vars.GITHUB_CLIENT_SECRET='fictional-private-value';c.ratelimits=[];
  const r=inspectConfig(c);assert.equal(r.ok,false);assert.ok(r.errors.includes('secret_like_variable_in_file'));assert.equal(JSON.stringify(r).includes(c.vars.GITHUB_CLIENT_SECRET),false);
});
test('doctor enforces OAuth bindings, public-only fetch, collection ceiling and semantic opt-in dependencies',async()=>{
  const c=await base();c.vars.MEMORY_OAUTH_ENABLED='true';assert.equal(inspectConfig(c).ok,false);
  c.kv_namespaces=[{binding:'OAUTH_KV',id:'1'.repeat(32)}];assert.equal(inspectConfig(c).ok,true);
  c.vars.MEMORY_OAUTH_COLLECTIONS='other';assert.equal(inspectConfig(c).ok,false);
  c.vars.MEMORY_OAUTH_COLLECTIONS='shared';c.compatibility_flags=[];assert.equal(inspectConfig(c).ok,false);
  c.compatibility_flags=['global_fetch_strictly_public'];c.vars.MEMORY_SEARCH_ENABLED='true';assert.equal(inspectConfig(c).ok,false);
});
test('absolute lifetime expires exactly at its boundary and refuses invalid/future issuance',()=>{
  assert.equal(withinLifetime(10,10+BEARER_TTL_MS-1,BEARER_TTL_MS),true);
  for(const start of [10,null,-1,11.5,Number.NaN,10+BEARER_TTL_MS+1])assert.equal(withinLifetime(start,10+BEARER_TTL_MS,BEARER_TTL_MS),false);
});
test('encrypted snapshot roundtrips, changes ciphertext each time and refuses overwrites',async()=>{
  await createKey(key);const sql='-- fictional private note\nSELECT 1;';
  await sealSql({sql,database:'fictional-memory',keyFile:key,output});
  const other=join(dir,'other.smbak');await sealSql({sql,database:'fictional-memory',keyFile:key,output:other});
  const bytes=await readFile(output);assert.equal(bytes.includes(Buffer.from('fictional private note')),false);assert.notDeepEqual(bytes,await readFile(other));
  assert.equal((await openSnapshot({input:output,keyFile:key})).sql,sql);assert.equal((await stat(output)).mode&0o777,0o600);
  await assert.rejects(sealSql({sql,database:'fictional-memory',keyFile:key,output}),{code:'EEXIST'});
});
test('tampering, wrong keys, symlinks and broadly readable keys are rejected',async()=>{
  await createKey(key);await sealSql({sql:'SELECT 1;',database:'fictional-memory',keyFile:key,output});
  const other=join(dir,'wrong-key');await createKey(other);await assert.rejects(openSnapshot({input:output,keyFile:other}),/AUTHENTICATION_FAILED/);
  const bytes=await readFile(output);bytes[bytes.length-1]^=1;await writeFile(output,bytes,{mode:0o600});
  await assert.rejects(runBackupCli(['prepare-restore','--input',output,'--key-file',key,'--output',join(dir,'never-created.sql')]),/AUTHENTICATION_FAILED/);
  await assert.rejects(stat(join(dir,'never-created.sql')),{code:'ENOENT'});
  const alias=join(dir,'alias');await symlink(key,alias);await assert.rejects(openSnapshot({input:output,keyFile:alias}));
  await chmod(key,0o644);await assert.rejects(openSnapshot({input:output,keyFile:key}),/OWNER_ONLY_PERMISSIONS/);
});
test('prepared D1 restore expires snapshot auth/approvals and queues canonical reindexing',async()=>{
  const sql=(await readFile(new URL('../../migrations/0001_bootstrap.sql',import.meta.url),'utf8'))+(await readFile(new URL('../../migrations/0002_oauth.sql',import.meta.url),'utf8'))+`
INSERT INTO memory_clients(id,label,token_sha256,scopes,created_at_ms) VALUES('client','client','fictional-digest','memory:read',1);
INSERT INTO memory_review_sessions(token_sha256,github_id,created_at_ms,expires_at_ms) VALUES('fictional-session','12345',1,9999999999999);
INSERT INTO memory_oauth_connections(id,user_id,client_id,resource,scope,redirect_origin,collections_json,status,created_at,updated_at,expires_at)
VALUES('fictional-connection','github-12345','fictional','https://memory.example/memory/mcp','memory:read','https://client.example','["shared"]','active',1,1,9999999999999);
INSERT INTO memory_facts(owner_id,collection_id,id,version,deleted,indexed_version,updated_at_ms) VALUES('github-12345','shared','fact',1,0,1,1);
INSERT INTO memory_index_jobs(owner_id,collection_id,fact_id,version,operation,state) VALUES('github-12345','shared','fact',1,'put','done');
`;
  await createKey(key);await sealSql({sql,database:'fictional-memory',keyFile:key,output});
  const db=new DatabaseSync(':memory:');try{db.exec(restoreSql(await openSnapshot({input:output,keyFile:key}),5000));
    assert.equal(db.prepare('SELECT revoked_at_ms FROM memory_clients').get().revoked_at_ms,5000);
    assert.equal(db.prepare('SELECT revoked_at_ms FROM memory_review_sessions').get().revoked_at_ms,5000);
    assert.equal(db.prepare('SELECT status FROM memory_oauth_connections').get().status,'revoked');
    assert.equal(db.prepare('SELECT indexed_version FROM memory_facts').get().indexed_version,0);
    assert.equal(db.prepare('SELECT state FROM memory_index_jobs').get().state,'pending');
  }finally{db.close();}
});
