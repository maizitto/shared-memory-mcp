/** Durable outbox: canonical facts commit before any model/index call. */
import { SQL_NOW } from './schema.mjs';
import {writeLexicalDocument} from './lexical-index.mjs';
import { identifier } from './ledger.mjs';
import {vectorId,namespace} from './vectors.mjs';
import {chunkText,MAX_CHUNKS} from './chunks.mjs';
export {vectorId,namespace,embeddingProvider} from './vectors.mjs';
export {searchFacts} from './search.mjs';
const jobWhere = 'owner_id=? AND collection_id=? AND fact_id=? AND version=? AND lease_token=?';
const key = job => [job.owner_id,job.collection_id,job.fact_id,job.version,job.lease_token];
const headFor = (db,j) => db.prepare('SELECT * FROM memory_facts WHERE owner_id=? AND collection_id=? AND id=?').bind(j.owner_id,j.collection_id,j.fact_id).first();
const owned = async (db,j) => !!await db.prepare(`SELECT 1 FROM memory_index_jobs WHERE ${jobWhere} AND state='running'`).bind(...key(j)).first();
async function removeVersion(vectors,owner,collection,id,version,count=MAX_CHUNKS){
 const ids=await Promise.all(Array.from({length:count},(_,i)=>vectorId(owner,collection,id,version,i)));
 await vectors.deleteByIds(ids);
}
async function removeVersions(db,vectors,job,upper) {
 const versions=(await db.prepare('SELECT version,payload_json FROM memory_versions WHERE owner_id=? AND collection_id=? AND fact_id=? AND version<?').bind(job.owner_id,job.collection_id,job.fact_id,upper).all()).results??[];
 for(const v of versions){const content=JSON.parse(v.payload_json).content;await removeVersion(vectors,job.owner_id,job.collection_id,job.fact_id,v.version,content?chunkText(content).length:1);}
}
export async function runIndexJob(db,{embedding,vectors,owner_id,collections,lexicalIndex=false}) {
 let scoped='',scopeArgs=[];
 if(owner_id!==undefined||collections!==undefined){
  identifier(owner_id);if(!Array.isArray(collections)||!collections.length||collections.length>8)throw new Error('Invalid index scope');collections.forEach(identifier);
  scoped=` AND owner_id=? AND collection_id IN (${collections.map(()=>'?').join(',')})`;scopeArgs=[owner_id,...collections];
 }
 const token=crypto.randomUUID();
 const rows=await db.prepare(`UPDATE memory_index_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until_ms=${SQL_NOW}+30000
 WHERE rowid=(SELECT rowid FROM memory_index_jobs WHERE ((state='pending' AND available_at_ms<=${SQL_NOW}) OR
 (state='running' AND lease_until_ms<=${SQL_NOW}))${scoped} ORDER BY available_at_ms,version DESC LIMIT 1) RETURNING *`).bind(token,...scopeArgs).all();
 const j=rows.results?.[0];if(!j)return {status:'idle'};
 let code='STORAGE_UNAVAILABLE';
 try {
  let head=await headFor(db,j);
  if(j.operation==='purge'){
   // Version rows are gone; vector IDs are derived, so every version up to the current head is removed.
   code='VECTOR_UNAVAILABLE';for(let version=1;version<=Math.max(head?.version??0,j.version);version++)await removeVersion(vectors,j.owner_id,j.collection_id,j.fact_id,version);
   code='STORAGE_UNAVAILABLE';await db.prepare(`UPDATE memory_index_jobs SET state='done',lease_token=NULL,lease_until_ms=NULL,last_error_code=NULL WHERE ${jobWhere} AND state='running'`).bind(...key(j)).run();
   return {status:'purged'};
  }
  if(!head||head.version!==j.version){
   code='VECTOR_UNAVAILABLE';await removeVersion(vectors,j.owner_id,j.collection_id,j.fact_id,j.version);
   await db.prepare(`UPDATE memory_index_jobs SET state='done',lease_token=NULL,lease_until_ms=NULL,last_error_code='SUPERSEDED' WHERE ${jobWhere}`).bind(...key(j)).run();
   return {status:'superseded'};
  }
  if(j.operation==='put') {
   const row=await db.prepare('SELECT payload_json FROM memory_versions WHERE owner_id=? AND collection_id=? AND fact_id=? AND version=?').bind(j.owner_id,j.collection_id,j.fact_id,j.version).first();
   if(lexicalIndex&&row)await writeLexicalDocument(db,{...j,id:j.fact_id,payload_json:row.payload_json});
   code='EMBEDDING_UNAVAILABLE';const chunks=chunkText(JSON.parse(row.payload_json).content);
   const values=chunks.length===1?[await embedding.embed(chunks[0])]:embedding.embedMany?await embedding.embedMany(chunks):await Promise.all(chunks.map(t=>embedding.embed(t)));
   if(values.length!==chunks.length)throw new Error('Invalid embedding response');
   if(!await owned(db,j))return {status:'lease_lost'};
   code='VECTOR_UNAVAILABLE';const space=await namespace(j.owner_id,j.collection_id);
   await vectors.upsert(await Promise.all(values.map(async(value,chunk)=>({id:await vectorId(j.owner_id,j.collection_id,j.fact_id,j.version,chunk),values:value,
    namespace:space,metadata:{kind:'fact',owner_id:j.owner_id,collection_id:j.collection_id,fact_id:j.fact_id,version:j.version,chunk,embedding_version:embedding.fingerprint}}))));
   head=await headFor(db,j);
   if(!head||head.deleted||head.version!==j.version){
    await removeVersion(vectors,j.owner_id,j.collection_id,j.fact_id,j.version);
    await db.prepare(`UPDATE memory_index_jobs SET state='done',lease_token=NULL,lease_until_ms=NULL,last_error_code='SUPERSEDED' WHERE ${jobWhere}`).bind(...key(j)).run();return {status:'superseded'};
   }
  }
  code='VECTOR_UNAVAILABLE';await removeVersions(db,vectors,j,j.version);
  code='STORAGE_UNAVAILABLE';
  await db.batch([
   db.prepare(`UPDATE memory_facts SET indexed_version=?,indexed_fingerprint=? WHERE owner_id=? AND collection_id=? AND id=? AND version=?
    AND EXISTS(SELECT 1 FROM memory_index_jobs WHERE ${jobWhere} AND state='running')`).bind(j.version,embedding.fingerprint,j.owner_id,j.collection_id,j.fact_id,j.version,...key(j)),
   db.prepare(`UPDATE memory_index_jobs SET state='done',lease_token=NULL,lease_until_ms=NULL,last_error_code=NULL WHERE ${jobWhere} AND state='running'`).bind(...key(j)),
  ]);
  return {status:j.operation==='delete'?'deleted':'indexed'};
 } catch {
  await db.prepare(`UPDATE memory_index_jobs SET state='pending',lease_token=NULL,lease_until_ms=NULL,last_error_code=?,available_at_ms=${SQL_NOW}+?
   WHERE ${jobWhere} AND state='running'`).bind(code,Math.min(60000,1000*2**Math.min(j.attempts,5)),...key(j)).run();
  return {status:'retry_pending',error_code:code};
 }
}
export async function rebuildIndex(db,{owner_id,collection_id}) {
 identifier(owner_id);identifier(collection_id);
 await db.batch([
  db.prepare(`INSERT INTO memory_index_jobs(owner_id,collection_id,fact_id,version,operation)
   SELECT owner_id,collection_id,id,version,CASE WHEN deleted=1 AND NOT EXISTS(SELECT 1 FROM memory_versions v WHERE v.owner_id=memory_facts.owner_id AND v.collection_id=memory_facts.collection_id AND v.fact_id=memory_facts.id) THEN 'purge' WHEN deleted=1 THEN 'delete' ELSE 'put' END FROM memory_facts WHERE owner_id=? AND collection_id=?
   ON CONFLICT(owner_id,collection_id,fact_id,version) DO UPDATE SET operation=excluded.operation,state='pending',available_at_ms=0,lease_token=NULL,lease_until_ms=NULL,last_error_code=NULL`).bind(owner_id,collection_id),
  db.prepare('UPDATE memory_facts SET indexed_version=0,indexed_fingerprint=NULL WHERE owner_id=? AND collection_id=?').bind(owner_id,collection_id),
 ]);
}
