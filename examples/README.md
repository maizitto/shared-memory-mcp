# Three examples to try

[scenarios.mjs](scenarios.mjs) runs these cases using a fresh in-memory SQLite
database and two MCP SDK clients each time. Identities, content and review are
simulated. [This JSON](sample-output.json) is a recorded demo result; random
internal IDs are excluded from the output.

```sh
npm run demo:scenarios
```

## 1. Confirm a preference and retrieve it with another assistant

In the fictional Aurora project, a person prefers training in the morning.
Client A proposes the fact. Before approval, client B sees zero current facts.
After simulated approval and commit, B reads:

```json
{
  "read_by_client_b": "In the fictional Aurora project, I prefer training in the morning.",
  "version": 1,
  "source": "fictional walkthrough"
}
```

The common service holds the memory. In a cloud installation, the owner reviews
the content in the browser: approval there saves the fact, which the client can
then reread or confirm. The demo separates review and commit capabilities to
make them visible.

**Run:** `npm run demo:scenarios -- --case 1`.

## 2. A decision changes while another client still uses the old version

The fictional Aurora project's deadline was November 17. Two clients read
version 1 and prepare changes: one to November 24, the other to November 25.
Both proposals are approved against version 1 before either commit, to exercise
the final database guard.

The first commit creates version 2. The second receives `VERSION_CONFLICT`.
The current read keeps November 24; version 1 remains available as history.
The stale client must reread and propose again.

The real review page also checks the version before approval. The database
precondition protects the write if state changes again afterwards.

**Run:** `npm run demo:scenarios -- --case 2`.

## 3. The embedding model becomes unavailable

The fact is approved and saved. A simulated outage makes the first indexing
attempt fail, leaving a retry job. Client B can still read the fact by ID, and
hybrid search returns a lexical result while explicitly reporting degradation.

After recovery, the demo advances the retry only in its in-memory copy. The job
indexes the fact with precomputed vectors, and semantic search finds it through
a paraphrase. The ledger contains just one write receipt.

```json
{
  "save": "stored",
  "index_during_outage": "pending",
  "hybrid_during_outage": "lexical",
  "degraded": true,
  "index_after_recovery": "indexed",
  "fact_written_once": true
}
```

**Run:** `npm run demo:scenarios -- --case 3`.

This case and the original `two-clients.mjs` demo intentionally keep the fictional
Italian texts paired with the committed MiniLM embeddings. Translating those
texts would require recomputing the vectors; renaming them would misrepresent
the fixture. The walkthrough's headings and output fields are in English.

## Use the examples to present the project

In about a minute, show the command, three outcomes and corresponding code.
Explain that identities and inference are simulated, then connect each outcome
to its purpose: sharing context, preserving corrections and handling an outage.

The workerd tests cover the actual local Workers runtime. This demo is not a
real browser sign-in, a multi-app cloud trial or a cloud-cost measurement.
