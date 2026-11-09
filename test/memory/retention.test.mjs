/** Grants, definitive purge, proposal cleanup, export and restore with real SQLite. Fictional data only. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalD1, writer, reviewer, localSearch } from './testkit.mjs';
import { proposeFact, approveProposal, commitProposal, getFact, listFacts, hash, MemoryError } from '../../src/memory/ledger.mjs';
import { runIndexJob, searchFacts } from '../../src/memory/indexer.mjs';
import { RETENTION_SCHEMA, purgeFact, discardProposal, exportCollection, restoreCollection } from '../../src/memory/retention.mjs';

const root = new URL('../../', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('fixtures/embeddings/second-brain.json', root)));
const t = JSON.parse(readFileSync(new URL('fixtures/memory-sharing/second-brain.json', root))).texts;
const a = writer(), b = writer('owner-demo', 'client-b');
const owner = { owner_id: 'owner-demo', subject: 'owner-review', collections: ['shared'], scopes: ['memory:approve', 'memory:purge', 'memory:export', 'memory:restore'] };
const put = (request_id, content, expected_version = 0, fact_id = 'preference') => ({ collection: 'shared', request_id, fact_id, operation: 'put', expected_version, content,
  source: 'fictional-retention-source', observed_at: '2020-01-01T00:00:00Z', valid_from: '2020-01-01T00:00:00Z' });
const del = (request_id, expected_version, fact_id = 'preference') => ({ collection: 'shared', request_id, fact_id, operation: 'delete', expected_version });
const error = code => e => e instanceof MemoryError && e.code === code;
let db, search;

async function open() { const d = await new LocalD1().init(); for (const sql of RETENTION_SCHEMA) await d.prepare(sql).run(); return d; }
async function approved(command, actor = a, on = db) { const p = await proposeFact(on, actor, command); await approveProposal(on, reviewer, { collection: 'shared', proposal_id: p.proposal_id, expected_digest: p.digest }); return p; }
const commit = (p, operation = 'put', on = db) => commitProposal(on, a, { collection: 'shared', proposal_id: p.proposal_id }, operation);
async function drain(on = db) { on.raw.exec('UPDATE memory_index_jobs SET available_at_ms=0'); let r; const seen = []; while ((r = await runIndexJob(on, search)).status !== 'idle') seen.push(r.status); return seen; }
/** Every row of every memory_* table, as text, to prove that purged content is nowhere. */
function everything(on = db) {
  const tables = on.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory%'").all().map(r => r.name);
  return JSON.stringify(Object.fromEntries(tables.map(name => [name, on.raw.prepare(`SELECT * FROM ${name}`).all()])));
}

beforeEach(async () => { db = await open(); search = localSearch(fixture); });
afterEach(() => db.close());

test('per-collection grants decide each scope; unknown or inherited keys never grant', async () => {
  const p = { owner_id: 'owner-demo', subject: 'client-g', grants: { shared: ['memory:read'], other: ['memory:read', 'memory:write'] } };
  assert.equal((await listFacts(db, p, { collection: 'shared' })).facts.length, 0);
  await assert.rejects(proposeFact(db, p, put('g-1', t.preference)), error('FORBIDDEN'));
  assert.equal((await proposeFact(db, p, { ...put('g-2', t.preference), collection: 'other' })).status, 'pending');
  for (const collection of ['constructor', 'toString', 'missing']) await assert.rejects(listFacts(db, p, { collection }), error('FORBIDDEN'));
  await assert.rejects(listFacts(db, { ...p, grants: { shared: 'memory:read' } }, { collection: 'shared' }), error('FORBIDDEN'));
  await assert.rejects(listFacts(db, { ...p, grants: {} }, { collection: 'shared' }), error('FORBIDDEN'));
});

