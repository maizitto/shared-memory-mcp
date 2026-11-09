/** Test-only native SQLite facade; semantic vectors come from the pinned ONNX fixture. */
import { DatabaseSync } from 'node:sqlite';
import { installSchema } from '../../src/memory/schema.mjs';
import { embeddingProvider } from '../../src/memory/indexer.mjs';
export class LocalD1 {
 constructor(path=':memory:'){this.raw=new DatabaseSync(path);this.raw.exec('PRAGMA foreign_keys=ON');}
 prepare(sql){const db=this.raw;const make=(args=[])=>{
  const direct=()=>{const s=db.prepare(sql);if(s.columns().length)return {success:true,results:s.all(...args),meta:{changes:0}};const r=s.run(...args);return {success:true,results:[],meta:{changes:Number(r.changes)}};};
  return {bind:(...values)=>make(values),async first(){return direct().results[0]??null;},async all(){return direct();},async run(){return direct();},direct};};return make();}
 async batch(statements){this.raw.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.direct());this.raw.exec('COMMIT');return out;}catch(e){this.raw.exec('ROLLBACK');throw e;}}
 close(){this.raw.close();}
 async init(){await installSchema(this);return this;}
}
export const writer=(owner_id='owner-demo',subject='client-a',collections=['shared'])=>({owner_id,subject,collections,scopes:['memory:read','memory:write']});
export const reviewer={owner_id:'owner-demo',subject:'owner-review',collections:['shared'],scopes:['memory:approve']};
export function localSearch(fixture){
 const state={failAI:false,failVectors:false,embeddingCalls:0,vectors:new Map()};
 const embedding=embeddingProvider({async run(_model,{text}){state.embeddingCalls++;if(state.failAI)throw new Error('offline');return {data:text.map(t=>{if(!fixture.vectors[t])throw new Error('Missing real fixture embedding');return fixture.vectors[t];})};}},{model:fixture.model,dimensions:fixture.dimensions,fingerprint:'pinned-multilingual-minilm-fixture-v1'});
 const vectors={async upsert(items){if(state.failVectors)throw new Error('offline');items.forEach(i=>state.vectors.set(i.id,structuredClone(i)));},async deleteByIds(ids){if(state.failVectors)throw new Error('offline');ids.forEach(id=>state.vectors.delete(id));},async query(values,{filter={},namespace,topK}){if(state.failVectors)throw new Error('offline');const cosine=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0)/Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0));return {matches:[...state.vectors.values()].filter(v=>v.namespace===namespace&&Object.entries(filter).every(([k,value])=>v.metadata[k]===value)).map(v=>({id:v.id,metadata:v.metadata,score:cosine(values,v.values)})).sort((a,b)=>b.score-a.score).slice(0,topK)};}};
 return {state,embedding,vectors};
}
