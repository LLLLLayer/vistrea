# ADR-0012: Hub uses organization-scoped team inheritance

- Status: Accepted
- Date: 2026-07-14
- Owners: Hub, Data, and collaboration lanes
- Related contracts: `docs/interfaces/HUB_API.md`, ADR-0003, ADR-0011

## Context

Project-only grants require an administrator to repeat the same principal and
role across every project owned by one team. That repetition drifts, makes
revocation incomplete, and provides no stable team scope for discovery or
future subscriptions. At the same time, local Workspaces and portable packs
must remain independent of an online identity service.

Team authorization and versioned collaboration content have different
lifecycle rules. Team roles are operational policy, while Review Issues,
Design Baselines, Knowledge Collections, and Tuning Patches remain canonical
Commit/Ref content.

## Decision

1. A configured Hub project belongs to either no team or exactly one team
   identified by `(organization_id, team_id)`. One team may own multiple
   projects, and one Hub process may serve multiple isolated organizations and
   teams. Organization identifiers are namespace boundaries in this Beta; an
   organization-wide role is not inferred.
2. A team issues its own bootstrap admin/viewer credentials and named-principal
   credentials. A valid team credential authorizes the same principal in every
   associated project. It is invalid for projects outside that team.
3. When a principal has both a direct project grant and an inherited team
   grant, the effective project role is the higher role in the accepted Hub
   hierarchy. Identity responses and administrator permission lists expose all
   contributing sources, while also reporting which credential scope was used.
4. Team permission administration mirrors project administration: grant,
   re-role, revoke, and rotate. The private `HubDirectoryStore` persists only
   organization/team identities and named roles. Plaintext tokens remain
   process-local, are stored only as SHA-256 digests by the server, and are
   reissued after restart.
5. Every team permission attempt, outcome, and role denial is written to each
   associated project's operational audit stream. Successful mutations appear
   as token-free `PermissionChanged` activity in every child project. This
   makes inherited changes visible where their authorization effect occurs
   without creating a separate mutable collaboration history.
6. The standalone service configures associations explicitly and uses one
   mode-`0600`, single-writer, atomically replaced directory document. The
   configured team identity set must match the persisted set on reopen; adding
   or removing a team is an explicit stopped-service migration rather than an
   accidental command-line mutation.
7. The implementation is bounded to 128 teams and 256 principals per team per
   process. Search, subscriptions, external identity providers,
   organization-wide grants, cross-team project sharing, and multi-node policy
   storage remain additive service layers.

## Alternatives considered

### Copy every team grant into every project permission file

Copies lose provenance and make partial revocation likely. A separate team
scope with effective-role projection keeps one operational source of truth.

### Store team membership in Workspace Commits

Local users can move Refs, exchange partial history, and garbage-collect
content. Those semantics cannot safely control current remote access.

### Let one project belong to multiple teams immediately

This creates conflict rules for team policy, retention, and discovery before
the single-parent hierarchy is proven. The Beta keeps one explicit owner team;
future cross-team sharing must use a separately reviewed policy rather than
silently adding more parents.

### Create a second organization database first

The Beta needs a durable contract and restart behavior, not a premature
deployment topology. `HubDirectoryStore` is replaceable without exposing file
layout to the server or clients.

## Consequences

### Positive

- One grant or revocation applies consistently across every team project.
- Direct exceptions remain possible and their provenance is visible.
- Team credentials cannot probe unrelated project namespaces.
- Project viewers observe successful inherited changes without receiving
  administrator audit data or credentials.
- Local Workspaces and versioned collaboration models remain unchanged.

### Negative

- One team mutation creates an audit record in every associated project.
- The file-backed directory is single-process and requires an explicit
  stopped-service migration when the configured team set changes.
- The Beta does not yet express organization-wide roles or multi-team project
  sharing.

### Risks and mitigations

- Cross-namespace token oracles are mitigated by authorizing only against the
  requested team or associated project and returning the same unauthenticated
  response for unknown scope and invalid credentials.
- Directory substitution and concurrent writers are mitigated by absolute
  paths, no-follow opening, strict format validation, a private ownership lock,
  fsync, atomic rename, and mode `0600`.
- Permission escalation is bounded by the explicit maximum-role rule and by
  returning both direct and inherited sources in every effective projection.
- Team audit fan-out is bounded by the process project limit and is serialized
  through the existing audit store.

## Compatibility and migration

Projects without `organization_id` and `team_id` retain their project-only
behavior. Existing project tokens, permission files, pack sync, and API routes
are unchanged. Team routes and the `teams` connection-descriptor section are
additive. On first standalone start, `--team-grant` values seed the private
directory; after that, persisted roles are authoritative and every plaintext
credential rotates.

## Validation

Integration coverage proves direct-plus-inherited effective roles, associated
project discovery, unrelated-project denial, online grant/re-role/revoke/token
rotation, audit and activity fan-out, token non-disclosure, private directory
mode and restart continuity, and the standalone two-project descriptor flow.
