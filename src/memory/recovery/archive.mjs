/** Portable canonical collection format; hashes detect corruption, not who authored an archive. */
import {MemoryError,authorize,identifier,hash,normalizeCommand,strict} from '../ledger.mjs';
export const EXPORT_FORMAT='persistent-memory-export';
const fail=code=>{throw new MemoryError(code);};
export const canonicalExport=data=>JSON.stringify({owner_id:data.owner_id,collection:data.collection,facts:data.facts,purged:data.purged});
function checkFact(fact, collection) {
  strict(fact, ['id', 'head_version', 'deleted', 'versions'], ['id', 'head_version', 'deleted', 'versions']);
  identifier(fact.id);
  if (!Number.isSafeInteger(fact.head_version) || fact.head_version<1 || !Array.isArray(fact.versions) || !fact.versions.length || fact.versions.length !== fact.head_version || typeof fact.deleted !== 'boolean') fail('INVALID_EXPORT');
  fact.versions.forEach((v, i) => {
    strict(v, ['version', 'operation', 'payload', 'actor', 'recorded_at_ms'], ['version', 'operation', 'payload', 'actor', 'recorded_at_ms']);
    const c = normalizeCommand(v.payload);
    // The stored payload is exactly the normalized command the owner approved; anything else is not a genuine export.
    if (JSON.stringify(c) !== JSON.stringify(v.payload) || v.version !== i + 1 || c.expected_version !== i || c.collection !== collection || c.fact_id !== fact.id ||
      c.operation !== v.operation || (i===0 && v.operation!=='put') || (v.operation === 'delete' && i !== fact.versions.length - 1) ||
      typeof v.actor !== 'string' || !v.actor || v.actor.length > 200 || !Number.isSafeInteger(v.recorded_at_ms) || v.recorded_at_ms < 0) fail('INVALID_EXPORT');
  });
  if (fact.deleted !== (fact.versions.at(-1).operation === 'delete')) fail('INVALID_EXPORT');
}


/** Pure validation, before any destination write. The principal comes from the owner/operator. */
export async function validateCollectionExport(principal,data){
 if(!data||typeof data!=='object'||Array.isArray(data))fail('INVALID_EXPORT');
 const [owner,collection]=authorize(principal,data.collection,'memory:restore');identifier(owner);
 strict(data,['format','format_version','exported_at_utc','owner_id','collection','facts','purged','sha256'],['format','format_version','owner_id','collection','facts','purged','sha256']);
 if(data.format!==EXPORT_FORMAT||data.format_version!==1||!Array.isArray(data.facts)||!Array.isArray(data.purged))fail('INVALID_EXPORT');
 if(data.owner_id!==owner)fail('FORBIDDEN');
 if(data.exported_at_utc!==undefined&&(typeof data.exported_at_utc!=='string'||!Number.isFinite(Date.parse(data.exported_at_utc))||new Date(data.exported_at_utc).toISOString()!==data.exported_at_utc))fail('INVALID_EXPORT');
 if(data.sha256!==await hash(canonicalExport(data)))fail('EXPORT_DIGEST_MISMATCH');
 const ids=new Set();let versions=0;
 let previousId='';
 for(const fact of data.facts){if(fact.id<=previousId)fail('INVALID_EXPORT');previousId=fact.id;checkFact(fact,collection);if(ids.has(fact.id))fail('INVALID_EXPORT');ids.add(fact.id);versions+=fact.versions.length;}
 previousId='';
 for(const p of data.purged){
  if(p.fact_id<=previousId)fail('INVALID_EXPORT');previousId=p.fact_id;
  strict(p,['fact_id','last_version','purged_by','purged_at_ms'],['fact_id','last_version','purged_by','purged_at_ms']);identifier(p.fact_id);
  if(ids.has(p.fact_id)||!Number.isSafeInteger(p.last_version)||p.last_version<1||p.last_version>1e9+1||typeof p.purged_by!=='string'||!p.purged_by||p.purged_by.length>200||!Number.isSafeInteger(p.purged_at_ms)||p.purged_at_ms<0)fail('INVALID_EXPORT');
  ids.add(p.fact_id);
 }
 const active=data.facts.filter(f=>!f.deleted).length;if(active>200)fail('CAPACITY_REACHED');
 return {owner,collection,facts:data.facts.length,versions,purged:data.purged.length,active};
}
