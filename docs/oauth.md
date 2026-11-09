# OAuth for remote MCP clients

OAuth is optional. The MCP endpoint stays `/memory/mcp`; registered `pmm_`
bearer clients continue to use their existing D1 grants independently of OAuth.
Enable OAuth to connect applications that discover an authorization server and
obtain their own access tokens. This is a personal instance with one owner,
not an identity service for multiple users.

## Flow and permissions

1. The client receives a `401` challenge with protected-resource metadata. The
   metadata identifies the exact MCP resource and this instance's issuer.
2. The client uses a published HTTPS Client ID Metadata Document (CIMD), or
   registers through Dynamic Client Registration (DCR).
3. The owner sees the client identity, redirect destination, requested operations
   and available collections. Read is the default; collections and optional write access must be explicitly
   selected. Existing grants retain their approved permissions until revoked.
4. GitHub sign-in verifies the configured numeric owner ID. No repository scope
   is requested. Another GitHub account cannot complete the connection.
5. The client exchanges a resource-bound code using PKCE S256 and receives an
   access token and a rotating refresh token.
6. Every authenticated request also checks the live connection in D1: owner,
   client, resource, scopes, expiry, status and current collection allowlist.

`memory:read` is required. `memory:write` allows proposals and confirmation of
already approved changes. Neither grants owner review, approval, purge or export.
A new fact still needs the separate owner-review page. Connecting an app does
not approve all its future writes.

CIMD identifies a published client domain and validates its listed redirects.
A public client using `none` does not prove possession of a client secret.
DCR names are self-declared and explicitly labelled as unverified on consent.
The provider supports CIMD `private_key_jwt` with public JWKS verification as
well as `none`. An invalid signed assertion cannot fall back to anonymous
client authentication. Redirects are validated by the provider, including the
RFC 8252 port exception for declared HTTP loopback callbacks.

## Enable on your instance

First follow [deployment](deployment.md). Use a dedicated KV namespace for the
provider; its encrypted grant material, codes, client registrations and replay
markers are auth state, separate from the memory ledger.

```sh
npx --no-install wrangler kv namespace create OAUTH_KV --config config/worker.local.json
```

Copy the returned namespace ID into your ignored operator configuration:

```json
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "YOUR_NAMESPACE_ID" }]
```

Keep `compatibility_flags: ["global_fetch_strictly_public"]` from the template.
The provider requires it to fetch HTTPS client metadata and public keys while
blocking private-network destinations. Do not replace it with unrestricted fetch.

Apply the top-level D1 migrations explicitly. New installations apply both
`0001_bootstrap.sql` and `0002_oauth.sql`; an existing instance of this extraction
with 0001 recorded applies only the new additive migration. Inspect Wrangler's
pending migrations before accepting. The old private source deployment has no
automatic upgrade path.

```sh
npx --no-install wrangler d1 migrations apply YOUR_DATABASE --remote --config config/worker.local.json
```

In the GitHub OAuth App, register **both exact callbacks** for the same origin:

- `https://YOUR_HOST/review/github/callback` — owner review.
- `https://YOUR_HOST/oauth/github/callback` — authorizing an MCP client.

Keep wildcard matching disabled. Do not paste the MCP client's own callback
into the GitHub App: that callback is validated separately by the MCP OAuth
provider. The GitHub client secret remains a Worker secret and is never supplied
to Claude, ChatGPT or OpenCode. See [GitHub's authorization guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

Set the following variables and deploy the reviewed configuration:

```json
"MEMORY_OAUTH_ENABLED": "true",
"MEMORY_OAUTH_COLLECTIONS": "shared"
```

The OAuth collection allowlist must contain one to eight unique collections,
all included in `MEMORY_REVIEW_COLLECTIONS`. The consent page permits only this
set. Removing a collection from the allowlist removes it from existing OAuth
connections too. OAuth requires neither Vectorize, Workers AI nor a cron.

## Discovery and lifetime

| Item | Value |
| --- | --- |
| Resource | `https://YOUR_HOST/memory/mcp` |
| Resource metadata | `/.well-known/oauth-protected-resource/memory/mcp`, with a root alias |
| Authorization metadata | `/.well-known/oauth-authorization-server` |
| Authorization / consent | `/authorize` |
| Token, refresh and RFC 7009 revocation | `/oauth/token` |
| Dynamic registration fallback | `/oauth/register` |
| Access token | 1 hour |
| Connection and refresh ceiling | 30 days from connection creation; refreshing does not extend the D1 ceiling |
| DCR client registration | 30 days; register again if it expires |

The provider returns the issuer in authorization responses (RFC 9207), advertises
PKCE S256 and binds tokens to the exact resource. Only authorization code and
refresh grants are enabled. There are no password or client-credentials grants.
Token cryptography and protocol parsing use the pinned
[Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider).
This project adds the one-owner policy, collection selection and D1 authority.

## Inspect and revoke

Use the operator CLI with an explicit target. It prints connection metadata,
never access tokens, refresh tokens or provider grant material:

```sh
npm run connection -- list --config config/worker.local.json --database YOUR_DATABASE --remote
npm run connection -- revoke CONNECTION_UUID --config config/worker.local.json --database YOUR_DATABASE --remote
```

D1 revocation denies subsequent access and refresh requests, including tokens
that remain cryptographically valid. It cannot cancel a request already in
progress. Client logout may invoke the provider's standard revocation endpoint;
its KV state is eventually consistent across locations. Use the operator D1
command when you need the connection-wide check on subsequent requests.

For a local rehearsal replace `--remote` with
`--local --persist-to /tmp/memory-oauth-rehearsal`. These commands are not MCP
tools and require the operator's Cloudflare access.

## Resource bounds and recovery

The existing per-location rate-limit bindings are required and fail closed when
unavailable. Additional D1 counters cap this small instance at 20 consent pages,
30 DCR requests and 240 token/revocation POSTs per UTC day. Failed attempts also
consume these budgets. They bound those paths, not all Worker requests or billing;
public abuse can exhaust them and temporarily prevent new connections or refresh.
Provider KV and metadata fetches add usage to the basic D1 deployment.

Replay claims for consent, GitHub state and authorization codes also use D1.
The provider manages refresh rotation and signed-assertion replay markers in KV;
do not describe all OAuth replay protection as globally transactional. Expired
D1 replay claims are removed when a new consent flow starts. Connection metadata
is retained for the operator; collection purge does not erase auth history.

[Offline recovery](recovery.md) exports a collection, not OAuth state or KV.
After a lost auth store, revoke old D1 connections and create new connections;
do not assume a restored collection restores client access. See
[security](../SECURITY.md) and [verification](verification.md) for evidence and
remaining limits.

The authorization design follows the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
The MCP message transport still negotiates the 2025 versions documented in
[clients](clients.md); this OAuth work does not implement every 2026 MCP feature.
