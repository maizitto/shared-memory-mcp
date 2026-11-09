# Installing on your Cloudflare account

This guide describes operator actions for a **new isolated installation**. The
memory core passed a bounded fresh-cloud rehearsal; see [verification](verification.md).
The rehearsal used new resources in the existing owner's account, not a newly
created Cloudflare account or an independent reader following the guide. Those
setup paths, production capacity and cost qualification remain unverified. The
development machine's existing service is not a deployment target. Use fictional text for the first rehearsal.

## 1. Verify locally

Use Node 22.22.x, run the README commands, and inspect the disabled template.
The bootstrap schema is for a new empty database; do not apply it to an existing
personal deployment. There is no automatic upgrade path from the private source deployment.
Version 0.2.0 adds `0002_oauth.sql` to this public package's bootstrap sequence.
Use only the top-level `migrations/` directory for this installation. The SQL
snapshots under `src/memory/migrations/` preserve earlier contract tests and are
not an additional deployment sequence.

## 2. Prepare your own configuration

Copy `config/wrangler.example.json` to `config/worker.local.json` (ignored by Git).
Log into your own Cloudflare account with Wrangler, create a new D1 database and
put its ID/name in the local configuration. Choose the instance's HTTPS hostname
and set `MEMORY_PUBLIC_ORIGIN` to its exact origin.
Leave `MEMORY_ENABLED=false` during preparation. Choose unused positive-integer
rate-limit namespace IDs in your account; sharing IDs shares counters.

