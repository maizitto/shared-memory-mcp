import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chunkCount,chunkText} from '../../src/memory/chunks.mjs';
import {LocalD1,writer} from './testkit.mjs';
import {searchFacts} from '../../src/memory/search.mjs';
// Reference is the original whole-word BM25 contract, intentionally unoptimized.
const stop=new Set('a ad al alla alle allo agli ai anche che chi ci coi col come con da dal dalla dalle degli dei del della delle dello di dove e ed è era essere fa fare gli ha hai hanno i il in io la le lo ma mi ne nel nella nelle nello noi non o ogni per più quale quali quando quanto se si sia sono su sul sulla sulle tra un una uno voi the a an and or is of to for in how what when where'.split(' '));
const tokens=t=>t.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('it').match(/[\p{L}\p{N}]+/gu)??[];
function reference(facts,query){
 const terms=[...new Set(tokens(query).filter(t=>!stop.has(t)))];if(!terms.length)return [];
 const docs=facts.map(f=>{const words=tokens(f.id+' '+f.source+' '+f.content),frequency=new Map();for(const t of words)frequency.set(t,(frequency.get(t)??0)+1);return {...f,length:words.length,frequency};});
 const avg=docs.reduce((s,d)=>s+d.length,0)/Math.max(1,docs.length),df=new Map(terms.map(t=>[t,docs.filter(d=>d.frequency.has(t)).length]));
 return docs.map(d=>{let score=0,matched=0;for(const t of terms){const tf=d.frequency.get(t)??0;if(!tf)continue;matched++;score+=Math.log(1+(docs.length-df.get(t)+0.5)/(df.get(t)+0.5))*tf*2.2/(tf+1.2*(0.25+0.75*d.length/Math.max(1,avg)));}return {id:d.id,score,matched};})
 .filter(d=>d.matched>=Math.ceil(terms.length/2)).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,10).map(({id,score})=>({id,score}));
}
test('Unicode window count without constructing windows matches actual windows at boundaries and malformed surrogate sequences',()=>{
 for(const n of[0,1,255,256,257,319,320,321,575,576,577,7936,8000,8192,8256,8257]){
  for(const unit of['a','🙂','e\u0301','\ud800','\udc00','\ud800x\udc00']){
   const content=unit.repeat(n);
   try{const windows=chunkText(content);assert.equal(chunkCount(content),windows.length);}
   catch(e){assert.equal(e.message,'Too many chunks');assert.throws(()=>chunkCount(content),/Too many chunks/);}
  }
 }
});
test('optimized BM25 preserves exact scores and order for multilingual, repeated, missing and source-only terms',async()=>{
 const db=await new LocalD1().init();
 try{
  const words=['caffè','caffe\u0300','ATTIVITÀ','locale','casa','red','credenziale','μέτρο','東京','İstanbul','kit42','mix東京bar','abc123全角４２','𐐀test𐐨','🙂','e\u0301'];
  const facts=Array.from({length:37},(_,i)=>({id:'doc.'+i,source:'fonte'+i%4,content:Array.from({length:30+i*7},(_,j)=>words[(j*j+i*3+j)%words.length]).join(i%2?' ':' — ')}));
  const head=db.raw.prepare("INSERT INTO memory_facts(owner_id,collection_id,id,version,deleted,updated_at_ms) VALUES('owner-demo','shared',?,1,0,1)");
  const version=db.raw.prepare("INSERT INTO memory_versions(owner_id,collection_id,fact_id,version,operation,payload_json,actor,recorded_at_ms) VALUES('owner-demo','shared',?,1,'put',?,'fixture',1)");
  for(const f of facts){head.run(f.id);version.run(f.id,JSON.stringify({...f,observed_at:'2020-01-01T00:00:00.000Z',valid_from:'2020-01-01T00:00:00.000Z',expires_at:null}));}
  const queries=['caffè locale','ATTIVITA fonte2','red','e di la','東京 kit42','méTro Kit42','credenziale assente','fontE1 fonte3','İstanbul locale','🙂 🙂',...words.flatMap((word,i)=>[word+' '+words[(i+3)%words.length],word+' '+word+' assente'])];
  for(const query of queries){const r=await searchFacts(db,writer(),{collection:'shared',query,mode:'lexical',limit:10});assert.deepEqual(r.candidates.map(c=>({id:c.id,score:c.retrieval.lexical_score})),reference(facts,query),query);}
 }finally{db.close();}
});

test('embedding validation preserves exact owned values, rejects sparse/nonfinite/zero rows, and does not alias typed buffers',async()=>{
 const {embeddingProvider}=await import('../../src/memory/vectors.mjs');
 const config={model:'fixture',dimensions:4,fingerprint:'fixture'};
 const json=[-0,0.5,-2,Number.MIN_VALUE],typed=new Float64Array([0,-1,2,0]);
 const provider=embeddingProvider({async run(){return {data:[json,typed]};}},config);
 const result=await provider.embedMany(['fictional one','fictional two']);
 assert.deepEqual(result,[json,Array.from(typed)]);assert.ok(Object.is(result[0][0],-0));
 json[1]=9;typed[1]=9;assert.equal(result[0][1],0.5);assert.equal(result[1][1],-1);
 for(const row of[[0,0,0,-0],[1,,2,3],[1,2,3,Infinity],[1,2,3,'4'],new BigInt64Array([1n,2n,3n,4n]),new DataView(new ArrayBuffer(32))]){
  const invalid=embeddingProvider({async run(){return {data:[row]};}},config);
  await assert.rejects(invalid.embedMany(['fictional']),/Invalid embedding response/);
 }
});
