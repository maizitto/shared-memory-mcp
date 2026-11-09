/**
 * Owner review of shared-memory proposals: GitHub owner login, short browser session, exact-digest approval,
 * rejection, definitive purge and export. This is the only way to obtain owner capabilities; no MCP tool or
 * access token reaches it.
 */
import { newVerifier, challenge, githubUrl, githubIdentity, GithubError, base64url } from '../../platform/github.mjs';
import { primary } from '../../platform/d1.mjs';
import { readBody } from '../../platform/http.mjs';
import { authorize, approveAndWrite, cleanupExpiredProposals, hash, identifier, MemoryError, MAX_BATCH_APPROVALS } from '../ledger.mjs';
import { purgeFact, discardProposal, exportCollection } from '../retention.mjs';
import { reviewConfig, reviewerPrincipal } from './identity.mjs';
import { loginPage, signedInPage, messagePage, reviewPage, purgePage, STYLE_HASH } from './page.mjs';
import { REVIEW_SESSION_TTL_MS, withinLifetime } from '../../platform/credentials.mjs';

// Review authority expires after 12 hours, including sessions issued by an older release.
export const LOGIN_TTL_MS = 600000, SESSION_TTL_MS = REVIEW_SESSION_TTL_MS, DAILY_LOGINS = 20, PAGE_SIZE = 60;
export const SESSION_COOKIE = '__Host-memory-review', LOGIN_COOKIE = '__Host-memory-review-login', NEXT_COOKIE = '__Host-memory-review-next';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVIEW_CSP = `default-src 'none'; style-src '${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
// Chrome applies form-action to the redirect that follows the login form.
const LOGIN_CSP = `default-src 'none'; style-src '${STYLE_HASH}'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'`;

function secure(csp = REVIEW_CSP) {
  const h = new Headers();
  h.set('cache-control', 'no-store'); h.set('x-content-type-options', 'nosniff'); h.set('x-frame-options', 'DENY');
  // Forms need a real Origin header: no-referrer would make browsers send "Origin: null".
  h.set('referrer-policy', 'same-origin'); h.set('cross-origin-opener-policy', 'same-origin');
  h.set('content-security-policy', csp);
  return h;
}
function page(body, status = 200, { cookies = [], csp } = {}) {
  const h = secure(csp); h.set('content-type', 'text/html; charset=utf-8');
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(body, { status, headers: h });
}
const message = (status, title, text, options) => page(messagePage(title, text), status, options);
function redirect(location, cookies = []) {
  const h = secure(); h.set('location', location);
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
}
const token = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const setCookie = (name, value, seconds, sameSite) => `${name}=${value}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=${sameSite}`;
function cookie(request, name) {
  const values = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
  // A duplicate name means an unexpected cookie was planted; refuse rather than guess.
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) ? values[0] : null;
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const csrfFor = sessionToken => hash(`memory-review-csrf:${sessionToken}`);

const ERRORS = {
  APPROVAL_MISMATCH: [409, 'Command changed', 'The command no longer matches the one shown. No approval recorded.'],
  PROPOSAL_UNAVAILABLE: [409, 'Proposal unavailable', 'The proposal expired or was already decided. No approval recorded.'],
  NOT_FOUND: [404, 'Proposal not found', 'No matching proposal in this memory.'],
  FORBIDDEN: [403, 'Not authorized', 'This session cannot review the requested collection.'],
};

