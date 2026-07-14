# Vistrea Hub

The optional remote coordination service for cross-device and cross-team
sharing. Its long-term surface includes:

- commit, ref, and project namespaces
- content-addressed object upload and download
- team spaces, RBAC, auditing, and retention
- organization-wide discovery and search
- Design Baseline, Review Issue, and Tuning Patch collaboration
- push, pull, publish, subscribe, and deep-link APIs

Hub does not replace the local Workspace. It stores shared refs and remote copies while local clients remain available offline and may create new commits.

## Implemented Hub Beta

`startHubServer` is a pack relay over shared remote Workspaces (the Hub reuses
the same Data layer as every local Workspace). It implements the contract's
`GET refs`, `refs:resolve`, `refs:update` (explicit `RefUpdatePrecondition`;
forced moves fail closed until protected-ref authorization exists),
`packs:import`, and `packs:export` for every configured project namespace.

Every project has independent grants using the contract roles `viewer`,
`contributor`, `reviewer`, `maintainer`, and `admin`. The backward-compatible
write token is now the bootstrap admin and the read token is the bootstrap
viewer; named principals are configured with `--grant`. Viewer access covers
refs, export, and the collaboration feed. Contributor/reviewer capabilities are
reserved for their versioned collaboration endpoints. Maintainer adds pack
import and ref update. Admin adds permission and audit visibility. A token from
one namespace remains indistinguishable from an invalid token in another.

The Beta also implements:

- `GET /v1/projects/{project_id}/me` for the caller's role and capabilities;
- admin-only `GET .../permissions`, which never returns tokens;
- admin-only cursor-paginated `GET .../audit-events`;
- project-readable cursor-paginated `GET .../events`, a safe activity
  projection of successful ref and pack operations.

Returned cursors and sequences are project-local even though the durable file
uses one global append order, so one project cannot infer another project's
traffic. A process is bounded to 128 projects and 256 principals per project.

Mutations write an append-only audit attempt before touching shared state, then
record success or failure. The standalone server persists mode-`0600` JSONL
under the first Workspace's `.hub/audit.jsonl` by default; `--audit-log` selects
another absolute path. Audit is operational evidence and is deliberately not a
mutable Commit root. The activity feed projects this log and does not become a
second source of truth for Review Issues, Design Baselines, or Knowledge
Collections. The Beta fails closed when the audit file reaches 256 MiB; an
operator must archive and replace it while Hub is stopped, then reset poll
cursors. A private sidecar lock prevents two Hub processes from appending the
same file; a lock left after process death requires explicit operator recovery.
Epoch-aware online rotation remains a deployment follow-up.

Plain HTTP binds loopback interfaces only. Configuring TLS
(`--tls-cert`/`--tls-key` PEM files) unlocks non-loopback binds and enforces TLS
1.3 for cross-team collaboration.

Run it standalone; the rotating token travels only through a mode-0600 connection descriptor:

```bash
pnpm build:host
node .build/typescript/services/hub/main.js \
  --project <project_id> --workspace <abs-path> \
  --grant alice:contributor \
  --grant riley:reviewer \
  --grant maya:maintainer \
  [--project <project_id> --workspace <abs-path> --grant <principal:role>]... \
  [--connection-file <abs-path>] [--audit-log <abs-path>] \
  [--host <address>] [--port <port>] [--tls-cert <pem> --tls-key <pem>]
```

Permission mutation/rotation, organization and team inheritance, searchable
discovery, versioned collaboration mutations, subscriptions, and user-facing
Studio sync remain later slices.

See [Vistrea Hub API](../../docs/interfaces/HUB_API.md).

Pack exports stream without persisting: storing one pack object per request would let any caller, including a read-only one, grow the Hub's object store without bound. `data/sync/hub-pack-sync.ts` is the client — it pushes with explicit fast-forwards, fetches, and reports divergent refs as conflicts — and has no CLI or Studio surface yet.
