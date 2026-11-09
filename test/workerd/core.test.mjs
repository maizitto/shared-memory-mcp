/** Acceptance in the real local Workers runtime and D1 SQLite. No remote bindings. */
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import net from 'node:net';
import {connect,tool as sdkTool} from '../../examples/sdk.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),run=promisify(execFile);
const t=JSON.parse(await readFile(join(root,'fixtures/memory-sharing/second-brain.json'),'utf8')).texts;
let directory,child,base,port,inspector,logs=''; // inspector: own port, 9229 collides when runtimes start together
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([exited,pause(3000)]);if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}await exited;}}}
async function start(){
 child=spawn(join(root,'node_modules/.bin/wrangler'),['dev','--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector),'--config',join(root,'test/workerd/core/wrangler.json'),'--persist-to',join(directory,'state')],{cwd:root,detached:true,env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',XDG_CONFIG_HOME:join(directory,'config')},stdio:['ignore','pipe','pipe']});
 for(const stream of[child.stdout,child.stderr])stream.on('data',d=>logs=(logs+d).slice(-16000));
 for(let i=0;i<160;i++){if(child.exitCode!==null)throw new Error(logs);try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(r.ok)return;}catch{}await pause(150);}throw new Error('workerd startup failed: '+logs);
}
async function send(path,token,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return {status:r.status,body:await r.json()};}
const op=(action,extra={})=>send('/operator','fictional-operator',{action,...extra});
const cmd=(request_id='req-1',content=t.preference,expected_version=0)=>({collection:'shared',request_id,fact_id:'preference',operation:'put',expected_version,content,source:'fictional-workerd',observed_at:'2020-01-01T00:00:00Z',valid_from:'2020-01-01T00:00:00Z'});
async function tool(name,args,token='fictional-a'){const r=await send('/mcp',token,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});assert.equal(r.status,200);return r.body.result;}
const data=async p=>{const r=await p;assert.equal(r.isError,false,JSON.stringify(r.structuredContent));return r.structuredContent;};
async function approve(command){const p=await data(tool('propose_fact',command));const r=await send('/review','fictional-reviewer',{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});assert.equal(r.status,200,JSON.stringify(r.body));return p;}
const commit=(p,name='put_fact',token='fictional-a')=>tool(name,{collection:'shared',proposal_id:p.proposal_id},token);
const get=()=>data(tool('get_fact',{collection:'shared',id:'preference'},'fictional-b'));
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'shared-memory-workerd-'));await mkdir(join(directory,'config'),{recursive:true});
 const free=async()=>{const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;};port=await free();inspector=await free();base='http://127.0.0.1:'+port;await start();
},{timeout:40000});
after(async()=>{await stop();if(directory)await rm(directory,{recursive:true,force:true});});
beforeEach(async()=>{const r=await op('reset');assert.equal(r.status,200);});

