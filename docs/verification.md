# Verification — 9 November 2026

## Current client status

**Tested with OpenCode and ChatGPT. Claude testing is planned.**

On 9 November, the owner completed a 20-check fictional-data functional
rehearsal in ChatGPT. It exercised all six tools, read-only and collection
permissions, explicit write consent, owner approval, retries, correction,
history, stale-write rejection, logical deletion, native refresh and the
post-revocation reauthorization gate. App results were supplied by the owner;
server inspections checked grants, approvals, versions and receipts. See
[the ChatGPT record](chatgpt-rehearsal.md) for the observation methods and results.

| Target | Status | Recorded evidence |
| --- | --- | --- |
| Official MCP SDK | Tested | Real-owner cloud grant, read/propose/approval/confirm, scope restriction, refresh and revocation |
| OpenCode 1.18.30 | Tested | Native CIMD login and refresh; SDK tool readback under that grant; revocation |
| ChatGPT | Tested | Completed functional rehearsal through its app, with owner-reported tool results, server cross-checks and owner-observed reauthorization after revocation |
| Claude / Claude Code | Planned | Published Claude web-client metadata/redirect contract checked; direct client testing is the next step |

The [Verify workflow](https://github.com/maizitto/shared-memory-mcp/actions/workflows/ci.yml)
checks the current public source. The dated development observations below are
retained as historical evidence; they do not supersede this current client status.

## Hardening and operator tools — 0.3.0

This revision adds absolute registered-bearer expiry (30 days from issuance),
12-hour review sessions including older rows, and read-only/explicit-collection
OAuth consent defaults. No schema or dependency change is needed. An offline
configuration doctor catches common setup failures; it does not inspect secrets,
account plans or live resources.

The operator backup CLI authenticates/encrypts D1 SQL snapshots and prepares a
restore that revokes snapshot credentials, expires outstanding approvals and
queues current heads for vector indexing. Local tests cover tampering, wrong
keys, file permissions, symlinks, overwrite refusal and restore invalidation.
No backup scheduler was enabled automatically. Local verification passed:
127 native tests, 29 workerd tests, the SDK demo, three scenarios, retrieval
comparison, dry-run build and package checks.

A real encrypted export of the fictional cloud rehearsal database was prepared
and imported into a new, empty isolated D1 database. Five checks passed:
canonical heads, full version payloads and receipts matched; restored auth and
pending approvals were inactive; canonical vector reindexing was queued. The
temporary target was deleted. Provider KV and a replacement Worker were not
restored. This is not a full-service recovery claim or a measured RPO/RTO.
D1's provider-managed Time Travel is a separate recovery path documented in
[backup](backup.md); it was not rolled back in this rehearsal.

The offline retrieval comparison uses six fictional facts and five development
queries with precomputed MiniLM vectors: lexical 3/4 positive hits at 3,
semantic 2/4, hybrid 3/4; each returned no candidates for the single negative
query. This is not held-out, representative-corpus or cloud performance evidence.
See [retrieval evaluation](retrieval-evaluation.md).

## Real-owner OAuth and OpenCode cloud follow-up

The 0.3.0 service was deployed only to the isolated fictional-data Worker on
8 November. The owner registered
the second exact GitHub callback and completed real browser consent.

A first DCR grant completed via a controlled SDK handoff after the native CLI
callback timed out. The saved client ID differed from the original authorization
URL; a mismatched exchange was rejected. The original client ID and matching
PKCE verifier completed that exact grant. Twelve functional checks then passed:
tool discovery without owner tools, canonical version-2 read, collection ceiling,
proposal hidden/uncommittable before approval, real owner browser approval,
receipt confirmation/version-1 read, native OpenCode connection and refresh,
read-only downscoping/write refusal, and access/refresh denial after D1 revocation.
The refresh test invalidated only the private test access cache; it did not wait
one hour or alter server validation.

A second independent grant used the actual published OpenCode CIMD URL with
V1's explicit `oauth.clientId`. OpenCode **1.18.30 completed token exchange
natively through the direct browser callback**, connected with OAuth and
performed a real refresh after the same private-cache fault. No SDK bootstrap
was used for that login. SDK readback with this second grant discovered the six
tools, read the newly approved fact and replayed the first connection's receipt.
Revocation of this CIMD connection also denied access (401) and refresh (400).
No inference/model conversation was used to test OpenCode tool selection.
After the trial, both OAuth connections, the three earlier bearer clients and
all owner-review sessions were revoked; the public Workers route and cron were
disabled. Two fictional heads and three versions/receipts remain for inspection.
One indexing job remains pending with semantic search disabled; no job is running.

App workspace policies were respected. Documentation compatibility is not an
unconditional app guarantee.
See [clients](clients.md) for the tested V1 recipe and current primary references.
The [0.3.0 CI run](https://github.com/maizitto/shared-memory-mcp/actions/runs/42528165175)
passed clean install, 127 native tests, 29 workerd tests, demos, retrieval
comparison, dry-run build and package checks on Ubuntu.

## OAuth revision 0.2.0

Verified on macOS arm64 with Node 22.22.2. The pinned development tooling is now
Wrangler 4.158.0; the runtime OAuth dependency is
`@cloudflare/workers-oauth-provider` 1.2.4. The provider MIT notice is preserved.

| Check | Observed result |
| --- | --- |
| Native SQLite tests | 120 passed, no failures or skips |
| Local workerd / D1 / KV tests | 27 passed, no failures or skips |
| Original SDK demo | Passed |
| Three walkthrough scenarios | Passed |
| Dry-run build | Passed; 405.07 KiB / 91.58 KiB gzip in this observation |
| Package checks | Passed: fixtures, both migrations, links, sensitive patterns and bundle boundary |
| npm audit | Zero reported vulnerabilities, including development dependencies, at this observation |

The 15 added workerd tests use the actual provider with local D1 and KV. They
cover discovery/challenges, CIMD, DCR, loopback redirects, PKCE enforcement,
issuer/resource binding, browser consent, foreign-origin rejection, identity
failure, replay, scope/collection restriction, refresh and both revocation paths.
A signed-client fixture verifies `private_key_jwt` against a remote-JWKS substitute
and rejects missing/forged assertions. The official MCP SDK completes discovery,
registration and PKCE, then lists tools with its issued credential. A second
OAuth client reads a fact only after a separate owner-review flow approves it.

GitHub identity, CIMD documents and JWKS in this suite are **fictional local
substitutes**. This local suite alone does not establish an app account
connection. Separate real OpenCode and ChatGPT observations are recorded in
the current client status above; none is implied by the old service's history.
Bearer clients are also tested with OAuth off or KV unavailable.

## Fresh-cloud memory-core rehearsal

The earlier 0.1.0 source was deployed to a new isolated Worker, D1 database and 1,024-dimensional cosine
Vectorize index. All facts were invented. The operator's personal service and
memory were not modified. No OAuth-client flow was part of this baseline.

Eighteen distinct functional checks passed, covering:

- Anonymous/invalid credentials, foreign Origin, read-only write attempts,
  ungranted collections and bearer attempts at approval were denied.
- Two official SDK clients connected over real HTTPS and had no approval tool.
- Proposal retries were idempotent and content stayed hidden before approval.
- The real owner signed in with GitHub in Safari and approved the first fact.
  The second client read canonical version 1 while indexing was still pending;
  `put_fact` replayed the already committed receipt.
- Real D1 lexical search and explicit hybrid fallback with semantic search
  disabled worked. This was not an induced Workers AI outage.
- A Worker redeployment preserved the canonical fact. Revoking a client in D1
  denied its subsequent request.
- A second real owner approval saved a correction as version 2; current and
  explicit historical version reads returned their expected content.
- Real Workers AI BGE-M3 produced 1,024 finite components. The scheduled indexer
  completed both jobs (one attempt each), and a Vectorize paraphrase query
  returned canonical version 2, with similarity 0.6539714 in this small example.

The cron appeared after normal propagation; this was not a latency benchmark.
After the bounded rehearsal, all three bearer clients were revoked, the public
Workers route and cron were disabled, and no jobs remained pending. The
fictional database/index were retained for inspection. OAuth follow-up uses the
same isolated resources and is a separate observation.

This demonstrates the checked path on fictional data. It does not qualify
maximum capacity, Free-plan entitlement, ongoing cost, uptime, broad retrieval
quality or full-service recovery. No social post was sent.

## Earlier 0.2.0 metadata-only cloud observation

The earlier 0.2.0 adapter was deployed to the same isolated Worker with a new dedicated KV namespace and
the additive OAuth migration. No semantic cron was enabled. Eight bounded
cloud checks passed:

- Resource/authorization metadata exposed the exact resource, issuer, PKCE S256
  and CIMD support.
- Anonymous MCP returned the OAuth challenge with resource metadata.
- The Worker fetched and accepted the **actual public CIMD documents** for
  Claude, ChatGPT and OpenCode, with each published redirect. OpenCode's declared
  loopback callback was accepted with a dynamic port.
- For each of those three identities, a missing S256 method was rejected with
  `invalid_request` and the correct issuer in the authorization response.

These were server-side metadata/redirect contract checks, not connections
initiated by those apps. Separately, the actual OpenCode **1.18.30** CLI, running
with isolated temporary configuration/credential directories and no model calls,
recognized the remote server and reported `needs authentication`. The operator
connection-list command also completed against cloud D1 and returned no grants.
At that stage the real OAuth login was pending the second exact GitHub
callback. The later 0.3.0 real-owner follow-up above supersedes that limitation.

The current app qualification is in the 0.3.0 follow-up above; this earlier
observation established metadata contracts only.

The [Verify CI run](https://github.com/maizitto/shared-memory-mcp/actions/runs/42517775259)
passed on Ubuntu at `0b87dee`: clean install, 120 native and 27 workerd tests,
the SDK demo, three scenarios, dry-run build and package checks.

The app setup instructions cite current primary documentation in
[clients](clients.md). OAuth follows the newer authorization guidance, while
the MCP transport still negotiates 2025-06-18 / 2025-03-26. Forcing a 2026 message
protocol is unsupported. No universal client certification is claimed.

## Publication review follow-up

All documented local commands were repeated after translating the remaining
Italian examples in MCP tool descriptions: 120 native tests, 27 workerd tests,
SDK demo, three scenarios, dry-run build and package checks passed. Runtime
policy, schema and dependencies are unchanged. Security documentation now
separates prompt-injection risk, credential lifetimes and recovery limits.

The cloud rehearsal used new resources in the existing owner's account. Setup
from a newly created Cloudflare account and an independent reader's complete
walkthrough remain unverified. No corpus evaluation establishes an advantage
for semantic or hybrid search over BM25; fictional retrieval checks are not a
quality benchmark. At that revision app-specific OAuth logins were still pending; see the later
0.3.0 real-owner follow-up above.
No new cloud deployment or social post was performed in this follow-up.

## Earlier observations

The records below describe the previous 0.1.0 extraction and its earlier CI.
They remain historical evidence; their counts and cloud limitations do not
replace the separate 0.2.0 results above.

### Initial snapshot — 28 October 2026

Scope: the standalone 0.1.0 candidate, fictional fixtures only. Verified locally
on macOS arm64 with Node 22.22.2. Dependency versions and integrity hashes are
fixed in package-lock.json. At the time of this local snapshot the configured
Ubuntu GitHub Actions job had not yet been executed; see the later CI result below.

| Check | Observed result |
| --- | --- |
| `npm ci --ignore-scripts` | Clean dependency installation succeeded |
| `npm test` | 111 passed; zero failures or skips |
| `npm run test:workerd` | 12 passed; zero failures or skips |
| `npm run demo` | Two official MCP SDK clients; separate fictional reviewer; canonical read and receipt replay passed |
| `npm run build` | Dry-run bundle compiled; 116.24 KiB, 30.04 KiB gzip in this observation |
| Clean portable checkout | Dependency install, all 123 tests, demo, build and checks repeated successfully without the original project |

The portable checkout contained only the Git candidate's distributable files,
with no pre-existing node_modules, personal configuration or ignored work directory.
Its dependency install used the populated npm cache in offline mode. This proves
local package independence; it is not a GitHub-hosted CI run or cloud deployment.

The first editorial revision explained personal installation, Workers and free
allocations without changing service code or the dependency graph.

## Reproducible walkthrough revision

The case-study kit adds an Italian README, English overview, PROMPT.md,
REPRODUCE.md, an examples guide and `examples/scenarios.mjs`. Service code,
database schema and dependency versions remain unchanged. The CI now also runs
the three new scenarios. Its first GitHub execution is recorded below.

The latest local check of this kit repeated **111 native tests and 12 workerd
tests**, all passing without skips, plus the original SDK demo and dry-run build.
The three new scenarios also pass their executable assertions:

| Scenario | Observed behavior |
| --- | --- |
| Shared preference | Hidden before approval; client B reads canonical version 1 afterwards |
| Corrected decision | Canonical version 2 remains; stale write returns VERSION_CONFLICT; version 1 is explicitly historical |
| Embedding outage | Stored fact, pending index, explicit degraded lexical response; indexing recovers with one write receipt |

`examples/sample-output.json` is a recorded run of all three cases. They use
the same native SQLite facade and precomputed fictional vectors as the contract
tests, with two independent official SDK clients. These are three executable
walkthroughs in addition to the 123 tests, not three new cloud tests.

The current walkthrough kit was also copied into a new directory containing only
its 93 distributable files, with no node_modules or ignored work directory.
`npm ci --ignore-scripts`, all three scenarios, dry-run build and content checks
succeeded there. Its scenario JSON matches the committed sample output.

The simulated reviewer approves commands against their digest, and the client
then commits. The actual review page saves on approval; the scenario guide
explains this distinction. Retry delay is bypassed only in the isolated demo.

The native suite covers canonical state, grants, source/version/expiry checks,
approval binding, retries, conflicts, index failures, stale-vector rejection,
purge, atomic export/restore and offline CLI process boundaries. It also checks
the fresh-install schema and standalone entry's disabled/misconfigured behavior.

The workerd suite runs the actual local Workers runtime and D1 with temporary
storage, HTTP clients and a process restart. GitHub identity is simulated;
vectors are real precomputed MiniLM outputs over fictional text with an in-memory
cosine index. It does not contact GitHub, Workers AI, Vectorize or a cloud D1.
Cookie jars test the application's protocol; they do not model all browser
SameSite behavior.

The demo uses injected in-process fetch, not a network listener. The separate
workerd suite verifies SDK clients over loopback HTTP. Both use fictional
reviewers; neither substitutes for a real browser/cloud installation rehearsal.

The build uses the disabled placeholder configuration. The public bundle must
exclude private test operators and Node filesystem/SQLite imports. `npm run check`
checks that boundary, fixture hashes, schema drift, internal Markdown links and
known sensitive patterns. Those checks are not an independent security audit.

No cloud deployment, personal memory import, paid resource or public repository
was created during this verification. Full service restore, maximum cloud
capacity, production CPU/cost and independent security review remain unqualified.

## GitHub CI — 8 November 2026

The initial [Verify run](https://github.com/maizitto/shared-memory-mcp/actions/runs/42483818562)
passed on Ubuntu with Node 22.22.2 at commit `7e0eafb`: dependency installation,
111 native tests, 12 workerd tests, the SDK demo, three walkthrough scenarios,
dry-run build and package checks. The repository was private. This is hosted CI
evidence, not a Cloudflare deployment or a real GitHub owner-review login test.

## English repository revision

English is now the main language for the README, prompt, reproduction guide,
examples and owner-review interface. The original Italian README is retained in
`README.it.md`. Code identifiers and comments were already in English. UI copy,
the purge form confirmation value and export filename prefix were localized;
the ledger schema, MCP contracts, authorization checks and dependencies are unchanged.

The first two walkthroughs now use English fictional text. The semantic scenario
and earlier SDK demo retain Italian fixtures with their original precomputed
embeddings. The recorded walkthrough output was regenerated from the executable.

Local verification of this revision passed: 111 native tests, 12 workerd tests,
the original SDK demo, all three scenarios, dry-run build and package checks.
The dry-run bundle was 115.51 KiB (29.72 KiB gzip) in this observation. Semantic
fixture hashes, the fresh schema and internal documentation links passed checks.
