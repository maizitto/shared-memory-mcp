/**
 * Owner-only retention: definitive purge, discarding proposals, export and restore.
 * Purge removes content from every table and queues removal of every vector; a minimal audit remains
 * (fact ID, last version, who and when) so that the ID can never be reused. IDs themselves are not purged.
 */
import { MemoryError, authorize, identifier, hash, strict } from './ledger.mjs';
import {EXPORT_FORMAT,canonicalExport,validateCollectionExport} from './recovery/archive.mjs';
export {EXPORT_FORMAT} from './recovery/archive.mjs';
export {restoreCollection} from './recovery/restore.mjs';

export const RETENTION_SCHEMA = [
`CREATE TABLE IF NOT EXISTS memory_purges (
 owner_id TEXT NOT NULL, collection_id TEXT NOT NULL, fact_id TEXT NOT NULL,
 last_version INTEGER NOT NULL, purged_by TEXT NOT NULL, purged_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,collection_id,fact_id))`,
];
const fail = code => { throw new MemoryError(code); };

export async function purgeFact(db, principal, args, now = Date.now()) {
  strict(args, ['collection', 'fact_id'], ['collection', 'fact_id']);
  const [owner, collection] = authorize(principal, args.collection, 'memory:purge'), id = identifier(args.fact_id);
  if (!await db.prepare('SELECT 1 FROM memory_facts WHERE owner_id=? AND collection_id=? AND id=?').bind(owner, collection, id).first()) fail('NOT_FOUND');
  const where = 'owner_id=? AND collection_id=? AND fact_id=?', keys = [owner, collection, id];
  // Read inside the transaction, so a commit that lands just before the batch is purged too.
  const head = '(SELECT version FROM memory_facts WHERE owner_id=? AND collection_id=? AND id=?)';
  const results = await db.batch([
    db.prepare(`INSERT INTO memory_purges(owner_id,collection_id,fact_id,last_version,purged_by,purged_at_ms) VALUES(?,?,?,${head},?,?) ON CONFLICT DO NOTHING`)
      .bind(...keys, ...keys, principal.subject, now),
    db.prepare(`DELETE FROM memory_versions WHERE ${where}`).bind(...keys),
    db.prepare('UPDATE memory_facts SET deleted=1,indexed_version=0,indexed_fingerprint=NULL,updated_at_ms=? WHERE owner_id=? AND collection_id=? AND id=?').bind(now, ...keys),
    db.prepare(`UPDATE memory_approvals SET digest='purged',expires_at_ms=0 WHERE proposal_id IN (SELECT id FROM memory_proposals WHERE ${where})`).bind(...keys),
    db.prepare(`UPDATE memory_proposals SET digest='purged',expires_at_ms=0,payload_json=json_object('collection',collection_id,'request_id',request_id,
      'fact_id',fact_id,'operation',operation,'expected_version',expected_version,'purged',json('true')) WHERE ${where}`).bind(...keys),
    db.prepare(`UPDATE memory_receipts SET digest='purged' WHERE ${where}`).bind(...keys),
    db.prepare(`DELETE FROM memory_index_jobs WHERE ${where}`).bind(...keys),
    db.prepare(`INSERT INTO memory_index_jobs(owner_id,collection_id,fact_id,version,operation) VALUES(?,?,?,${head},'purge')`).bind(...keys, ...keys),
  ]);
  return { status: 'purged', collection, id, already_purged: results[0].meta.changes === 0 };
}

/** Rejecting a proposal deletes it and its approval now instead of letting the text wait for expiry. */
export async function discardProposal(db, principal, args) {
  strict(args, ['collection', 'proposal_id'], ['collection', 'proposal_id']);
  const [owner, collection] = authorize(principal, args.collection, 'memory:approve'), id = identifier(args.proposal_id);
  const open = "SELECT id FROM memory_proposals WHERE id=? AND owner_id=? AND collection_id=? AND status!='consumed'";
  const results = await db.batch([
    db.prepare(`DELETE FROM memory_approvals WHERE proposal_id IN (${open})`).bind(id, owner, collection),
    db.prepare(`DELETE FROM memory_proposals WHERE id IN (${open})`).bind(id, owner, collection),
  ]);
  if (results[1].meta.changes !== 1) fail('PROPOSAL_UNAVAILABLE');
  return { status: 'discarded', proposal_id: id };
}



/** Current facts with full version history, plus purge tombstones. Proposals, sessions and clients are not memory. */
export async function exportCollection(db, principal, args, now = Date.now()) {
  strict(args, ['collection'], ['collection']);
  const [owner, collection] = authorize(principal, args.collection, 'memory:export');
  // Both reads share one D1 transaction: a concurrent correction/purge cannot split the snapshot.
  const snapshots=await db.batch([
    db.prepare(`SELECT f.id,f.version AS head_version,f.deleted,v.version,v.operation,v.payload_json,v.actor,v.recorded_at_ms
      FROM memory_facts f LEFT JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id
      WHERE f.owner_id=? AND f.collection_id=? ORDER BY f.id,v.version`).bind(owner,collection),
    db.prepare('SELECT fact_id,last_version,purged_by,purged_at_ms FROM memory_purges WHERE owner_id=? AND collection_id=? ORDER BY fact_id').bind(owner,collection),
  ]);
  const rows=snapshots[0].results??[],purged=snapshots[1].results??[],purgeById=new Map(purged.map(p=>[p.fact_id,p]));
  for(const p of purged){const head=rows.find(r=>r.id===p.fact_id);if(!head||head.version!==null||head.deleted!==1||head.head_version!==p.last_version)fail('INVALID_EXPORT');}
  const facts = [];
  for (const r of rows) {
    if(r.version===null){if(!purgeById.has(r.id))fail('INVALID_EXPORT');continue;}
    if (facts.at(-1)?.id !== r.id) facts.push({ id: r.id, head_version: r.head_version, deleted: r.deleted === 1, versions: [] });
    facts.at(-1).versions.push({ version: r.version, operation: r.operation, payload: JSON.parse(r.payload_json), actor: r.actor, recorded_at_ms: r.recorded_at_ms });
  }
  const data = { owner_id: owner, collection, facts, purged: purged.map(p => ({ ...p })) };
  const result={format:EXPORT_FORMAT,format_version:1,exported_at_utc:new Date(now).toISOString(),...data,sha256:await hash(canonicalExport(data))};
  await validateCollectionExport({owner_id:owner,subject:principal.subject,collections:[collection],scopes:['memory:restore']},result);
  return result;
}
