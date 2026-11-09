# Security boundaries

This is experimental software for one owner and trusted clients. It has not had
an independent security audit. A threat model and local tests do not constitute
certification for sensitive or regulated workloads.

## Credentials and recovery: check before use

- Registered `pmm_` bearer tokens expire **30 days after issuance**. Each new
  request checks that age and revocation in D1. Older tokens must be replaced. Use separate credentials and narrow
  collection grants for each client.
- OAuth access tokens last **one hour**. Their live D1 connection and refresh
  ceiling expire **30 days** after connection creation. The operator can revoke
  the connection in D1. Provider KV replay/revocation state has cross-location
  consistency limits; see [OAuth](docs/oauth.md).
- The owner's review browser session lasts **12 hours**. Logout revokes the
  current session. Protect that browser as an approval capability.
- A [encrypted D1 snapshot CLI](docs/backup.md) is available for operator scheduling;
  **no periodic job is enabled automatically**. D1 also has provider-managed Time
  Travel. There is no completed full-service cloud recovery rehearsal. Offline collection restore does not
  restore auth, provider KV or the Cloudflare account. See [recovery](docs/recovery.md).

New OAuth consent starts read-only and requires explicit collection selection;
write permission must be enabled deliberately. Existing OAuth grants keep their
approved permissions until expiry or revocation. This limits exposure, without
guaranteeing how the host model handles retrieved content.

Losing the configured GitHub identity requires an operator recovery procedure.
Revocation applies to subsequent requests; it cannot undo data already read or
cancel a request already in progress.

## Trust boundaries

The application trusts its operator, D1 administrator, configured GitHub owner,
deployment supply chain and Cloudflare. A compromised client can read its granted
collections and submit proposals; it cannot acquire review rights through MCP.

## Prompt injection through stored content

An approved fact can contain malicious instructions, including text copied from
another source. For example, a project note could tell the reading assistant to
ignore the user and disclose other notes. If stored, that text can be retrieved
in later chats by different clients. Human approval of storage does not make the
content safe for every model to interpret as an instruction.

The server returns stored content as data, includes source/version information
and tells clients to treat embedded instructions as data. These instructions
are guidance to the client model, not an enforced model sandbox. The server
does not run generative inference, execute stored instructions or expose an
approval tool. D1 grants and separate owner approval constrain this service's
reads/writes, but cannot constrain tools or secrets the host app has elsewhere.

When connecting an assistant:

- Treat facts and tool results as untrusted reference material. Never let their
  contents authorize tool calls, new permissions or disclosure to another service.
- Start with read-only access to a narrow collection. Review proposed text and
  its source before saving; avoid copying whole unreviewed documents into facts.
- Preserve the host's own confirmation controls for external writes and data
  disclosure. A fact's approval receipt authorizes that stored change only.
- If suspicious content is found, stop affected client use, inspect current and
  historical versions, correct or purge it, and review any actions already taken.
  Deleting a fact cannot retract text already present in a chat or undo actions.

These controls reduce exposure. There is no adversarial evaluation demonstrating
that this project prevents prompt injection or that each target app will follow
the guidance. MCP hosts have their own security responsibilities; see the
[MCP tools security considerations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#security-considerations).

## Data handling

Memory text, proposals, lexical terms, vectors and exports can be sensitive.
There is no end-to-end encryption. Provider backups and logs have separate
retention. Do not put personal text in permanent IDs or log raw request bodies.
Purge is not a promise to remove every provider backup instantly.

## Report a vulnerability

Report vulnerabilities through the repository's private security advisory channel
at [Report a vulnerability](https://github.com/maizitto/shared-memory-mcp/security/advisories/new).
Do not disclose exploit details or private data in a public issue.
