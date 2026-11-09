import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LocalD1,writer,localSearch} from './testkit.mjs';
import {proposeFact,approveProposal,commitProposal} from '../../src/memory/ledger.mjs';
import {runIndexJob} from '../../src/memory/indexer.mjs';
import {searchFacts} from '../../src/memory/search.mjs';
import {searchFacts as previousSearch} from '../../fixtures/memory-sharing/lexical-baseline/search.mjs';
import {indexLexicalTick,writeLexicalDocument} from '../../src/memory/lexical-index.mjs';
import {LEXICAL_POLICY} from '../../src/memory/lexical.mjs';
import {RETENTION_SCHEMA,purgeFact} from '../../src/memory/retention.mjs';
const root=new URL('../../',import.meta.url),corpus=JSON.parse(readFileSync(new URL('fixtures/memory-sharing/hybrid-retrieval.json',root))),fixture=JSON.parse(readFileSync(new URL('fixtures/embeddings/hybrid.json',root)));
let db,runtime;const actor=writer(),reviewer={...actor,scopes:['memory:approve','memory:purge']};
beforeEach(async()=>{db=await new LocalD1().init();for(const sql of RETENTION_SCHEMA)await db.prepare(sql).run();runtime=localSearch(fixture);});
afterEach(()=>db.close());
async function store(id,content,version=0,extra={},owner=actor){
 const p=await proposeFact(db,owner,{collection:'shared',fact_id:id,operation:'put',expected_version:version,content,source:'fictional-lexical-test',observed_at:'2020-01-01',...extra});
 await approveProposal(db,{...reviewer,owner_id:owner.owner_id},{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});
 return commitProposal(db,owner,{collection:'shared',proposal_id:p.proposal_id},'put');
}
const cacheRows=()=>db.raw.prepare('SELECT * FROM memory_lexical_docs ORDER BY owner_id,fact_id').all();
const rowFor=id=>db.raw.prepare('SELECT f.*,v.payload_json FROM memory_facts f JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version WHERE f.owner_id=? AND f.collection_id=? AND f.id=?').get('owner-demo','shared',id);
async function fill(){for(let i=0;i<210;i++){const r=await indexLexicalTick(db,{owner_id:'owner-demo',collections:['shared']});if(r.status==='idle')return;}throw new Error('Derived fill did not drain');}
async function vectors(){for(let i=0;i<100;i++){const r=await runIndexJob(db,runtime);if(r.status==='idle')return;assert.notEqual(r.status,'retry_pending');}throw new Error('Vector jobs did not drain');}
const search=(query,mode='lexical',extra={},database=db)=>searchFacts(database,actor,{collection:'shared',query,mode,limit:3,...extra},{...runtime,minSimilarity:0.3,lexicalIndex:true});
function observe(base,hook){
 const calls=[];
 const wrap=(stmt,sql,args=[])=>({
  bind(...values){assert.ok(values.length<=100);return wrap(stmt.bind(...values),sql,values);},
  async all(){await hook?.(sql);const result=await stmt.all();calls.push({sql,bytes:Buffer.byteLength(JSON.stringify(result.results)),rows:result.results});return result;},
  async first(){await hook?.(sql);const result=await stmt.first();calls.push({sql,bytes:Buffer.byteLength(JSON.stringify(result)),rows:[]});return result;},
  async run(){throw new Error('Search must never write derived data');}
 });
 return {database:{prepare(sql){return wrap(base.prepare(sql),sql);}},calls};
}
test('complete and partial derived indexes preserve every frozen query response in all modes',async()=>{
 for(const f of corpus.facts){let v=0;for(const content of [...f.history??[],f.content])await store(f.id,content,v++);}
 await vectors();
 // Deliberately mix ready and missing records before checking the complete index.
 for(const stage of['empty','partial','complete']){
  if(stage==='partial')await indexLexicalTick(db,{owner_id:'owner-demo',collections:['shared']});
  if(stage==='complete')await fill();
  for(const mode of['lexical','semantic','hybrid'])for(const q of corpus.queries){
   const args={collection:'shared',query:q.query,mode,limit:3},options={...runtime,minSimilarity:0.3};
   assert.deepEqual(await searchFacts(db,actor,args,{...options,lexicalIndex:true}),await previousSearch(db,actor,args,options),stage+' '+mode+' '+q.id);
  }
 }
});
test('cached query reads only compact statistics and selected full facts; queries never populate the index',async()=>{
 for(let i=0;i<53;i++)await store('doc.'+i,('procedura locale caffè 🙂 ').repeat(90));
 await fill();const before=JSON.stringify(cacheRows()),seen=observe(db);
 const r=await search('procedura locale','lexical',{},seen.database);
 assert.equal(r.candidates.length,3);assert.equal(seen.calls.length,2);
 assert.ok(seen.calls[0].rows.every(row=>row.payload_json===null));
 assert.equal(seen.calls[1].rows.length,3);
 const old=observe(db);await previousSearch(old.database,actor,{collection:'shared',query:'procedura locale',mode:'lexical',limit:3},runtime);
 assert.ok(seen.calls.reduce((s,c)=>s+c.bytes,0)<old.calls.reduce((s,c)=>s+c.bytes,0)*0.3);
 assert.equal(JSON.stringify(cacheRows()),before);
});
test('newly approved and corrected facts are immediately searchable before either index runs',async()=>{
 await store('doc.one','caffè locale stanza');await fill();await store('doc.two','procedura locale nuova');
 assert.equal((await search('procedura locale')).candidates[0].id,'doc.two');
 await store('doc.one','ripristino remoto nuovo',1);assert.equal(cacheRows().some(r=>r.fact_id==='doc.one'),false);
 assert.equal((await search('ripristino remoto')).candidates[0].version,2);
 assert.equal((await search('caffe stanza')).candidates.length,0);
});
test('lexical maintenance is scoped, idempotent and independent of AI/vector availability',async()=>{
 await store('doc.one',corpus.facts[0].content);await store('doc.foreign',corpus.facts[0].content,0,{},writer('other-owner'));
 runtime.state.failAI=true;runtime.state.failVectors=true;
 assert.equal((await indexLexicalTick(db,{owner_id:'owner-demo',collections:['shared']})).status,'lexical_indexed');
 assert.equal((await indexLexicalTick(db,{owner_id:'owner-demo',collections:['shared']})).status,'idle');
 assert.equal(cacheRows().length,1);assert.equal(cacheRows()[0].owner_id,'owner-demo');assert.equal(runtime.state.embeddingCalls,0);
});
test('durable index jobs prepare lexical statistics even when embedding inference fails',async()=>{
 await store('doc.one',corpus.facts[0].content);runtime.state.failAI=true;
 assert.equal((await runIndexJob(db,{...runtime,lexicalIndex:true})).status,'retry_pending');
 assert.equal(cacheRows().length,1);assert.equal(cacheRows()[0].policy,LEXICAL_POLICY);
 const r=await search('Aurora','hybrid');assert.equal(r.method,'lexical');assert.equal(r.degraded,true);
});
test('logical deletion and definitive purge synchronously remove derived text; stale fills cannot resurrect it',async()=>{
 await store('doc.one','procedura locale riservata');await fill();const stale=rowFor('doc.one');
 await purgeFact(db,reviewer,{collection:'shared',fact_id:'doc.one'});
 assert.equal(cacheRows().length,0);assert.equal(await writeLexicalDocument(db,stale),false);
 assert.equal((await search('procedura locale')).candidates.length,0);
 await store('doc.two','procedura locale seconda');await fill();
 const p=await proposeFact(db,actor,{collection:'shared',fact_id:'doc.two',operation:'delete',expected_version:1});
 await approveProposal(db,reviewer,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});await commitProposal(db,actor,{collection:'shared',proposal_id:p.proposal_id},'delete');
 assert.equal(cacheRows().length,0);
});
test('cache invalidation is transactional and a rolled-back canonical change preserves the original statistics',async()=>{
 await store('doc.one','procedura locale');await fill();const original=JSON.stringify(cacheRows());
 db.raw.exec('BEGIN');db.raw.prepare("UPDATE memory_facts SET version=2 WHERE id='doc.one'").run();assert.equal(cacheRows().length,0);db.raw.exec('ROLLBACK');
 assert.equal(JSON.stringify(cacheRows()),original);assert.equal((await search('procedura locale')).candidates[0].version,1);
});
test('even in-place canonical payload changes invalidate statistics and reject a racing stale writer',async()=>{
 await store('doc.one','procedura locale');await fill();const stale=rowFor('doc.one'),payload=JSON.parse(stale.payload_json);payload.content='ripristino remoto';
 db.raw.prepare('UPDATE memory_versions SET payload_json=? WHERE fact_id=?').run(JSON.stringify(payload),'doc.one');
 assert.equal(cacheRows().length,0);assert.equal(await writeLexicalDocument(db,stale),false);
 assert.equal((await search('ripristino remoto')).candidates[0].id,'doc.one');
});
test('a correction between metadata and final hydration retries and never returns old content',async()=>{
 await store('doc.one','locale locale principale');await store('doc.two','locale secondario');await fill();let changed=false;
 const seen=observe(db,async sql=>{if(!changed&&sql.includes('f.id IN (SELECT value FROM json_each(?3))')){changed=true;await store('doc.one','remoto corretto',1);}});
 const r=await search('locale locale','lexical',{limit:1},seen.database);
 assert.equal(changed,true);assert.equal(r.candidates[0].id,'doc.two');assert.ok(r.candidates.every(c=>!c.content.includes('principale')));assert.ok(seen.calls.length<=4);
});
test('a purge between metadata and hydration refills from remaining authorized candidates',async()=>{
 await store('doc.one','locale locale principale');await store('doc.two','locale secondario');await fill();let changed=false;
 const seen=observe(db,async sql=>{if(!changed&&sql.includes('f.id IN (SELECT value FROM json_each(?3))')){changed=true;await purgeFact(db,reviewer,{collection:'shared',fact_id:'doc.one'});}});
 const r=await search('locale locale','lexical',{limit:1},seen.database);assert.equal(r.candidates[0].id,'doc.two');assert.equal(cacheRows().length,1);
});
test('continued concurrent changes cannot cause an unbounded retry or expose stale versions',async()=>{
 await store('doc.one','locale stabile');await fill();let changes=0;
 const seen=observe(db,async sql=>{if(sql.includes('f.id IN (SELECT value FROM json_each(?3))')){await store('doc.one','locale cambiato '+changes,1+changes);changes++;}});
 const r=await search('locale locale','lexical',{limit:1},seen.database);assert.equal(changes,2);assert.equal(r.candidates.length,0);assert.equal(seen.calls.length,4);
});
test('foreign, future, expired and unapproved records stay excluded even if they have ready statistics',async()=>{
 const text=corpus.facts[4].content;
 await store('doc.expired',text,0,{expires_at:'2021-01-01'});await store('doc.future',text,0,{valid_from:'2999-01-01'});await store('doc.foreign',text,0,{},writer('other-owner'));
 await proposeFact(db,actor,{collection:'shared',fact_id:'doc.proposed',operation:'put',expected_version:0,content:text,source:'fictional'});
 await fill();await vectors();
 for(const mode of['lexical','semantic','hybrid'])assert.equal((await search('ZXQ-731',mode)).candidates.length,0);
 const seen=observe(db);await assert.rejects(searchFacts(seen.database,{...actor,scopes:[]},{collection:'shared',query:'locale'},{...runtime,lexicalIndex:true}),e=>e.code==='FORBIDDEN');assert.equal(seen.calls.length,0);
});
test('wrong cache policy, invalid term frequencies and missing schema safely fall back to canonical words',async()=>{
 await store('doc.one','procedura locale caffè');await fill();
 db.raw.prepare("UPDATE memory_lexical_docs SET policy='obsolete'").run();
 assert.equal((await search('procedura locale')).candidates[0].id,'doc.one');await fill();
 db.raw.prepare('UPDATE memory_lexical_docs SET terms_json=?').run(JSON.stringify({procedura:'invalid',locale:1}));
 assert.equal((await search('procedura locale')).candidates[0].id,'doc.one');
 db.raw.exec('DROP TABLE memory_lexical_docs');
 assert.equal((await search('procedura locale')).candidates[0].id,'doc.one');
});
test('canonical text overrides an incorrect derived chunk count instead of accepting a nonexistent vector window',async()=>{
 const f=corpus.facts[4];await store(f.id,f.content);await vectors();await fill();
 const vector=[...runtime.state.vectors.values()][0];
 db.raw.prepare('UPDATE memory_lexical_docs SET chunk_count=32').run();
 const {vectorId}=await import('../../src/memory/vectors.mjs');
 runtime.vectors.query=async()=>({matches:[{id:await vectorId('owner-demo','shared',f.id,1,1),score:0.9,metadata:{...vector.metadata,chunk:1}}]});
 assert.equal((await search('ZXQ-731','semantic')).candidates.length,0);
});
test('many query terms remain bound data under the D1 parameter limit and preserve exact scores',async()=>{
 await store('doc.one',Array.from({length:110},(_,i)=>'w'+i).join(' '));await fill();
 const query=Array.from({length:100},(_,i)=>'w'+i).join(' '),args={collection:'shared',query,mode:'lexical',limit:3},seen=observe(db);
 assert.deepEqual(await searchFacts(seen.database,actor,args,{...runtime,lexicalIndex:true}),await previousSearch(db,actor,args,runtime));
});

