/** LOOPBACK TEST FACADE ONLY. Fictional authentication and operator fault injection. NEVER DEPLOY. */
import {fixture,texts} from '../../../fixtures/workerd.mjs';
import {installSchema} from '../../../src/memory/schema.mjs';
import {approveProposal,inspectProposal} from '../../../src/memory/ledger.mjs';
import {embeddingProvider,runIndexJob,rebuildIndex} from '../../../src/memory/indexer.mjs';
import {handleMemoryMcp} from '../../../src/memory/mcp.mjs';
let failAI=false,failVectors=false;const vectorStore=new Map();
const principal=token=>{
 if(['fictional-a','fictional-b','fictional-reader'].includes(token))return {owner_id:'owner-demo',subject:token,collections:['shared'],scopes:token==='fictional-reader'?['memory:read']:['memory:read','memory:write']};
 if(token==='fictional-other')return {owner_id:'other-owner',subject:token,collections:['shared'],scopes:['memory:read','memory:write']};
 if(token==='fictional-reviewer')return {owner_id:'owner-demo',subject:'owner-review',collections:['shared'],scopes:['memory:approve']};return null;
};
const embedding=embeddingProvider({async run(_model,{text}){if(failAI)throw new Error('offline');return {data:text.map(s=>{if(!fixture.vectors[s])throw new Error('Unknown fixture text');return fixture.vectors[s];})};}},{model:fixture.model,dimensions:fixture.dimensions,fingerprint:'pinned-multilingual-minilm-fixture-v1'});
const vectors={async upsert(items){if(failVectors)throw new Error('offline');items.forEach(i=>vectorStore.set(i.id,i));},async deleteByIds(ids){if(failVectors)throw new Error('offline');ids.forEach(id=>vectorStore.delete(id));},async query(values,options){if(failVectors)throw new Error('offline');const cosine=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0)/Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0));return {matches:[...vectorStore.values()].filter(v=>v.namespace===options.namespace&&Object.entries(options.filter).every(([k,x])=>v.metadata[k]===x)).map(v=>({id:v.id,metadata:v.metadata,score:cosine(v.values,values)})).sort((a,b)=>b.score-a.score).slice(0,options.topK)};}};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export default {async fetch(request,env){
 const url=new URL(request.url);if(!['127.0.0.1','localhost'].includes(url.hostname))return new Response('Local test only',{status:404});
 if(url.pathname==='/health')return json({local_test_only:true});
 const token=(request.headers.get('authorization')??'').replace(/^Bearer /,'');
 if(url.pathname==='/mcp')return handleMemoryMcp(request,{db:env.DB,principal:principal(token),embedding,vectors});
 if(request.method!=='POST')return new Response(null,{status:405});
 let data;try{data=await request.json();}catch{return json({error:'bad test input'},400);}
 if(url.pathname==='/review'){
  if(token!=='fictional-reviewer')return json({error:'FORBIDDEN'},403);
  try{return json(data.action==='inspect'?await inspectProposal(env.DB,principal(token),data):await approveProposal(env.DB,principal(token),data));}
  catch(e){return json({error:e.code??'STORAGE_UNAVAILABLE'},400);}
 }
 if(url.pathname!=='/operator'||token!=='fictional-operator')return json({error:'FORBIDDEN'},403);
 switch(data.action){
 case 'reset':
  await installSchema(env.DB);
  for(const table of ['memory_index_jobs','memory_receipts','memory_approvals','memory_proposals','memory_versions','memory_facts'])await env.DB.prepare(`DELETE FROM ${table}`).run();
  failAI=false;failVectors=false;vectorStore.clear();return json({reset:true});
 case 'faults':failAI=!!data.ai;failVectors=!!data.vectors;return json({ai:failAI,vectors:failVectors});
 case 'run_job':return json(await runIndexJob(env.DB,{embedding,vectors}));
 case 'ready_jobs':await env.DB.prepare('UPDATE memory_index_jobs SET available_at_ms=0').run();return json({ready:true});
 case 'expire_approval':await env.DB.prepare('UPDATE memory_approvals SET expires_at_ms=0').run();return json({expired:true});
 case 'expire_lease':await env.DB.prepare("UPDATE memory_index_jobs SET state='running',lease_token='crashed-worker',lease_until_ms=0").run();return json({expired:true});
 case 'rebuild':vectorStore.clear();await rebuildIndex(env.DB,{owner_id:'owner-demo',collection_id:'shared'});return json({queued:true});
 case 'atomic_fault':
  if(data.enabled)await env.DB.prepare("CREATE TRIGGER fail_synthetic BEFORE INSERT ON memory_index_jobs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
  else await env.DB.prepare('DROP TRIGGER IF EXISTS fail_synthetic').run();return json({enabled:!!data.enabled});
 case 'counts':{
  const counts={};for(const table of ['memory_facts','memory_versions','memory_receipts','memory_index_jobs','memory_approvals'])counts[table]=(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n;
  return json({...counts,vectors:vectorStore.size});}
 default:return json({error:'Unknown test action'},400);
 }
}};
