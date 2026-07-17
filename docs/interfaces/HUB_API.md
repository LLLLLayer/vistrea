# Vistrea Hub API

## 1. Scope

Vistrea Hub is an optional remote coordination service for versioned UI knowledge, content-addressed artifacts, permissions, discovery, and collaboration. Local Workspaces remain authoritative for offline work and do not require Hub availability.

The initial service may use HTTP/JSON plus object-transfer URLs. Shared manifests and model semantics remain transport-neutral under `protocol/`.

### 1.1 Implemented Hub Beta boundary

The current executable Hub implements project-namespaced refs and pack sync,
five dynamically managed roles, durable direct-project and organization-scoped
team grants, revocable token rotation, an append-only operational audit store,
and a safe pollable activity projection. Team grants inherit into every
associated project, while a token remains invalid outside its exact team. The
local Engine/Host adapter and its Studio/CLI clients can inspect effective
identity, discover the projects visible to a team credential, compare selected
local and remote refs, fetch, fast-forward push, and poll the safe activity
projection. Hub does not yet implement search, subscriptions,
organization-wide roles, multi-team project sharing, guided conflict
resolution, or the versioned Review Issue/Design Baseline/Knowledge Collection
mutation endpoints below.

The additional executable endpoints are:

```text
GET /v1/projects/{project_id}/me
GET /v1/projects/{project_id}/permissions       # admin only
POST /v1/projects/{project_id}/permissions:grant
PATCH /v1/projects/{project_id}/permissions/{principal_id}
DELETE /v1/projects/{project_id}/permissions/{principal_id}
POST /v1/projects/{project_id}/permissions/{principal_id}:rotate-token
GET /v1/projects/{project_id}/audit-events      # admin only, cursor paginated
GET /v1/projects/{project_id}/events            # project activity, cursor paginated

GET /v1/organizations/{organization_id}/teams/{team_id}/projects
GET /v1/organizations/{organization_id}/teams/{team_id}/permissions
POST /v1/organizations/{organization_id}/teams/{team_id}/permissions:grant
PATCH /v1/organizations/{organization_id}/teams/{team_id}/permissions/{principal_id}
DELETE /v1/organizations/{organization_id}/teams/{team_id}/permissions/{principal_id}
POST /v1/organizations/{organization_id}/teams/{team_id}/permissions/{principal_id}:rotate-token
```

Grant and rotation responses return the new bearer token exactly once. The
permission list, audit stream, activity stream, and durable role file never
contain tokens. `events` contains only successful ref, pack, and permission
activity that every project viewer may already observe. A team permission
mutation is audited and projected independently into every associated project.
It never exposes tokens, unauthorized object hashes, failed authorization
details, or the admin audit stream.

## 2. Resource hierarchy

```text
organization
└── team
    └── project
        ├── refs
        ├── commits
        ├── objects
        ├── knowledge collections
        ├── design baselines
        ├── review issues
        └── subscriptions
```

Every associated project carries one organization and team authorization
context. Projects without an association retain project-only authorization.
One team may own multiple projects; one project has at most one owner team in
the Beta. Organization identifiers provide namespace isolation but do not yet
create an organization-wide role.

## 3. Sync endpoints

Conceptual HTTP endpoints:

```text
POST   /v1/protocol:negotiate
GET    /v1/projects/{project_id}/refs
POST   /v1/projects/{project_id}/refs:resolve
POST   /v1/projects/{project_id}/refs:update
GET    /v1/projects/{project_id}/commits/{commit_id}
POST   /v1/projects/{project_id}/commits
POST   /v1/projects/{project_id}/commits:batchGet
POST   /v1/projects/{project_id}/objects:negotiate
POST   /v1/projects/{project_id}/object-uploads
POST   /v1/projects/{project_id}/object-uploads/{upload_id}:finalize
GET    /v1/projects/{project_id}/objects/{sha256}
GET    /v1/projects/{project_id}/sync-conflicts
POST   /v1/projects/{project_id}/sync-conflicts/{conflict_id}:resolve
POST   /v1/projects/{project_id}/packs:import
POST   /v1/projects/{project_id}/packs:export
```

Ref names are carried in request bodies, not raw URL path segments, because names contain `/`. `refs:update` requires the same explicit `RefUpdatePrecondition` as the Data API: `must_match`, `must_not_exist`, or policy-authorized `force`. A mismatch returns `conflict` with the remote target; omission never means force.

`protocol:negotiate` selects manifest and API versions before a sync session. `POST commits` validates canonical identity, parent availability or thin-push policy, object references, and authorization before accepting a manifest.

### 3.1 Implemented local product adapter