The template disables workers.dev and preview URLs. For a personal trial, opt
into `workers_dev: true` in your local configuration and use your account's
Workers hostname. Alternatively configure your own domain and its route.
The placeholder example.invalid is not a working service address. A purchased
domain is optional. See [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
[Worker configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

For example, the following command changes **your selected remote database**:

```sh
npx --no-install wrangler d1 migrations apply YOUR_DATABASE --remote --config config/worker.local.json
```

For a local schema rehearsal use `--local --persist-to /tmp/memory-rehearsal`
instead of `--remote`. The fresh-schema unit test and real D1 contract tests
exercise schema creation separately from cloud account provisioning.

After replacing placeholders, run an offline preflight:

```sh
npm run doctor -- --config config/worker.local.json
```

It checks owner/origin/collections, rate-limit bindings, placeholders and the
extra bindings needed for OAuth/semantic search. It prints the exact GitHub
callbacks to register and never loads a secret store or contacts your account.
A passing result does not verify resource existence, account plan, Worker secrets
or an actual login. The committed placeholder template intentionally fails it.

## 3. Configure owner review

Create a GitHub OAuth App for your own installation. Its callback is exactly
`https://YOUR_HOST/review/github/callback`. Set your public client ID and numeric
GitHub owner ID in the local configuration. Store the client secret through the
interactive secret command, never in a file or a command argument:

```sh
npx --no-install wrangler secret put GITHUB_CLIENT_SECRET --config config/worker.local.json
```

The app asks for no repository scope. This login proves the owner's identity for
review. Optional MCP client OAuth additionally uses the exact
`https://YOUR_HOST/oauth/github/callback` callback; follow [OAuth setup](oauth.md)
before enabling it. Existing GitHub permissions
or account policy may affect the login and should be checked in the rehearsal.

## 4. Choose client authentication

For Claude, ChatGPT or OpenCode OAuth, follow [OAuth setup](oauth.md), then return
to the enable/rehearse step below. It adds a dedicated KV namespace and the
second exact GitHub callback. Registered bearer tokens remain an independent
option for clients accepting fixed credentials.

### Register a bearer client and grant a collection

The operator tool stores a new token in a private directory outside this
repository; the database receives its hash. Importing the tool does nothing.
It requires an explicit `--local` or `--remote` target.

```sh
npm run client -- create assistant-a memory:read memory:write --config config/worker.local.json --database YOUR_DATABASE --remote
npm run client -- grant assistant-a shared memory:read memory:write --config config/worker.local.json --database YOUR_DATABASE --remote
```

`YOUR_DATABASE` must be the actual lowercase D1 database name. Token files default
to `~/.local/state/shared-memory-mcp/tokens/`; set `MEMORY_REVIEW_TOKEN_DIR` to an
explicit private directory if needed. Do not put it under the checkout. A newly
created client has no collection access until granted. Each grant is capped by
the scopes given at creation. Restrict `MEMORY_REVIEW_COLLECTIONS` to the intended
collection names; there are at most eight configured collections.

Bearer tokens expire 30 days after issuance. Use `list` (no label) with the same
target options to inspect metadata and expiry without token values. To renew,
create a new client label, grant only its needed collections, update that client
and revoke the old label. Expired tokens cannot be reactivated by adding grants.

To revoke, use the same options with `revoke assistant-a`. To remove just one
collection grant use `ungrant assistant-a shared`. Token files are retained for
the operator to remove; revocation in D1 is what denies subsequent requests.

## 5. Enable and rehearse

Set `MEMORY_ENABLED=true`, keep `AUTH_GUARDS_REQUIRED=true`, and deploy only after
reviewing the local config, bindings and budget. This command publishes to your
account and is intentionally absent from package scripts and CI:

```sh
npx --no-install wrangler deploy --config config/worker.local.json
```

Verify: anonymous MCP denied, wrong token denied, owner GitHub sign-in succeeds,
writer proposes fictional content, the owner approves it, a second client reads
the correct version, read-only clients cannot propose, and revocation takes effect.
The local tests use a GitHub substitute; they do not replace this real-browser test.

## Optional semantic search

Canonical text and versions stay in D1. Workers AI computes embeddings;
Vectorize stores the vectors in a derived index. The Worker verifies returned
candidates against current D1 state before exposing their canonical content.

Lexical search needs no AI binding or cron. Semantic/hybrid search requires:

- `AI` Workers AI binding and a **dedicated** `MEMORY_VECTORS` index, 1024 dimensions,
  cosine metric, with metadata indexes `kind`, `owner_id`, `collection_id`,
  `embedding_version`.
- `MEMORY_SEARCH_ENABLED=true`, `MEMORY_SEARCH_COLLECTIONS=shared` and an explicit
  `MEMORY_MIN_SIMILARITY` between 0 and 1. The previous small fictional BGE-M3
  experiment used 0.45; this is not a threshold calibrated for your documents.
- An explicitly configured scheduled trigger, for example once per minute.
  The handler processes one scoped job per invocation. Queries never run indexing.

With semantic indexing disabled, normal facts and lexical search remain usable;
index jobs can remain pending. Semantic-only search fails explicitly, and hybrid
reports a lexical fallback. Enabling AI/indexing is a separate account-cost and
data-processing choice. Neither the template nor npm scripts enables it silently.

See [Vectorize metadata indexes](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
and [BGE-M3](https://developers.cloudflare.com/workers-ai/models/bge-m3/).

## Operations and limits

Workers, D1, Vectorize and inference have separate quotas and costs. No zero-cost
or Free-plan capacity guarantee is made. [Rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
are approximate per location, not a global usage or billing ceiling.

Keep raw memory text and auth headers out of logs. Record deployed source and
configuration versions, establish backup ownership and rehearse recovery before
depending on the service. Schema changes need compatible migrations; reverting
Worker code does not remove tables, cron triggers or derived jobs.

## Upgrading 0.2.x to 0.3.0

No schema migration is added. The server now enforces a 30-day age limit on
registered bearer tokens using their existing issuance timestamp. Reissue tokens
older than that before depending on the new Worker. Review sessions, including
old rows with a later expiry, are capped at 12 hours from login; sign in again
when needed. New OAuth consent defaults to read-only and explicit collections.
Existing approved OAuth grants remain valid within their existing ceiling.

Prepare an [encrypted D1 snapshot](backup.md) before deployment and test recovery
on an isolated target. A code rollback changes credential policy; do not treat
it as a way to extend expired credentials. No schedule or paid resource is
created by installing this version.
