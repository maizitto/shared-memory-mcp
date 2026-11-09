# Starting with Cloudflare's free resources

The project is open source under Apache-2.0. Each person runs an instance in
their own Cloudflare account. The design starts with a small personal memory and
the resources included in the free plan, with semantic search as an optional step.

Workers hosts the memory endpoint on demand, and D1 persists facts, versions and
approvals. There is no VM or always-on computer to maintain for that endpoint.
Your AI client or agent still needs its own place to run.

## Included resources

Official allocations checked on **28 October 2026**. These are provider quotas,
not measured capacity claims for this application, and can change.

| Component | Role here | Free allocation at the check date | Source |
| --- | --- | --- | --- |
| Workers | MCP endpoint and owner review | 100,000 requests/day; 10 ms CPU per invocation | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 | Durable facts, approval and history | 5 million rows read/day; 100,000 rows written/day; 5 GB total storage | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Vectorize, optional | Semantic index | 30 million queried dimensions/month; 5 million stored dimensions | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Workers AI, optional | Embedding inference | 10,000 neurons/day; model eligibility and rates apply | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |

Start with Workers + D1 and lexical search. That path needs no model inference
or vector index. Add semantic search when it helps your actual queries, then
measure its usage separately. D1 quotas count rows scanned/written, not simply
API calls; vector dimensions and inference neurons are different units again.

Cloudflare provides a workers.dev hostname, so an existing custom domain is not
required for a personal trial. The installation guide explains how to opt into
that hostname while keeping the committed template disabled. See
[workers.dev configuration](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

OAuth adds a dedicated Workers KV namespace for provider auth state. Its read,
write, delete, list and storage usage has separate limits; MCP calls and OAuth
flows do not each correspond to one KV operation. Check [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)
before enabling it (reference checked 8 November 2026). The OAuth request budgets
are not an infrastructure billing ceiling.

## What "free" means for this project

The useful starting point is the availability of these free resources. A
workload can run without an infrastructure charge while it fits every applicable
free limit. Request volume alone does not establish that fit: CPU time, database
queries, storage, index usage and model work all matter.

The extracted package has not been qualified at maximum size on Workers Free.
Earlier observations from the source installation included memory requests at
1–12 ms CPU, which do not establish headroom under the documented 10 ms limit.
Measure the new installation before claiming that your workload fits. A quota
can cause requests to fail or require a deliberate plan change.

AI application subscriptions/API calls, an optional purchased domain and any
paid Cloudflare usage are separate. The repository does not make them free or
host other people's instances. No paid plan, inference binding, scheduled job or
remote resource is enabled by running the local demo or tests.
