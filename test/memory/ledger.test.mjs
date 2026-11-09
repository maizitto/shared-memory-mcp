import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalD1,writer,reviewer,localSearch} from './testkit.mjs';
import {proposeFact,approveProposal,commitProposal,getFact,listFacts,MemoryError} from '../../src/memory/ledger.mjs';
import {runIndexJob,searchFacts,rebuildIndex} from '../../src/memory/indexer.mjs';
import {callMemoryTool,handleMemoryMcp,TOOLS} from '../../src/memory/mcp.mjs';
const root=new URL('../../',import.meta.url),fixture=JSON.parse(readFileSync(new URL('fixtures/embeddings/second-brain.json',root))),t=JSON.parse(readFileSync(new URL('fixtures/memory-sharing/second-brain.json',root))).texts;
let db,search;
const a=writer(),b=writer('owner-demo','client-b');
const put=(request_id='request-1',content=t.preference,expected_version=0,fact_id='preference')=>({collection:'shared',request_id,fact_id,operation:'put',expected_version,content,source:'fictional-fixture',observed_at:'2020-01-01T00:00:00Z',valid_from:'2020-01-01T00:00:00Z'});
const del=(expected_version=1)=>({collection:'shared',request_id:'delete-1',fact_id:'preference',operation:'delete',expected_version});
async function approved(command,actor=a){const p=await proposeFact(db,actor,command);await approveProposal(db,reviewer,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});return p;}
const commit=(p,operation='put',actor=a)=>commitProposal(db,actor,{collection:'shared',proposal_id:p.proposal_id},operation);
const read=(actor=b,args={})=>getFact(db,actor,{collection:'shared',id:'preference',...args});
const error=(code)=>e=>e instanceof MemoryError&&e.code===code;
async function ready(){db.raw.exec("UPDATE memory_index_jobs SET available_at_ms=0");return runIndexJob(db,search);}
beforeEach(async()=>{db=await new LocalD1().init();search=localSearch(fixture);});
afterEach(()=>db.close());

