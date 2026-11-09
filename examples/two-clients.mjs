/** Offline contract demonstration. The reviewer and identities here are fictional test capabilities. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalD1, localSearch, writer, reviewer } from '../test/memory/testkit.mjs';
import { handleMemoryMcp } from '../src/memory/mcp.mjs';
import { approveProposal } from '../src/memory/ledger.mjs';
import { runIndexJob } from '../src/memory/indexer.mjs';
import { connect, tool } from './sdk.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/embeddings/second-brain.json', import.meta.url)));
const { texts } = JSON.parse(await readFile(new URL('../fixtures/memory-sharing/second-brain.json', import.meta.url)));
const db = await new LocalD1().init();
const search = localSearch(fixture);
const clients = [];
const fetcher = async (input, init) => {
  const request = new Request(input, init);
  const token = request.headers.get('authorization');
  const principal = token === 'Bearer fictional-a' ? writer('owner-demo', 'client-a')
    : token === 'Bearer fictional-b' ? writer('owner-demo', 'client-b') : null;
  return handleMemoryMcp(request, { db, principal, ...search });
};
try {
  const a = await connect('demo-client-a', 'https://memory.example/memory/mcp', 'fictional-a', fetcher); clients.push(a);
  const b = await connect('demo-client-b', 'https://memory.example/memory/mcp', 'fictional-b', fetcher); clients.push(b);
  const proposal = await tool(a, 'propose_fact', { collection: 'shared', request_id: 'demo-1',
    fact_id: 'preference', operation: 'put', expected_version: 0, content: texts.preference,
    source: 'fictional offline demo', observed_at: '2020-01-01' });
  assert.equal((await tool(b, 'list_facts', { collection: 'shared' })).facts.length, 0);
  console.log('1. Client A proposes; client B sees no approved fact.');
  await approveProposal(db, reviewer, { collection: 'shared', proposal_id: proposal.proposal_id, expected_digest: proposal.digest });
  const saved = await tool(a, 'put_fact', { collection: 'shared', proposal_id: proposal.proposal_id });
  const replay = await tool(a, 'put_fact', { collection: 'shared', proposal_id: proposal.proposal_id });
  assert.equal(saved.status, 'stored'); assert.equal(replay.replayed, true);
  console.log('2. A separate fictional reviewer approves the exact digest; retry reuses the receipt.');
  assert.equal((await runIndexJob(db, search)).status, 'indexed');
  const found = await tool(b, 'search_facts', { collection: 'shared', query: texts.paraphrase, mode: 'semantic' });
  assert.equal(found.candidates[0].id, 'preference');
  const fact = await tool(b, 'get_fact', { collection: 'shared', id: found.candidates[0].id });
  assert.equal(fact.content, texts.preference);
  console.log('3. Client B finds the Italian paraphrase and reads canonical version ' + fact.version + '.');
  console.log(JSON.stringify({ two_sdk_clients: true, approval_is_separate: true, retry_replayed: true,
    canonical_read: true, precomputed_model_vectors: true, live_inference: false, network_requests: 0 }));
} finally {
  await Promise.allSettled(clients.map(client => client.close())); db.close();
}
