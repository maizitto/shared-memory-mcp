# Third-party components

The Worker source uses Web Platform APIs and Cloudflare bindings. Optional OAuth imports the pinned Cloudflare OAuth provider, distributed under
the MIT license; its notice is preserved in `licenses/`. Node SQLite is used by local tests and
the offline recovery CLI; it is not included in the Worker bundle.

| Component | Role | License / reference |
| --- | --- | --- |
| `@cloudflare/workers-oauth-provider` 1.2.4 | Runtime authorization and resource-server protocol / token handling | MIT; [notice](licenses/cloudflare-workers-oauth-provider-MIT.txt), [source](https://github.com/cloudflare/workers-oauth-provider) |
| `@modelcontextprotocol/sdk` 1.32.1 | Development-only demo and client interoperability tests | MIT; [source](https://github.com/modelcontextprotocol/typescript-sdk) |
| `wrangler` 4.158.0 | Development-only bundling and local workerd/D1 tests | MIT OR Apache-2.0; [source](https://github.com/cloudflare/workers-sdk) |
| multilingual MiniLM L12 v2 | Precomputed 384-dimensional test vectors over fictional corpora | Apache-2.0 model; [pinned model](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42) |
| BGE-M3 through Workers AI | Optional operator-enabled cloud embeddings | [model documentation](https://developers.cloudflare.com/workers-ai/models/bge-m3/); Cloudflare service terms apply |

The lockfile fixes transitive package versions and integrity hashes. Their
licenses remain with the installed packages; this table is not an independent
dependency security or redistribution audit. No weights or dependency binaries
are committed. Fixture metadata records the model revision and original corpus
hash; `fixtures/manifest.json` checks the distributed files' hashes.
