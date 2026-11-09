# D1 backup and recovery

There are two different recovery paths. D1's provider-managed
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is
always enabled on its production backend; the documented window is seven days
on Workers Free and thirty on Workers Paid (checked 8 November 2026). It is an
in-place database rollback, so it can also roll back credential revocations and
purges. Stop client access and review the desired point before using it. No
Time Travel rollback was performed on the source or personal database here.

The optional operator CLI below creates an **encrypted SQL snapshot outside the
provider**. It uses Wrangler's [D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and Node's AES-256-GCM implementation. No new runtime package or Worker binding
is needed. This is a database backup, not a copy of the whole deployed service.

## Create and check a snapshot

Use your own private paths outside the checkout, on a trusted Unix host. Parent
directories must be owner-only; files and keys must have owner-only permissions.
The tool refuses symlink inputs, overwriting an existing output and repository
paths. The key is random, is never printed, and is not a password to memorize.

```sh
mkdir -m 700 -p /PRIVATE/keys /PRIVATE/backups
npm run backup -- keygen --key-file /PRIVATE/keys/memory.key
npm run backup -- snapshot --config config/worker.local.json --database YOUR_DATABASE --key-file /PRIVATE/keys/memory.key --output /PRIVATE/backups/first.smbak
npm run backup -- inspect --input /PRIVATE/backups/first.smbak --key-file /PRIVATE/keys/memory.key
```

Replace the example paths and exact lowercase database name. The database must
be the config's `DB` binding. `snapshot` is a remote operator action requiring
Wrangler access. It exports into a mode-700 temporary directory, encrypts, then
removes that directory on normal completion/failure. A process or host crash
can leave the private temporary export behind; inspect private temporary storage
when recovering from a crash. This is not a secure-erasure guarantee.

The versioned container authenticates its header and ciphertext with a fresh
12-byte nonce and a 16-byte GCM tag. The key is 32 random bytes. The encrypted
payload includes database name, creation time, SQL and its digest. Exported SQL
is limited to 32 MiB; very large histories must use another operator procedure.
`inspect` decrypts/authenticates in memory and prints only metadata. A wrong key
or modified ciphertext cannot produce a prepared restore file.

Store a recoverable copy of the key separately from the backup location. Losing
it loses access to these snapshots. Protect the source host as well: encryption
of this file does not encrypt live D1, app traffic or provider backups.

## Schedule explicitly

For a scheduler use `scheduled`, which chooses a unique timestamped filename:

```sh
npm run backup -- scheduled --config config/worker.local.json --database YOUR_DATABASE --key-file /PRIVATE/keys/memory.key --directory /PRIVATE/backups
```

An operator can run it daily through cron/systemd/launchd on a trusted host. Use
absolute paths to Node, the script and config; ensure scoped Cloudflare access
is available non-interactively. A sleeping/offline host does not back up. Check
exit status, last successful snapshot and available disk space; the command
returns nonzero on failure. It does not install a scheduler, delete old snapshots,
manage retention, send alerts or put a Cloudflare credential in the repository.

No periodic backup job has been enabled on the author's machine or cloud account.
The command is ready for an operator-selected schedule and storage policy.

## Prepare a restore into a new database

```sh
npm run backup -- prepare-restore --input /PRIVATE/backups/first.smbak --key-file /PRIVATE/keys/memory.key --output /PRIVATE/restore.sql
```

The SQL output is plaintext, mode 600, and contains the complete D1 snapshot,
including auth hashes and historical text. The command does **not** execute it.
Only use trusted snapshots. Create a new empty D1 database and a separate operator
config pointing `DB` to it; keep that target's Worker disabled and route closed.
Verify the target name/ID before applying:

```sh
npx --no-install wrangler d1 execute YOUR_NEW_EMPTY_DATABASE --remote --config /PRIVATE/restore-worker.json --file /PRIVATE/restore.sql
```

The prepared SQL imports the snapshot and then revokes all bearer/review/OAuth
connections, clears login state, expires outstanding approvals/proposals and
queues current canonical heads for indexing into a fresh vector backend. Old
credentials are not a supported recovery mechanism. The SQL steps are not an
atomic whole-service transaction; leave access closed if import fails midway.

Before opening a replacement instance:

1. Compare canonical heads, complete version payloads, tombstones and receipts
   with the snapshot; inspect the cutoff time and reconcile later purges/deletions.
2. Reconfigure owner identity, bindings, routes, secrets and GitHub callbacks.
   Recreate OAuth KV and client connections. Verify old credentials are denied.
3. Keep semantic search off until a dedicated fresh Vectorize index is built.
   Verify lexical results and reindex status before enabling it.
4. Rehearse owner approval, a second-client read and revocation. Delete the
   plaintext SQL when no longer needed and establish the next backup schedule.

The archive excludes Worker code/config/secrets, provider KV and Vectorize data.
Restoring a D1 copy alone cannot recover those components. The portable
[collection recovery](recovery.md) format remains available separately and omits
D1 authentication state altogether.

## Observed evidence

Local tests cover authenticated roundtrip, randomized ciphertext, overwrite
refusal, wrong keys, tampering, private permissions, symlinks and restored auth
invalidation. An actual cloud D1 export was encrypted, authenticated and imported
into a new isolated D1 database. Canonical heads, complete version payloads and
receipts matched; restored auth was inactive and a reindex job was pending.
The temporary target was then deleted. No personal service/data was used.
This is D1 recovery evidence, not a completed full-service recovery rehearsal,
independent crypto audit or a measured RPO/RTO. See [verification](verification.md).
