# Contributing

Start with a small reproducer using fictional text. For changes to ledger,
identity or search, explain the invariant, failure case and verification.

```sh
npm ci --ignore-scripts
npm test
npm run test:workerd
npm run demo
npm run demo:scenarios
npm run build
npm run check
```

Keep credentials, personal deployments and memory exports outside the repository.
Changes to the fresh-install schema require `npm run schema`; existing installed
databases need an explicit incremental migration rather than replaying bootstrap.

Include attribution when adding code or data, and review changes before submitting.
