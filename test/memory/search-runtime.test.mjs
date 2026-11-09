import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1,writer} from './testkit.mjs';
import {memorySearch,indexMemoryTick,MEMORY_DIMENSIONS,MEMORY_FINGERPRINT} from '../../src/memory/search-runtime.mjs';
import {proposeFact,approveProposal,commitProposal} from '../../src/memory/ledger.mjs';
import {embeddingProvider} from '../../src/memory/vectors.mjs';
function bindings(){const calls=[];return {calls,MEMORY_SEARCH_ENABLED:'true',MEMORY_MIN_SIMILARITY:'0.6',MEMORY_REVIEW_ENABLED:'true',GITHUB_OWNER_ID:'12345',MEMORY_REVIEW_COLLECTIONS:'synthetic,shared',MEMORY_SEARCH_COLLECTIONS:'shared',
 AI:{async run(model,{text}){calls.push({model,count:text.length});return {data:text.map(()=>Array(MEMORY_DIMENSIONS).fill(0.01))};}},
 MEMORY_VECTORS:{async upsert(rows){calls.push({vectors:rows.length,owner:rows[0].metadata.owner_id});},async query(){return {matches:[]};},async deleteByIds(){}}};}
test('disabled runtime never invokes AI and preserves explicit semantic-unavailable behavior',async()=>{
 const env=bindings();env.MEMORY_SEARCH_ENABLED='false';const runtime=memorySearch(env);assert.equal(runtime.defaultSearchMode,'semantic');await assert.rejects(runtime.embedding.embed('fictional'));
 assert.deepEqual(await indexMemoryTick(env),{status:'disabled'});assert.equal(env.calls.length,0);
});
test('opt-in requires a model-specific threshold and a dedicated vector binding; invalid config remains lexical-capable',async()=>{
 for(const tweak of [{MEMORY_MIN_SIMILARITY:undefined},{MEMORY_MIN_SIMILARITY:'NaN'},{MEMORY_MIN_SIMILARITY:'1.2'},{MEMORY_VECTORS:undefined}]){
  const env={...bindings(),...tweak};assert.equal(memorySearch(env).defaultSearchMode,'hybrid');assert.equal((await indexMemoryTick(env)).status,'configuration_unavailable');assert.equal(env.calls.length,0);
 }
 const env=bindings();env.VECTORIZE=env.MEMORY_VECTORS;assert.equal((await indexMemoryTick(env)).status,'configuration_unavailable');
 const runtime=memorySearch(bindings());assert.equal(runtime.embedding.dimensions,1024);assert.equal(runtime.embedding.fingerprint,MEMORY_FINGERPRINT);assert.equal(runtime.minSimilarity,0.6);
});
test('scheduled runtime processes only one committed job for its configured owner/collection',async()=>{
 const db=await new LocalD1().init(),env={...bindings(),DB:db};
 try{
  for(const [owner,id]of[['other-owner','foreign'],['github-12345','one'],['github-12345','two']]){
   const actor=writer(owner),p=await proposeFact(db,actor,{collection:'shared',fact_id:id,operation:'put',expected_version:0,content:'Fatto inventato per il runtime.',source:'fixture'});
   await approveProposal(db,{...actor,scopes:['memory:approve']},{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});await commitProposal(db,actor,{collection:'shared',proposal_id:p.proposal_id},'put');
  }
  assert.equal((await indexMemoryTick(env)).status,'indexed');assert.equal(env.calls.filter(c=>c.vectors).length,1);assert.equal(env.calls.find(c=>c.vectors).owner,'github-12345');
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM memory_index_jobs WHERE state='pending'").get().n,2);
  env.MEMORY_SEARCH_COLLECTIONS='private';assert.equal((await indexMemoryTick(env)).status,'configuration_unavailable');
 }finally{db.close();}
});
test('embedding batches reject wrong row counts, dimensions and non-finite values',async()=>{
 for(const data of [[],[[0,0]],[[NaN]],[[0]],[[0],[0]]]){
  const provider=embeddingProvider({async run(){return {data};}},{model:'fictional',dimensions:1,fingerprint:'test'});await assert.rejects(provider.embedMany(['input']));
 }
 const provider=embeddingProvider({async run(_m,{text}){return {data:text.map(()=>new Float32Array([1]))};}},{model:'fictional',dimensions:1,fingerprint:'test'});assert.deepEqual(await provider.embedMany(['a','b']),[[1],[1]]);
});
