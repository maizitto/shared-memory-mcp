/** LOOPBACK ONLY: real local D1/KV/provider with fictional GitHub and CIMD. NEVER DEPLOY. */
import entry from '../../../src/worker.mjs';
import { installSchema } from '../../../src/memory/schema.mjs';
import { installReviewSchema } from '../../../src/memory/review/schema.mjs';
import { createReviewApp } from '../../../src/memory/review/app.mjs';
import { installOAuthSchema } from '../../../src/auth/schema.mjs';
import { createOAuthApp } from '../../../src/auth/app.mjs';
import { guardOAuth } from '../../../src/auth/guard.mjs';
import { revokeConnection } from '../../../src/auth/registry.mjs';
import { hash } from '../../../src/memory/ledger.mjs';

const ORIGIN = 'https://memory.example';
const CIMD = 'https://published-client.example/client.json';
const SIGNED_CIMD = 'https://signed-client.example/client.json';
let publicJwk;
const nativeFetch = fetch;
// Only a fictional public metadata URL is replaced. No personal installation is contacted.
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (url === CIMD) return Promise.resolve(Response.json({ client_id: CIMD, client_name: 'Fictional Published Client',
    redirect_uris: ['https://client.example/callback','http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types:['code'] }));
  if (url === SIGNED_CIMD) return Promise.resolve(Response.json({ client_id: SIGNED_CIMD, client_name: 'Fictional Signed Client',
    redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'private_key_jwt',
    jwks_uri: 'https://signed-client.example/jwks.json', token_endpoint_auth_signing_alg: 'ES256',
    grant_types: ['authorization_code','refresh_token'], response_types: ['code'] }));
  if (url === 'https://signed-client.example/jwks.json') return Promise.resolve(Response.json({keys: publicJwk ? [publicJwk] : []}));
  return nativeFetch(input, init);
};
const tables = ['memory_index_jobs','memory_receipts','memory_approvals','memory_proposals','memory_versions','memory_facts',
  'memory_client_grants','memory_clients','memory_review_logins','memory_review_sessions','memory_review_budget',
  'memory_oauth_connections','memory_oauth_uses','memory_oauth_budgets'];
const LEGACY = 'pmm_' + 'l'.repeat(43);

export default {
  async fetch(request, bindings, ctx) {
    if (!['127.0.0.1','localhost'].includes(new URL(request.url).hostname)) return new Response(null,{status:404});
    if (new URL(request.url).pathname === '/health') return new Response('ready');
    const input = await request.json();
    const limiter = {async limit(){if(input.guard==='failed')throw new Error('fictional guard failure');return {success:input.guard!=='exhausted'};}};
    const env = { ...bindings, MEMORY_ENABLED:'true', MEMORY_REVIEW_ENABLED:'true', AUTH_GUARDS_REQUIRED:'true',
      AUTH_LOGIN_LIMIT:limiter,AUTH_API_LIMIT:limiter,MEMORY_PUBLIC_ORIGIN:ORIGIN,GITHUB_OWNER_ID:'12345',
      GITHUB_CLIENT_ID:'fictional-app',GITHUB_CLIENT_SECRET:'fictional-secret',MEMORY_REVIEW_COLLECTIONS:'shared,writing',
      MEMORY_OAUTH_ENABLED:'true',MEMORY_OAUTH_COLLECTIONS:'shared,writing',MEMORY_SEARCH_ENABLED:'false',
      ...(input.oauthOff?{MEMORY_OAUTH_ENABLED:'false'}:{}),...(input.noKv?{OAUTH_KV:undefined}:{}) };
    if(input.action==='reset') {
      await installSchema(env.DB);await installReviewSchema(env.DB);await installOAuthSchema(env.DB);
      for(const table of tables)await env.DB.prepare(`DELETE FROM ${table}`).run();
      await env.DB.prepare("INSERT INTO memory_clients(id,label,token_sha256,scopes,created_at_ms) VALUES('legacy','legacy',?,'memory:read memory:write',?)").bind(await hash(LEGACY),Date.now()).run();
      await env.DB.prepare("INSERT INTO memory_client_grants(client_id,collection_id,scopes) VALUES('legacy','shared','memory:read memory:write')").run();
      return Response.json({reset:true,legacyToken:LEGACY,cimdClient:CIMD,signedClient:SIGNED_CIMD});
    }
    if(input.action==='public-jwk') {publicJwk=input.jwk;return Response.json({installed:true});}
    if(input.action==='connections')return Response.json((await env.DB.prepare('SELECT id,user_id,client_id,resource,scope,collections_json,status,expires_at FROM memory_oauth_connections').all()).results);
    if(input.action==='expire-legacy'){await env.DB.prepare('UPDATE memory_clients SET created_at_ms=? WHERE id=?').bind(Date.now()-31*86400000,'legacy').run();return Response.json({expired:true});}
    if(input.action==='revoke')return Response.json({changed:await revokeConnection(env.DB,input.id)});
    if(input.action==='expire') {await env.DB.prepare('UPDATE memory_oauth_connections SET expires_at=1 WHERE id=?').bind(input.id).run();return Response.json({expired:true});}
    let githubFetches=0;
    const github=async(url,options)=>{
      githubFetches++;
      if(input.github==='unavailable')return new Response('',{status:503});
      if(url==='https://github.com/login/oauth/access_token'){
        const form=new URLSearchParams(options.body);
        if(!form.get('code_verifier')||options.redirect!=='manual')throw new Error('upstream PKCE missing');
        return Response.json({access_token:'fictional-github-token',scope:input.github==='broad-scope'?'repo':''});
      }
      if(url==='https://api.github.com/user')return Response.json({id:input.github==='other-user'?77777:12345});
      throw new Error('unexpected upstream URL');
    };
    const req=new Request(new URL(input.path,ORIGIN),{method:input.method??'GET',headers:input.headers,...(input.body!==undefined?{body:input.body}:{})});
    let response;
    if(input.path.startsWith('/oauth/github/callback')) {
      response=await guardOAuth(req,env)??await createOAuthApp(env,{githubFetcher:github}).fetch(req,env,ctx);
    } else if(input.path==='/review'||input.path.startsWith('/review/')){
      response=await createReviewApp(env,{githubFetcher:github}).fetch(req);
    } else response=await entry.fetch(req,env,ctx);
    return Response.json({status:response.status,headers:[...response.headers],cookies:response.headers.getSetCookie(),body:await response.text(),githubFetches});
  }
};
