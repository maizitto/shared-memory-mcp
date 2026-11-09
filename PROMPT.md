# A prompt to understand, reproduce and adapt the project

This prompt accompanies the repository's code. Open a local copy with your coding
assistant and paste the block below. The goal is to understand and adapt a
verifiable version of the solution.

Tell the assistant your operating system and which MCP clients you want to connect.
The demo only needs Node and npm; a Cloudflare account is needed for the later
cloud phase.

## Copy this prompt

```text
Help me understand and reproduce this repository's case study: personal memory
shared across AI clients, accessible through MCP and deployable in my own
Cloudflare account using Workers and D1.

Canonical text and state live in D1. If I enable semantic search, Workers AI
computes embeddings and Vectorize stores their vectors. The Worker coordinates
operations and checks results against the current facts in D1.

Work with the existing code. Read README.md, AGENTS.md, REPRODUCE.md,
docs/architecture.md and docs/clients.md. Explain the flow in plain language:
proposal → approval → storage → reading from a second client.
Do not rebuild the service from scratch or replace pinned dependencies without
a concrete reason. The examples use fictional identities and data.

Phase one: reproduce locally.
1. Check the documented prerequisites. If something is missing, explain what
   is needed before changing my environment.
2. Install dependencies with npm ci --ignore-scripts and run
   npm run demo:scenarios. No credentials or remote models are needed.
3. Show me the three outcomes: one client reads another's approved preference;
   a stale-version write is rejected; an embedder outage leaves the fact stored
   and lexical search available.
4. Run the documented checks and report actual results. Distinguish SQLite
   tests, the workerd runtime, simulated identities and real cloud observations.
   Diagnose failures without disabling the controls.

Phase two: prepare an adaptation for my use.
Ask only for missing information that affects the solution: operating system,
MCP clients, whether semantic search is needed and the Cloudflare account to use.
Check whether my clients need registered HTTP bearer tokens or OAuth. For
Claude, ChatGPT or OpenCode, read docs/oauth.md and the current official client
documentation. Distinguish protocol tests from a real connection in my account.
Preserve the separate owner approval after authorizing a client.

Prepare configuration separately from the template. Preserve owner review,
expected versions, collection grants and derived indexes. Start with Workers
and D1 using lexical search; treat Workers AI and Vectorize as optional additions.
Check current quotas in official sources before describing costs: free resources
are a starting point, not a guarantee for every workload.

Stay inside this repository and temporary test directories. Do not read other
personal installations, conversations or real data; do not import memories.
Never write tokens or secrets into the repository, logs or responses. Explain
how to enter them through the tools' intended private channels.

Before creating remote resources, deploying, enabling paid plans or publishing
repositories/posts, show me the configuration, commands, affected resources and
possible costs. That phase requires my decision.

At the end, provide commands run, observed results, changed files, client
compatibility and what remains to verify in the cloud. Support any claim that
something works with a specific observation.
```

## A small adaptation

After reproducing the project, you can add:

```text
I want to adapt the examples to project decisions and writing preferences.
Prepare three fictional facts, identify each one's source and version, and show
which MCP tools two clients would use to propose and retrieve them. Preserve
the approval mechanism and leave remote services disconnected for now.
```

The prompt does not contain a copy of every source file or guarantee identical
results with every model. Versioned code, fixtures and checks are the concrete
references for reproducing behavior. App configuration still needs a test in the
chosen client.
