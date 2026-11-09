/**
 * Shared-memory bearer and owner-review routes. Mounted only when MEMORY_REVIEW_ENABLED === 'true'.
 * /review/* is the owner review; /memory/mcp is a separate write-capable MCP endpoint for registered bearer
 * clients. The owner review is separate from MCP client capabilities.
 */
import { createReviewApp } from './app.mjs';
import { grantPrincipal } from './identity.mjs';
import { handleMemoryMcp } from '../mcp.mjs';
import { hash } from '../ledger.mjs';
import { primary } from '../../platform/d1.mjs';
import { memorySearch } from '../search-runtime.mjs';
import { BEARER_TTL_MS, withinLifetime } from '../../platform/credentials.mjs';

export const MEMORY_MCP_PATH = '/memory/mcp';
const BEARER = /^Bearer (pmm_[A-Za-z0-9_-]{43})$/;
/** Select an authenticator only; matching a format never authenticates the token. */
export const isRegisteredMemoryBearer = request => BEARER.test(request.headers.get('authorization') ?? '');
export const isMemoryRoute = pathname => pathname === '/review' || pathname.startsWith('/review/') || pathname === MEMORY_MCP_PATH;

const denied = status => new Response(status === 429 ? 'Request limit reached. Try later.' : 'Request guard unavailable.',
  { status, headers: { 'cache-control': 'no-store', 'retry-after': '60' } });
/** Same per-location limiter bindings and fail-closed rule as the OAuth routes. */
async function guard(env, binding, key) {
  if (env.AUTH_GUARDS_REQUIRED !== 'true') return null;
  try {
    if (!env[binding]) return denied(503);
    return (await env[binding].limit({ key })).success ? null : denied(429);
  } catch { return denied(503); }
}

async function bearerPrincipal(db, config, request) {
  const match = BEARER.exec(request.headers.get('authorization') ?? '');
  if (!match) return null;
  const client = await db.prepare('SELECT id,scopes,created_at_ms,revoked_at_ms FROM memory_clients WHERE token_sha256=?').bind(await hash(match[1])).first();
  if (!client || client.revoked_at_ms !== null || !withinLifetime(client.created_at_ms, Date.now(), BEARER_TTL_MS)) return null;
  const grants = (await db.prepare('SELECT collection_id,scopes FROM memory_client_grants WHERE client_id=?').bind(client.id).all()).results;
  return grantPrincipal(config, client, grants);
}

/** Fetch injection is for local tests in code only. Throws when configuration is incomplete; the caller fails closed. */
export async function handleMemoryRoute(request, env, { githubFetcher } = {}) {
  const app = createReviewApp({
    MEMORY_PUBLIC_ORIGIN: env.MEMORY_PUBLIC_ORIGIN, GITHUB_OWNER_ID: env.GITHUB_OWNER_ID, GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET, MEMORY_REVIEW_COLLECTIONS: env.MEMORY_REVIEW_COLLECTIONS, DB: env.DB
  }, githubFetcher ? { githubFetcher } : {});
  const { pathname } = new URL(request.url);
  if (pathname === MEMORY_MCP_PATH) {
    const rejected = await guard(env, 'AUTH_API_LIMIT', 'memory-mcp');
    if (rejected) return rejected;
    const db = primary(env.DB);
    return handleMemoryMcp(request, { db, principal: await bearerPrincipal(db, app.config, request), allowedOrigins: [], reviewUrl: `${app.config.origin}/review`, ...memorySearch(env) });
  }
  const login = pathname === '/review/login' || pathname === '/review/github/callback';
  const rejected = await guard(env, login ? 'AUTH_LOGIN_LIMIT' : 'AUTH_API_LIMIT', login ? 'memory-review-login' : 'memory-review');
  return rejected ?? app.fetch(request);
}
