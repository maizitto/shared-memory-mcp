/** Offline bootstrap only. Canonical rows, tombstones and rebuild work commit in one bounded transaction. */
import {MemoryError} from '../ledger.mjs';
import {validateCollectionExport} from './archive.mjs';
export const RESTORE_MAX_STATEMENTS=40,RESTORE_BIND_BYTES=120000;
const tables=['memory_facts','memory_versions','memory_proposals','memory_approvals','memory_receipts','memory_index_jobs','memory_purges'];
const occupied=(owner='NEW.owner_id',collection='NEW.collection_id')=>tables.map(t=>`(SELECT COUNT(*) FROM ${t} WHERE owner_id=${owner} AND collection_id=${collection})`).join('+');
export const RECOVERY_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS memory_restore_guard(owner_id TEXT NOT NULL,collection_id TEXT NOT NULL,archive_sha256 TEXT NOT NULL,restored_at_ms INTEGER NOT NULL,PRIMARY KEY(owner_id,collection_id))`,
 `CREATE TRIGGER IF NOT EXISTS memory_restore_empty BEFORE INSERT ON memory_restore_guard BEGIN
  SELECT CASE WHEN ${occupied()}>0 THEN RAISE(ABORT,'COLLECTION_NOT_EMPTY') END;
 END`,
];
const groups=rows=>{
 const out=[];let group=[],size=2;
 for(const row of rows){const encoded=JSON.stringify(row),bytes=new TextEncoder().encode(encoded).length+1;if(bytes+2>RESTORE_BIND_BYTES)throw new MemoryError('RESTORE_TOO_LARGE');if(size+bytes>RESTORE_BIND_BYTES){out.push(JSON.stringify(group));group=[];size=2;}group.push(row);size+=bytes;}
 if(group.length)out.push(JSON.stringify(group));return out;
};
export function restorePlan(data){
 const versions=data.facts.flatMap(f=>f.versions.map(v=>({fact_id:f.id,version:v.version,operation:v.operation,payload_json:JSON.stringify(v.payload),actor:v.actor,recorded_at_ms:v.recorded_at_ms})));
 const heads=[...data.facts.map(f=>({id:f.id,version:f.head_version,deleted:f.deleted?1:0,updated_at_ms:f.versions.at(-1).recorded_at_ms})),...data.purged.map(p=>({id:p.fact_id,version:p.last_version,deleted:1,updated_at_ms:p.purged_at_ms}))];
 const plan=[
  ...groups(versions).map(payload=>({payload,sql:`INSERT INTO memory_versions(owner_id,collection_id,fact_id,version,operation,payload_json,actor,recorded_at_ms) SELECT ?1,?2,json_extract(value,'$.fact_id'),json_extract(value,'$.version'),json_extract(value,'$.operation'),json_extract(value,'$.payload_json'),json_extract(value,'$.actor'),json_extract(value,'$.recorded_at_ms') FROM json_each(?3)`})),
  ...groups(heads).map(payload=>({payload,sql:`INSERT INTO memory_facts(owner_id,collection_id,id,version,deleted,indexed_version,indexed_fingerprint,updated_at_ms) SELECT ?1,?2,json_extract(value,'$.id'),json_extract(value,'$.version'),json_extract(value,'$.deleted'),0,NULL,json_extract(value,'$.updated_at_ms') FROM json_each(?3)`})),
  ...groups(data.purged).map(payload=>({payload,sql:`INSERT INTO memory_purges(owner_id,collection_id,fact_id,last_version,purged_by,purged_at_ms) SELECT ?1,?2,json_extract(value,'$.fact_id'),json_extract(value,'$.last_version'),json_extract(value,'$.purged_by'),json_extract(value,'$.purged_at_ms') FROM json_each(?3)`})),
 ];
 // Guard + canonical inserts + durable rebuild jobs. Refuse oversize input before touching destination/schema.
 if(plan.length+2>RESTORE_MAX_STATEMENTS)throw new MemoryError('RESTORE_TOO_LARGE');
 return plan;
}
export async function restoreCollection(db,principal,data){
 const summary=await validateCollectionExport(principal,data),{owner,collection}=summary,plan=restorePlan(data);
 const used=await db.prepare(`SELECT ${occupied('?1','?2')} AS n`).bind(owner,collection).first();
 if(used.n)throw new MemoryError('COLLECTION_NOT_EMPTY');
 // Private bootstrap bookkeeping only; no web/MCP restore route is installed.
 for(const sql of RECOVERY_SCHEMA)await db.prepare(sql).run();
 const statements=[db.prepare('INSERT INTO memory_restore_guard(owner_id,collection_id,archive_sha256,restored_at_ms) VALUES(?,?,?,?)').bind(owner,collection,data.sha256,Date.now()),
  ...plan.map(p=>db.prepare(p.sql).bind(owner,collection,p.payload)),
  db.prepare(`INSERT INTO memory_index_jobs(owner_id,collection_id,fact_id,version,operation)
   SELECT f.owner_id,f.collection_id,f.id,f.version,CASE WHEN p.fact_id IS NOT NULL THEN 'purge' WHEN f.deleted=1 THEN 'delete' ELSE 'put' END
   FROM memory_facts f LEFT JOIN memory_purges p ON p.owner_id=f.owner_id AND p.collection_id=f.collection_id AND p.fact_id=f.id
   WHERE f.owner_id=?1 AND f.collection_id=?2`).bind(owner,collection),
 ];
 try{await db.batch(statements);}catch(error){
  if(String(error.message).includes('COLLECTION_NOT_EMPTY'))throw new MemoryError('COLLECTION_NOT_EMPTY');
  if(String(error.message).includes('UNIQUE constraint failed: memory_restore_guard'))throw new MemoryError('RESTORE_ALREADY_APPLIED');
  throw error;
 }
 return {status:'restored',collection,facts:summary.facts,versions:summary.versions,purged:summary.purged};
}
