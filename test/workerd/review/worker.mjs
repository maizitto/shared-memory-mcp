/**
 * LOOPBACK TEST HARNESS ONLY. Fictional GitHub, owner, grants and content. NEVER DEPLOY.
 * Requests arrive as JSON instructions and are replayed against the synthetic https origin.
 */
import { installSchema } from '../../../src/memory/schema.mjs';
import { installReviewSchema } from '../../../src/memory/review/schema.mjs';
import { createReviewApp } from '../../../src/memory/review/app.mjs';
import { clientPrincipal } from '../../../src/memory/review/identity.mjs';
import { handleMemoryMcp } from '../../../src/memory/mcp.mjs';

const ORIGIN = 'https://memory.example';
const SETTINGS = { MEMORY_PUBLIC_ORIGIN: ORIGIN, GITHUB_OWNER_ID: '12345', GITHUB_CLIENT_ID: 'synthetic-app',
  GITHUB_CLIENT_SECRET: 'synthetic-not-a-secret', MEMORY_REVIEW_COLLECTIONS: 'shared' };
// Stand-ins for tokens already verified by an OAuth server. The writer's grant also claims memory:approve.
const GRANTS = {
  'synthetic-writer': { userId: 'github-12345', scope: ['memory:read', 'memory:write', 'memory:approve'], props: { connectionId: 'conn-writer' } },
  'synthetic-reader': { userId: 'github-12345', scope: ['memory:read'], props: { connectionId: 'conn-reader' } },
  'synthetic-foreign': { userId: 'github-77777', scope: ['memory:read', 'memory:write'], props: { connectionId: 'conn-foreign' } },
};
const offline = { embedding: { fingerprint: 'offline', async embed() { throw new Error('offline'); } }, vectors: {} };
const TABLES = ['memory_index_jobs', 'memory_receipts', 'memory_approvals', 'memory_proposals', 'memory_versions', 'memory_facts',
  'memory_review_logins', 'memory_review_sessions', 'memory_review_budget'];

export default {
  async fetch(request, bindings) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)) return new Response('Local test only', { status: 404 });
    const input = await request.json(), env = { ...SETTINGS, DB: bindings.DB };
    if (input.action === 'reset') {
      await installSchema(env.DB); await installReviewSchema(env.DB);
      for (const table of TABLES) await env.DB.prepare(`DELETE FROM ${table}`).run();
      return Response.json({ reset: true });
    }
    if (input.action === 'counts') {
      const counts = {};
      for (const table of TABLES) counts[table] = (await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n;
      return Response.json(counts);
    }
    if (input.action === 'approvals') return Response.json((await env.DB.prepare('SELECT proposal_id,digest,approved_by,consumed_at_ms FROM memory_approvals').all()).results);
    let fetches = 0;
    const github = async (url, options) => {
      fetches++;
      if (input.github === 'unavailable') return new Response('', { status: 503 });
      if (url === 'https://github.com/login/oauth/access_token') {
        const body = new URLSearchParams(options.body);
        if (!body.get('code_verifier') || options.redirect !== 'manual' || body.get('redirect_uri') !== `${ORIGIN}/review/github/callback`) throw new Error('PKCE, redirect or callback guard missing');
        return Response.json({ access_token: 'synthetic-github-token', scope: '' });
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: input.github === 'other-user' ? 77777 : 12345 });
      throw new Error('Unexpected external fetch');
    };
    const req = new Request(new URL(input.path, ORIGIN), { method: input.method ?? 'GET', headers: input.headers, ...(input.body !== undefined && { body: input.body }) });
    let response;
    if (input.path === '/mcp') {
      const app = createReviewApp(env, { githubFetcher: github });
      const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      response = await handleMemoryMcp(req, { db: env.DB, principal: clientPrincipal(app.config, GRANTS[bearer]), allowedOrigins: [], ...offline });
    } else response = await createReviewApp(env, { githubFetcher: github }).fetch(req);
    return Response.json({ status: response.status, headers: [...response.headers], cookies: response.headers.getSetCookie(), body: await response.text(), githubFetches: fetches });
  }
};
