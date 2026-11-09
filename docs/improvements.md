# Improvements and remaining evidence

This tracks the review findings as observable work, rather than counting files
or treating every missing measurement as a reproducible bug.

| Finding | Implemented in 0.3.0 | Evidence still needed |
| --- | --- | --- |
| Long-lived credentials | Bearer maximum 30 days, reviewer maximum 12 hours; old rows also checked; token metadata listing | Operational rotation in each chosen app |
| Excess default access | Read-only consent with explicit collections; OpenCode and ChatGPT tested, including ChatGPT write consent, approval, correction, deletion, refresh and post-revocation reauthorization gate | Claude app testing is planned |
| Fragile setup | Offline `doctor` validates placeholders, guards, collections and optional bindings | Independent walkthrough from a newly created Cloudflare account |
| Backup and recovery | Encrypted D1 export, verification, unique scheduled filenames, prepared restore invalidating auth; cloud D1 restore exercised | Operator-selected host/storage/schedule, failure monitoring and whole-service drill |
| Unproven vector benefit | Repeatable lexical/semantic/hybrid runner; small fixture shows no hybrid gain | Representative, prelabelled corpus with held-out queries and actual provider measurements |
| Prompt injection | Explicit boundary, narrow/read-only initial grants, separate approvals | Controlled model/app evaluation with fictional data and isolated dummy tools; no prevention claim |
| Costs | No inference/index/cron needed for the basic memory; explicit opt-ins | Observe the chosen account's CPU, D1/KV, vector and inference usage at its intended load |

## Next acceptance checks

1. OpenCode and ChatGPT have been tested; see [the ChatGPT rehearsal](chatgpt-rehearsal.md).
   The next client test is Claude, where workspace policy permits.
   Do not bypass a workspace restriction to complete an app test.
2. Follow the public deployment guide without relying on the author's account
   or cached state. Record the exact failure/recovery step, not just “deploy OK”.
3. Choose a private backup destination and non-interactive operator credential;
   enable a schedule deliberately. Verify a successful snapshot and a visible
   failure, then rehearse recovery of code/config/secrets/KV plus D1 before using
   the service as essential storage. Keep app access closed during recovery.
4. Evaluate retrieval and actual resource usage on an explicitly approved test
   corpus. Keep lexical as the base unless the measured benefit justifies the
   additional provider, index and indexing work.

No TypeScript rewrite is needed for these changes. Learning the current request,
approval and storage flow is more immediately useful than adding another build
step. A later language decision should follow maintainability needs and the
contributor's understanding of the code.
