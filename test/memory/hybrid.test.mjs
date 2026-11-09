import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LocalD1,writer,localSearch} from './testkit.mjs';
import {proposeFact,approveProposal,commitProposal,getFact,MemoryError} from '../../src/memory/ledger.mjs';
import {runIndexJob,searchFacts,rebuildIndex,namespace,vectorId} from '../../src/memory/indexer.mjs';
import {RETENTION_SCHEMA,purgeFact} from '../../src/memory/retention.mjs';
import {chunkText,MAX_CHUNKS} from '../../src/memory/chunks.mjs';
import {TOOLS,handleMemoryMcp} from '../../src/memory/mcp.mjs';
const root=new URL('../../',import.meta.url),corpus=JSON.parse(readFileSync(new URL('fixtures/memory-sharing/hybrid-retrieval.json',root))),fixture=JSON.parse(readFileSync(new URL('fixtures/embeddings/hybrid.json',root)));
let db,search;
const principal=writer(),reviewer={...writer(),scopes:['memory:approve','memory:purge']};
async function store(id,content,expected_version=0,extra={},owner=principal){
 const p=await proposeFact(db,owner,{collection:'shared',fact_id:id,request_id:id+'-'+expected_version,operation:'put',expected_version,content,source:'fictional-search-test',observed_at:'2020-01-01',...extra});
 await approveProposal(db,{...reviewer,owner_id:owner.owner_id},{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});return commitProposal(db,owner,{collection:'shared',proposal_id:p.proposal_id},'put');
}
const fact=n=>corpus.facts[n-1],query=(q,mode='hybrid',options={})=>searchFacts(db,principal,{collection:'shared',query:q,mode,limit:3},{...search,minSimilarity:0.5,...options});
async function indexAll(){for(let i=0;i<40;i++){const r=await runIndexJob(db,search);if(r.status==='idle')return;assert.notEqual(r.status,'retry_pending',JSON.stringify(r));}throw new Error('Jobs did not drain');}
beforeEach(async()=>{db=await new LocalD1().init();for(const sql of RETENTION_SCHEMA)await db.prepare(sql).run();search=localSearch(fixture);});
afterEach(()=>db.close());

