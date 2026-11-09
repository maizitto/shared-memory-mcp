# Contributor instructions

Read README.md and docs/architecture.md first. Keep this repository independent
of personal assistant installations. Use fictional fixtures only. Never import
personal conversations, health records, credentials or deployment configuration.

The canonical ledger, approval capability and derived search indexes have
different responsibilities. Preserve version checks, transactional receipts,
collection grants, expiry, deletion and canonical hydration after external awaits.

Run npm test, npm run test:workerd, npm run demo, npm run demo:scenarios,
npm run build and npm run check
when changing the extracted service. The workerd harnesses belong only to local
tests. The public Worker must never import them, Node SQLite or filesystem code.

Deployment is an explicit operator action. No CI job or install hook deploys.
Document whether evidence is native SQLite, local workerd, simulated identity or
cloud observation. Test vectors are precomputed model outputs, not live inference.
