import { primary } from '../platform/d1.mjs';
import { OAUTH_CALLBACK_PATH } from './config.mjs';
const denied = (status, retry = 60) => new Response(status === 429 ? 'Authorization request limit reached.' : 'Authorization guard unavailable.', {
  status, headers: { 'cache-control': 'no-store', 'retry-after': String(retry) }
});
export async function dailyBudget(db, bucket, limit, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await primary(db).prepare(`INSERT INTO memory_oauth_budgets(bucket,day,used) VALUES(?,?,1)
    ON CONFLICT(bucket,day) DO UPDATE SET used=used+1 WHERE used<? RETURNING used`).bind(bucket, day, limit).first();
  return Boolean(row);
}
export async function consentBudget(env) {
  return await dailyBudget(env.DB, 'consent', 20) ? null : denied(429, 3600);
}
/** Legacy pmm_ requests never enter this guard. No KV dependency is added to them. */
export async function guardOAuth(request, env) {
  try {
    if (env.AUTH_GUARDS_REQUIRED !== 'true') return denied(503);
    const path = new URL(request.url).pathname;
    const group = ['/authorize', OAUTH_CALLBACK_PATH].includes(path) ? 'login'
      : path === '/oauth/token' ? 'token' : path === '/oauth/register' ? 'register' : 'resource';
    const binding = group === 'login' ? env.AUTH_LOGIN_LIMIT : env.AUTH_API_LIMIT;
    if (!binding?.limit) return denied(503);
    if (!(await binding.limit({ key: 'memory-oauth:' + group })).success) return denied(429);
    if (request.method === 'POST' && ['token', 'register'].includes(group)
        && !await dailyBudget(env.DB, group, group === 'token' ? 240 : 30)) return denied(429, 3600);
    return null;
  } catch { return denied(503); }
}