Studio and Coding Agents never duplicate Hub pack logic. The Engine owns ref
comparison and sync orchestration, while the authenticated loopback Host
accepts the remote credential only in a bounded JSON request body:

```text
POST /v1/sync/status
POST /v1/sync/fetch
POST /v1/sync/push
POST /v1/sync/activity
```

Every request carries `remote: { base_url, project_id, bearer_token }`. Status
may carry `ref_names`; fetch and push require canonical `ref_names` and
`created_by`; push may include a bounded `message`; activity may include
`after_sequence` and `limit`. The Host response contains only the sanitized
remote origin and Project ID, effective identity and permission sources,
accessible projects, ref relations, transfer reports, conflicts, or safe
activity. It never contains the bearer token.

The strict CLI reads the remote credential only from `VISTREA_HUB_TOKEN` and
provides `sync status`, `sync fetch`, `sync push`, and `sync activity`. Studio
keeps the credential in the current model session, persists only non-secret
form preferences, and clears the credential on disconnect. Fetch and push
advance only ancestry-proven fast-forwards under compare-and-set preconditions
and never force a ref: a non-fast-forward remains `diverged` with both commit
IDs for a later explicit resolution workflow.

Object negotiation request:

```ts
interface NegotiateObjectsRequest {
  offered_hashes: string[];
  requested_hashes?: string[];
}

interface NegotiateObjectsResponse {
  missing_from_hub: string[];
  available_from_hub: ObjectTransferDescriptor[];
  rejected: RejectedObject[];
}
```

Large objects use an upload session and may transfer through scoped pre-signed URLs. Finalization verifies byte count and digest before the object becomes available. Interrupted sessions can resume by provider capability.

## 4. Collaboration endpoints

```text
GET    /v1/projects/{project_id}/review-issues
POST   /v1/projects/{project_id}/review-issues
GET    /v1/projects/{project_id}/review-issues/{issue_id}
PATCH  /v1/projects/{project_id}/review-issues/{issue_id}
POST   /v1/projects/{project_id}/review-issues/{issue_id}:verify

GET    /v1/projects/{project_id}/design-baselines
POST   /v1/projects/{project_id}/design-baselines:promote

GET    /v1/projects/{project_id}/knowledge-collections
POST   /v1/projects/{project_id}/knowledge-collections:publish
POST   /v1/projects/{project_id}/subscriptions
DELETE /v1/projects/{project_id}/subscriptions/{subscription_id}
```

## 5. Collaboration projection model

Review Issues, Design Baselines, and Knowledge Collections are projections of versioned Commit state, not a second mutable source of truth.

Every collaboration list or detail query requires exactly one `VersionSelector`:

```ts
type VersionSelector =
  | { kind: "commit"; commit_id: string }
  | { kind: "ref"; ref_name: string }
  | { kind: "tag"; tag_name: string };
```

This is the canonical protocol `VersionSelector`, not a Hub-private representation. When a ref or tag is selected, Hub resolves it once at query start and returns `resolved_commit_id` with the response. Pagination remains pinned to that Commit; there is no project-global implicit "current" collaboration value.

Every collaboration mutation includes:

- `target_ref`;
- `expected_commit_id`;
- the resource change and expected resource revision;
- actor and policy context.

Hub atomically validates the change, creates a canonical Commit, and compare-and-set updates `target_ref`. Query and search indexes project the resulting Commit state. A conflict returns both current ref and resource revision without creating a visible partial change.

## 6. Discovery and search

```text
POST /v1/search
```

Search scope is explicit:

- organization, team, or project;
- selected refs or published collections;
- resource kinds;
- actor permissions;
- optional runtime context such as build, route, component, or design baseline.

Search never reveals the existence of unauthorized object hashes or resources.

## 7. Authentication and authorization

Initial roles:

- `viewer`: read published authorized content;
- `contributor`: create local/team commits and issues;
- `reviewer`: verify issues and promote baselines;
- `maintainer`: update protected refs and retention policy;
- `admin`: manage team/project permissions and audit access.

Authorization may additionally restrict artifact classes, environments, projects, and redaction profiles.

The executable Beta orders these roles monotonically and currently grants:

| Role | Executable capability |
|---|---|
| `viewer` | read/resolve refs, export packs, read activity |
| `contributor` | viewer plus reserved collaboration contribution capability |
| `reviewer` | contributor plus reserved review capability |
| `maintainer` | reviewer plus import packs, update refs, and future retention management |
| `admin` | maintainer plus permission administration, token rotation, and audit access |

Each project always receives rotating bootstrap admin and viewer tokens for
backward compatibility. `--grant` seeds named principals when the standalone
mode-`0600` permission file is first created; later role mutations atomically
replace that file and survive restart. Each configured team independently
receives bootstrap admin/viewer tokens. `--team-grant` seeds its named
principals in a separate mode-`0600` directory document. A team credential is
accepted by every associated project and nowhere else.

