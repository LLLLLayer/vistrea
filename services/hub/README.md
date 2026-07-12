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

`startHubServer` is an optional loopback pack relay over one shared remote Workspace (the Hub reuses the same Data layer as every local Workspace). It implements the contract's `GET refs`, `refs:resolve`, `refs:update` (explicit `RefUpdatePrecondition`, never force), `packs:import`, and `packs:export` for a single configured project, behind a per-run bearer token.

Run it standalone; the rotating token travels only through a mode-0600 connection descriptor:

```bash
pnpm build:host
node .build/typescript/services/hub/main.js \
  --workspace <abs-path> --project <project_id> [--connection-file <abs-path>]
```

Multi-project namespaces, non-loopback transport with TLS, RBAC, auditing, collaboration endpoints, and subscriptions remain later slices.

See [Vistrea Hub API](../../docs/interfaces/HUB_API.md).