/** Fetch injection exists only for local tests in code, never via an HTTP field or binding. */
export function createReviewApp(env, { githubFetcher = fetch, clock = Date.now } = {}) {
  const config = reviewConfig(env), db = primary(env.DB);

  async function currentSession(request, now) {
    const value = cookie(request, SESSION_COOKIE);
    if (!value) return null;
    const row = await db.prepare('SELECT * FROM memory_review_sessions WHERE token_sha256=?').bind(await hash(value)).first();
    if (!row || row.revoked_at_ms !== null || row.expires_at_ms <= now
        || !withinLifetime(row.created_at_ms, now, SESSION_TTL_MS)) return null;
    const principal = reviewerPrincipal(config, row.github_id);
    return principal && { value, principal, tokenHash: row.token_sha256, csrf: await csrfFor(value) };
  }

  /** Refuse before reading a body: foreign origin, cross-site fetch metadata, wrong media type, unexpected fields. */
  async function form(request, fields, multi = [], optional = []) {
    if (request.method !== 'POST') return { rejected: message(405, 'Method not allowed', 'Use the form on the review page.') };
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== config.origin || (site && site !== 'same-origin')) return { rejected: message(403, 'Invalid origin', 'The request did not come from the review page.') };
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return { rejected: message(415, 'Invalid form', 'Unsupported form format.') };
    const bytes = await readBody(request, 16384); // up to 60 approval items of ~110 bytes each
    if (bytes === null) return { rejected: message(413, 'Form too large', 'The form exceeds the allowed size.') };
    const params = new URLSearchParams(new TextDecoder().decode(bytes));
    if ([...params.keys()].some(key => !fields.includes(key) && !multi.includes(key) && !optional.includes(key)) || fields.some(key => params.getAll(key).length !== 1) ||
      optional.some(key => params.getAll(key).length > 1) ||
      multi.some(key => { const n = params.getAll(key).length; return n < 1 || n > MAX_BATCH_APPROVALS; })) return { rejected: message(400, 'Invalid form', 'Missing or unexpected fields.') };
    return { values: Object.fromEntries([...fields.map(key => [key, params.get(key)]), ...multi.map(key => [key, params.getAll(key)]), ...optional.map(key => [key, params.get(key)])]) };
  }

  /** One query, including current head and approval, so a page stays inside Free-plan D1 query limits. */
  async function proposals(principal, now, id) {
    const marks = principal.collections.map(() => '?').join(',');
    const rows = (await db.prepare(`SELECT p.*, f.version AS head_version, f.deleted AS head_deleted, v.payload_json AS head_payload,
      a.expires_at_ms AS approval_expires_at_ms
      FROM memory_proposals p
      LEFT JOIN memory_facts f ON f.owner_id=p.owner_id AND f.collection_id=p.collection_id AND f.id=p.fact_id
      LEFT JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version
      LEFT JOIN memory_approvals a ON a.proposal_id=p.id AND a.owner_id=p.owner_id AND a.collection_id=p.collection_id
      WHERE p.owner_id=? AND p.collection_id IN (${marks}) AND p.status IN ('pending','approved') AND p.expires_at_ms>?
      ${id ? 'AND p.id=?' : ''} ORDER BY p.created_at_ms, p.id LIMIT ${PAGE_SIZE + 1}`)
      .bind(principal.owner_id, ...principal.collections, now, ...(id ? [id] : [])).all()).results ?? [];
    return rows.map(row => ({ ...row, approval_live: row.approval_expires_at_ms > now, blocked: blocked(row) }));
  }
  function blocked(row) {
    const current = row.head_version ?? 0;
    if (row.head_deleted) return 'this ID was deleted and cannot be rewritten.';
    if (current !== row.expected_version) return `the proposal starts from version ${row.expected_version}, but the current version is ${current}. The client must propose again.`;
    if (row.operation === 'delete' && row.head_version === null) return 'there is no fact to delete.';
    return null;
  }

  async function loginBudget(now) {
    const day = new Date(now).toISOString().slice(0, 10);
    return Boolean(await db.prepare(`INSERT INTO memory_review_budget(day,used) VALUES(?,1)
      ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<? RETURNING used`).bind(day, DAILY_LOGINS).first());
  }

  async function startLogin(request, now) {
    const { rejected, values } = await form(request, [], [], ['p']);
    if (rejected) return rejected;
    // A proposal link opened before signing in is reopened after the GitHub return (cookie, 10 minutes).
    const next = UUID.test(values.p ?? '') ? [`${NEXT_COOKIE}=${values.p}; Max-Age=${LOGIN_TTL_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`] : [];
    if (!await loginBudget(now)) return message(429, 'Too many sign-ins', 'Daily sign-in limit reached. Try again tomorrow.');
    // Bounded cleanup per login; never removes a still-valid state or session.
    await db.prepare('DELETE FROM memory_review_logins WHERE expires_at_ms<?').bind(now).run();
    await db.prepare('DELETE FROM memory_review_sessions WHERE expires_at_ms<?').bind(now).run();
    await cleanupExpiredProposals(db, config.userId, now);
    const state = token(), binding = token(), verifier = newVerifier();
    await db.prepare('INSERT INTO memory_review_logins(state_sha256,binding_sha256,verifier,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?)')
      .bind(await hash(state), await hash(binding), verifier, now, now + LOGIN_TTL_MS).run();
    // Lax: GitHub returns through a cross-site top-level navigation.
    return redirect(githubUrl(config, state, await challenge(verifier)), [setCookie(LOGIN_COOKIE, binding, LOGIN_TTL_MS / 1000, 'Lax'), ...next]);
  }

  async function finishLogin(request, url, now) {
    if (request.method !== 'GET') return message(405, 'Method not allowed', 'Start again at /review.');
    const clear = [setCookie(LOGIN_COOKIE, '', 0, 'Lax'), setCookie(NEXT_COOKIE, '', 0, 'Lax')];
    const nextValues = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${NEXT_COOKIE}=`)).map(part => part.slice(NEXT_COOKIE.length + 1));
    const next = nextValues.length === 1 && UUID.test(nextValues[0]) ? nextValues[0] : null;
    const binding = cookie(request, LOGIN_COOKIE), state = url.searchParams.get('state');
    if (!binding || url.searchParams.getAll('state').length !== 1 || !state || state.length > 128) return message(400, 'Invalid sign-in', 'Sign-in was not started from this browser. Start again at /review.', { cookies: clear });
    const claimed = await db.prepare(`UPDATE memory_review_logins SET used_at_ms=?
      WHERE state_sha256=? AND binding_sha256=? AND used_at_ms IS NULL AND expires_at_ms>? RETURNING verifier`)
      .bind(now, await hash(state), await hash(binding), now).first();
    if (!claimed) return message(400, 'Invalid sign-in', 'Sign-in expired, was already used or started elsewhere. Start again at /review.', { cookies: clear });
    if (url.searchParams.has('error')) return message(403, 'Sign-in cancelled', 'GitHub did not confirm sign-in.', { cookies: clear });
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 512) return message(400, 'Invalid sign-in', 'Missing GitHub code.', { cookies: clear });
    const id = await githubIdentity(config, code, claimed.verifier, githubFetcher);
    if (!reviewerPrincipal(config, id)) return message(403, 'Account not authorized', 'This GitHub account cannot review this memory.', { cookies: clear });
    const session = token();
    await db.prepare('INSERT INTO memory_review_sessions(token_sha256,github_id,created_at_ms,expires_at_ms) VALUES(?,?,?,?)')
      .bind(await hash(session), id, now, now + SESSION_TTL_MS).run();
    // Strict session cookie: the follow-up link is a same-site navigation, so it is sent there and never cross-site.
    return page(signedInPage(next), 200, { cookies: [...clear, setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000, 'Strict')] });
  }

  async function approve(request, now) {
    const { rejected, values } = await form(request, ['csrf', 'collection', 'proposal_id', 'expected_digest']);
    if (rejected) return rejected;
    const session = await currentSession(request, now);
    if (!session) return message(401, 'Session expired', 'Sign in again: no approval recorded.');
    if (!same(values.csrf, session.csrf)) return message(403, 'Invalid form', 'The form does not belong to this session. No approval recorded.');
    try {
      authorize(session.principal, values.collection, 'memory:approve'); identifier(values.proposal_id);
      const [row] = await proposals(session.principal, now, values.proposal_id);
      if (!row || row.collection_id !== values.collection) {
        // A second click on an already saved proposal is not an error.
        const saved = await db.prepare("SELECT 1 FROM memory_proposals WHERE id=? AND owner_id=? AND collection_id=? AND status='consumed'").bind(values.proposal_id, config.userId, values.collection).first();
        return saved ? redirect('/review') : message(...ERRORS.PROPOSAL_UNAVAILABLE);
      }
      // The commit guard enforces versions again; refusing here avoids approving a write that can only conflict.
      if (row.status === 'pending' && row.blocked) return message(409, 'Version changed', `Not approved: ${row.blocked}`);
      if (!/^[0-9a-f]{64}$/.test(values.expected_digest)) return message(400, 'Invalid form', 'No approval recorded.');
      if (row.digest !== values.expected_digest) return message(...ERRORS.APPROVAL_MISMATCH);
      // Approving writes: the proposer does not need to come back.
      const result = await approveAndWrite(db, session.principal, { collection: values.collection, items: [{ proposal_id: values.proposal_id, expected_digest: values.expected_digest }] });
      await cleanupExpiredProposals(db, config.userId, now);
      if (result.skipped.length) return message(...ERRORS.PROPOSAL_UNAVAILABLE);
      return redirect(`/review?done=${result.written.length}`);
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      return message(...(ERRORS[error.code] ?? [400, 'Invalid request', 'No approval recorded.']));
    }
  }

  /** Same-origin form + live session + its CSRF token, for every owner action other than approval. */
  async function ownerForm(request, now, fields, multi) {
    const { rejected, values } = await form(request, ['csrf', ...fields], multi);
    if (rejected) return { rejected };
    const session = await currentSession(request, now);
    if (!session) return { rejected: message(401, 'Session expired', 'Sign in again: no change recorded.') };
    if (!same(values.csrf, session.csrf)) return { rejected: message(403, 'Invalid form', 'The form does not belong to this session. No change recorded.') };
    return { values, session };
  }
  const failed = (error, fallback) => {
    if (!(error instanceof MemoryError)) throw error;
    if (error.code === 'FORBIDDEN') return message(...ERRORS.FORBIDDEN);
    return message(...(fallback[error.code] ?? [400, 'Invalid request', 'No change recorded.']));
  };

  /** The items must be exactly proposals still shown as approvable; anything else is skipped, never approved. */
  async function approveAllShown(request, now) {
    const { rejected, values, session } = await ownerForm(request, now, ['collection'], ['item']);
    if (rejected) return rejected;
    try {
      authorize(session.principal, values.collection, 'memory:approve');
      const items = values.item.map(item => { const [proposal_id, expected_digest, extra] = item.split(':'); return extra === undefined ? { proposal_id, expected_digest } : null; });
      if (items.some(i => !i)) return message(400, 'Invalid form', 'No approval recorded.');
      const shown = new Map((await proposals(session.principal, now)).map(r => [r.id, r]));
      const valid = items.filter(i => { const r = shown.get(i.proposal_id); return r && r.status === 'pending' && !r.blocked && r.collection_id === values.collection && r.digest === i.expected_digest; });
      const result = valid.length ? await approveAndWrite(db, session.principal, { collection: values.collection, items: valid }) : { written: [] };
      await cleanupExpiredProposals(db, config.userId, now);
      return redirect(`/review?done=${result.written.length}`);
    } catch (error) { return failed(error, { INVALID_DIGEST: [400, 'Invalid form', 'No approval recorded.'] }); }
  }

  async function discard(request, now) {
    const { rejected, values, session } = await ownerForm(request, now, ['collection', 'proposal_id']);
    if (rejected) return rejected;
    try { await discardProposal(db, session.principal, { collection: values.collection, proposal_id: values.proposal_id }); return redirect('/review'); }
    catch (error) { return failed(error, { PROPOSAL_UNAVAILABLE: [409, 'Proposal unavailable', 'The proposal was already written or no longer exists.'] }); }
  }

  /** Step one only shows what will be destroyed; nothing is written until the separate confirmation. */
  async function purge(request, now, confirmed) {
    const { rejected, values, session } = await ownerForm(request, now, confirmed ? ['collection', 'fact_id', 'confirm'] : ['collection', 'fact_id']);
    if (rejected) return rejected;
    try {
      authorize(session.principal, values.collection, 'memory:purge'); identifier(values.fact_id);
      if (!confirmed) {
        const fact = (await storedFacts(session.principal)).find(f => f.collection_id === values.collection && f.id === values.fact_id);
        if (!fact) return message(404, 'Fact not found', 'No fact to delete with this ID.');
        return page(purgePage({ fact, csrf: session.csrf }));
      }
      if (values.confirm !== 'permanent') return message(400, 'Missing confirmation', 'No change recorded.');
      await purgeFact(db, session.principal, { collection: values.collection, fact_id: values.fact_id }, now);
      return redirect('/review');
    } catch (error) { return failed(error, { NOT_FOUND: [404, 'Fact not found', 'No fact to delete with this ID.'] }); }
  }

  /** A download of one collection. GET, read-only, owner session required. */
  async function download(request, url, now) {
    if (request.method !== 'GET') return message(405, 'Method not allowed', 'Use the link on the review page.');
    const session = await currentSession(request, now);
    if (!session) return message(401, 'Session expired', 'Sign in again to export.');
    if (url.searchParams.getAll('collection').length !== 1 || [...url.searchParams.keys()].some(k => k !== 'collection')) return message(400, 'Invalid request', 'Specify exactly one collection.');
    try {
      const data = await exportCollection(db, session.principal, { collection: url.searchParams.get('collection') }, now);
      const h = secure(); h.set('content-type', 'application/json; charset=utf-8');
      h.set('content-disposition', `attachment; filename="memory-${data.collection}-${data.exported_at_utc.slice(0, 10)}.json"`);
      return new Response(JSON.stringify(data, null, 2), { headers: h });
    } catch (error) { return failed(error, {}); }
  }

  /** Stored facts, including logically deleted ones whose text is still in history; purged ones are gone. */
  async function storedFacts(principal) {
    const marks = principal.collections.map(() => '?').join(',');
    return (await db.prepare(`SELECT f.collection_id, f.id, f.version, f.deleted,
      (SELECT v.payload_json FROM memory_versions v WHERE v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.operation='put' ORDER BY v.version DESC LIMIT 1) AS last_put,
      (SELECT COUNT(*) FROM memory_versions v WHERE v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id) AS versions
      FROM memory_facts f WHERE f.owner_id=? AND f.collection_id IN (${marks})
      AND NOT EXISTS (SELECT 1 FROM memory_purges p WHERE p.owner_id=f.owner_id AND p.collection_id=f.collection_id AND p.fact_id=f.id)
      ORDER BY f.collection_id, f.deleted, f.id LIMIT 401`).bind(principal.owner_id, ...principal.collections).all()).results ?? [];
  }

  async function logout(request, now) {
    const { rejected, values } = await form(request, ['csrf']);
    if (rejected) return rejected;
    const session = await currentSession(request, now);
    if (session && same(values.csrf, session.csrf)) {
      await db.prepare('UPDATE memory_review_sessions SET revoked_at_ms=? WHERE token_sha256=? AND revoked_at_ms IS NULL').bind(now, session.tokenHash).run();
    } else if (session) return message(403, 'Invalid form', 'The form does not belong to this session.');
    return redirect('/review', [setCookie(SESSION_COOKIE, '', 0, 'Strict')]);
  }

  async function show(request, now) {
    if (request.method !== 'GET') return message(405, 'Method not allowed', 'Use GET.');
    const session = await currentSession(request, now);
    // GET never writes: login state is created only by the POST that follows.
    const url = new URL(request.url), focus = UUID.test(url.searchParams.get('p') ?? '') ? url.searchParams.get('p') : null;
    if (!session) return page(loginPage(focus), 200, { csp: LOGIN_CSP });
    const done = /^\d{1,2}$/.test(url.searchParams.get('done') ?? '') ? Number(url.searchParams.get('done')) : null;
    if (focus) {
      const rows = await proposals(session.principal, now, focus);
      const saved = !rows.length && await db.prepare("SELECT 1 FROM memory_proposals WHERE id=? AND owner_id=? AND status='consumed'").bind(focus, config.userId).first();
      return page(reviewPage({ rows, more: false, csrf: session.csrf, collections: config.collections, facts: [], batchLimit: MAX_BATCH_APPROVALS, focus: { saved: Boolean(saved) } }));
    }
    const rows = await proposals(session.principal, now), facts = await storedFacts(session.principal);
    return page(reviewPage({ rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE, csrf: session.csrf, collections: config.collections, facts, batchLimit: MAX_BATCH_APPROVALS, done }));
  }

  return {
    config,
    handles: pathname => pathname === '/review' || pathname.startsWith('/review/'),
    async fetch(request) {
      const url = new URL(request.url), now = clock();
      if (url.origin !== config.origin) return message(400, 'Unexpected host', 'Invalid request.');
      if (request.url.length > 4096) return message(414, 'Request too long', 'Invalid request.');
      try {
        switch (url.pathname) {
          case '/review': return await show(request, now);
          case '/review/login': return await startLogin(request, now);
          case '/review/github/callback': return await finishLogin(request, url, now);
          case '/review/approve': return await approve(request, now);
          case '/review/approve-all': return await approveAllShown(request, now);
          case '/review/discard': return await discard(request, now);
          case '/review/purge': return await purge(request, now, false);
          case '/review/purge/confirm': return await purge(request, now, true);
          case '/review/export': return await download(request, url, now);
          case '/review/logout': return await logout(request, now);
          default: return message(404, 'Page not found', 'Unknown address.');
        }
      } catch (error) {
        if (error instanceof GithubError) return error.code === 'github_unavailable'
          ? message(503, 'GitHub unavailable', 'Try again shortly: no session created.')
          : message(403, 'Identity not verified', 'GitHub did not confirm a valid identity.');
        return message(503, 'Service unavailable', 'Review is temporarily unavailable. No approval recorded.');
      }
    }
  };
}
