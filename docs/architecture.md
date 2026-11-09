# Architecture and failure behavior

D1 holds facts, versions, proposals, approvals, receipts and durable index jobs.
Derived term statistics and vectors help find facts but cannot authorize reads
or replace the canonical version. The service contains no generative model call.

## Where the data lives

| Component | Responsibility |
| --- | --- |
| D1 | Canonical text, sources, versions, approvals and jobs; also derived lexical statistics |
| Workers AI, optional | Computes embeddings for fact windows and search queries |
| Vectorize, optional | Stores those embedding vectors and returns semantic candidates |
| Worker | Coordinates writes, inference and search, then verifies candidates against current D1 state |

In this implementation the semantic vector index is in **Vectorize**; D1 is the
canonical memory store. With semantic search disabled, D1 reads and lexical
search remain usable without Workers AI or Vectorize.

The cloud adapter uses `@cf/baai/bge-m3` with **1,024 dimensions**: each text
window or query becomes a vector of 1,024 numeric components. The offline demo
instead uses precomputed `paraphrase-multilingual-MiniLM-L12-v2` vectors with
**384 dimensions**. Each model uses its own index and fingerprint; the demo
vectors are not BGE-M3 outputs. The fictional Italian semantic texts are kept
unchanged alongside their committed embeddings.

## Writes

1. The authentication adapter fixes the owner and collection grants.
2. A client proposes a command with an expected version and request key.
3. The browser reviewer approves a digest binding destination, payload and version.
4. An inserted receipt triggers head/version updates, approval consumption and
   index-job creation in the same transaction.
5. Indexing happens later. Stored data remains readable when embedding is offline.

Two clients using the same request key share its receipt within owner/collection.
A different payload conflicts. Concurrent edits to a head require rereading and
reproposing; they cannot both silently overwrite the same expected version.
An uncertain storage response requires a retry with the same explicit key or a
canonical read. A timeout does not prove rollback.

The convenience auto-key omits source/time fields and default dates are evaluated
on each request. For robust retries provide a request ID and all timestamps;
reusing an auto-key with different source/time fields can produce a conflict.

## Reads and indexes

Exact ID lookup does not require embeddings. Lexical search uses normalized
whole-word BM25. Semantic search uses windows of 320 Unicode characters with
64-character overlap, at most 32 per fact. Hybrid combines ranked channels with
reciprocal-rank fusion (constant 60).

Final hydration checks current versions, deletion, validity, owner and collection
after external AI/vector operations. An update or purge during retrieval cannot
make an older vector's text authoritative. The derived lexical path rechecks the
snapshot and retries once; pending statistics use current canonical text.

The indexer has durable jobs and leases. A crash can leave a pending/retry job;
it does not require repeating the fact mutation. Vectors are reconstructible from
canonical state. The optional scheduled handler processes one scoped job per tick.

## Why start with lexical search

For a collection capped at 200 non-deleted IDs, exact lookup and BM25 may be
sufficient. They are the basic configuration and need no inference, vector
backend or scheduled indexing. This project has not demonstrated that semantic
or hybrid retrieval improves results on the owner's actual corpus. The small
fictional examples are behavior checks, not a quality benchmark. A small [repeatable comparison](retrieval-evaluation.md) now
records lexical, semantic and hybrid results on those development fixtures.

The optional semantic path adds a model, chunking, Vectorize, rank fusion and
retries. Durable jobs and leases make that external work recoverable after a
save; they do not establish that its retrieval benefit justifies the complexity.
The ledger still records jobs when semantic indexing is disabled, but no remote
inference or cron is needed for normal reads and lexical search.

Before enabling it for a real use case, define representative queries with
expected fact IDs, including exact terms, paraphrases, corrections and questions
with no relevant fact. Compare lexical, semantic and hybrid on the same corpus,
version and result limit. Record relevant results in the top positions, false
matches, latency and resource usage. Keep evaluation queries separate from those
used to tune the similarity threshold. A benefit on fictional fixtures alone
does not establish a benefit for personal or sensitive data.

## Identity and review

Bearer client tokens are hashed in D1; age (maximum 30 days), revocation and
grants are checked on each new request.
The only owner is the configured numeric GitHub ID. Review uses GitHub PKCE,
browser-bound login state, secure HttpOnly cookies, CSRF checks and exact digests.
Review sessions last 12 hours and logout revokes the current session. OAuth access
tokens from GitHub are used to verify identity and are not persisted.

Optional OAuth adds discovery, CIMD/DCR, PKCE and refresh through the pinned
Cloudflare provider. KV stores provider auth state; D1 holds the live connection
and its scope/collection ceiling. This adapter is scoped to this standalone
one-owner instance; it does not import the private service or other domains.
See [OAuth](oauth.md) for configuration, revocation and consistency limits.

## Boundaries

The entry point refuses disabled or incomplete configuration. Limiter bindings
are mandatory there; approximate per-location limits are not global quotas.
There is no public SQL, arbitrary file/URL loader, reviewer capability in MCP,
restore endpoint or automatic conversation capture. The operator and database
administrator are trusted; database access can bypass application policy.
