/** Absolute credential lifetimes. Refreshing a cookie never extends these timestamps. */
export const BEARER_TTL_MS = 30 * 86400000;
export const REVIEW_SESSION_TTL_MS = 12 * 3600000;
export function withinLifetime(created, now, ttl) {
  return Number.isSafeInteger(created) && created >= 0 && created <= now && now - created < ttl;
}
