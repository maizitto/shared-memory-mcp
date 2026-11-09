/** Actual local Workers runtime, D1, KV and OAuth provider. No live account or private credentials. */
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {newVerifier,challenge} from '../../src/platform/github.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const ORIGIN='https://memory.example',RESOURCE=ORIGIN+'/memory/mcp',REDIRECT='https://client.example/callback';
let child,directory,base,logs='',fixture;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function send(input){const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();}
const headers=r=>new Headers(r.headers),location=r=>headers(r).get('location'),json=r=>JSON.parse(r.body);
class Browser {
  cookies=new Map();
  async go(path,{method='GET',form,headers:extra={},...other}={}){
    const h={...extra};if(this.cookies.size)h.cookie=[...this.cookies].map(([k,v])=>k+'='+v).join('; ');
    if(method==='POST'){h.origin=ORIGIN;h['content-type']='application/x-www-form-urlencoded';}
    const r=await send({path,method,headers:h,...(form?{body:new URLSearchParams(form).toString()}:{}),...other});
    for(const cookie of r.cookies??[]){const part=cookie.split(';')[0],i=part.indexOf('='),name=part.slice(0,i);if(/Max-Age=0/i.test(cookie))this.cookies.delete(name);else this.cookies.set(name,part.slice(i+1));}
    return r;
  }
}
async function register(extra={}){
  const r=await send({path:'/oauth/register',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'<script>Fictional client</script>',redirect_uris:[REDIRECT],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],...extra})});
  assert.equal(r.status,201,r.body);return json(r);
}
async function consent(client,overrides={}){
  const verifier=newVerifier(),browser=new Browser();
  const params={response_type:'code',client_id:client.client_id,redirect_uri:REDIRECT,resource:RESOURCE,
    scope:'memory:read memory:write',state:'fictional-client-state',code_challenge:await challenge(verifier),code_challenge_method:'S256',...overrides};
  for(const k of Object.keys(params))if(params[k]===undefined)delete params[k];
  const r=await browser.go('/authorize?'+new URLSearchParams(params));
  return {r,browser,verifier,client,params,handle:/name="handle" value="([^"]+)"/.exec(r.body)?.[1]};
}
async function finish(c,{scopes=['memory:read','memory:write'],collections=['shared'],github,...extra}={}){
  const form=[['handle',c.handle],['decision','approve'],...scopes.map(s=>['scope',s]),...collections.map(s=>['collection',s])];
  const upstream=await c.browser.go('/authorize',{method:'POST',form});assert.equal(upstream.status,302,upstream.body);
  const state=new URL(location(upstream)).searchParams.get('state');
  const callback=await c.browser.go('/oauth/github/callback?'+new URLSearchParams({code:'fictional-github-code',state}),{github,...extra});
  return {upstream,callback,state};
}
async function login(client=undefined,options={}){
  client??=await register();const c=await consent(client,options.params);assert.equal(c.r.status,200,c.r.body);
  const result=await finish(c,options);assert.equal(result.callback.status,302,result.callback.body);
  const u=new URL(location(result.callback));assert.equal(u.searchParams.get('state'),'fictional-client-state');assert.equal(u.searchParams.get('iss'),ORIGIN);
  return {...c,...result,code:u.searchParams.get('code')};
}
const token=values=>send({path:'/oauth/token',method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values).toString()});
const exchange=(c,patch={})=>token({grant_type:'authorization_code',client_id:c.client.client_id,redirect_uri:c.params.redirect_uri,resource:RESOURCE,code:c.code,code_verifier:c.verifier,...patch});
async function access(options={}){const c=await login(undefined,options),r=await exchange(c);assert.equal(r.status,200,r.body);return {...json(r),client:c.client,login:c};}
const rpc=(access,method='tools/list',params={},extra={})=>send({path:'/memory/mcp',method:'POST',headers:{'content-type':'application/json',...(access?{authorization:'Bearer '+access}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),...extra});
const tool=(access,name,args)=>rpc(access,'tools/call',{name,arguments:args});
const command={collection:'shared',request_id:'oauth-write',fact_id:'oauth.preference',operation:'put',expected_version:0,
  content:'The fictional Aurora project uses short checklists.',source:'fictional OAuth test',observed_at:'2020-01-01T00:00:00Z',valid_from:'2020-01-01T00:00:00Z'};

before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'memory-oauth-local-'));await mkdir(join(directory,'config'));
  const free=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
  const port=await free(),inspector=await free();base='http://127.0.0.1:'+port;
  child=spawn(join(root,'node_modules/.bin/wrangler'),['dev','--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector),
    '--config',join(root,'test/workerd/oauth/wrangler.json'),'--persist-to',join(directory,'state')],{cwd:root,detached:true,
    env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',XDG_CONFIG_HOME:join(directory,'config')},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',d=>logs=(logs+d).slice(-14000));
  for(let i=0;i<160;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(base+'/health',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await pause(150);}throw new Error('OAuth workerd startup failed: '+logs);
},{timeout:40000});
after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([exited,pause(3000)]);if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}await exited;}}if(directory)await rm(directory,{recursive:true,force:true});});
beforeEach(async()=>{fixture=await send({action:'reset'});assert.equal(fixture.reset,true);});

