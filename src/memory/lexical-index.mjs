/** Version-scoped lexical statistics. No inference; no canonical writes; request execution never fills the cache. */
import {identifier} from './ledger.mjs';
import {documentStatistics,LEXICAL_POLICY,queryDocument} from './lexical.mjs';
import {chunkCount} from './chunks.mjs';
export class DerivedIndexUnavailable extends Error {}
export async function writeLexicalDocument(db,row){
 const payload=JSON.parse(row.payload_json),stats=documentStatistics(row.id,payload);
 const sql=[
  'INSERT INTO memory_lexical_docs(owner_id,collection_id,fact_id,version,policy,word_count,chunk_count,terms_json)',
  'SELECT f.owner_id,f.collection_id,f.id,f.version,?1,?2,?3,?4 FROM memory_facts f',
  'JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version',
  'WHERE f.owner_id=?5 AND f.collection_id=?6 AND f.id=?7 AND f.version=?8 AND f.deleted=0 AND v.operation=\'put\' AND v.payload_json=?9',
  'ON CONFLICT(owner_id,collection_id,fact_id) DO UPDATE SET version=excluded.version,policy=excluded.policy,',
  'word_count=excluded.word_count,chunk_count=excluded.chunk_count,terms_json=excluded.terms_json',
  'WHERE memory_lexical_docs.version!=excluded.version OR memory_lexical_docs.policy!=excluded.policy'
 ].join('\n');
 const result=await db.prepare(sql).bind(LEXICAL_POLICY,stats.length,chunkCount(payload.content),JSON.stringify(stats.frequencies),row.owner_id,row.collection_id,row.id,row.version,row.payload_json).run();
 return result.meta.changes===1;
}
export async function indexLexicalTick(db,{owner_id,collections}){
 identifier(owner_id);if(!Array.isArray(collections)||!collections.length||collections.length>8)throw new Error('Invalid lexical scope');collections.forEach(identifier);
 const row=await db.prepare([
  'SELECT f.owner_id,f.collection_id,f.id,f.version,v.payload_json FROM memory_facts f',
  'JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version',
  'LEFT JOIN memory_lexical_docs d ON d.owner_id=f.owner_id AND d.collection_id=f.collection_id AND d.fact_id=f.id',
  'WHERE f.owner_id=?1 AND f.collection_id IN (SELECT value FROM json_each(?2)) AND f.deleted=0',
  'AND (d.version IS NULL OR d.version!=f.version OR d.policy!=?3) ORDER BY f.collection_id,f.id LIMIT 1'
 ].join('\n')).bind(owner_id,JSON.stringify(collections),LEXICAL_POLICY).first();
 if(!row)return {status:'idle'};
 return {status:await writeLexicalDocument(db,row)?'lexical_indexed':'superseded'};
}
export function missingLexicalSchema(error){return /no such table: (?:main\.)?memory_lexical_docs/i.test(String(error?.message??error));}
export async function searchSnapshot(db,{owner,collection,terms,semanticIds,needWords}){
 // Query terms are data in one bound JSON array, never interpolated SQL or JSON paths.
 const valid='d.version=f.version AND d.policy=?1';
 const sql=[
  'SELECT f.id,f.collection_id,f.version,f.indexed_version,f.indexed_fingerprint,',
  'CASE WHEN '+valid+' THEN d.word_count END word_count,',
  'CASE WHEN '+valid+' THEN d.chunk_count END chunk_count,',
  'CASE WHEN '+valid+' THEN (SELECT json_group_object(t.value,COALESCE(json_extract(d.terms_json,\'$."\'||t.value||\'"\'),0)) FROM json_each(?2) t) END query_tf_json,',
  'CASE WHEN '+valid+' THEN NULL WHEN ?3=1 OR f.id IN (SELECT value FROM json_each(?4)) THEN v.payload_json END payload_json',
  'FROM memory_facts f JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version',
  'LEFT JOIN memory_lexical_docs d ON d.owner_id=f.owner_id AND d.collection_id=f.collection_id AND d.fact_id=f.id',
  'WHERE f.owner_id=?5 AND f.collection_id=?6 AND f.deleted=0',
  "AND json_extract(v.payload_json,'$.valid_from')<=?7",
  "AND (json_extract(v.payload_json,'$.expires_at') IS NULL OR json_extract(v.payload_json,'$.expires_at')>?7)",
  'ORDER BY f.id LIMIT 201'
 ].join('\n');
 return (await db.prepare(sql).bind(LEXICAL_POLICY,JSON.stringify(terms),needWords?1:0,JSON.stringify(semanticIds),owner,collection,new Date().toISOString()).all()).results??[];
}
export function snapshotDocuments(rows,terms,payload){
 return rows.map(row=>{
  if(row.word_count===null||row.word_count===undefined)return queryDocument(row,terms,payload);
  const frequencies=JSON.parse(row.query_tf_json),frequency=new Map();
  if(!Number.isSafeInteger(row.word_count)||row.word_count<1)throw new DerivedIndexUnavailable('Invalid derived length');
  for(const term of terms){const value=frequencies[term]??0;if(!Number.isSafeInteger(value)||value<0||value>row.word_count)throw new DerivedIndexUnavailable('Invalid derived frequency');if(value)frequency.set(term,value);}
  return {row,length:row.word_count,frequency};
 });
}
export async function hydrateCandidates(db,owner,collection,ids){
 if(!ids.length)return [];
 return (await db.prepare([
  'SELECT f.*,v.payload_json,v.actor,v.recorded_at_ms FROM memory_facts f',
  'JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version',
  'WHERE f.owner_id=?1 AND f.collection_id=?2 AND f.deleted=0 AND f.id IN (SELECT value FROM json_each(?3))'
 ].join('\n')).bind(owner,collection,JSON.stringify(ids)).all()).results??[];
}
