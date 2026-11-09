import { reviewConfig, CLIENT_SCOPES } from '../memory/review/identity.mjs';
import { MEMORY_MCP_PATH } from '../memory/review/facade.mjs';

export const OAUTH_SCOPES = CLIENT_SCOPES;
export const OAUTH_CALLBACK_PATH = '/oauth/github/callback';
const paths = new Set(['/authorize', '/oauth/token', '/oauth/register', OAUTH_CALLBACK_PATH,
  '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/memory/mcp']);
export const isOAuthRoute = path => paths.has(path);

/** Explicit opt-in and a collection allowlist. Review capabilities are never OAuth scopes. */
export function authConfig(env) {
  const base = reviewConfig(env);
  if (env.MEMORY_OAUTH_ENABLED !== 'true' || !env.OAUTH_KV) throw new Error('oauth_configuration_missing');
  const collections = String(env.MEMORY_OAUTH_COLLECTIONS ?? '').split(',').map(c => c.trim());
  if (!collections[0] || collections.length > 8 || new Set(collections).size !== collections.length
      || collections.some(c => !base.collections.includes(c))) throw new Error('oauth_collections_required');
  return Object.freeze({ ...base, collections: Object.freeze(collections),
    resource: base.origin + MEMORY_MCP_PATH, callback: base.origin + OAUTH_CALLBACK_PATH });
}
