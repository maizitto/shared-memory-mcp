# ChatGPT functional rehearsal — 9 November 2026

**Tested with OpenCode and ChatGPT. Claude testing is planned.**

The owner completed this 20-check functional rehearsal through ChatGPT's custom
MCP plugin, using the isolated 0.3.0 service and fictional data. All six tools
were exercised: `get_fact`, `list_facts`, `search_facts`, `propose_fact`,
`put_fact` and `delete_fact`.

## Observed results

| Check | Observed result |
| --- | --- |
| Read | Approved Atlas fact read with version and source. |
| List | Approved facts listed without pending proposal contents. |
| Lexical search | Atlas and the newly saved Helios fact retrieved from D1. |
| Hybrid fallback | Hybrid search explicitly reported lexical fallback with SEMANTIC_UNAVAILABLE. |
| Collection boundary | An ungranted collection returned FORBIDDEN. |
| Read-only boundary | A read-only proposal attempt returned FORBIDDEN; no proposal was created. |
| Write consent | New consent explicitly granted memory:read and memory:write for shared. |
| Proposal retries | Identical request keys and payloads returned the same proposal ID and digest. |
| Pending visibility | The pending fact returned NOT_FOUND through ordinary reads. |
| Save approval | put_fact before owner approval returned APPROVAL_REQUIRED. |
| Owner approval and save | Browser approval saved Helios v1; ChatGPT confirmed the receipt and content. |
| Receipt replay | Repeated put_fact calls replayed one receipt without creating another version. |
| Correction | The Monday correction was saved as v2. |
| History | An explicit v1 read returned the original content while v2 was current. |
| Stale approved write | The separately approved Tuesday alternative returned VERSION_CONFLICT. |
| Delete approval | delete_fact before its separate approval returned APPROVAL_REQUIRED. |
| Delete confirmation | Approved logical deletion became v3; repeated confirmations replayed one receipt. |
| Deleted content visibility | Current/history reads returned NOT_FOUND; list and search excluded Helios. |
| Native refresh | Same connection refreshed after the original access lifetime without another login. |
| Post-revocation app access | After operator revocation, the owner observed and declined a new Rehars sign-in prompt. |

## Approval, versions and search

The neutral test ID was `chatgpt.full.20261109` in `shared`. The owner first
approved “For the fictional Helios project, weekly updates use two bullet
points.” Two alternatives then started from v1: delivery every Monday and
every Tuesday. The owner approved both through the browser batch action.
Monday became v2; the Tuesday proposal remained approved without a receipt,
and ChatGPT's confirmation attempt returned `VERSION_CONFLICT`.

A separate owner approval logically deleted Helios as v3. Server records show
exactly three versions and three receipts for this ID. The original Atlas and
Aurora fixtures stayed visible. Approving in the browser performs the write,
so the following `put_fact` and `delete_fact` confirmations correctly reported
`replayed: true` from their first invocation.

Semantic search was deliberately disabled and the indexing cron stayed off.
Lexical queries retrieved current canonical content while indexing was pending;
hybrid queries explicitly reported lexical fallback. After deletion, both
queries excluded Helios, and its ordinary current/history reads returned
`NOT_FOUND`. The canonical audit versions remained in D1.

## Native refresh

The writer's initial token-exchange timestamp was `2026-11-09T10:17:35.186Z`.
After fresh ChatGPT reads without login or reconnection, the same connection's
exchange timestamp was `2026-11-09T11:21:05.608Z`, more than an hour
later. Its connection ID and provider-grant fingerprint stayed unchanged.
The operator performed no token exchange or timestamp mutation before that
check. In the deployed adapter, a new authorization creates a new connection,
and repeated authorization-code exchanges are refused; a later successful
exchange on this connection therefore identifies native refresh.

## Revocation and cleanup

The operator revoked both ChatGPT test grants while the public route remained
reachable. The owner observed a new sign-in prompt specifically for Rehars
and declined it. That connector reauthorization gate is the recorded app outcome.
An earlier attempted tool call encountered an expired ChatGPT Code Mode
continuation; that infrastructure message is recorded separately from the
server and connector observations.

Afterwards the public route was disabled and cron remained empty. Server
checks confirmed zero active bearer clients, OAuth connections, owner-review
sessions and running indexing jobs. The fictional database was retained:
three heads (two visible, one logically deleted), six versions and six receipts
across the baseline and this rehearsal. Four indexing jobs remain pending with
semantic search disabled.

## Evidence sources

The owner operated ChatGPT and browser approval and supplied the app results.
Separate server inspections checked client identity
`https://chatgpt.com/oauth/client.json`, collection/scopes, approvals, version
payloads, receipts, token-exchange timestamps and cleanup. The final sign-in
prompt is an owner-observed interface result. The record contains fictional
content and non-secret metadata. The broader SDK and OpenCode observations
are in [verification](verification.md).