test('real provider discovery exposes audience, PKCE, CIMD, DCR and issuer identification',async()=>{
  const as=await send({path:'/.well-known/oauth-authorization-server'});assert.equal(as.status,200);const meta=json(as);
  assert.equal(meta.issuer,ORIGIN);assert.equal(meta.registration_endpoint,ORIGIN+'/oauth/register');assert.equal(meta.client_id_metadata_document_supported,true);
  assert.ok(meta.code_challenge_methods_supported.includes('S256'));assert.equal(meta.authorization_response_iss_parameter_supported,true);
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/memory/mcp']){
    const r=await send({path});assert.equal(r.status,200,r.body);assert.equal(json(r).resource,RESOURCE);
  }
  const denied=await rpc(null);assert.equal(denied.status,401);assert.match(headers(denied).get('www-authenticate'),/resource_metadata=/);
});
test('legacy tokens work with OAuth off or KV missing, and invalid legacy tokens still fail',async()=>{
  for(const patch of [{oauthOff:true},{noKv:true}])assert.equal((await rpc(fixture.legacyToken,'tools/list',{},patch)).status,200);
  assert.equal((await rpc('pmm_'+'x'.repeat(43),'tools/list',{}, {noKv:true})).status,401);
  assert.equal((await send({path:'/.well-known/oauth-authorization-server',oauthOff:true})).status,404);
});
test('consent escapes metadata, names the redirect and rejects cross-site or unbound forms',async()=>{
  const c=await consent(await register());assert.equal(c.r.status,200,c.r.body);
  assert.match(c.r.body,/&#60;script&#62;/);assert.doesNotMatch(c.r.body,/<script>/);assert.match(c.r.body,/client\.example/);
  assert.equal(headers(c.r).get('referrer-policy'),'same-origin');assert.equal(headers(c.r).get('x-frame-options'),'DENY');
  const form=new URLSearchParams([['handle',c.handle],['decision','approve'],['scope','memory:read'],['collection','shared']]).toString();
  const foreign=await send({path:'/authorize',method:'POST',headers:{origin:'https://foreign.example','content-type':'application/x-www-form-urlencoded'},body:form});assert.equal(foreign.status,403);
  const unbound=await send({path:'/authorize',method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:form});assert.equal(unbound.status,400);
});
test('DCR rejects unsafe redirects and unsupported scopes before storing a client',async()=>{
  for(const patch of [{redirect_uris:['javascript:alert(1)']},{scope:'memory:approve'}]){
    const r=await send({path:'/oauth/register',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'bad',redirect_uris:[REDIRECT],token_endpoint_auth_method:'none',...patch})});assert.equal(r.status,400);
  }
});
test('PKCE downgrade, unknown scopes and redirect substitution are refused',async()=>{
  const c=await register();
  for(const patch of [{code_challenge:undefined,code_challenge_method:undefined},{code_challenge_method:'plain'},
    {scope:'memory:read memory:approve'},{redirect_uri:'https://attacker.example/callback'}]){
    const r=(await consent(c,patch)).r;assert.notEqual(r.status,200);assert.equal(r.githubFetches,0);
  }
});
test('CIMD public identity and loopback callbacks with dynamic ports are supported',async()=>{
  const client={client_id:fixture.cimdClient};
  const c=await login(client,{params:{redirect_uri:'http://127.0.0.1:43123/callback'}});
  assert.match(c.r.body,/published-client\.example/);assert.match(c.r.body,/local app/);
  const r=await exchange(c);assert.equal(r.status,200,r.body);assert.equal((await rpc(json(r).access_token)).status,200);
});
test('CIMD private_key_jwt verifies remote public keys and rejects unsigned or forged client assertions',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const kid=randomUUID();await send({action:'public-jwk',jwk:{...publicKey.export({format:'jwk'}),kid,alg:'ES256',use:'sig'}});
  const c=await login({client_id:fixture.signedClient});
  assert.equal((await exchange(c)).status,401);
  const assertion=key=>{
    const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
    const now=Math.floor(Date.now()/1000);
    const input=b64({alg:'ES256',kid,typ:'JWT'})+'.'+b64({iss:fixture.signedClient,sub:fixture.signedClient,aud:ORIGIN+'/oauth/token',iat:now,exp:now+60,jti:randomUUID()});
    return input+'.'+sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  };
  const type='urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
  const bad=generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey;
  assert.equal((await exchange(c,{client_assertion_type:type,client_assertion:assertion(bad)})).status,401);
  const r=await exchange(c,{client_assertion_type:type,client_assertion:assertion(privateKey)});
  assert.equal(r.status,200,r.body);assert.equal((await rpc(json(r).access_token)).status,200);
});
test('consent defaults grant only read on the collection explicitly selected by the owner',async()=>{
  const c=await consent(await register());assert.equal(c.r.status,200,c.r.body);
  const inputs=[...c.r.body.matchAll(/<input\b([^>]*)>/g)].map(m=>({...Object.fromEntries([...m[1].matchAll(/([a-z]+)="([^"]*)"/g)].map(x=>[x[1],x[2]])),checked:/\bchecked\b/.test(m[1])}));
  const defaults=inputs.filter(i=>i.type==='hidden'||i.type==='checkbox'&&i.checked).map(i=>[i.name,i.value]);
  const up=await c.browser.go('/authorize',{method:'POST',form:[...defaults,['decision','approve'],['collection','shared']]});assert.equal(up.status,302,up.body);
  const cb=await c.browser.go('/oauth/github/callback?'+new URLSearchParams({code:'fictional-default-consent',state:new URL(location(up)).searchParams.get('state')}));assert.equal(cb.status,302,cb.body);
  c.code=new URL(location(cb)).searchParams.get('code');const issued=await exchange(c);assert.equal(issued.status,200,issued.body);
  const access=json(issued).access_token;assert.equal(json(await tool(access,'propose_fact',command)).result.structuredContent.error,'FORBIDDEN');
  assert.equal(json(await tool(access,'list_facts',{collection:'shared'})).result.isError,false);
  assert.equal(json(await tool(access,'list_facts',{collection:'writing'})).result.structuredContent.error,'FORBIDDEN');
});
test('expired registered tokens are rejected in workerd even with OAuth disabled',async()=>{
  await send({action:'expire-legacy'});assert.equal((await rpc(fixture.legacyToken,'tools/list',{}, {oauthOff:true})).status,401);
});
test('another GitHub identity, broad GitHub permissions and upstream outages never grant access',async()=>{
  for(const [github,status]of [['other-user',403],['broad-scope',403],['unavailable',503]]){
    const c=await consent(await register());const r=await finish(c,{github});assert.equal(r.callback.status,status,r.callback.body);
  }
  assert.equal((await send({action:'connections'})).length,0);
});
test('code, consent and upstream state cannot be replayed, and a wrong verifier fails',async()=>{
  const c=await login(),up=await c.browser.go('/oauth/github/callback?'+new URLSearchParams({code:'again',state:c.state}));assert.equal(up.status,400);
  const r=await exchange(c);assert.equal(r.status,200,r.body);assert.equal((await exchange(c)).status,400);
  const other=await login();assert.equal((await exchange(other,{code_verifier:newVerifier()})).status,400);
});
test('read-only OAuth and selected collections are enforced; approval is never a tool',async()=>{
  const a=await access({scopes:['memory:read'],collections:['writing']});
  const tools=await rpc(a.access_token);assert.equal(tools.status,200);assert.equal(json(tools).result.tools.some(t=>/approve|review/.test(t.name)),false);
  assert.equal(json(await tool(a.access_token,'list_facts',{collection:'writing'})).result.isError,false);
  assert.equal(json(await tool(a.access_token,'list_facts',{collection:'shared'})).result.structuredContent.error,'FORBIDDEN');
  assert.equal(json(await tool(a.access_token,'propose_fact',{...command,collection:'writing'})).result.structuredContent.error,'FORBIDDEN');
});
test('OAuth writer still needs separate browser approval before another client can read a fact',async()=>{
  const a=await access(),b=await access();const proposal=json(await tool(a.access_token,'propose_fact',command)).result.structuredContent;
  assert.equal(json(await tool(a.access_token,'put_fact',{collection:'shared',proposal_id:proposal.proposal_id})).result.structuredContent.error,'APPROVAL_REQUIRED');
  assert.equal(json(await tool(b.access_token,'list_facts',{collection:'shared'})).result.structuredContent.facts.length,0);
  const owner=new Browser();const start=await owner.go('/review/login',{method:'POST',form:[]});const state=new URL(location(start)).searchParams.get('state');
  const cb=await owner.go('/review/github/callback?'+new URLSearchParams({code:'fictional-owner-code',state}));assert.equal(cb.status,200,cb.body);
  const page=await owner.go('/review');const match=/<form method="post" action="\/review\/approve">(.*?)<\/form>/s.exec(page.body);assert.ok(match);
  const form=Object.fromEntries([...match[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m=>[m[1],m[2]]));
  assert.equal((await owner.go('/review/approve',{method:'POST',form})).status,303);
  const fact=json(await tool(b.access_token,'get_fact',{collection:'shared',id:command.fact_id})).result.structuredContent;
  assert.equal(fact.version,1);assert.equal(fact.content,command.content);assert.match(fact.actor,/^oauth:/);
});
test('refresh rotates credentials and D1 revocation denies both access and refresh',async()=>{
  const a=await access();assert.equal(a.expires_in,3600);assert.ok(a.refresh_token);
  const fresh=await token({grant_type:'refresh_token',client_id:a.client.client_id,refresh_token:a.refresh_token,resource:RESOURCE});assert.equal(fresh.status,200,fresh.body);
  const renewed=json(fresh);assert.notEqual(renewed.access_token,a.access_token);assert.notEqual(renewed.refresh_token,a.refresh_token);
  const [connection]=await send({action:'connections'});await send({action:'revoke',id:connection.id});
  assert.equal((await rpc(renewed.access_token)).status,401);
  assert.equal((await token({grant_type:'refresh_token',client_id:a.client.client_id,refresh_token:renewed.refresh_token,resource:RESOURCE})).status,400);
});
test('wrong resource and expired connection cannot authorize MCP requests',async()=>{
  const c=await login();assert.equal((await exchange(c,{resource:'https://other.example/mcp'})).status,400);
  const a=await access();const rows=await send({action:'connections'});const row=rows.find(r=>r.client_id===a.client.client_id);await send({action:'expire',id:row.id});
  assert.equal((await rpc(a.access_token)).status,401);
});
test('provider-standard token revocation closes the active access token',async()=>{
  const a=await access();const r=await token({client_id:a.client.client_id,token:a.access_token,token_type_hint:'access_token'});assert.equal(r.status,200,r.body);
  assert.equal((await rpc(a.access_token)).status,401);
});
test('official MCP SDK discovers, registers, completes PKCE and lists tools through OAuth',async()=>{
  let savedClient,savedTokens,verifier,authorizeUrl;
  const provider={redirectUrl:REDIRECT,clientMetadata:{client_name:'Official SDK fixture',redirect_uris:[REDIRECT],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},
    clientInformation:()=>savedClient,saveClientInformation:v=>{savedClient=v;},tokens:()=>savedTokens,saveTokens:v=>{savedTokens=v;},
    redirectToAuthorization:u=>{authorizeUrl=u;},saveCodeVerifier:v=>{verifier=v;},codeVerifier:()=>verifier,
    invalidateCredentials:scope=>{if(scope==='all'||scope==='tokens')savedTokens=undefined;if(scope==='all'||scope==='client')savedClient=undefined;}};
  const proxy=async(input,init)=>{const req=new Request(input,init);const u=new URL(req.url);assert.equal(u.origin,ORIGIN);
    const r=await send({path:u.pathname+u.search,method:req.method,headers:Object.fromEntries(req.headers),...(req.method!=='GET'?{body:await req.text()}:{})});
    return new Response(r.body||null,{status:r.status,headers:r.headers});};
  assert.equal(await auth(provider,{serverUrl:new URL(RESOURCE),scope:'memory:read memory:write',fetchFn:proxy}),'REDIRECT');
  const browser=new Browser(),page=await browser.go(authorizeUrl.pathname+authorizeUrl.search);assert.equal(page.status,200,page.body);
  const handle=/name="handle" value="([^"]+)"/.exec(page.body)[1];
  const up=await browser.go('/authorize',{method:'POST',form:[['handle',handle],['decision','approve'],['scope','memory:read'],['scope','memory:write'],['collection','shared']]});
  const cb=await browser.go('/oauth/github/callback?'+new URLSearchParams({code:'fictional-sdk-login',state:new URL(location(up)).searchParams.get('state')}));assert.equal(cb.status,302,cb.body);
  const code=new URL(location(cb)).searchParams.get('code');assert.equal(await auth(provider,{serverUrl:new URL(RESOURCE),authorizationCode:code,fetchFn:proxy}),'AUTHORIZED');
  const client=new Client({name:'oauth-sdk-client',version:'0.1.0'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE),{authProvider:provider,fetch:proxy}));assert.equal((await client.listTools()).tools.length,6);}finally{await client.close();}
});
