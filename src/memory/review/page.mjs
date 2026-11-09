/** Owner review pages. Every value from proposals, facts or clients is escaped; no scripts or styles. */
import { escapeHtml as esc } from '../../platform/html.mjs';

const time = ms => new Date(ms).toISOString();
/** The only style, allowed by its hash in the CSP (see STYLE_HASH); long document lines wrap instead of scrolling. */
export const STYLE = 'body{font-family:system-ui,sans-serif;max-width:64rem;margin:0 auto;padding:0 1rem;line-height:1.4}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:.5rem}article{border-top:1px solid #ccc;padding:.5rem 0}';
export const STYLE_HASH = 'sha256-OItJIioUE09Ifm62uMrYkiBMpmwZ8bhjEXWdCgK12Hg=';
const doc = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style><main>${body}</main></html>`;
const hidden = values => Object.entries(values).map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`).join('');

export const loginPage = (focus = null) => doc('Memory review', `<h1>Shared memory review</h1>
<p>Only the owner of this instance can view and approve write proposals. Sign in with the owner account on GitHub.</p>
<form method="post" action="/review/login">${focus ? hidden({ p: focus }) : ''}<button>Sign in with GitHub</button></form>
<p>GitHub only verifies identity: no permissions to repositories or GitHub data are requested.</p>`);

export const signedInPage = (next = null) => doc('Sign-in verified', `<h1>Sign-in verified</h1>
<p>This browser stays authorized for 12 hours; signing out ends the session immediately.</p>
<p><a href="${next ? `/review?p=${esc(next)}` : '/review'}">${next ? 'Open the proposal' : 'Open proposals'}</a></p>`);