test('proposals remain absent from normal reads and the writer cannot approve',async()=>{
 const p=await proposeFact(db,a,put());assert.equal((await listFacts(db,b,{collection:'shared'})).facts.length,0);
 await assert.rejects(commit(p),error('APPROVAL_REQUIRED'));
 await assert.rejects(approveProposal(db,a,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest}),error('FORBIDDEN'));
 assert.equal(TOOLS.some(t=>/approv|review/.test(t.name)),false);
});
test('owner approval binds exact command; forged tool fields do not grant approval',async()=>{
 await assert.rejects(proposeFact(db,a,{...put(),approved:true}),error('INVALID_ARGUMENTS'));
 const p=await proposeFact(db,a,put());await assert.rejects(approveProposal(db,reviewer,{collection:'shared',proposal_id:p.proposal_id,expected_digest:'0'.repeat(64)}),error('APPROVAL_MISMATCH'));
 await approveProposal(db,reviewer,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});
 await assert.rejects(commitProposal(db,a,{collection:'shared',proposal_id:p.proposal_id,content:t.stale},'put'),error('INVALID_ARGUMENTS'));
 const saved=await commit(p);assert.equal(saved.status,'stored');assert.equal((await read()).content,t.preference);
 assert.equal(search.state.embeddingCalls,0);assert.equal(saved.fact.index_status,'pending');
});
test('concurrent proposal and commit retries produce one fact/version/receipt/job/approval',async()=>{
 const proposals=await Promise.all([proposeFact(db,a,put()),proposeFact(db,b,put())]);assert.equal(proposals[0].proposal_id,proposals[1].proposal_id);
 const p=proposals[0];await approveProposal(db,reviewer,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});
 const saved=await Promise.all([commit(p),commit(p,'put',b)]);assert.equal(saved.filter(r=>!r.replayed).length,1);
 for(const table of ['memory_facts','memory_versions','memory_receipts','memory_index_jobs','memory_approvals'])assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,1);
 assert.ok(db.raw.prepare('SELECT consumed_at_ms FROM memory_approvals').get().consumed_at_ms);
});
test('changed payload under the same request key is rejected before and after commit',async()=>{
 const p=await approved(put());await assert.rejects(proposeFact(db,b,put('request-1',t.corrected)),error('IDEMPOTENCY_CONFLICT'));
 await commit(p);await assert.rejects(proposeFact(db,b,put('request-1',t.corrected)),error('IDEMPOTENCY_CONFLICT'));
});
test('two stale approved corrections cannot both overwrite version one',async()=>{
 await commit(await approved(put()));const p=await approved(put('a-edit',t.corrected,1)),q=await approved(put('b-edit',t.stale,1));
 const outcomes=await Promise.allSettled([commit(p),commit(q,'put',b)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'VERSION_CONFLICT');assert.equal((await read()).version,2);
 const old=await read(b,{version:1});assert.equal(old.content,t.preference);assert.equal(old.historical,true);
});
test('expired approval cannot commit; a completed receipt remains replayable with fresh authorization',async()=>{
 const p=await approved(put());db.raw.exec('UPDATE memory_approvals SET expires_at_ms=0');await assert.rejects(commit(p),error('APPROVAL_REQUIRED'));
 db.raw.exec('UPDATE memory_approvals SET expires_at_ms=9999999999999');await commit(p);db.raw.exec('UPDATE memory_approvals SET expires_at_ms=0');
 assert.equal((await commit(p)).replayed,true);await assert.rejects(commit(p,'put',{...a,scopes:['memory:read']}),error('FORBIDDEN'));
});
test('storage failure inside the trigger rolls back every side effect and does not consume approval',async()=>{
 const p=await approved(put());db.raw.exec("CREATE TRIGGER fail_synthetic BEFORE INSERT ON memory_index_jobs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 await assert.rejects(commit(p));for(const table of ['memory_facts','memory_versions','memory_receipts','memory_index_jobs'])assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.equal(db.raw.prepare('SELECT consumed_at_ms FROM memory_approvals').get().consumed_at_ms,null);
 db.raw.exec('DROP TRIGGER fail_synthetic');assert.equal((await commit(p)).status,'stored');
});
test('embedding outage leaves the committed fact and durable retry job available',async()=>{
 search.state.failAI=true;const p=await approved(put());const saved=await commit(p);assert.equal(saved.status,'stored');assert.equal((await read()).content,t.preference);
 assert.deepEqual(await ready(),{status:'retry_pending',error_code:'EMBEDDING_UNAVAILABLE'});
 assert.equal((await commit(p)).replayed,true);assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_versions').get().n,1);
 assert.equal(db.raw.prepare('SELECT state FROM memory_index_jobs').get().state,'pending');
 search.state.failAI=false;assert.equal((await ready()).status,'indexed');assert.equal((await read()).index_status,'indexed');
});
test('a semantic error is explicit while lexical reads remain independent from AI',async()=>{
 await commit(await approved(put()));await ready();search.state.failAI=true;
 await assert.rejects(searchFacts(db,b,{collection:'shared',query:t.paraphrase},search),error('SEMANTIC_UNAVAILABLE'));
 const lexical=await searchFacts(db,b,{collection:'shared',query:'Aurora',mode:'lexical'},search);assert.equal(lexical.candidates[0].content,t.preference);
 search.state.failAI=false;search.state.failVectors=true;await assert.rejects(searchFacts(db,b,{collection:'shared',query:t.paraphrase},search),error('SEMANTIC_UNAVAILABLE'));
});
test('real local embeddings find the Italian paraphrase; canonical content comes from D1',async()=>{
 await commit(await approved(put()));for(const [i,content]of[t.distractor1,t.distractor2,t.distractor3].entries())await commit(await approved(put('d-'+i,content,0,'d-'+i)));
 for(let i=0;i<4;i++)assert.equal((await ready()).status,'indexed');
 const found=await searchFacts(db,b,{collection:'shared',query:t.paraphrase,limit:3},search);assert.ok(found.candidates.some(r=>r.id==='preference'&&r.content===t.preference));assert.equal(found.pending_current_facts,0);
});
test('stale vector candidates never expose the superseded text',async()=>{
 await commit(await approved(put()));await ready();await commit(await approved(put('edit',t.corrected,1)));
 const stale=await searchFacts(db,b,{collection:'shared',query:t.paraphrase},search);assert.equal(stale.candidates.some(r=>r.content===t.preference),false);assert.equal(stale.pending_current_facts,1);
 await ready();assert.equal((await read()).content,t.corrected);assert.equal(search.state.vectors.size,1);
});
test('logical deletion is immediate and retry cannot resurrect the ID',async()=>{
 const initial=await approved(put());await commit(initial);await ready();const deletion=await approved(del());await commit(deletion,'delete');
 await assert.rejects(read(),error('NOT_FOUND'));assert.equal((await searchFacts(db,b,{collection:'shared',query:t.paraphrase},search)).candidates.length,0);
 const replay=await commit(initial);assert.equal(replay.status,'deleted');assert.equal(replay.fact,null);assert.equal(replay.current_version,2);
 const again=await approved(put('new-at-old-id',t.stale,2));await assert.rejects(commit(again),error('DELETED_ID'));
 search.state.failVectors=true;assert.equal((await ready()).status,'retry_pending');search.state.failVectors=false;assert.equal((await ready()).status,'deleted');assert.equal(search.state.vectors.size,0);
});
test('replayed older receipts report the new current version instead of restoring the old fact',async()=>{
 const first=await approved(put());await commit(first);await commit(await approved(put('correction',t.corrected,1)));
 const replay=await commit(first);assert.equal(replay.committed_version,1);assert.equal(replay.current_version,2);assert.equal(replay.superseded,true);assert.equal(replay.fact.content,t.corrected);
});
test('owner/collection/read-only permissions are checked again for every operation',async()=>{
 const p=await approved(put());await commit(p);
 await assert.rejects(read(writer('someone-else')),error('NOT_FOUND'));
 await assert.rejects(getFact(db,a,{collection:'other',id:'preference'}),error('FORBIDDEN'));
 await assert.rejects(commit(p,'put',{...a,scopes:['memory:read']}),error('FORBIDDEN'));
 await assert.rejects(listFacts(db,{...a,scopes:[]},{collection:'shared'}),error('FORBIDDEN'));
 const other=writer('another-owner');await assert.rejects(commit(p,'put',other),error('NOT_FOUND'));
});
test('expired and future facts stay out of ordinary reads and search',async()=>{
 const future={...put(),valid_from:'2999-01-01T00:00:00Z'};await commit(await approved(future));await assert.rejects(read(),error('NOT_CURRENT'));
 assert.equal((await listFacts(db,b,{collection:'shared'})).facts.length,0);
 await assert.rejects(proposeFact(db,a,{...put('bad'),valid_from:'2026-02-30T00:00:00Z'}),error('INVALID_TIME'));
});
test('index can be rebuilt entirely from the authoritative registry',async()=>{
 await commit(await approved(put()));await ready();search.state.vectors.clear();await rebuildIndex(db,{owner_id:'owner-demo',collection_id:'shared'});
 assert.equal((await ready()).status,'indexed');assert.ok((await searchFacts(db,b,{collection:'shared',query:t.paraphrase},search)).candidates.some(r=>r.id==='preference'));
});
test('an expired worker lease is recovered without creating a new mutation',async()=>{
 await commit(await approved(put()));db.raw.exec("UPDATE memory_index_jobs SET state='running',lease_token='dead-worker',lease_until_ms=0");
 assert.equal((await ready()).status,'indexed');assert.equal(db.raw.prepare('SELECT attempts FROM memory_index_jobs').get().attempts,1);assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_receipts').get().n,1);
});
test('a delayed indexer cannot publish a stale version after a correction',async()=>{
 await commit(await approved(put()));let release;const gate=new Promise(r=>release=r),original=search.embedding.embed;let started;const entered=new Promise(r=>started=r);
 search.embedding.embed=async text=>{started();await gate;return original(text);};
 const old=runIndexJob(db,search);await entered;await commit(await approved(put('new',t.corrected,1)));release();assert.equal((await old).status,'superseded');
 search.embedding.embed=original;await ready();assert.equal(search.state.vectors.size,1);assert.equal((await read()).version,2);
});
test('a superseded lease never removes vectors published by its successor for the same version',async()=>{
 await commit(await approved(put()));let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),original=search.embedding.embed;let count=0;
 search.embedding.embed=async text=>{if(count++===0){entered();await gate;}return original(text);};
 const slow=runIndexJob(db,search);await started;db.raw.exec('UPDATE memory_index_jobs SET lease_until_ms=0');assert.equal((await runIndexJob(db,search)).status,'indexed');
 release();assert.equal((await slow).status,'lease_lost');assert.equal(search.state.vectors.size,1);assert.equal((await read()).index_status,'indexed');
});
test('reopening storage preserves fact, approval, receipt and pending index job',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-registry-'));db.close();db=await new LocalD1(join(dir,'d1.sqlite3')).init();
 try{const p=await approved(put());await commit(p);db.close();db=await new LocalD1(join(dir,'d1.sqlite3')).init();assert.equal((await read()).content,t.preference);assert.equal((await commit(p)).replayed,true);assert.equal((await ready()).status,'indexed');}
 finally{db.close();rmSync(dir,{recursive:true,force:true});db=await new LocalD1().init();}
});
test('MCP prototype exposes six tools and never exposes owner approval or raw storage errors',async()=>{
 const ctx={db,principal:a,...search};const request=body=>new Request('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 let r=await handleMemoryMcp(request({jsonrpc:'2.0',id:1,method:'tools/list'}),ctx);assert.equal((await r.json()).result.tools.length,6);
 r=await handleMemoryMcp(request({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'approve_proposal',arguments:{}}}),ctx);assert.equal((await r.json()).result.structuredContent.error,'UNKNOWN_TOOL');
 assert.equal((await handleMemoryMcp(request({jsonrpc:'2.0',id:3,method:'ping'}),{...ctx,principal:null})).status,401);
 assert.equal((await handleMemoryMcp(new Request('http://localhost/mcp',{method:'POST',headers:{origin:'https://foreign.example'},body:'{}'}),ctx)).status,403);
 await assert.rejects(callMemoryTool('propose_fact',{...put(),principal:reviewer},ctx),error('INVALID_ARGUMENTS'));
});