test('exact authorized ID wins without invoking the embedder, including a pending fact',async()=>{
 await store(fact(12).id,fact(12).content);search.state.failAI=true;
 const r=await query('doc.12');assert.equal(r.candidates[0].id,'doc.12');assert.equal(r.method,'exact');assert.equal(search.state.embeddingCalls,0);assert.equal(r.pending_current_facts,1);
});
test('lexical ranking uses whole normalized words and accents, rather than all query words as substrings',async()=>{
 await store(fact(10).id,fact(10).content);await store(fact(5).id,fact(5).content);
 assert.equal((await query('caffe sala nord','lexical')).candidates[0].id,'doc.10');
 assert.equal((await query('ZXQ-731','lexical')).candidates[0].id,'doc.05');
 assert.equal((await query('red','lexical')).candidates.length,0); // no substring in credenziale
});
test('hybrid retrieves a paraphrase, exposes channels and preserves canonical source/version',async()=>{
 for(const n of[1,4,11,13])await store(fact(n).id,fact(n).content);await indexAll();
 const r=await query('Quanto possiamo spendere per Boreale?');assert.ok(r.candidates.some(c=>c.id==='doc.04'));
 assert.equal(r.method,'hybrid');assert.equal(r.degraded,false);assert.ok(r.candidates[0].retrieval.channels.includes('semantic'));assert.equal(r.candidates[0].source,'fictional-search-test');assert.equal(r.candidates[0].version,1);
});
test('hybrid failure is explicit degradation to lexical, while semantic-only still errors',async()=>{
 await store(fact(5).id,fact(5).content);await indexAll();search.state.failAI=true;
 const r=await query('ZXQ-731');assert.equal(r.candidates[0].id,'doc.05');assert.equal(r.method,'lexical');assert.equal(r.degraded,true);assert.equal(r.semantic_error,'SEMANTIC_UNAVAILABLE');
 await assert.rejects(query('ZXQ-731','semantic'),e=>e.code==='SEMANTIC_UNAVAILABLE');
 search.state.failAI=false;search.state.failVectors=true;assert.equal((await query('ZXQ-731')).degraded,true);
});
test('a no-evidence query yields no candidates with the configured semantic floor',async()=>{
 await store(fact(5).id,fact(5).content);await indexAll();
 const r=await query('Quanto pesa il satellite lanciato ieri?','hybrid',{minSimilarity:1});assert.equal(r.candidates.length,0);assert.equal(r.evidence,'no_candidates');
});
test('long sections are indexed as bounded chunks and can be found by their final passage',async()=>{
 await store(fact(9).id,fact(9).content);await indexAll();assert.ok(search.state.vectors.size>1);assert.ok(search.state.vectors.size<=MAX_CHUNKS);
 const chunks=chunkText(fact(9).content);assert.equal(search.state.vectors.size,chunks.length);
 const r=await query('Quale procedura uso per tornare all’ultima copia verificata?','semantic',{minSimilarity:0});assert.equal(r.candidates[0].id,'doc.09');assert.equal(r.candidates[0].content,fact(9).content);assert.ok(r.candidates[0].retrieval.chunk>0);
});
test('all chunks of obsolete versions are removed after a correction',async()=>{
 await store(fact(9).id,fact(9).content);await indexAll();assert.ok(search.state.vectors.size>1);
 await store(fact(9).id,fact(1).content,1);await indexAll();assert.equal(search.state.vectors.size,1);assert.equal([...search.state.vectors.values()][0].metadata.version,2);
});
test('definitive purge followed by rebuild still removes all derived chunks',async()=>{
 await store(fact(9).id,fact(9).content);await indexAll();await purgeFact(db,reviewer,{collection:'shared',fact_id:fact(9).id});
 await rebuildIndex(db,{owner_id:'owner-demo',collection_id:'shared'});await indexAll();assert.equal(search.state.vectors.size,0);
 assert.equal((await query('ripara aurora')).candidates.length,0);
});
test('canonical hydration happens after external awaits: a concurrent correction cannot return old text',async()=>{
 await store(fact(1).id,fact(1).content);await indexAll();const original=search.vectors.query;
 search.vectors.query=async(...args)=>{const matches=await original(...args);await store(fact(1).id,fact(4).content,1);return matches;};
 const r=await query('Quando ci ritroviamo per coordinare Aurora?','semantic',{minSimilarity:0});assert.equal(r.candidates.length,0);
});
test('canonical hydration after external awaits also excludes a concurrent purge',async()=>{
 await store(fact(1).id,fact(1).content);await indexAll();const original=search.vectors.query;
 search.vectors.query=async(...args)=>{const matches=await original(...args);await purgeFact(db,reviewer,{collection:'shared',fact_id:fact(1).id});return matches;};
 assert.equal((await query('Quando ci ritroviamo per coordinare Aurora?','semantic',{minSimilarity:0})).candidates.length,0);
});
test('foreign owners, expired/future and unapproved facts remain excluded in every search channel',async()=>{
 const content=fact(5).content;
 await store('doc.expired',content,0,{expires_at:'2021-01-01'});await store('doc.future',content,0,{valid_from:'2999-01-01'});await store('doc.foreign',content,0,{},writer('other-owner'));
 await proposeFact(db,principal,{collection:'shared',fact_id:'doc.proposed',operation:'put',expected_version:0,content,source:'fictional'});await indexAll();
 for(const mode of['lexical','semantic','hybrid'])assert.equal((await query('ZXQ-731',mode,{minSimilarity:0})).candidates.length,0);
 const before=search.state.embeddingCalls;await assert.rejects(searchFacts(db,{...principal,scopes:[]},{collection:'shared',query:'ZXQ-731',mode:'hybrid'},search),e=>e.code==='FORBIDDEN');assert.equal(search.state.embeddingCalls,before);
});
test('untrusted vector metadata, invalid scores and duplicate chunks cannot bypass D1',async()=>{
 await store(fact(5).id,fact(5).content);await indexAll();const v=[...search.state.vectors.values()][0],valid={id:v.id,metadata:v.metadata,score:0.9};
 search.vectors.query=async()=>({matches:[{...valid,metadata:{...v.metadata,owner_id:'foreign'}},{...valid,score:NaN},{...valid,metadata:{...v.metadata,chunk:999}},valid,valid]});
 const r=await query('ZXQ-731','semantic');assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].id,'doc.05');
});
test('scheduled-style scoped job processing cannot index another owner or collection',async()=>{
 await store(fact(1).id,fact(1).content,0,{},writer('other-owner'));await store(fact(5).id,fact(5).content);
 const r=await runIndexJob(db,{...search,owner_id:'owner-demo',collections:['shared']});assert.equal(r.status,'indexed');assert.equal(search.state.vectors.size,1);assert.equal([...search.state.vectors.values()][0].metadata.owner_id,'owner-demo');
 assert.equal((await runIndexJob(db,{...search,owner_id:'owner-demo',collections:['shared']})).status,'idle');
});
test('MCP advertises hybrid and enforces the JSON body limit before tool execution',async()=>{
 assert.ok(TOOLS.find(t=>t.name==='search_facts').inputSchema.properties.mode.enum.includes('hybrid'));
 const r=await handleMemoryMcp(new Request('https://example.test/mcp',{method:'POST',body:' '.repeat(32769)}),{db,principal,...search});assert.equal(r.status,413);
});


test('cosine roundoff near one is accepted, but an out-of-range score is rejected',async()=>{
 await store(fact(5).id,fact(5).content);await indexAll();const v=[...search.state.vectors.values()][0];
 search.vectors.query=async()=>({matches:[{id:v.id,metadata:v.metadata,score:1+1e-12}]});assert.equal((await query('ZXQ-731','semantic')).candidates[0].similarity,1);
 search.vectors.query=async()=>({matches:[{id:v.id,metadata:v.metadata,score:2}]});assert.equal((await query('ZXQ-731','semantic')).candidates.length,0);
});
test('semantic collection opt-in prevents sending queries for excluded collections to AI',async()=>{
 await store(fact(5).id,fact(5).content);const r=await query('ZXQ-731','hybrid',{semanticCollections:['other']});assert.equal(r.degraded,true);assert.equal(r.candidates[0].id,'doc.05');assert.equal(search.state.embeddingCalls,0);
 const content='🙂'.repeat(4000),chunks=chunkText(content);assert.ok(chunks.length<=MAX_CHUNKS);assert.ok(chunks.every(c=>!c.includes('\uFFFD')));assert.ok(chunks.at(-1).endsWith('🙂'));
});
