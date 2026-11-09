# Scope and alternatives

This is a personal open-source project for people who want their AI tools to
consult a common memory. Each person installs their own instance on their own
Cloudflare account, can inspect the code and can adapt it. Small personal usage
and Cloudflare's free allowances are the starting point; see [costs](costs.md).

Persistent agent memory, semantic retrieval and MCP are existing categories.
[Second Brain on Cloudflare](https://github.com/rahilp/second-brain-cloudflare)
and [Open Brain on Cloudflare](https://github.com/aspitz/open-brain-cf) are close
references for a personal Cloudflare/MCP setup. This repository presents its
own reproducible walkthrough rather than claiming that hosting approach is new.
[MCP Memory Service](https://github.com/doobidoo/mcp-memory-service),
[Hindsight](https://github.com/vectorize-io/hindsight),
[Mem0](https://github.com/mem0ai/mem0) and the
[MCP reference Memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
are relevant starting points. This document does not claim they lack particular
features in their current versions.

This implementation concentrates on one owner's explicit approval, conditional
version updates, durable request receipts and canonical checks after retrieval.
It combines established database and authorization techniques for that personal
use case. The initial scope is one owner and their authorized clients.

The source project compared pinned candidates using fictional data before
building a narrow write boundary. Those experiments explain its origin; they
do not prove this service is cheaper or better to maintain than an extension.

The release excludes personal coach ingestion, FIT files, Dropbox automation,
Telegram jobs, personal plans and deployment journals. The generic memory core,
owner review, bearer adapter, optional one-owner OAuth and offline collection
recovery are the supported review scope. The OAuth adapter does not expose the
private source deployment's other resources or identity rules. Choosing a memory system should start from the
approval, hosting, retrieval and operational requirements of the intended use.