If a principal has both a direct project role and an inherited team role, the
effective project role is the higher one. `GET .../me` returns
`credential_scope` plus `permission_sources`; the project permission list also
returns every source, so an administrator can distinguish an inherited grant
from a direct exception. Team `GET .../projects` reports only child projects
and the caller's effective role in each.

Bootstrap roles cannot be changed or revoked, but their tokens can be rotated.
All bearer tokens are 256-bit random values held by the server only as SHA-256
digests. They rotate on every process start and may be individually rotated
online; the old digest is invalidated before the new one-time response is
returned. One Beta process serves at most 128 projects, 128 teams, 256
principals per project, and 256 principals per team so token checks, audit
fan-out, and permission responses remain bounded.

Permission request bodies are exact and bounded:

```json
{"principal_id":"alice","role":"contributor"}
```

The grant endpoint creates only; a duplicate returns `already_exists`. `PATCH`
accepts only `{ "role": <HubRole> }`. `DELETE` revokes the principal and its
token. Mutation is serialized per project or team, writes an audit attempt,
persists the new role set before changing live authorization, and records
success or failure. Team events fan out to each associated project's audit
stream with `permission_scope: "team"`. Token rotation changes only the
in-memory digest because every token is intentionally reissued after restart.

## 8. Publication model

Teams share immutable knowledge through refs and collections:

```text
users/alice/design-review
teams/im/main
builds/2026.07.12
baselines/design-v3
releases/32.1
```

Publishing updates a selected shared ref or collection after permission and policy checks. It never uploads an unbounded local Workspace implicitly.

## 9. Conflict behavior

- Observations and objects merge by immutable identity.
- Derived graphs recompute locally or remotely.
- Ref conflicts require rebase, merge, or explicit overwrite permission.
- Review Issue fields use revision preconditions.
- Design baseline and Tuning Patch promotion requires review.
- Binary objects never content-merge.

## 10. Events and subscriptions

Initial event kinds:

- `RefUpdated`
- `KnowledgeCollectionPublished`
- `ReviewIssueChanged`
- `DesignBaselinePromoted`
- `ObjectRetentionChanged`
- `PermissionChanged`

The initial client may poll with cursors. Streaming delivery can be added later without changing event semantics.

The current `events` and `audit-events` endpoints accept `cursor=<last
sequence>` and `limit=<1..500>` and always return `next_cursor`. API sequences
are project-local even though the standalone audit file has one strictly
ordered append stream, so cursors do not reveal another project's traffic.
The safe activity projection maps successful grant, role, revocation, and token
rotation operations to `PermissionChanged` without including the credential.
It may contain gaps where project-private audit events were omitted; a gap does
not imply lost activity.

## 11. Security and data lifecycle

- All transfers use authenticated encryption in transit.
- Objects are encrypted at rest according to organization policy.
- Redaction is validated before publication.
- Access, export, ref update, permission, and deletion operations are audited.
- Retention operates on commit reachability, pinning, policy, and artifact class.
- Content hash namespaces must not leak cross-tenant object existence.
- Deletion creates an auditable tombstone where policy requires it.

The standalone Beta stores append-only JSON Lines, an atomic project-role
document, and a separate atomic team-directory document with mode `0600`. A shared
mutation records `attempted` before changing Workspace state and then records
`succeeded` or `failed`. This provides durable intent evidence even if the
post-mutation audit write fails; it is not a claim of a distributed atomic
transaction between the operational audit file and Workspace metadata.
The executable Beta records authenticated role denials, Ref reads and updates,
pack imports and exports, direct and inherited permission mutations and
rotations, team-project discovery, and administrator permission/audit reads.
Team permission attempts and outcomes are copied into every affected child
project's audit stream. It omits
invalid-token attempts and activity-feed polling to prevent unauthenticated or
self-amplifying audit-log exhaustion; deployment ingress owns rate-limited
network authentication telemetry.

## 12. Required contract tests

- ref compare-and-set conflict;
- missing-object negotiation and resumable upload;
- commit manifest upload and canonical identity rejection;
- protocol-version negotiation;
- permission-filtered search;
- direct-plus-team effective-role projection and unrelated-project denial;
- team grant, update, revocation, rotation, audit fan-out, and restart continuity;
- unauthorized hash non-disclosure;
- pack and sync manifest compatibility;
- Review Issue optimistic concurrency;
- collaboration mutation, Commit creation, and ref update atomicity;
- retention and reachable-object protection;
- offline local commit followed by push and pull convergence.