test('real D1 commit is atomic across fact, version, receipt, approval consumption and job',async()=>{
 const p=await approve(cmd());await op('atomic_fault',{enabled:true});const failed=await commit(p);assert.equal(failed.isError,true);
 let counts=(await op('counts')).body;for(const k of['memory_facts','memory_versions','memory_receipts','memory_index_jobs'])assert.equal(counts[k],0);
 await op('atomic_fault',{enabled:false});assert.equal((await data(commit(p))).status,'stored');counts=(await op('counts')).body;
 for(const k of['memory_facts','memory_versions','memory_receipts','memory_index_jobs'])assert.equal(counts[k],1);
});
test('writer cannot approve or publish a proposal; independent review binds its digest',async()=>{
 const p=await data(tool('propose_fact',cmd()));assert.equal((await commit(p)).structuredContent.error,'APPROVAL_REQUIRED');
 assert.equal((await send('/review','fictional-a',{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest})).status,403);
 assert.equal((await send('/review','fictional-reviewer',{collection:'shared',proposal_id:p.proposal_id,expected_digest:'0'.repeat(64)})).body.error,'APPROVAL_MISMATCH');
 assert.equal((await data(tool('list_facts',{collection:'shared'}))).facts.length,0);
});
test('concurrent commits replay one receipt; changed payload under the same key is rejected',async()=>{
 const p=await approve(cmd());const r=await Promise.all([data(commit(p)),data(commit(p,'put_fact','fictional-b'))]);assert.equal(r.filter(x=>!x.replayed).length,1);
 assert.equal((await op('counts')).body.memory_versions,1);
 assert.equal((await tool('propose_fact',cmd('req-1',t.corrected))).structuredContent.error,'IDEMPOTENCY_CONFLICT');
});
test('stale approved writes conflict inside real D1 rather than silently overwriting',async()=>{
 await data(commit(await approve(cmd())));const a=await approve(cmd('edit-a',t.corrected,1)),b=await approve(cmd('edit-b',t.stale,1));
 const r=await Promise.all([commit(a),commit(b,'put_fact','fictional-b')]);assert.equal(r.filter(x=>!x.isError).length,1);assert.equal(r.find(x=>x.isError).structuredContent.error,'VERSION_CONFLICT');assert.equal((await get()).version,2);
});
test('stored outcome survives embedding/index outages and later recovers without replaying the mutation',async()=>{
 await op('faults',{ai:true});const p=await approve(cmd());const first=await data(commit(p));assert.equal(first.status,'stored');assert.equal(first.fact.index_status,'pending');
 assert.equal((await op('run_job')).body.error_code,'EMBEDDING_UNAVAILABLE');assert.equal((await get()).content,t.preference);assert.equal((await data(commit(p))).replayed,true);
 await op('faults',{vectors:true});await op('ready_jobs');assert.equal((await op('run_job')).body.error_code,'VECTOR_UNAVAILABLE');
 await op('faults');await op('ready_jobs');assert.equal((await op('run_job')).body.status,'indexed');assert.equal((await get()).index_status,'indexed');assert.equal((await op('counts')).body.memory_receipts,1);
});
test('deleted facts disappear immediately and old retries do not resurrect the record',async()=>{
 const p=await approve(cmd());await data(commit(p));await op('run_job');const deletion=await approve({collection:'shared',request_id:'delete-1',fact_id:'preference',operation:'delete',expected_version:1});await data(commit(deletion,'delete_fact'));
 assert.equal((await tool('get_fact',{collection:'shared',id:'preference'})).structuredContent.error,'NOT_FOUND');assert.equal((await data(commit(p))).status,'deleted');
 assert.equal((await data(tool('search_facts',{collection:'shared',query:t.paraphrase}))).candidates.length,0);await op('run_job');assert.equal((await op('counts')).body.vectors,0);
});
test('expired approvals, reader-only scope and other owners are denied on each request',async()=>{
 const p=await approve(cmd());await op('expire_approval');assert.equal((await commit(p)).structuredContent.error,'APPROVAL_REQUIRED');
 assert.equal((await commit(p,'put_fact','fictional-reader')).structuredContent.error,'FORBIDDEN');assert.equal((await commit(p,'put_fact','fictional-other')).structuredContent.error,'NOT_FOUND');
 assert.equal((await send('/mcp','invalid',{jsonrpc:'2.0',id:1,method:'tools/list'})).status,401);
});
test('real workerd restart preserves the canonical fact, receipt and pending work',async()=>{
 const p=await approve(cmd());await data(commit(p));await op('expire_lease');await stop();await start();
 assert.equal((await get()).content,t.preference);assert.equal((await data(commit(p))).replayed,true);assert.equal((await op('run_job')).body.status,'indexed');
 assert.equal((await data(tool('search_facts',{collection:'shared',query:t.paraphrase}))).candidates[0].id,'preference');
},{timeout:40000});
test('two official JS MCP SDK clients share an approved fact over HTTP and find its Italian paraphrase',async()=>{
 const a=await connect('workerd-client-a',base+'/mcp','fictional-a');
 let b;
 try{
  b=await connect('workerd-client-b',base+'/mcp','fictional-b');
  const p=await sdkTool(a,'propose_fact',cmd('sdk-demo'));
  assert.equal((await sdkTool(b,'list_facts',{collection:'shared'})).facts.length,0);
  const approval=await send('/review','fictional-reviewer',{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});
  assert.equal(approval.status,200);
  assert.equal((await sdkTool(a,'put_fact',{collection:'shared',proposal_id:p.proposal_id})).status,'stored');
  assert.equal((await op('run_job')).body.status,'indexed');
  const result=await sdkTool(b,'search_facts',{collection:'shared',query:t.paraphrase});
  assert.equal(result.candidates[0].id,'preference');
 }finally{await Promise.allSettled([a.close(),b?.close()]);}
});
