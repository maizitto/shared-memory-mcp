import { handleMemoryRoute, isMemoryRoute, MEMORY_MCP_PATH, isRegisteredMemoryBearer } from './memory/review/facade.mjs';
import { reviewConfig } from './memory/review/identity.mjs';
import { indexMemoryTick } from './memory/search-runtime.mjs';
import { isOAuthRoute } from './auth/config.mjs';
import { guardOAuth } from './auth/guard.mjs';

const unavailable = () => new Response('Memory service is not configured.', {
  status: 503, headers: { 'cache-control': 'no-store' }
});

function configured(env) {
  if (env.MEMORY_ENABLED !== 'true' || env.MEMORY_REVIEW_ENABLED !== 'true'
      || env.AUTH_GUARDS_REQUIRED !== 'true' || !env.AUTH_LOGIN_LIMIT?.limit
      || !env.AUTH_API_LIMIT?.limit) throw new Error('configuration_missing');
  return reviewConfig(env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const config = configured(env);
      const url = new URL(request.url);
      if (url.origin !== config.origin) return new Response(null, { status: 400 });
      if (env.MEMORY_OAUTH_ENABLED === 'true' && (isOAuthRoute(url.pathname)
          || (url.pathname === MEMORY_MCP_PATH && !isRegisteredMemoryBearer(request)))) {
        const rejected = await guardOAuth(request, env); if (rejected) return rejected;
        // The provider imports cloudflare:workers. Keep native/offline and legacy paths independent.
        const { createOAuthApp } = await import('./auth/app.mjs');
        return await createOAuthApp(env).fetch(request, env, ctx);
      }
      if (!isMemoryRoute(url.pathname)) return new Response(null, { status: 404 });
      return await handleMemoryRoute(request, env);
    } catch {
      return unavailable();
    }
  },
  async scheduled(_event, env) {
    configured(env);
    const result = await indexMemoryTick(env);
    if (result.status === 'configuration_unavailable' || result.status === 'retry') {
      // Status only. Never log memory text, token values or raw exceptions.
      console.warn('memory_index_pending');
    }
  }
};