test('purge removes every copy of the text, its vectors and pending proposals; only a minimal audit remains', async () => {
  const first = await approved(put('p-1', t.preference)); await commit(first);
  const second = await approved(put('p-2', t.corrected, 1)); await commit(second);
  const waiting = await proposeFact(db, b, put('p-3', t.stale, 2));
  await drain(); assert.equal(search.state.vectors.size, 1);
  for (const text of [t.preference, t.corrected, t.stale, 'fictional-retention-source']) assert.ok(everything().includes(text), text);
  const purged = await purgeFact(db, owner, { collection: 'shared', fact_id: 'preference' });
  assert.deepEqual(purged, { status: 'purged', collection: 'shared', id: 'preference', already_purged: false });
  for (const text of [t.preference, t.corrected, t.stale, 'fictional-retention-source', 'observed_at']) assert.ok(!everything().includes(text), text);
  assert.deepEqual(db.raw.prepare('SELECT fact_id,last_version,purged_by FROM memory_purges').all().map(r => ({ ...r })), [{ fact_id: 'preference', last_version: 2, purged_by: 'owner-review' }]);
  await assert.rejects(getFact(db, b, { collection: 'shared', id: 'preference' }), error('NOT_FOUND'));
  await assert.rejects(getFact(db, b, { collection: 'shared', id: 'preference', version: 1 }), error('NOT_FOUND'));
  assert.equal((await listFacts(db, b, { collection: 'shared' })).facts.length, 0);
  assert.equal((await searchFacts(db, b, { collection: 'shared', query: 'Aurora', mode: 'lexical' }, search)).candidates.length, 0);
  // Vectors of every version are removed, although the version rows no longer exist.
  assert.deepEqual(await drain(), ['purged']); assert.equal(search.state.vectors.size, 0);
  const replay = await commit(first);
  assert.equal(replay.status, 'deleted'); assert.equal(replay.purged, true); assert.equal(replay.fact, null);
  await assert.rejects(approveProposal(db, reviewer, { collection: 'shared', proposal_id: waiting.proposal_id, expected_digest: waiting.digest }), error('APPROVAL_MISMATCH'));
  await assert.rejects(commit(await approved(put('p-4', t.stale, 2))), error('DELETED_ID'));
  assert.equal((await purgeFact(db, owner, { collection: 'shared', fact_id: 'preference' })).already_purged, true);
});

test('purge needs the owner capability and an existing fact; it also works after a logical delete', async () => {
  await commit(await approved(put('q-1', t.preference)));
  await assert.rejects(purgeFact(db, a, { collection: 'shared', fact_id: 'preference' }), error('FORBIDDEN'));
  await assert.rejects(purgeFact(db, reviewer, { collection: 'shared', fact_id: 'preference' }), error('FORBIDDEN'));
  await assert.rejects(purgeFact(db, owner, { collection: 'shared', fact_id: 'missing' }), error('NOT_FOUND'));
  await assert.rejects(purgeFact(db, owner, { collection: 'shared', fact_id: 'preference', extra: 1 }), error('INVALID_ARGUMENTS'));
  await commit(await approved(del('q-2', 1)), 'delete');
  assert.ok(everything().includes(t.preference)); // a logical delete keeps the history text
  await purgeFact(db, owner, { collection: 'shared', fact_id: 'preference' });
  assert.ok(!everything().includes(t.preference));
});

test('expired proposals and their approvals are removed at the next proposal; receipts of commits remain', async () => {
  const done = await approved(put('e-1', t.preference)); await commit(done);
  const pending = await proposeFact(db, a, put('e-2', t.corrected, 1));
  const unused = await approved(put('e-3', t.stale, 1, 'other'));
  db.raw.exec(`UPDATE memory_proposals SET expires_at_ms=1 WHERE id IN ('${pending.proposal_id}','${unused.proposal_id}')`);
  await proposeFact(db, b, put('e-4', t.distractor1, 0, 'third'));
  assert.ok(!everything().includes(t.corrected) && !everything().includes(t.stale));
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_approvals').get().n, 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_receipts').get().n, 1);
  assert.equal((await commit(done)).replayed, true);
  // An expired request key can be proposed again instead of returning the stale proposal.
  assert.equal((await proposeFact(db, a, put('e-2', t.corrected, 1))).status, 'pending');
});

test('rejecting deletes a pending or approved proposal at once; written or foreign ones cannot be rejected', async () => {
  const pending = await proposeFact(db, a, put('d-1', t.preference));
  await assert.rejects(discardProposal(db, a, { collection: 'shared', proposal_id: pending.proposal_id }), error('FORBIDDEN'));
  assert.deepEqual(await discardProposal(db, owner, { collection: 'shared', proposal_id: pending.proposal_id }), { status: 'discarded', proposal_id: pending.proposal_id });
  assert.ok(!everything().includes(t.preference));
  await assert.rejects(commit(pending), error('NOT_FOUND'));
  const ready = await approved(put('d-2', t.corrected));
  await discardProposal(db, owner, { collection: 'shared', proposal_id: ready.proposal_id });
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_approvals').get().n, 0);
  const done = await approved(put('d-3', t.stale)); await commit(done);
  await assert.rejects(discardProposal(db, owner, { collection: 'shared', proposal_id: done.proposal_id }), error('PROPOSAL_UNAVAILABLE'));
  await assert.rejects(discardProposal(db, { ...owner, owner_id: 'other-owner' }, { collection: 'shared', proposal_id: done.proposal_id }), error('PROPOSAL_UNAVAILABLE'));
});

