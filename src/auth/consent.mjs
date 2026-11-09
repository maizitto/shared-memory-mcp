import { escapeHtml as esc } from '../platform/html.mjs';
export function consentPage(details, handle, collections, scopes) {
  const name = esc(details.clientName);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title><main><h1>Allow ${name} to use your shared memory?</h1>
<p>${details.clientDomain ? `Published client identity: <strong>${esc(details.clientDomain)}</strong>.` : 'This client registered itself; its name is not verified.'}</p>
<p>Access returns to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p>Only continue if you started this connection in a local app. Another process could be listening on that address.</p>' : ''}
<p>Read approved facts and search memory. Proposing a change never approves it: each fact still needs separate owner review.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(handle)}">
<input type="hidden" name="scope" value="memory:read"><p>Permission: <strong>memory:read</strong></p>
<p>Access is read-only unless you enable proposing changes. Select at least one collection below.</p>
${scopes.includes('memory:write') ? '<p><label><input type="checkbox" name="scope" value="memory:write"> Also allow proposing changes (memory:write)</label></p>' : ''}
<fieldset><legend>Collections this client may access</legend>${collections.map(c => `<p><label><input type="checkbox" name="collection" value="${esc(c)}"> ${esc(c)}</label></p>`).join('')}</fieldset>
<p>Next, sign in with the GitHub account of this instance owner. This connection expires after 30 days and can be revoked earlier.</p>
<button name="decision" value="approve">Allow and continue with GitHub</button> <button name="decision" value="deny">Deny</button>
</form></main></html>`;
}
export function consentCsp(redirectUri) {
  const origin = new URL(redirectUri).origin;
  if (!/^https?:\/\/[A-Za-z0-9._:[\]-]+$/.test(origin)) throw new Error('unsupported_redirect_origin');
  return `default-src 'none'; form-action 'self' https://github.com ${origin}; frame-ancestors 'none'; base-uri 'none'`;
}
