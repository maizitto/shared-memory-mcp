import { primary } from '../platform/d1.mjs';
import { hash } from '../memory/ledger.mjs';
import { OAUTH_SCOPES } from './config.mjs';

export const GRANT_TTL_MS = 30 * 86400000;
export function scopeFits(scope) {
  const scopes = String(scope ?? '').split(' ').filter(Boolean);
  return scopes.includes('memory:read') && scopes.length === new Set(scopes).size
    && scopes.every(s => OAUTH_SCOPES.includes(s));
}
export const scopesWithin = (scopes, ceiling) => Array.isArray(scopes) && scopes.length > 0
  && scopes.includes('memory:read') && new Set(scopes).size === scopes.length && scopes.every(s => ceiling.includes(s));
export function clientLabel(id) {
  try { const u = new URL(id); if (u.protocol === 'https:') return u.hostname.slice(0, 40); } catch {}
  return String(id).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'client';
}
/** D1 replay claims supplement the provider KV across edge locations. */
export async function claimUse(db, kind, value, ttlMs = 600000, now = Date.now()) {
  const r = await primary(db).prepare('INSERT OR IGNORE INTO memory_oauth_uses(kind,digest,expires_at) VALUES(?,?,?)')
    .bind(kind, await hash(value), now + ttlMs).run();
  return r.meta.changes === 1;
}
export async function prepareConnection(db, { userId, clientId, resource, scope, collections, redirectUri }, now = Date.now()) {
  if (!scopeFits(scope) || !Array.isArray(collections) || !collections.length || new Set(collections).size !== collections.length) throw new Error('invalid_grant');
  const id = crypto.randomUUID();
  const redirectOrigin = new URL(redirectUri).origin;
  if (redirectOrigin === 'null') throw new Error('invalid_redirect');
  await primary(db).prepare(`INSERT INTO memory_oauth_connections(id,user_id,client_id,resource,scope,redirect_origin,collections_json,status,created_at,updated_at,expires_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).bind(id, userId, clientId, resource, scope, redirectOrigin, JSON.stringify(collections), now, now, now + GRANT_TTL_MS).run();
  return id;
}
export async function activateConnection(db, id, now = Date.now()) {
  const r = await primary(db).prepare("UPDATE memory_oauth_connections SET status='active',updated_at=? WHERE id=? AND status='pending' AND expires_at>?").bind(now, id, now).run();
  if (r.meta.changes !== 1) throw new Error('connection_activation_failed');
}
export async function findConnection(db, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return primary(db).prepare('SELECT * FROM memory_oauth_connections WHERE id=?').bind(id).first();
}
/** A cryptographically valid token also needs its live, matching D1 grant. */
export async function authorizedConnection(db, props, token, config, now = Date.now()) {
  const row = await findConnection(db, props?.connectionId);
  if (!row || row.status !== 'active' || row.expires_at <= now || row.user_id !== config.userId
      || token.userId !== row.user_id || token.clientId !== row.client_id || token.resource !== row.resource
      || row.resource !== config.resource || !scopeFits(row.scope) || !scopesWithin(token.scope, row.scope.split(' '))) return null;
  const collections = JSON.parse(row.collections_json).filter(c => config.collections.includes(c));
  return collections.length ? { ...row, collections } : null;
}
export async function revokeConnection(db, id, now = Date.now()) {
  const r = await primary(db).prepare("UPDATE memory_oauth_connections SET status='revoked',revoked_at=?,updated_at=? WHERE id=? AND status!='revoked'")
    .bind(now, now, id).run();
  return r.meta.changes === 1;
}
