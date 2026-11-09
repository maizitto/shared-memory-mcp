# Reproduce the case study

Start from a local copy of this repository. The procedure uses fictional examples
and requires no personal data or changes to an installed assistant. To explore it
with a coding assistant, use [PROMPT.md](PROMPT.md).

## 1. Check your environment

The project targets **Node 22.22.x**; CI uses 22.22.2. You need npm and a terminal.
Check with `node --version` and `npm --version`. An experimental SQLite API warning
is expected with this Node version.

Local checks were run on macOS arm64. The initial
[Ubuntu GitHub Actions run](https://github.com/maizitto/shared-memory-mcp/actions/runs/42483818562)
also passed. The workerd tests use loopback ports and Unix process management;
other environments need their own verification.

For a reading-only walkthrough, open the [examples](examples/README.md) and
[recorded result](examples/sample-output.json).

## 2. Install and observe the three cases

From this directory:

```sh
npm ci --ignore-scripts
npm run demo:scenarios
```

The first command downloads pinned dependencies. The demo then uses in-memory
SQLite, two MCP SDK clients and a simulated reviewer. It opens no ports and does
not contact Cloudflare, GitHub or inference services.

Run one case at a time with:

```sh
npm run demo:scenarios -- --case 1
npm run demo:scenarios -- --case 2
npm run demo:scenarios -- --case 3
```

| Case | Expected result |
| --- | --- |
| 1 — Shared preference | `before_approval: 0`, then the same preference read by client B at version 1 |
| 2 — Correction | Current version 2, deadline November 24, `VERSION_CONFLICT` on the stale attempt |
| 3 — Embedding outage | `stored`, index `pending`, `lexical` fallback, then `indexed` with only one fact write |

Assertions stop the demo if an expected outcome differs. For JSON output use
`npm run demo:scenarios -- --json`. Each scenario starts with a fresh database.

The semantic vectors are precomputed MiniLM outputs over fictional Italian text.
That text is preserved with its vectors. The demo computes no new embeddings and
uses a local substitute for the vector index. Its fictional credentials and
reviewer must never become a public service's authentication.

## 3. Verify the code

```sh
npm test
npm run test:workerd
npm run demo
npm run build
npm run check
```

- Native tests check the ledger, permissions, conflicts, search and recovery.
- Workerd tests start local Workers and D1 on `127.0.0.1`, exercise HTTP and a
  restart, then remove temporary state. They need permission to open local ports.
- `demo` is the earlier minimal two-client example with an Italian paraphrase.
- `build` compiles the Worker with `--dry-run` and the disabled template.
- `check` validates fixtures, schema, links, known sensitive patterns and the
  public bundle boundary.

If an isolated environment denies loopback ports, report the restriction and
repeat workerd tests in an environment that permits them. Do not mark an unrun
test as passed or treat a port restriction as a memory-contract failure.

## 4. Decide whether to use the cloud

The [deployment guide](docs/deployment.md) prepares a new instance in your account:
a fresh database, an HTTPS address, a GitHub OAuth App for owner review and
revocable credentials for MCP clients.

Before changing remote resources, check:

1. Does your client use HTTP bearer tokens or OAuth? For Claude, ChatGPT and
   OpenCode use the [client guide](docs/clients.md) and optional [OAuth setup](docs/oauth.md).
2. Is lexical search enough? If so, neither Workers AI nor Vectorize is needed.
3. Have you chosen private storage for credentials and any exports?
4. Have you read the current [quotas and costs](docs/costs.md)?

Local commands do not deploy. The [verification record](docs/verification.md)
includes a bounded fresh-cloud rehearsal with real GitHub sign-in. Repeat the
relevant checks for your own instance; usage and each chosen app connection
still need their own evidence.

## 5. What reproduction demonstrates

A successful reproduction demonstrates the stated behaviors for these examples
and the runtime used. It does not qualify cloud availability, ongoing costs,
full-load performance or general semantic quality. The checks provide concrete
design choices to discuss and identify what still needs verification.
