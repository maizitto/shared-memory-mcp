/**
 * Offline walkthroughs with fictional identities and an in-memory SQLite database.
 * The review capability and faults below belong only to this local example.
 * Public installations use the authenticated browser review; never deploy this file.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalD1, localSearch, writer, reviewer } from '../test/memory/testkit.mjs';
import { handleMemoryMcp } from '../src/memory/mcp.mjs';
import { approveProposal } from '../src/memory/ledger.mjs';
import { runIndexJob } from '../src/memory/indexer.mjs';
import { connect, tool } from './sdk.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/embeddings/second-brain.json', import.meta.url)));
const { texts } = JSON.parse(await readFile(new URL('../fixtures/memory-sharing/second-brain.json', import.meta.url)));

async function withLab(run) {
  const db = await new LocalD1().init();
  const search = localSearch(fixture);
  const clients = [];
  const fetcher = async (input, init) => {
    const request = new Request(input, init);
    const header = request.headers.get('authorization');
    const principal = header === 'Bearer fictional-a' ? writer('owner-demo', 'client-a')
      : header === 'Bearer fictional-b' ? writer('owner-demo', 'client-b') : null;
    return handleMemoryMcp(request, { db, principal, ...search });
  };
  try {
    const a = await connect('walkthrough-a', 'https://memory.example/memory/mcp', 'fictional-a', fetcher); clients.push(a);
    const b = await connect('walkthrough-b', 'https://memory.example/memory/mcp', 'fictional-b', fetcher); clients.push(b);
    const propose = (client, request, content, version = 0, id = 'preference') => tool(client, 'propose_fact', {
      collection: 'shared', request_id: request, fact_id: id, operation: 'put', expected_version: version,
      content, source: 'fictional walkthrough', observed_at: '2020-01-01T00:00:00Z', valid_from: '2020-01-01T00:00:00Z'
    });
    const approve = proposal => approveProposal(db, reviewer, {
      collection: 'shared', proposal_id: proposal.proposal_id, expected_digest: proposal.digest
    });
    const commit = (client, proposal) => tool(client, 'put_fact', { collection: 'shared', proposal_id: proposal.proposal_id });
    const get = (client, id = 'preference', version) => tool(client, 'get_fact', {
      collection: 'shared', id, ...(version === undefined ? {} : { version })
    });
    return await run({ db, search, a, b, propose, approve, commit, get });
  } finally {
    await Promise.allSettled(clients.map(client => client.close())); db.close();
  }
}

const scenarios = {
  '1': {
    title: 'A preference reaches another assistant',
    run: () => withLab(async ({ a, b, propose, approve, commit, get }) => {
      const proposal = await propose(a, 'shared-preference-1', 'In the fictional Aurora project, I prefer training in the morning.');
      const before = await tool(b, 'list_facts', { collection: 'shared' });
      assert.equal(before.facts.length, 0);
      await approve(proposal);
      const saved = await commit(a, proposal);
      const fact = await get(b);
      assert.equal(saved.status, 'stored'); assert.equal(fact.version, 1); assert.equal(fact.content, 'In the fictional Aurora project, I prefer training in the morning.');
      return { before_approval: 0, read_by_client_b: fact.content, version: fact.version, source: fact.source };
    })
  },
  '2': {
    title: 'A decision changes while another client is behind',
    run: () => withLab(async ({ a, b, propose, approve, commit, get }) => {
      const id = 'project.deadline';
      const initial = await propose(a, 'deadline-1', 'The fictional Aurora project deadline is November 17.', 0, id);
      await approve(initial); await commit(a, initial);
      assert.equal((await get(a, id)).version, 1); assert.equal((await get(b, id)).version, 1);
      const correction = await propose(a, 'deadline-2-a', 'The fictional Aurora project deadline is November 24.', 1, id);
      const stale = await propose(b, 'deadline-2-b', 'The fictional Aurora project deadline is November 25.', 1, id);
      // Both commands were reviewed against version 1 before either client committed.
      await approve(correction); await approve(stale);
      await commit(a, correction);
      const refused = await b.callTool({ name: 'put_fact', arguments: { collection: 'shared', proposal_id: stale.proposal_id } });
      assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error, 'VERSION_CONFLICT');
      const current = await get(b, id);
      const history = await get(b, id, 1);
      assert.equal(current.version, 2); assert.match(current.content, /November 24/);
      assert.equal(history.historical, true); assert.match(history.content, /November 17/);
      return { current: current.content, version: current.version, stale_write: refused.structuredContent.error,
        previous_version_available: history.version === 1 };
    })
  },
  '3': {
    title: 'Embeddings are unavailable while the fact stays stored',
    run: () => withLab(async ({ db, search, a, b, propose, approve, commit, get }) => {
      search.state.failAI = true;
      const proposal = await propose(a, 'outage-1', texts.preference);
      await approve(proposal);
      const saved = await commit(a, proposal);
      const job = await runIndexJob(db, search);
      const canonical = await get(b);
      const fallback = await tool(b, 'search_facts', { collection: 'shared', query: texts.keyword, mode: 'hybrid' });
      assert.equal(saved.status, 'stored'); assert.equal(canonical.index_status, 'pending');
      assert.equal(job.status, 'retry_pending'); assert.equal(job.error_code, 'EMBEDDING_UNAVAILABLE');
      assert.equal(fallback.degraded, true); assert.equal(fallback.method, 'lexical');
      assert.equal(fallback.candidates[0].id, 'preference');
      search.state.failAI = false;
      // Skip the retry delay in this in-memory demonstration only; the actual indexer has backoff.
      db.raw.prepare('UPDATE memory_index_jobs SET available_at_ms=0').run();
      assert.equal((await runIndexJob(db, search)).status, 'indexed');
      const semantic = await tool(b, 'search_facts', { collection: 'shared', query: texts.paraphrase, mode: 'semantic' });
      assert.equal(semantic.candidates[0].id, 'preference');
      const receipts = db.raw.prepare('SELECT COUNT(*) AS n FROM memory_receipts').get().n;
      assert.equal(receipts, 1);
      return { save: saved.status, index_during_outage: canonical.index_status, hybrid_during_outage: fallback.method,
        degraded: fallback.degraded, index_after_recovery: 'indexed', fact_written_once: receipts === 1 };
    })
  }
};

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run demo:scenarios -- [--case 1|2|3] [--json]');
} else {
  let selected = Object.keys(scenarios), json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--case' && Object.hasOwn(scenarios, args[i + 1])) selected = [args[++i]];
    else throw new Error('Use --case 1|2|3 and/or --json.');
  }
  const results = [];
  for (const key of selected) {
    const scenario = scenarios[key], outcome = await scenario.run();
    results.push({ scenario: Number(key), title: scenario.title, ...outcome });
    if (!json) console.log(`${key}. ${scenario.title}\n${JSON.stringify(outcome, null, 2)}\n`);
  }
  const scope = { fictional_data: true, simulated_identity_and_review: true, native_sqlite: true,
    precomputed_vectors: true, live_inference: false, network_requests: 0 };
  console.log(JSON.stringify({ scenarios: results, scope }));
}
