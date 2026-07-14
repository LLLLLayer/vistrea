# ADR-0011: Hub uses project RBAC and a separate operational audit log

- Status: Accepted
- Date: 2026-07-14
- Owners: Hub, Data, and collaboration lanes
- Related contracts: `docs/interfaces/HUB_API.md`, ADR-0003, ADR-0006

## Context

Vistrea Hub must let teams share versioned UI knowledge without making the
remote service a second mutable source of truth. The existing Hub pack relay
already transfers canonical Commits, Refs, and content-addressed objects, but
its anonymous write/read token pair cannot express team responsibilities or
provide durable evidence of privileged operations.

Collaboration content and operational security evidence have different
lifecycle rules. Review Issues, Design Baselines, Knowledge Collections, and
Tuning Patches must remain portable and version-selectable through Commit/Ref
history. Access decisions and attempted mutations must instead remain durable
even when a content mutation fails or a user later moves a Ref.

## Decision

1. Hub authorization is project scoped and uses five monotonically ordered
   roles: `viewer`, `contributor`, `reviewer`, `maintainer`, and `admin`.
   Maintainers may import packs and update Refs; administrators additionally
   read project permissions and the operational audit stream. Contributor and
   reviewer capabilities are reserved for their versioned collaboration
   endpoints rather than granting low-level Ref mutation.
2. Each Hub process issues independent opaque tokens for named principals.
   The existing write and read tokens remain compatible as bootstrap admin and
   viewer principals. Tokens exist only in the private mode-`0600` connection
   descriptor and never appear in permission, audit, or activity responses.
3. Authenticated role denials and sensitive project operations append to a
   `HubAuditStore`. The standalone composition uses a mode-`0600`, append-only
   JSON Lines file with strictly increasing server-global storage sequences.
   API cursors and returned sequences are projected into project-local
   ordinals so they do not disclose another project's traffic. The file is
   server-owned operational state, not a Workspace Commit root, portable pack
   member, or Data API repository.
4. A shared-state mutation must persist an `attempted` audit event before it
   touches the Workspace and then append `succeeded` or `failed`. Failure to
   write the attempt fails closed. A post-mutation audit failure may make the
   request result uncertain, so clients reconcile through canonical Refs
   rather than assuming that an HTTP failure rolled back shared state.
5. The project activity feed is a least-privilege projection of successful Ref
   and pack audit events. It omits denials, failed operations, tokens, and the
   administrator audit stream. Collaboration resources themselves remain
   projections of canonical Commit state selected by an explicit version.
6. Invalid or cross-project bearer tokens return the same unauthenticated
   response and are not written to the project audit file. This avoids both
   namespace disclosure and unauthenticated audit-log exhaustion; deployment
   ingress may retain rate-limited network authentication telemetry.
7. The Beta manages grants at process startup. Permission mutation, token
   rotation APIs, organization/team inheritance, external identity providers,
   retention automation, and deployment-grade audit export remain later work.

## Alternatives considered

### Store collaboration rows directly in a Hub database

This would make local history and remote collaboration disagree and would
require a separate conflict model. It is rejected in favor of Commit/Ref truth.

### Put security audit records inside Workspace Commits

Users can move Refs, exchange only part of history, and garbage-collect
unreachable content. Those semantics are wrong for operational audit evidence,
so the audit store remains separate.

### Give contributors low-level pack import and Ref update

Pack import may create or advance shared Refs. Until collaboration mutations
create canonical Commits behind policy-aware compare-and-set operations, those
powers remain maintainer-only.

### Return one project-wide token per role

Shared tokens cannot attribute operations to a principal and make selective
revocation impossible. Per-principal issuance is required even before dynamic
rotation exists.

## Consequences

### Positive

- Every authorized request has one project identity and explicit capability
  boundary.
- Audit intent survives content-operation failure and is queryable by project
  administrators.
- Viewers can follow safe collaboration activity without receiving security
  evidence or secrets.
- Local Workspaces and portable packs remain independent of Hub availability.

### Negative

- Audit and Workspace writes are deliberately not one distributed transaction.
- Startup-managed grants require a Hub restart to add, remove, or rotate a
  principal in the Beta.
- The JSON Lines implementation requires operator rotation after its bounded
  size is reached and is not a multi-node audit backend.

### Risks and mitigations

- Audit-file substitution and concurrent writers are mitigated by absolute
  paths, no-follow opening, an exclusive sidecar ownership lock, regular-file
  validation, private permissions, strict event validation, and monotonic
  sequence checks on reopen. Crash-stale lock recovery is explicit.
- A cross-project token oracle is prevented by authorizing only against the
  requested project and returning one unauthenticated error shape.
- A response may be uncertain after a successful mutation and failed outcome
  append; explicit Ref reads and compare-and-set retries provide reconciliation.
- Activity-feed disclosure is bounded to successful actions already observable
  by project viewers.

## Compatibility and migration

Existing Hub clients continue to use `bearerToken` as bootstrap admin and
`readOnlyToken` as bootstrap viewer. The sync and pack contracts do not change.
Named grants and audit endpoints are additive service behavior; no Workspace,
protocol fixture, or `.vistrea-pack` migration is required.

## Validation

Integration coverage is written for role hierarchy, project isolation,
bootstrap compatibility, token non-disclosure, role-denial audit, mutation
attempt/outcome audit, safe activity projection, private file mode, and audit
sequence continuity after reopen. Execution is intentionally deferred while
the project owner has paused testing.
