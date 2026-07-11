# Vistrea Hub API

## 1. Scope

Vistrea Hub is an optional remote coordination service for versioned UI knowledge, content-addressed artifacts, permissions, discovery, and collaboration. Local Workspaces remain authoritative for offline work and do not require Hub availability.

The initial service may use HTTP/JSON plus object-transfer URLs. Shared manifests and model semantics remain transport-neutral under `protocol/`.

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

Every resource carries organization and project authorization context.

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
  | { commit_id: string }
  | { ref_name: string };
```

When a ref is selected, Hub resolves it once at query start and returns `resolved_commit_id` with the response. Pagination remains pinned to that Commit; there is no project-global implicit "current" collaboration value.

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

## 11. Security and data lifecycle

- All transfers use authenticated encryption in transit.
- Objects are encrypted at rest according to organization policy.
- Redaction is validated before publication.
- Access, export, ref update, permission, and deletion operations are audited.
- Retention operates on commit reachability, pinning, policy, and artifact class.
- Content hash namespaces must not leak cross-tenant object existence.
- Deletion creates an auditable tombstone where policy requires it.

## 12. Required contract tests

- ref compare-and-set conflict;
- missing-object negotiation and resumable upload;
- commit manifest upload and canonical identity rejection;
- protocol-version negotiation;
- permission-filtered search;
- unauthorized hash non-disclosure;
- pack and sync manifest compatibility;
- Review Issue optimistic concurrency;
- collaboration mutation, Commit creation, and ref update atomicity;
- retention and reachable-object protection;
- offline local commit followed by push and pull convergence.
