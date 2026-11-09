import { readBody } from './http.mjs';
/** Fixed GitHub endpoints. Tests inject a fetcher in code, never through request/env URLs. */
export class GithubError extends Error { constructor(code) { super(code); this.code = code; } }
export const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const newVerifier = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const challenge = async verifier => base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
export function githubUrl(config, state, codeChallenge) {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: config.githubClientId, redirect_uri: config.callback, scope: '', state, code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString();
  return url.href;
}
async function safeJson(fetcher, url, options) {
  try {
    const response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    const bytes = await readBody(response, 32768);
    if (bytes === null) throw new Error();
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new GithubError('github_unavailable'); }
}
export async function githubIdentity(config, code, verifier, fetcher = fetch) {
  const token = await safeJson(fetcher, 'https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.githubClientId, client_secret: config.githubClientSecret, redirect_uri: config.callback, code, code_verifier: verifier }).toString()
  });
  if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 512 || typeof token.scope !== 'string' || token.scope.trim() !== '') throw new GithubError('github_identity_rejected');
  const user = await safeJson(fetcher, 'https://api.github.com/user', { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}`, 'user-agent': 'shared-memory-mcp', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new GithubError('github_identity_rejected');
  return String(user.id); // access token is neither persisted nor returned
}