async function sample() {
  await commit(await approved(put('s-1', t.preference))); await commit(await approved(put('s-2', t.corrected, 1)));
  await commit(await approved(put('s-3', t.distractor1, 0, 'removed'))); await commit(await approved(del('s-4', 1, 'removed')), 'delete');
  await commit(await approved(put('s-5', t.distractor2, 0, 'secret')));
  await purgeFact(db, owner, { collection: 'shared', fact_id: 'secret' });
  await proposeFact(db, a, put('s-6', t.stale, 2)); // proposals are not memory and are not exported
  return exportCollection(db, owner, { collection: 'shared' }, Date.UTC(2026, 9, 22));
}

test('export then restore reproduces facts, history and purge tombstones in an empty database', async () => {
  const data = await sample();
  assert.equal(data.format, 'persistent-memory-export'); assert.equal(data.exported_at_utc, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(data.facts.map(f => [f.id, f.head_version, f.deleted, f.versions.length]), [['preference', 2, false, 2], ['removed', 2, true, 2]]);
  assert.deepEqual(data.purged.map(p => [p.fact_id, p.last_version]), [['secret', 1]]);
  const text = JSON.stringify(data);
  assert.ok(text.includes(t.preference) && text.includes(t.distractor1)); assert.ok(!text.includes(t.distractor2) && !text.includes(t.stale));
  await assert.rejects(exportCollection(db, a, { collection: 'shared' }), error('FORBIDDEN'));
  const target = await open();
  try {
    assert.deepEqual(await restoreCollection(target, owner, data), { status: 'restored', collection: 'shared', facts: 2, versions: 4, purged: 1 });
    assert.equal((await getFact(target, b, { collection: 'shared', id: 'preference' })).content, t.corrected);
    assert.equal((await getFact(target, b, { collection: 'shared', id: 'preference', version: 1 })).content, t.preference);
    await assert.rejects(getFact(target, b, { collection: 'shared', id: 'removed' }), error('NOT_FOUND'));
    await assert.rejects(commit(await approved(put('reuse', t.stale, 1, 'secret'), a, target), 'put', target), error('DELETED_ID'));
    assert.ok((await drain(target)).includes('indexed'));
    assert.equal((await searchFacts(target, b, { collection: 'shared', query: t.paraphrase }, search)).candidates[0]?.id, 'preference');
    const again = await exportCollection(target, owner, { collection: 'shared' }, Date.UTC(2026, 9, 22));
    assert.equal(again.sha256, data.sha256); assert.deepEqual(again, data);
  } finally { target.close(); }
});

test('restore refuses tampered, malformed, foreign or non-empty input and needs the restore capability', async () => {
  const data = await sample(), fresh = async () => open();
  const resign = async d => ({ ...d, sha256: await hash(JSON.stringify({ owner_id: d.owner_id, collection: d.collection, facts: d.facts, purged: d.purged })) });
  const clone = () => structuredClone(data);
  const cases = [
    [() => { const d = clone(); d.facts[0].versions[0].payload.content = 'changed'; return d; }, 'EXPORT_DIGEST_MISMATCH'],
    [async () => { const d = clone(); d.facts[0].versions[0].payload.observed_at = '2020-01-01T00:00:00Z'; return resign(d); }, 'INVALID_EXPORT'],
    [async () => { const d = clone(); d.facts[0].versions.shift(); d.facts[0].head_version = 1; return resign(d); }, 'INVALID_EXPORT'],
    [async () => { const d = clone(); d.facts[1].deleted = false; return resign(d); }, 'INVALID_EXPORT'],
    [async () => { const d = clone(); d.purged[0].fact_id = 'preference'; return resign(d); }, 'INVALID_EXPORT'],
    [async () => { const d = clone(); d.facts[0].versions[0].payload.collection = 'other'; return resign(d); }, 'INVALID_EXPORT'],
    [async () => ({ ...clone(), extra: true }), 'INVALID_ARGUMENTS'],
    [async () => ({ ...clone(), format_version: 2 }), 'INVALID_EXPORT'],
    [async () => resign({ ...clone(), owner_id: 'other-owner' }), 'FORBIDDEN'],
  ];
  for (const [make, code] of cases) { const target = await fresh(); try { await assert.rejects(restoreCollection(target, owner, await make()), error(code), code); } finally { target.close(); } }
  const target = await fresh();
  try {
    await assert.rejects(restoreCollection(target, { ...owner, scopes: ['memory:export'] }, data), error('FORBIDDEN'));
    await proposeFact(target, a, put('busy', t.stale));
    await assert.rejects(restoreCollection(target, owner, data), error('COLLECTION_NOT_EMPTY'));
  } finally { target.close(); }
});