export const messagePage = (title, text) => doc(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/review">Back to review</a></p>`);

function versionLine(row) {
  const current = row.head_version === null ? 'none' : `v${row.head_version}${row.head_deleted ? ' (deleted)' : ''}`;
  return `from v${row.expected_version} to v${row.expected_version + 1}; current: ${current}`;
}
function card(row, csrf) {
  const command = JSON.parse(row.payload_json), put = row.operation === 'put';
  const kind = put ? (row.expected_version === 0 ? 'new fact' : 'update') : 'logical deletion';
  const head = row.head_payload && !row.head_deleted ? JSON.parse(row.head_payload) : null;
  const details = [['Collection', row.collection_id], ['Fact ID', row.fact_id], ['Version', versionLine(row)], ['Proposed by', row.creator],
    ['Created', time(row.created_at_ms)], ['Proposal expires', time(row.expires_at_ms)],
    ...(put ? [['Source', command.source], ['Observed at', command.observed_at], ['Valid from', command.valid_from], ['Valid until', command.expires_at ?? 'no expiry']] : [])];
  const reject = `<form method="post" action="/review/discard">${hidden({ csrf, collection: row.collection_id, proposal_id: row.id })}
<button>Reject and delete proposal</button></form>`;
  let decision;
  if (row.status === 'approved') {
    decision = row.approval_live
      ? `<p><strong>Approved but not yet saved</strong> (the fact changed in the meantime, or another proposal targeted the same fact). The client can still write it until ${esc(time(row.approval_expires_at_ms))}, if the version allows it; otherwise reject it.</p>`
      : '<p><strong>Approval expired.</strong> It will not be written; the client must submit a new proposal.</p>';
    decision += reject;
  } else if (row.blocked) {
    decision = `<p><strong>Cannot approve:</strong> ${esc(row.blocked)}</p>${reject}`;
  } else {
    decision = `<form method="post" action="/review/approve">${hidden({ csrf, collection: row.collection_id, proposal_id: row.id, expected_digest: row.digest })}
<button>Approve and save</button></form>${reject}
<p>Approving immediately saves this exact content. Rejecting immediately deletes the proposal text. Without a decision, the proposal expires and is deleted.</p>`;
  }
  return `<article id="p-${esc(row.id)}"><h3>${esc(row.collection_id)} / ${esc(row.fact_id)}: ${esc(kind)}</h3><dl>${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
${put ? `<h4>Proposed content</h4><pre>${esc(command.content)}</pre>` : ''}
${head ? `<h4>${put ? 'Current content' : 'Content to be hidden'} (v${esc(row.head_version)})</h4><pre>${esc(head.content)}</pre>` : ''}
<details><summary>Exact command and digest</summary><pre>${esc(JSON.stringify(command, null, 2))}</pre>
<p>SHA-256 of the command bound to the owner: <code>${esc(row.digest)}</code></p></details>${decision}</article>`;
}

function storedFact(fact, csrf) {
  const content = fact.last_put ? JSON.parse(fact.last_put).content : null;
  const state = fact.deleted ? `deleted (v${fact.version}): excluded from reads and searches; text remains in history` : `current v${fact.version}`;
  return `<article><h3>${esc(fact.collection_id)} / ${esc(fact.id)}</h3><p>${esc(state)}; saved versions: ${esc(fact.versions)}.</p>
${content === null ? '' : `<pre>${esc(content)}</pre>`}
<form method="post" action="/review/purge">${hidden({ csrf, collection: fact.collection_id, fact_id: fact.id })}<button>Permanently delete…</button></form></article>`;
}

export function purgePage({ fact, csrf }) {
  const content = fact.last_put ? JSON.parse(fact.last_put).content : null;
  return doc('Permanent deletion', `<h1>Permanently delete ${esc(fact.collection_id)} / ${esc(fact.id)}?</h1>
${content === null ? '' : `<pre>${esc(content)}</pre>`}
<p>Text from all ${esc(fact.versions)} versions, related proposals and search indexes will be deleted. Only a minimal record remains: fact ID, last version, actor and time. The ID cannot be reused.</p>
<p><strong>This cannot be undone.</strong> Cloudflare retains database recovery copies for up to 7 days; until then, text remains recoverable through those copies. Export the collection first if you want a copy.</p>
<form method="post" action="/review/purge/confirm">${hidden({ csrf, collection: fact.collection_id, fact_id: fact.id, confirm: 'permanent' })}
<button>Yes, permanently delete</button></form><p><a href="/review">Cancel</a></p>`);
}

/** One form per collection: the approvable pending proposals shown above, each bound to its digest. */
function approveAll(pending, csrf, limit) {
  const byCollection = new Map();
  for (const row of pending.filter(r => !r.blocked)) byCollection.set(row.collection_id, [...(byCollection.get(row.collection_id) ?? []), row]);
  return [...byCollection].filter(([, list]) => list.length > 1).map(([collection, list]) => {
    const items = list.slice(0, limit);
    return `<form method="post" action="/review/approve-all">${hidden({ csrf, collection })}${items.map(r => `<input type="hidden" name="item" value="${esc(`${r.id}:${r.digest}`)}">`).join('')}
<button>Approve and save all ${items.length} pending proposals for ${esc(collection)} shown above</button></form>`;
  }).join('');
}

export function reviewPage({ rows, more, csrf, collections, facts = [], batchLimit = 25, done = null, focus = null }) {
  const pending = rows.filter(r => r.status === 'pending'), approved = rows.filter(r => r.status === 'approved');
  if (focus) {
    const body = rows.length ? rows.map(r => card(r, csrf)).join('')
      : `<p>${focus.saved ? 'This proposal has already been saved.' : 'This proposal is no longer available: it was rejected or expired.'}</p>`;
    return doc('Proposal', `<h1>Proposal</h1>${body}<p><a href="/review">All proposals and stored memory</a></p>`);
  }
  const section = (title, list, empty) => `<h2>${esc(title)} (${list.length})</h2>${list.length ? list.map(r => card(r, csrf)).join('') : `<p>${esc(empty)}</p>`}`;
  return doc('Proposals to review', `<h1>Proposals to review</h1>
<p>Collections: ${esc(collections.join(', '))}. You approve an exact command: a client change requires new approval.</p>
${done === null ? '' : `<p><strong>${done === 1 ? 'Saved 1 fact.' : `Saved ${esc(done)} facts.`}</strong></p>`}
<form method="post" action="/review/logout">${hidden({ csrf })}<button>Sign out</button></form>
${section('Pending', pending, 'No pending proposals.')}
${approveAll(pending, csrf, batchLimit)}
${approved.length ? section('Approved but not saved', approved, '') : ''}
${more ? '<p>Only the oldest proposals are shown; the others will appear later.</p>' : ''}
<h2>Stored memory (${facts.length})</h2>
<p>${collections.map(c => `<a href="/review/export?collection=${encodeURIComponent(c)}">Export ${esc(c)} (JSON)</a>`).join(' · ')}</p>
${facts.length ? facts.map(f => storedFact(f, csrf)).join('') : '<p>No stored facts.</p>'}`);
}