test('single-word queries keep the bounded exact-ID probe and exact IDs still avoid AI',async()=>{
 await store('doc.one','locale stabile');await fill();const seen=observe(db);
 assert.equal((await search('locale','lexical',{},seen.database)).candidates[0].id,'doc.one');assert.equal(seen.calls.length,3);
 runtime.state.failAI=true;const exact=observe(db),calls=runtime.state.embeddingCalls;
 const r=await search('doc.one','hybrid',{},exact.database);assert.equal(r.method,'exact');assert.equal(exact.calls.length,2);assert.equal(runtime.state.embeddingCalls,calls);
});

test('derived JSON term lookups preserve mixed Unicode, source terms and prototype-like words',async()=>{
 const words=['caffè','caffe\u0300','ATTIVITÀ','locale','red','credenziale','μέτρο','東京','İstanbul','mix東京bar','abc123全角４２','𐐀test𐐨','constructor','prototype','fonte','kit42'];
 for(let i=0;i<23;i++)await store('doc.'+i,Array.from({length:80+i*3},(_,j)=>words[(j*j+j+i*3)%words.length]).join(' — '));
 await fill();
 const queries=['locale constructor','東京 kit42','e di la','🙂 🙂','red fonte',...words.flatMap((w,i)=>[w+' '+words[(i+3)%words.length],w+' '+w+' assente'])];
 for(const query of queries){const args={collection:'shared',query,mode:'lexical',limit:10};assert.deepEqual(await searchFacts(db,actor,args,{...runtime,lexicalIndex:true}),await previousSearch(db,actor,args,runtime),query);}
});
