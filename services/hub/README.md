# Vistrea Hub

The remote coordination service for cross-device and cross-team sharing. Planned capabilities include:

- commit, ref, and project namespaces
- content-addressed object upload and download
- team spaces, RBAC, auditing, and retention
- organization-wide discovery and search
- Design Baseline, Review Issue, and Tuning Patch collaboration
- push, pull, publish, subscribe, and deep-link APIs

Hub does not replace the local Workspace. It stores shared refs and remote copies while local clients remain available offline and may create new commits.

## Implemented first slice

`startHubServer` is an optional pack relay over shared remote Workspaces (the Hub reuses the same Data layer as every local Workspace). It implements the contract's `GET refs`, `refs:resolve`, `refs:update` (explicit `RefUpdatePrecondition`; forced moves fail closed in the Data layer until the protected-ref policy exists), `packs:import`, and `packs:export` for every configured project namespace, behind a per-project token pair — read-write and read-only (the read-only role lists, resolves, and exports but never mutates refs or imports packs) — so a token for one namespace is not a token for another. Plain HTTP binds loopback interfaces only; configuring TLS (`--tls-cert`/`--tls-key` PEM files) unlocks non-loopback binds for cross-team collaboration.

Run it standalone; the rotating token travels only through a mode-0600 connection descriptor:

```bash
pnpm build:host
node .build/typescript/services/hub/main.js \
  (--project <project_id> --workspace <abs-path>)... [--connection-file <abs-path>]
  [--host <address>] [--port <port>] [--tls-cert <pem> --tls-key <pem>]
```

Auditing, discovery, collaboration endpoints, subscriptions, and richer role models remain later slices.

See [Vistrea Hub API](../../docs/interfaces/HUB_API.md).

Pack exports stream without persisting: storing one pack object per request would let any caller, including a read-only one, grow the Hub's object store without bound. `data/sync/hub-pack-sync.ts` is the client — it pushes with explicit fast-forwards, fetches, and reports divergent refs as conflicts — and has no CLI or Studio surface yet.
