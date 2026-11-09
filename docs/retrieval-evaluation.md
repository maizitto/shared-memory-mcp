# Comparing retrieval modes

Run an offline comparison without an account, live model or personal data:

```sh
npm run evaluate:retrieval
```

It builds a new native SQLite ledger with six fictional facts, approves them
through the simulated reviewer, indexes their precomputed MiniLM vectors and
runs the same five labelled queries through lexical, semantic and hybrid search.
Four queries have expected fact IDs and one has no approved relevant fact.

The output reports hit@3, mean reciprocal rank within the first three results,
negative queries receiving candidates, result IDs and local elapsed time.
Hit/MRR average over positive queries only; negative outcomes are separate. No
fact/query text is printed. Timing includes local fixture lookup and an in-memory
vector substitute; it measures neither inference/network latency nor cloud cost.

## Current development-fixture observation

With the committed 384-dimensional MiniLM fixture and fixed, uncalibrated
similarity threshold 0.5:

| Mode | Relevant fact in top 3 | MRR@3 | Negative queries with candidates |
| --- | --- | --- | --- |
| Lexical | 3 / 4 | 0.75 | 0 / 1 |
| Semantic | 2 / 4 | 0.50 | 0 / 1 |
| Hybrid | 3 / 4 | 0.75 | 0 / 1 |

On these examples hybrid adds no observed retrieval benefit and semantic alone
misses more labelled queries. The dataset is tiny and already used in development;
there is no held-out or representative-corpus quality claim. These are MiniLM
results, not BGE-M3 results. Do not tune to these five questions and call the
result a general benchmark. Lexical remains the basic configuration.

## Evaluate a corpus you explicitly choose

The runner accepts a labelled JSON dataset and matching precomputed vectors:

```sh
npm run evaluate:retrieval -- --dataset /PRIVATE/dataset.json --vectors /PRIVATE/vectors.json
```

Dataset shape:

```json
{
  "facts": [{ "id": "fact-001", "content": "Fictional approved fact text" }],
  "queries": [{ "id": "query-001", "query": "A question", "relevant": ["fact-001"] }],
  "min_similarity": 0.5
}
```

The vectors file uses the committed fixture format: `model`, `dimensions` and a
`vectors` object mapping every fact/query text to an array of that dimension.
Use one model/index convention throughout. There are at most 200 facts and 200
queries in this runner. An empty `relevant` array labels a negative query.

Choose neutral IDs: output includes query/result IDs. Sensitive datasets and
embeddings belong outside the repository. The command reads only explicit files;
it does not scan, import or label personal memory. An operator must separately
authorize any provider inference used to prepare new vectors.

For a useful evaluation, select representative exact-word, paraphrase, ambiguous,
correction and no-answer queries. Label relevance before seeing the results;
separate tuning from held-out questions. Record corpus/model/version, threshold,
result limit and failures. Measure actual cloud latency, CPU, database operations
and provider usage separately. Better retrieval must justify those costs and the
extra components in the intended use case.
