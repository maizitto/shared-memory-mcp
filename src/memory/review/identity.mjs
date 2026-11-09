/** Identity adapter for the shared-memory prototype. Access tokens never carry review rights. */
import { identifier } from '../ledger.mjs';

export const CLIENT_SCOPES = Object.freeze(['memory:read', 'memory:write']);
export const REVIEW_SCOPE = 'memory:approve';
/** Owner-session capabilities: approve or reject proposals, purge facts, export collections. Restore is operator-only. */
export const OWNER_SCOPES = Object.freeze([REVIEW_SCOPE, 'memory:purge', 'memory:export']);

export function reviewConfig(env) {
  const origin = new URL(env.MEMORY_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid_origin');
  const ownerId = env.GITHUB_OWNER_ID;
  if (!/^[1-9][0-9]{0,15}$/.test(ownerId || '') || !Number.isSafeInteger(Number(ownerId))) throw new Error('owner_required');
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.DB) throw new Error('review_configuration_missing');
  const collections = String(env.MEMORY_REVIEW_COLLECTIONS ?? '').split(',').map(value => value.trim());
  if (!collections[0] || collections.length > 8 || new Set(collections).size !== collections.length) throw new Error('collections_required');
  for (const collection of collections) identifier(collection);
  return Object.freeze({
    origin: origin.origin, callback: `${origin.origin}/review/github/callback`, ownerId, userId: `github-${ownerId}`,
    githubClientId: env.GITHUB_CLIENT_ID, githubClientSecret: env.GITHUB_CLIENT_SECRET, collections: Object.freeze(collections)
  });
}

/**
 * Map a token that the OAuth server has already verified. The owner and collections come from
 * configuration, never from the token or tool arguments; unknown scopes, including memory:approve, are dropped.
 */
export function clientPrincipal(config, auth) {
  if (!auth || auth.userId !== config.userId || !Array.isArray(auth.scope)) return null;
  const connection = auth.props?.connectionId;
  if (typeof connection !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(connection)) return null;
  const scopes = CLIENT_SCOPES.filter(scope => auth.scope.includes(scope));
  if (!scopes.length) return null;
  return { owner_id: config.userId, subject: `connection:${connection}`, scopes, collections: [...config.collections] };
}

/**
 * A registered bearer client: per collection, the granted scopes limited by the client's own scopes and by the
 * configured collections. A valid token with no usable grant is authenticated but can read or propose nothing.
 */
export function grantPrincipal(config, client, grants) {
  if (!client || typeof client.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(client.id) || typeof client.scopes !== 'string') return null;
  const ceiling = client.scopes.split(' '), out = {};
  for (const grant of grants ?? []) {
    if (!config.collections.includes(grant.collection_id) || typeof grant.scopes !== 'string') continue;
    const scopes = CLIENT_SCOPES.filter(scope => ceiling.includes(scope) && grant.scopes.split(' ').includes(scope));
    if (scopes.length) out[grant.collection_id] = scopes;
  }
  return { owner_id: config.userId, subject: `connection:${client.id}`, grants: out };
}

/** Only a browser session proven by the configured GitHub owner can approve, purge or export. */
export function reviewerPrincipal(config, githubId) {
  if (typeof githubId !== 'string' || githubId !== config.ownerId) return null;
  return { owner_id: config.userId, subject: `${config.userId}:review`, scopes: [...OWNER_SCOPES], collections: [...config.collections] };
}
