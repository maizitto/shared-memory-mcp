#!/usr/bin/env node
/** Explicit OFFLINE owner operations. No network, tokens, remote bindings, live DB discovery or public restore endpoint. */
import {mkdir,open,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MemoryError,identifier} from '../ledger.mjs';
import {installSchema} from '../schema.mjs';
import {RETENTION_SCHEMA,exportCollection,restoreCollection} from '../retention.mjs';
import {indexLexicalTick,missingLexicalSchema} from '../lexical-index.mjs';
import {LEXICAL_POLICY} from '../lexical.mjs';
import {RecoverySqlite} from './sqlite.mjs';
import {packBundle,readBundle,readRegular,recoveryPrincipal} from './bundle.mjs';
const allowed={pack:['export','output'],backup:['database','owner','collection','output'],inspect:['bundle'],restore:['bundle','owner','collection','target'],verify:['bundle','owner','collection','target'],'rebuild-lexical':['owner','collection','target']};
const fail=code=>{throw new MemoryError(code);};
const noLink=async path=>{const s=await lstat(path);if(s.isSymbolicLink())fail('RECOVERY_SYMLINK_DENIED');return s;};
const database=async(path,readOnly)=>{if(!(await noLink(path)).isFile())fail('INVALID_RECOVERY_TARGET');return new RecoverySqlite(path,{readOnly});};
async function status(db,owner,collection){
 const counts=await db.prepare(`SELECT COUNT(*) heads,SUM(CASE WHEN deleted=0 THEN 1 ELSE 0 END) active_heads,SUM(CASE WHEN deleted=0 AND indexed_version!=version THEN 1 ELSE 0 END) semantic_pending FROM memory_facts WHERE owner_id=? AND collection_id=?`).bind(owner,collection).first();
 let lexical_pending;
 try{const r=await db.prepare(`SELECT COUNT(*) n FROM memory_facts f LEFT JOIN memory_lexical_docs d ON d.owner_id=f.owner_id AND d.collection_id=f.collection_id AND d.fact_id=f.id WHERE f.owner_id=? AND f.collection_id=? AND f.deleted=0 AND (d.version IS NULL OR d.version!=f.version OR d.policy!=?)`).bind(owner,collection,LEXICAL_POLICY).first();lexical_pending=r.n;}catch(error){if(!missingLexicalSchema(error))throw error;lexical_pending=counts.active_heads??0;}
 return {...counts,active_heads:counts.active_heads??0,semantic_pending:counts.semantic_pending??0,lexical_pending};
}
export async function runCli(argv){
 const [action,...args]=argv;if(!Object.hasOwn(allowed,action))fail('RECOVERY_USAGE');const options={};
 for(let i=0;i<args.length;i+=2){const name=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!allowed[action].includes(name)||Object.hasOwn(options,name)||!args[i+1]||args[i+1].startsWith('--'))fail('RECOVERY_USAGE');options[name]=args[i+1];}
 if(allowed[action].some(k=>!options[k]))fail('RECOVERY_USAGE');
 if(action==='pack'){const data=JSON.parse(await readRegular(resolve(options.export)));return {status:'packed',...(await packBundle(data,resolve(options.output))).counts};}
 if(action==='inspect'){const {manifest}=await readBundle(resolve(options.bundle));return {status:'verified',...manifest.counts,authentication_restored:false,configuration_role:'disabled_template',private_archive:true};}
 const principal=recoveryPrincipal(options.owner,options.collection),owner=identifier(options.owner),collection=identifier(options.collection);
 if(action==='backup'){
  const db=await database(resolve(options.database),true);try{const data=await exportCollection(db,principal,{collection});const manifest=await packBundle(data,resolve(options.output));return {status:'packed',...manifest.counts,consistent_snapshot:true};}finally{db.close();}
 }
 const target=resolve(options.target),path=join(target,'memory.sqlite');
 if(action==='restore'){
  // Trust/identity/digest checks precede even creating a destination directory.
  const {data,manifest}=await readBundle(resolve(options.bundle),{owner,collection});
  // Check transaction size before creating files too.
  const {restorePlan}=await import('./restore.mjs');restorePlan(data);
  await mkdir(target,{mode:0o700});const f=await open(path,'wx',0o600);await f.close();
  const db=new RecoverySqlite(path);
  try{
   await installSchema(db);for(const sql of RETENTION_SCHEMA)await db.prepare(sql).run();
   await restoreCollection(db,principal,data);
   for(let i=0;i<201;i++){if((await indexLexicalTick(db,{owner_id:owner,collections:[collection]})).status==='idle')break;}
   const result={status:'canonical_restored',archive_sha256:manifest.canonical_sha256,...await status(db,owner,collection),authentication_restored:false,semantic_rebuild_required:true,snapshot_only:true,post_snapshot_deletions_checked:false,ready_for_clients:false};
   const receipt=await open(join(target,'restore.json'),'wx',0o600);try{await receipt.writeFile(JSON.stringify(result,null,2)+'\n');await receipt.sync();}finally{await receipt.close();}
   return result;
  }finally{db.close();}
 }
 if(!(await noLink(target)).isDirectory())fail('INVALID_RECOVERY_TARGET');
 const db=await database(path,action==='verify');
 try{
  if(action==='rebuild-lexical'){
   for(let i=0;i<201;i++){if((await indexLexicalTick(db,{owner_id:owner,collections:[collection]})).status==='idle')break;}
   return {status:'lexical_rebuild_checked',...await status(db,owner,collection)};
  }
  const {data}=await readBundle(resolve(options.bundle),{owner,collection}),again=await exportCollection(db,principal,{collection});
  if(again.sha256!==data.sha256)fail('RECOVERY_CANONICAL_MISMATCH');
  return {status:'verified',canonical_matches:true,snapshot_only:true,ready_for_clients:false,...await status(db,owner,collection)};
 }finally{db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await runCli(process.argv.slice(2))));}catch(error){const code=error instanceof MemoryError?error.code:['EEXIST','ENOENT','ELOOP'].includes(error?.code)?error.code:'RECOVERY_FAILED';console.error(JSON.stringify({error:code}));process.exitCode=1;}
}
