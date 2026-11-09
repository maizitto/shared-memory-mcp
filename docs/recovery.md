# Offline collection recovery

For provider-managed Time Travel and optional encrypted full-D1 snapshots, see
[D1 backup and recovery](backup.md). This page describes the separate portable
collection archive, which remains plaintext unless protected by the operator.

The CLI operates on an explicitly selected local database/export. It never
discovers a live personal database or contacts Cloudflare. Keep packages outside
the checkout: they contain plaintext history. Hashes detect accidental corruption,
not authenticity. Use trusted input and storage you control.

```sh
node --experimental-sqlite src/memory/recovery/cli.mjs backup --database /private/location/source.sqlite --owner github-YOUR_NUMERIC_ID --collection shared --output /private/location/new-package
node --experimental-sqlite src/memory/recovery/cli.mjs inspect --bundle /private/location/new-package
node --experimental-sqlite src/memory/recovery/cli.mjs restore --bundle /private/location/new-package --owner github-YOUR_NUMERIC_ID --collection shared --target /private/location/new-target
node --experimental-sqlite src/memory/recovery/cli.mjs verify --bundle /private/location/new-package --owner github-YOUR_NUMERIC_ID --collection shared --target /private/location/new-target
```

Replace the example private paths and numeric ID. Output/package and restore
target directories must be new; existing targets are refused. `pack --export
PATH --output NEW_DIRECTORY` accepts the application's canonical JSON export.
Do not assume a raw provider export is already in this format.

Export uses one consistent transaction. Restore validates the archive, refuses
an occupied collection and atomically writes history, heads, deletion tombstones
and rebuild jobs. Lexical statistics are rebuilt locally. Semantic jobs require
an explicitly configured fresh backend later.

Packages exclude client tokens, grants, browser sessions, proposals, receipts and
old vectors. They do not recover an entire service or Cloudflare account. A
snapshot cannot know about deletions made after it: reconcile later deletions
before reopening access. Receipts deliberately retain `ready_for_clients: false`.

The archive is bounded to 32 MiB, but a history may still exceed the transactional
restore budget and be refused before writes. No periodic backup, encryption,
signed archive, cloud restore endpoint, recovery-time objective or recovery-point
objective is provided. Local tests cover process boundaries and rollback; a
complete fresh-cloud recovery rehearsal remains future work. Collection exports
do not include OAuth connections, provider KV, client tokens or review sessions;
see [OAuth auth-state recovery](oauth.md).
