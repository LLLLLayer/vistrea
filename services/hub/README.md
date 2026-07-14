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
`contributor`, `reviewer`, `maintainer`, and `admin`. A project may additionally
belong to one `(organization_id, team_id)` scope. Team grants inherit into all
of that team's projects; direct and inherited roles combine by taking the
higher role, and responses preserve both sources. A team token is invalid in
unassociated projects. The backward-compatible project write/read tokens are
bootstrap admin/viewer credentials; teams receive separate bootstrap
credentials and named principals are configured with `--team-grant`.

Viewer access covers refs, export, and the collaboration feed.
Contributor/reviewer capabilities are reserved for their versioned
collaboration endpoints. Maintainer adds pack import and ref update. Admin adds
permission and audit visibility. Project and team admins can grant a named
principal, change its role, revoke it, or rotate its token through the Hub API.
Bootstrap roles are protected from change/revocation for compatibility, while
their tokens remain rotatable.

The Beta also implements:

- `GET /v1/projects/{project_id}/me` for the caller's role and capabilities;
- admin-only `GET .../permissions`, which never returns tokens;
- admin-only `POST .../permissions:grant`, `PATCH`/`DELETE
  .../permissions/{principal_id}`, and `POST
  .../permissions/{principal_id}:rotate-token`;
- admin-only cursor-paginated `GET .../audit-events`;
- project-readable cursor-paginated `GET .../events`, a safe activity
  projection of successful ref, pack, and permission operations;
- `GET /v1/organizations/{organization_id}/teams/{team_id}/projects` for the
  caller's effective role in each associated project;
- team-scoped permission list, grant, role update, revocation, and token
  rotation routes mirroring the project administration surface.

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

The standalone service also persists named project roles in a private,
atomically replaced permission document (the first Workspace's
`.hub/permissions.json` by default). `--grant` values seed only its first
creation; subsequent API mutations are authoritative. Bearer tokens are never
written there: the descriptor and one-time grant/rotation responses are the
only plaintext handoff surfaces, while Hub retains SHA-256 digests. Every
process start reissues all tokens. `--permission-file` selects another absolute
path. A sidecar lock prevents concurrent writers.

Organization-scoped team roles use a separate private, atomically replaced
directory document (`.hub/directory.json` by default). `--organization` and
`--team` associate the current project; repeated projects may name the same
team. `--team-grant` values seed only the directory's first creation, and
`--directory-file` selects another absolute path. Team mutations fan out
attempt/success/failure audit evidence and successful token-free
`PermissionChanged` activity to every associated project. The configured team
identity set must match the persisted directory on reopen.

Plain HTTP binds loopback interfaces only. Configuring TLS
(`--tls-cert`/`--tls-key` PEM files) unlocks non-loopback binds and enforces TLS
1.3 for cross-team collaboration.

Run it standalone; the rotating token travels only through a mode-0600 connection descriptor:

```bash
pnpm build:host
node .build/typescript/services/hub/main.js \
  --project <project_id> --workspace <abs-path> \
  --organization acme --team design \
  --grant alice:contributor \
  --team-grant riley:reviewer \
  --project <project_id> --workspace <abs-path> \
  --organization acme --team design \
  [--project <project_id> --workspace <abs-path> \
    [--grant <principal:role>] \
    [--organization <id> --team <id> --team-grant <principal:role>]]... \
  [--connection-file <abs-path>] [--audit-log <abs-path>] \
  [--permission-file <abs-path>] [--directory-file <abs-path>] \
  [--host <address>] [--port <port>] [--tls-cert <pem> --tls-key <pem>]
```

Organization-scoped team inheritance is implemented. Searchable discovery,
organization-wide roles, multi-team project sharing, versioned collaboration
mutations, subscriptions, and user-facing Studio sync remain later slices.

See [Vistrea Hub API](../../docs/interfaces/HUB_API.md).

Pack exports stream without persisting: storing one pack object per request would let any caller, including a read-only one, grow the Hub's object store without bound. `data/sync/hub-pack-sync.ts` is the client — it pushes with explicit fast-forwards, fetches, and reports divergent refs as conflicts — and has no CLI or Studio surface yet.
