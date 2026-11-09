import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,mkdir,symlink,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RecoverySqlite} from '../../../src/memory/recovery/sqlite.mjs';
import {installSchema} from '../../../src/memory/schema.mjs';
import {RETENTION_SCHEMA,exportCollection,restoreCollection,purgeFact} from '../../../src/memory/retention.mjs';
import {proposeFact,approveProposal,commitProposal,getFact,hash,normalizeCommand} from '../../../src/memory/ledger.mjs';
import {canonicalExport,validateCollectionExport} from '../../../src/memory/recovery/archive.mjs';
import {packBundle,readBundle,recoveryPrincipal,MAX_ARCHIVE_BYTES} from '../../../src/memory/recovery/bundle.mjs';
import {restorePlan,RESTORE_BIND_BYTES,RESTORE_MAX_STATEMENTS} from '../../../src/memory/recovery/restore.mjs';
const run=promisify(execFile),cli=new URL('../../../src/memory/recovery/cli.mjs',import.meta.url).pathname;
const principal={...recoveryPrincipal('owner-demo','shared'),scopes:['memory:read','memory:write','memory:approve','memory:purge','memory:export','memory:restore']};
const err=code=>e=>e.code===code;
async function fresh(path=':memory:'){const db=new RecoverySqlite(path);await installSchema(db);for(const sql of RETENTION_SCHEMA)await db.prepare(sql).run();return db;}
async function put(db,id,content,expected_version=0,extra={}){
 const p=await proposeFact(db,principal,{collection:'shared',fact_id:id,operation:'put',expected_version,content,source:'fictional-recovery',observed_at:'2020-01-01',...extra});
 await approveProposal(db,principal,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});return commitProposal(db,principal,{collection:'shared',proposal_id:p.proposal_id},'put');
}
async function sample(db){
 await put(db,'doc.active','copia originale');await put(db,'doc.active','copia corretta',1);
 await put(db,'doc.deleted','storia cancellata');const p=await proposeFact(db,principal,{collection:'shared',fact_id:'doc.deleted',operation:'delete',expected_version:1});await approveProposal(db,principal,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});await commitProposal(db,principal,{collection:'shared',proposal_id:p.proposal_id},'delete');
 await put(db,'doc.purged','PURGED_TEXT_MUST_NOT_BE_BACKED_UP');await purgeFact(db,principal,{collection:'shared',fact_id:'doc.purged'});
 await put(db,'doc.expired','esempio scaduto',0,{expires_at:'2021-01-01'});await put(db,'doc.future','esempio futuro',0,{valid_from:'2999-01-01'});
 await proposeFact(db,principal,{collection:'shared',fact_id:'doc.waiting',operation:'put',expected_version:0,content:'UNAPPROVED_MUST_NOT_BE_BACKED_UP',source:'fixture'});
 db.raw.exec("CREATE TABLE excluded_credentials(value TEXT);INSERT INTO excluded_credentials VALUES('FICTIONAL_CREDENTIAL_MUST_NOT_BE_BACKED_UP')");
 return exportCollection(db,principal,{collection:'shared'},Date.UTC(2026,9,24));
}
async function withTemp(fn){const d=await mkdtemp(join(tmpdir(),'memory-recovery-unit-'));try{return await fn(d);}finally{await rm(d,{recursive:true,force:true});}}
const counts=db=>Object.fromEntries(['memory_facts','memory_versions','memory_index_jobs','memory_purges'].map(t=>[t,db.raw.prepare('SELECT COUNT(*) n FROM '+t).get().n]));
test('export uses one consistent transaction even when another SQLite connection purges between its two reads',()=>withTemp(async dir=>{
 const path=join(dir,'source.sqlite'),source=await fresh(path);source.raw.exec('PRAGMA journal_mode=WAL');await put(source,'doc.active','snapshot before purge');
 const reader=new RecoverySqlite(path,{readOnly:true});let changed=false;
 const wrapped={prepare(sql){const stmt=reader.prepare(sql);const wrap=s=>({...s,bind(...a){return wrap(s.bind(...a));},direct(){
  if(sql.startsWith('SELECT fact_id,last_version')&&!changed){changed=true;source.raw.exec("BEGIN IMMEDIATE; INSERT INTO memory_purges VALUES('owner-demo','shared','doc.active',1,'test',1); DELETE FROM memory_versions; UPDATE memory_facts SET deleted=1; COMMIT;");}
  return s.direct();
 }});return wrap(stmt);},batch:statements=>reader.batch(statements)};
 try{const exported=await exportCollection(wrapped,principal,{collection:'shared'});assert.equal(changed,true);assert.equal(exported.facts[0].versions[0].payload.content,'snapshot before purge');assert.equal(exported.purged.length,0);assert.equal((await exportCollection(source,principal,{collection:'shared'})).purged.length,1);}finally{reader.close();source.close();}
}));
test('missing canonical history is rejected instead of silently producing an incomplete backup',async()=>{
 const db=await fresh();try{db.raw.exec("INSERT INTO memory_facts VALUES('owner-demo','shared','orphan',1,0,0,NULL,1)");await assert.rejects(exportCollection(db,principal,{collection:'shared'}),err('INVALID_EXPORT'));}finally{db.close();}
});
test('restore rolls back all canonical rows, tombstones, jobs and guard on a late outbox error, then succeeds on retry',async()=>{
 const source=await fresh(),target=await fresh();try{
  const data=await sample(source);target.raw.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON memory_index_jobs BEGIN SELECT RAISE(ABORT,'outbox unavailable');END");
  await assert.rejects(restoreCollection(target,principal,data),/outbox unavailable/);assert.deepEqual(Object.values(counts(target)),[0,0,0,0]);assert.equal(target.raw.prepare('SELECT COUNT(*) n FROM memory_restore_guard').get().n,0);
  target.raw.exec('DROP TRIGGER fail_recovery');await restoreCollection(target,principal,data);
  assert.equal((await exportCollection(target,principal,{collection:'shared'})).sha256,data.sha256);assert.equal(target.raw.prepare('SELECT COUNT(*) n FROM memory_index_jobs').get().n,5);
  assert.equal((await getFact(target,principal,{collection:'shared',id:'doc.active',version:1})).content,'copia originale');
  for(const id of['doc.deleted','doc.purged'])await assert.rejects(getFact(target,principal,{collection:'shared',id}),err('NOT_FOUND'));
  for(const id of['doc.expired','doc.future'])await assert.rejects(getFact(target,principal,{collection:'shared',id}),err('NOT_CURRENT'));
 }finally{source.close();target.close();}
});
test('transaction guard catches another writer after the emptiness precheck and never merges archives',async()=>{
 const source=await fresh(),target=await fresh();try{
  const data=await sample(source);let raced=false;
  const wrapped={prepare:sql=>target.prepare(sql),async batch(statements){if(!raced){raced=true;await put(target,'concurrent','written after precheck');}return target.batch(statements);}};
  await assert.rejects(restoreCollection(wrapped,principal,data),err('COLLECTION_NOT_EMPTY'));assert.equal(target.raw.prepare('SELECT COUNT(*) n FROM memory_facts').get().n,1);assert.equal((await getFact(target,principal,{collection:'shared',id:'concurrent'})).content,'written after precheck');
 }finally{source.close();target.close();}
});
test('orphan receipts, versions and purge audit also make a destination nonempty',async()=>{
 const source=await fresh();try{const data=await sample(source);
  for(const sql of["INSERT INTO memory_purges VALUES('owner-demo','shared','orphan',1,'test',1)","INSERT INTO memory_versions VALUES('owner-demo','shared','orphan',1,'put','{}','test',1)","INSERT INTO memory_index_jobs(owner_id,collection_id,fact_id,version,operation) VALUES('owner-demo','shared','orphan',1,'put')"]){const target=await fresh();try{target.raw.exec(sql);await assert.rejects(restoreCollection(target,principal,data),err('COLLECTION_NOT_EMPTY'));}finally{target.close();}}
 }finally{source.close();}
});
function largeExport(count=200){
 const facts=Array.from({length:count},(_,i)=>{const id='doc.'+String(i).padStart(3,'0'),payload=normalizeCommand({collection:'shared',request_id:'req.'+i,fact_id:id,operation:'put',expected_version:0,content:'🙂'.repeat(4000),source:'fictional-large-recovery',observed_at:'2020-01-01'});return {id,head_version:1,deleted:false,versions:[{version:1,operation:'put',payload,actor:'test',recorded_at_ms:1}]};});
 return {format:'persistent-memory-export',format_version:1,owner_id:'owner-demo',collection:'shared',facts,purged:[]};
}
test('200 maximum-length Unicode facts restore in a bounded batch with at most four parameters per statement',async()=>{
 const data=largeExport();data.sha256=await hash(canonicalExport(data));const target=await fresh();let max=0,batchSize=0;
 const wrap=sql=>{const s=target.prepare(sql);return {...s,bind(...args){max=Math.max(max,args.length);return s.bind(...args);}};};
 try{const plan=restorePlan(data);assert.ok(plan.every(p=>Buffer.byteLength(p.payload)<=RESTORE_BIND_BYTES));
  await restoreCollection({prepare:wrap,batch:statements=>{batchSize=statements.length;return target.batch(statements);}},principal,data);
  assert.ok(batchSize<=RESTORE_MAX_STATEMENTS);assert.ok(max<=4);assert.equal(counts(target).memory_facts,200);assert.equal((await exportCollection(target,principal,{collection:'shared'})).sha256,data.sha256);
 }finally{target.close();}
});
test('oversized history is rejected before any destination schema or content write',async()=>{
 const data=largeExport();for(const fact of data.facts){const p={...fact.versions[0].payload,request_id:'edit.'+fact.id,expected_version:1};fact.versions.push({version:2,operation:'put',payload:p,actor:'test',recorded_at_ms:2});fact.head_version=2;}data.sha256=await hash(canonicalExport(data));
 const target=await fresh();try{await assert.rejects(restoreCollection(target,principal,data),err('RESTORE_TOO_LARGE'));assert.deepEqual(Object.values(counts(target)),[0,0,0,0]);assert.equal(target.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='memory_restore_guard'").get().n,0);}finally{target.close();}
});
test('forged negative purge times and impossible first-delete history fail pure validation',async()=>{
 const source=await fresh();try{const data=await sample(source);data.purged[0].purged_at_ms=-1;data.sha256=await hash(canonicalExport(data));await assert.rejects(validateCollectionExport(principal,data),err('INVALID_EXPORT'));
 const impossible=structuredClone(data);impossible.purged[0].purged_at_ms=1;
 const f=impossible.facts[0];f.head_version=1;f.deleted=true;f.versions=[{version:1,operation:'delete',payload:{collection:'shared',request_id:'impossible',fact_id:f.id,operation:'delete',expected_version:0},actor:'test',recorded_at_ms:1}];impossible.sha256=await hash(canonicalExport(impossible));await assert.rejects(validateCollectionExport(principal,impossible),err('INVALID_EXPORT'));}finally{source.close();}
});
test('backup CLI creates a private package, restores after a process boundary, verifies without modifying the source, and excludes all credentials/proposals/purged text',()=>withTemp(async dir=>{
 const path=join(dir,'source.sqlite'),source=await fresh(path);await sample(source);source.close();
 const before=await readFile(path),bundle=join(dir,'bundle'),target=join(dir,'restored');
 const call=async(...args)=>JSON.parse((await run(process.execPath,[cli,...args],{maxBuffer:1024*1024})).stdout);
 const packed=await call('backup','--database',path,'--owner','owner-demo','--collection','shared','--output',bundle);assert.equal(packed.consistent_snapshot,true);
 const text=(await Promise.all(['archive.json','manifest.json','bootstrap.json','README.md'].map(n=>readFile(join(bundle,n),'utf8')))).join('');
 for(const forbidden of['PURGED_TEXT_MUST_NOT_BE_BACKED_UP','UNAPPROVED_MUST_NOT_BE_BACKED_UP','FICTIONAL_CREDENTIAL_MUST_NOT_BE_BACKED_UP'])assert.equal(text.includes(forbidden),false);
 assert.equal((await stat(bundle)).mode&0o777,0o700);for(const name of['archive.json','manifest.json','bootstrap.json','README.md'])assert.equal((await stat(join(bundle,name))).mode&0o777,0o600);
 assert.equal((await call('inspect','--bundle',bundle)).status,'verified');
 const restored=await call('restore','--bundle',bundle,'--owner','owner-demo','--collection','shared','--target',target);assert.equal(restored.status,'canonical_restored');assert.equal(restored.lexical_pending,0);assert.equal(restored.authentication_restored,false);assert.ok(restored.semantic_pending>0);
 assert.equal((await stat(join(target,'memory.sqlite'))).mode&0o777,0o600);
 const targetBefore=await readFile(join(target,'memory.sqlite'));assert.equal((await call('verify','--bundle',bundle,'--owner','owner-demo','--collection','shared','--target',target)).canonical_matches,true);assert.deepEqual(await readFile(join(target,'memory.sqlite')),targetBefore);assert.deepEqual(await readFile(path),before);
 const failed=await run(process.execPath,[cli,'restore','--bundle',bundle,'--owner','owner-demo','--collection','shared','--target',target]).then(()=>null,e=>e);assert.equal(JSON.parse(failed.stderr.trim().split('\n').at(-1)).error,'EEXIST');assert.deepEqual(await readFile(join(target,'memory.sqlite')),targetBefore);
}));
test('bundle detects tampering and rejects wrong owner before creating destination files',()=>withTemp(async dir=>{
 const source=await fresh();try{
  const data=await sample(source),bundle=join(dir,'bundle');await packBundle(data,bundle);
  await assert.rejects(readBundle(bundle,{owner:'someone-else',collection:'shared'}),err('FORBIDDEN'));
  const damaged=JSON.parse(await readFile(join(bundle,'archive.json'),'utf8'));damaged.facts[0].versions[0].payload.content='tampered';await writeFile(join(bundle,'archive.json'),JSON.stringify(damaged));
  await assert.rejects(readBundle(bundle),err('RECOVERY_DIGEST_MISMATCH'));
  const target=join(dir,'never-created');const failed=await run(process.execPath,[cli,'restore','--bundle',bundle,'--owner','owner-demo','--collection','shared','--target',target]).then(()=>null,e=>e);assert.ok(failed);await assert.rejects(stat(target),e=>e.code==='ENOENT');
 }finally{source.close();}
}));
test('pack supports the existing owner export format; links, unknown files, oversize input and overwrites are refused',()=>withTemp(async dir=>{
 const source=await fresh();try{
  const data=await sample(source),exportPath=join(dir,'export.json'),bundle=join(dir,'bundle');await writeFile(exportPath,JSON.stringify(data));
  const packed=await run(process.execPath,[cli,'pack','--export',exportPath,'--output',bundle]);assert.equal(JSON.parse(packed.stdout).status,'packed');
  await assert.rejects(packBundle(data,bundle),e=>e.code==='EEXIST');
  await symlink(exportPath,join(dir,'link.json'));const linkFail=await run(process.execPath,[cli,'pack','--export',join(dir,'link.json'),'--output',join(dir,'linkbundle')]).then(()=>null,e=>e);assert.ok(linkFail);
  await writeFile(join(bundle,'unexpected.txt'),'extra');await assert.rejects(readBundle(bundle),err('INVALID_RECOVERY_BUNDLE'));
  const f=await open(join(dir,'too-big.json'),'w');await f.truncate(MAX_ARCHIVE_BYTES+1);await f.close();const bigFail=await run(process.execPath,[cli,'pack','--export',join(dir,'too-big.json'),'--output',join(dir,'bigbundle')]).then(()=>null,e=>e);assert.equal(JSON.parse(bigFail.stderr.trim().split('\n').at(-1)).error,'RECOVERY_FILE_TOO_LARGE');
 }finally{source.close();}
}));


test('a metadata-only empty snapshot is applied once, and concurrent repetition cannot bypass the restore guard',async()=>{
 const source=await fresh(),target=await fresh();try{const data=await exportCollection(source,principal,{collection:'shared'});await restoreCollection(target,principal,data);await assert.rejects(restoreCollection(target,principal,data),err('RESTORE_ALREADY_APPLIED'));assert.deepEqual(Object.values(counts(target)),[0,0,0,0]);}finally{source.close();target.close();}
});
test('rehashing the manifest does not allow active bootstrap settings or path traversal filenames',()=>withTemp(async dir=>{
 const source=await fresh();try{const bundle=join(dir,'bundle');await packBundle(await sample(source),bundle);const manifestPath=join(bundle,'manifest.json'),original=await readFile(manifestPath,'utf8'),m=JSON.parse(original);
  const bootstrap=JSON.parse(await readFile(join(bundle,'bootstrap.json'),'utf8'));bootstrap.enabled=true;bootstrap.GITHUB_CLIENT_SECRET='FICTIONAL_NOT_ALLOWED';const changed=JSON.stringify(bootstrap);await writeFile(join(bundle,'bootstrap.json'),changed);m.files[1].sha256=await hash(changed);m.files[1].bytes=Buffer.byteLength(changed);await writeFile(manifestPath,JSON.stringify(m));await assert.rejects(readBundle(bundle),err('INVALID_RECOVERY_BUNDLE'));
  m.files[0].name='../outside.json';await writeFile(manifestPath,JSON.stringify(m));await assert.rejects(readBundle(bundle),err('INVALID_RECOVERY_BUNDLE'));
 }finally{source.close();}
}));
