/** Optional OAuth AS + MCP resource server. Only the provider handles token cryptography. */
import { OAuthAuthorizationServer, OAuthResourceServer, OAuthError, AuthorizationError,
  CimdFetchError, authorizationErrorRedirect, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { authConfig, OAUTH_SCOPES, OAUTH_CALLBACK_PATH } from './config.mjs';
import { consentBudget } from './guard.mjs';
import { consentPage, consentCsp } from './consent.mjs';
import { GRANT_TTL_MS, scopeFits, scopesWithin, clientLabel, claimUse, prepareConnection,
  activateConnection, authorizedConnection } from './registry.mjs';
import { primary } from '../platform/d1.mjs';
import { readBody } from '../platform/http.mjs';
import { newVerifier, challenge, githubUrl, githubIdentity, GithubError } from '../platform/github.mjs';
import { handleMemoryMcp } from '../memory/mcp.mjs';
import { memorySearch } from '../memory/search-runtime.mjs';

const secure = headers => {
  const h = new Headers(headers);
  h.set('cache-control', 'no-store'); h.set('referrer-policy', 'no-referrer');
  h.set('x-content-type-options', 'nosniff'); h.set('x-frame-options', 'DENY');
  h.set('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return h;
};
const fail = (text, status = 400, headers) => new Response(text, { status, headers: secure(headers) });
const redirect = (to, headers) => { const h = secure(headers); h.set('location', to); return new Response(null, { status: 302, headers: h }); };

/** Fetch injection is local test code only, never an HTTP field, environment URL or public route. */
export function createOAuthApp(env, { githubFetcher = fetch } = {}) {
  const config = authConfig(env);
  const server = new OAuthAuthorizationServer({
    issuer: config.origin, resources: [config.resource], defaultResource: config.resource,
    scopesSupported: [...OAUTH_SCOPES], clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: '/oauth/register', clientRegistrationTTL: GRANT_TTL_MS / 1000,
    accessTokenTTL: 3600, refreshTokenTTL: GRANT_TTL_MS / 1000,
    cookiePrefix: '__Host-memory-oauth-',
    clientRegistrationCallback({ clientMetadata }) {
      if (clientMetadata.scope !== undefined && (typeof clientMetadata.scope !== 'string'
          || clientMetadata.scope.split(' ').filter(Boolean).some(s => !OAUTH_SCOPES.includes(s)))) {
        return { description: 'Only memory:read and memory:write are supported.' };
      }
    },
    async tokenExchangeCallback(o) {
      try {
        const row = await authorizedConnection(o.env.DB, o.props, o, config);
        if (!['authorization_code', 'refresh_token'].includes(o.grantType) || !row
            || !scopesWithin(o.requestedScope, row.scope.split(' '))) {
          throw new OAuthError('invalid_grant', { description: 'Connection unavailable. Sign in again.' });
        }
        if (o.grantType === 'authorization_code' && !await claimUse(o.env.DB, 'code', o.grantId, GRANT_TTL_MS)) {
          throw new OAuthError('invalid_grant', { description: 'Authorization code already used.' });
        }
        await primary(o.env.DB).prepare('UPDATE memory_oauth_connections SET provider_grant_id=?,updated_at=? WHERE id=?')
          .bind(o.grantId, Date.now(), o.props.connectionId).run();
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        throw new OAuthError('temporarily_unavailable', { description: 'Authorization storage unavailable.', statusCode: 503 });
      }
    }
  });
  const resource = new OAuthResourceServer({
    resourceMetadata: { resource: config.resource, authorization_servers: [config.origin], resource_name: 'Shared Memory MCP' },
    // These scopes are advertised; the handler enforces read and the ledger enforces write per operation.
    requiredScopes: [...OAUTH_SCOPES],
    validateToken: current => async (audience, token) => {
      const valid = await server.validateToken(audience, token, current);
      if (!valid) return null;
      const row = await authorizedConnection(current.DB, valid.props, { ...valid, resource: audience }, config);
      return row ? { ...valid, props: { connectionId: row.id, collections: row.collections, redirectOrigin: row.redirect_origin } } : null;
    },
    handler: { fetch(request, current, ctx) {
      if (!ctx.auth.scope.includes('memory:read')) return insufficientScope(ctx.auth, ['memory:read']);
      const scopes = OAUTH_SCOPES.filter(s => ctx.auth.scope.includes(s));
      const principal = { owner_id: config.userId, subject: `oauth:${clientLabel(ctx.auth.clientId)}:${ctx.props.connectionId}`,
        grants: Object.fromEntries(ctx.props.collections.map(c => [c, scopes])) };
      return handleMemoryMcp(request, { db: primary(current.DB), principal,
        allowedOrigins: [config.origin, ctx.props.redirectOrigin], reviewUrl: config.origin + '/review', ...memorySearch(current) });
    } }
  });
  return {
    config, server,
    async fetch(request, current, ctx) {
      const url = new URL(request.url);
      if (url.origin !== config.origin) return fail('Unexpected host.', 400);
      if (request.url.length > 8192) return fail('Request too large.', 414);
      try {
        if (url.pathname === '/memory/mcp' || url.pathname === '/.well-known/oauth-protected-resource/memory/mcp') {
          return await resource.fetch(request, current, ctx);
        }
        if (url.pathname === '/.well-known/oauth-protected-resource') {
          return await resource.fetch(new Request(config.origin + '/.well-known/oauth-protected-resource/memory/mcp', request), current, ctx);
        }
        const oauth = server.getOAuthApi(current);
        if (url.pathname === '/authorize') {
          if (request.method === 'GET') {
            const original = await oauth.parseAuthRequest(request);
            if (original.resource !== config.resource || original.scope.some(s => !OAUTH_SCOPES.includes(s))) {
              return redirect(authorizationErrorRedirect(original, 'invalid_scope'));
            }
            // Require S256 for confidential clients too; do not permit a PKCE downgrade.
            if (url.searchParams.getAll('code_challenge').length !== 1
                || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '')
                || url.searchParams.getAll('code_challenge_method').length !== 1
                || url.searchParams.get('code_challenge_method') !== 'S256') {
              return redirect(authorizationErrorRedirect(original, 'invalid_request'));
            }
            const requested = original.scope.length ? original.scope : ['memory:read'];
            if (!scopeFits(requested.join(' '))) return redirect(authorizationErrorRedirect(original, 'invalid_scope'));
            const details = await oauth.describeConsent(original);
            const rejected = await consentBudget(current); if (rejected) return rejected;
            await primary(current.DB).prepare('DELETE FROM memory_oauth_uses WHERE expires_at<?').bind(Date.now()).run();
            const consent = await oauth.beginConsent(original);
            const h = secure(consent.headers); h.set('content-type', 'text/html; charset=utf-8');
            h.set('content-security-policy', consentCsp(original.redirectUri)); h.set('referrer-policy', 'same-origin');
            return new Response(consentPage(details, consent.handle, config.collections, requested), { headers: h });
          }
          if (request.method !== 'POST') return fail('Method not allowed.', 405, { allow: 'GET, POST' });
          const site = request.headers.get('sec-fetch-site');
          if (request.headers.get('origin') !== config.origin || (site && site !== 'same-origin')) return fail('Unexpected origin.', 403);
          if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return fail('Unsupported form.', 415);
          const bytes = await readBody(request, 16384); if (bytes === null) return fail('Request too large.', 413);
          const form = new URLSearchParams(new TextDecoder().decode(bytes));
          if ([...form.keys()].some(k => !['handle', 'decision', 'scope', 'collection'].includes(k))
              || form.getAll('handle').length !== 1 || form.getAll('decision').length !== 1
              || !['approve', 'deny'].includes(form.get('decision'))) return fail('Invalid consent.');
          const handle = form.get('handle');
          if (form.get('decision') === 'deny') {
            const denied = await oauth.denyConsent(request, handle);
            if (!await claimUse(current.DB, 'consent', handle)) return fail('Consent already used.');
            return new Response(null, { status: 302, headers: secure(denied.headers) });
          }
          const scopes = form.getAll('scope'), collections = form.getAll('collection');
          if (!scopeFits(scopes.join(' ')) || !collections.length || collections.length > config.collections.length
              || new Set(collections).size !== collections.length || collections.some(c => !config.collections.includes(c))) return fail('Invalid permissions or collections.');
          const approved = await oauth.approveConsent(request, handle, { scope: scopes });
          if (!await claimUse(current.DB, 'consent', handle)) return fail('Consent already used.');
          if (approved.request.resource !== config.resource) return fail('Invalid resource.');
          const verifier = newVerifier();
          const upstream = await oauth.beginUpstream(approved.request, { data: { verifier, collections }, headers: approved.headers });
          return redirect(githubUrl(config, upstream.state, await challenge(verifier)), upstream.headers);
        }
        if (url.pathname === OAUTH_CALLBACK_PATH) {
          if (request.method !== 'GET') return fail('Method not allowed.', 405, { allow: 'GET' });
          if (url.searchParams.getAll('state').length !== 1) return fail('Invalid sign-in state.');
          const resumed = await oauth.finishUpstream(request);
          if (!await claimUse(current.DB, 'upstream', url.searchParams.get('state'))) return fail('Sign-in already used.');
          if (url.searchParams.has('error')) return redirect(authorizationErrorRedirect(resumed.request, 'access_denied'), resumed.headers);
          const code = url.searchParams.get('code');
          if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 512) return fail('Missing sign-in code.', 400, resumed.headers);
          const id = await githubIdentity(config, code, resumed.data.verifier, githubFetcher);
          if (id !== config.ownerId) return fail('This GitHub account cannot access this instance.', 403, resumed.headers);
          const scopes = resumed.request.scope, collections = resumed.data.collections;
          if (resumed.request.resource !== config.resource || !scopeFits(scopes.join(' '))
              || !Array.isArray(collections) || !collections.length || collections.some(c => !config.collections.includes(c))) return fail('Authorization changed. Start again.', 400, resumed.headers);
          const connectionId = await prepareConnection(current.DB, { userId: config.userId, clientId: resumed.request.clientId,
            resource: config.resource, scope: scopes.join(' '), collections, redirectUri: resumed.request.redirectUri });
          const result = await oauth.completeAuthorization({ request: resumed.request, userId: config.userId,
            scope: scopes, metadata: { connectionId }, props: { connectionId }, revokeExistingGrants: false });
          await activateConnection(current.DB, connectionId);
          return redirect(result.redirectTo, resumed.headers);
        }
        if (['/oauth/token', '/oauth/register'].includes(url.pathname) && request.method === 'POST') {
          const bytes = await readBody(request, 16384); if (bytes === null) return fail('Request too large.', 413);
          request = new Request(request, { body: bytes });
        }
        return await server.fetch(request, current, ctx);
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
        if (error instanceof AuthorizationError || error instanceof CimdFetchError) return fail('Authorization could not be verified. Start again.');
        if (error instanceof GithubError) return fail(error.code === 'github_unavailable' ? 'GitHub temporarily unavailable.' : 'GitHub identity could not be verified.', error.code === 'github_unavailable' ? 503 : 403);
        return fail('Authorization temporarily unavailable.', 503);
      }
    }
  };
}
