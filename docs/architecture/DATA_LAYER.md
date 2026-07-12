# Vistrea Data Layer

## 1. Purpose

The Data Layer isolates Vistrea Studio, CLI, MCP, Skills, CI, and domain engines from concrete storage and synchronization details.

It must support:

- a fully usable offline local Workspace;
- structured graph and Deep Wiki queries;
- large screenshots, video, Snapshots, design assets, and logs;
- immutable observations and Git-like version semantics;
- portable import/export;
- optional synchronization with Vistrea Hub;
- replacement of local or remote providers without changing product UI.

The Obsidian comparison describes local-first linked knowledge, backlinks, graph navigation, and history. It does not require Markdown files to be the authoritative database for every runtime artifact.

## 2. Layering

```text
Presentation and Agent adapters
apps/studio-macos + integrations/cli|mcp|skills|ci
                         |
                         v
Application and domain behavior
engine/workspace|connection|automation|exploration|design|knowledge
engine/validation|operations|versioning|sync
                         |
                         v
Storage ports
data/api
                         |
                 dependency injection
              /                         \
             v                           v
Local implementations             Remote coordination
data/workspace                     data/sync
data/metadata                      services/hub
data/objects
data/versioning
data/search
data/exchange
                         |
                         v
Shared models and manifests
protocol
```

## 3. Access rules

- Studio Views and ViewModels never issue SQL or construct artifact paths.
- CLI, MCP, Skills, and CI never implement persistence, versioning, or sync rules.
- Engine use cases read and write through `data/api`.
- Data implementations provide persistence, queries, transactions, version metadata, exchange, and synchronization. They do not decide exploration or design-review outcomes.
- Composition roots select local, in-memory test, or synchronized implementations.
- Low-level Workspace maintenance commands may call explicit maintenance APIs. Product mutations still pass through Engine use cases.

This keeps every product surface on one fact base and prevents a separate private database from emerging behind each UI or Agent entry point.

## 4. Local Workspace layout

```text
.vistrea/
├── workspace.json
├── .host.lock
├── metadata.sqlite
├── objects/
│   └── sha256/ab/cdef...
├── refs/
├── exports/
└── cache/
```

This layout is a logical Workspace bundle, not a requirement that data live inside a source checkout. During repository development, `.vistrea/` is the default disposable local path. Studio users may choose another Workspace location, and packaged applications may default to an Application Support directory. `workspace.json` may link to a source repository URI and Git SHA without requiring co-location.

`.host.lock` is the exclusive writable-Host ownership record. It contains no secret and is removed only after the metadata store closes cleanly. SQLite locks still protect transactions, but they do not replace this product-level process boundary. Crash-stale lock recovery is an explicit maintenance operation; normal open never breaks another owner's lock automatically.

### `workspace.json`

Contains Workspace identity, protocol version, project metadata, genesis Commit, default ref, feature capabilities, and optional remote configuration. It must not contain secrets. Workspace creation makes the manifest, genesis Commit, and default ref visible atomically.

### `metadata.sqlite`

Contains queryable metadata and relations:

- builds, sessions, devices, and environments;
- Screen States, Transitions, Events, and Observations;
- selected UI Node index fields;
- Wiki nodes, links, and backlinks;
- Design References, Review Issues, and Tuning Patches;
- commits, parents, refs, tags, and object references;
- migration state and local search indexes.

Complete high-volume UI Trees may remain compressed objects while frequently queried fields are indexed in SQLite. This avoids expanding every native node into an expensive relational record.

### `objects/`

Stores immutable content-addressed payloads:

- screenshots;
- short video and failure windows;
- complete Runtime Snapshots and trees;
- design references;
- logs, traces, and validation evidence;
- generated export payloads when retained.

The object hash identifies content, not its physical location. The same Object Store interface must support local files and remote object providers.

### `refs/`

Caches named local and remote references. SQLite remains authoritative for transactions; the directory may contain recovery or interoperability representations if an ADR chooses that design.

### `exports/`

Generated Markdown, HTML, JSON manifests, and `.vistrea-pack` files. Exports are not the authoritative mutable Deep Wiki.

### `cache/`

Rebuildable thumbnails, visual features, embeddings, and derived indexes. Cache deletion must never lose authoritative knowledge.

## 5. Initial Data API ports

All metadata repositories used by one atomic Engine command come from one transaction-bound `DataUnitOfWork`. Repository instances from different units of work cannot participate in one transaction.

### `WorkspaceRepository`

- create, open, close, and inspect Workspace health;
- run atomic transactions;
- apply migrations;
- back up, compact, and restore.

### `SnapshotRepository`

- persist and load Runtime Snapshots;
- associate ObjectRefs and capture context;
- stream or page large payloads when needed.

### `ObservationRepository`

- append immutable state, transition, event, and artifact observations;
- load observations by stable identity and context;
- preserve corrections as superseding records rather than in-place rewrites.

### `RuntimeEventRepository`

- append validated event batches with durable epoch and sequence evidence;
- query retained events and reconstructed timelines;
- preserve reported gaps without treating filtered sequences as data loss.

### `ScreenGraphRepository`

- query Screen States and Transitions by build and environment;
- materialize version-scoped graph views;
- store explicit state-identity decisions;
- support graph comparison inputs.

### `WikiRepository`

- manage Wiki nodes, links, backlinks, labels, and notes;
- query related screens, components, tests, requirements, and code context;
- preserve edit and version history.

### `DesignReviewRepository`

- store Design References and runtime mappings;
- persist immutable comparisons and verification evidence;
- manage Review Issues, reversible Tuning Patches, and Tuning Applications.

### `ValidationRepository`

- manage Validation Run lifecycle and current Finding summaries;
- persist Findings, Suppressions, evidence, and immutable Build Diffs;
- atomically keep Run counts consistent with Finding state.

### `OperationRepository`

- persist revisioned long-running Operation summaries;
- append one contiguous event stream per Operation;
- atomically store succeeded state, terminal event, and typed result.

### `VersionRepository`

- maintain mutable local Working Sets rooted at a base Commit;
- create immutable commits;
- read parent graphs;
- update refs atomically;
- resolve build, baseline, team, and user-draft refs;
- provide diff inputs.

Creating a Commit from a Working Set and compare-and-set updating its target ref is one metadata transaction. A ref conflict preserves the Working Set.

### `ObjectStore`

- put and retrieve content by hash;
- verify integrity;
- pin or apply retention policy;
- enumerate physical inventory for Workspace GC.

The Object Store does not determine commit reachability. Workspace Engine GC combines Version Repository reachability, Working Sets, pins, and retention policy before authorizing physical deletion.

### `SearchIndex`

- index and search text, routes, components, screens, paths, and issues;
- expose rebuild status;
- rebuild from authoritative data.

### `SyncClient`

- fetch and publish refs;
- compare commit reachability;
- negotiate missing objects;
- push, pull, publish, and subscribe;
- report authorization and conflict state.

Interfaces return protocol models or explicit domain query results. They never expose SQLite rows, file handles, physical paths, or raw HTTP responses.

## 6. Version model

Vistrea requires version semantics for several independent dimensions:

| Dimension | Example | Treatment |
|---|---|---|
| Application build | `build-2026.07.12` | Immutable build context |
| Runtime observation | a captured transition | Immutable evidence |
| Exploration graph | graph for build and environment | Materialized from observations |
| Design baseline | `design-v3` | Versioned ref to a design commit |
| Review workflow | issue state and verification | Versioned collaboration data |
| Tuning preview | a property patch | Versioned reversible design value |
| Wiki editing | notes, labels, links | Versioned knowledge changes |

A Commit is a small immutable manifest:

```text
Commit
├── commit_id
└── manifest
    ├── protocol_version
    ├── parents
    ├── created_at
    ├── author
    ├── message
    ├── build_context?
    ├── roots
    │   ├── runtime_graph?
    │   ├── wiki?
    │   ├── design?
    │   ├── reviews?
    │   └── validation?
    ├── object_hashes
    └── extensions
```

This is the canonical `Commit`/`CommitManifest` shape from `commit.schema.json`. Tuning Patches and other design-review values are represented inside the referenced design or review root object, not as extra Commit fields.

Refs provide mutable names:

```text
users/alice/design-review
teams/im/main
builds/2026.07.12
baselines/design-v3
releases/32.1
```

Vistrea uses Git-like semantics but does not store high-volume runtime objects in Git.

## 7. Observation and graph history

Never overwrite an old path simply because a new exploration did not observe it.

Each Observation records:

- build and source revision;
- environment, account, feature, locale, and device context;
- source state, action, target state, and artifacts;
- capture time and confidence;
- protocol and adapter capabilities.

A graph view is derived for a selected context. State and transition summaries may include `first_seen`, `last_seen`, `seen_in_builds`, and `missing_in_builds` without losing immutable evidence.

This distinction allows Vistrea to tell the difference between removal, conditional availability, and incomplete exploration.

## 8. Portable exchange

`.vistrea-pack` is the portable unit for backup, offline handoff, and pre-Hub sharing.

A pack contains:

- one or more commit manifests;
- selected refs;
- required protocol metadata;
- referenced objects or an explicit thin-pack policy;
- integrity hashes;
- optional redaction and retention metadata.

Pack exchange and Hub sync use the same manifest and object identity model.

The version 1 pack manifest is a protocol model
(`protocol/schema/v1/exchange-pack.schema.json`), the byte framing is fixed by
ADR-0006, and `data/exchange/README.md` documents the implemented exporter and
importer behavior.

## 9. Hub synchronization

```text
Local Workspace A                 Local Workspace B
SQLite + Objects                 SQLite + Objects
        \                             /
         \---- push / pull / sync ---/
                       |
                 Vistrea Hub
         Metadata / Objects / Refs
         Permissions / Audit / Search
```

Synchronization sequence:

1. compare local and remote refs;
2. exchange commit manifests;
3. negotiate missing content hashes;
4. transfer missing objects with resumability;
5. verify integrity, authorization, redaction, and retention policy;
6. update refs atomically;
7. rebuild local indexes or materialized graphs as needed.

Merge behavior depends on data type:

- immutable Observations merge as sets;
- derived graphs are recomputed;
- Wiki text and labels use explicit edit conflict handling;
- Review Issues merge by defined field/state semantics;
- Design Baselines and Tuning Patches require explicit review;
- binary objects are referenced by hash and never content-merged.

## 10. Security and lifecycle

- Redact sensitive text before publication according to project policy.
- Keep tokens and credentials outside Workspace manifests and artifacts.
- Apply separate permission and retention policy to screenshots, video, logs, and traces.
- Scope content hashes to authorization boundaries if global hashes could leak object existence.
- Audit remote reads, writes, ref updates, exports, and permission changes.
- Pin baselines, unresolved issues, and release evidence; allow transient successful-run artifacts to expire.
- Garbage collection removes only objects unreachable from retained commits and active references.

## 11. Usage from UI and Agents

```text
Designer creates a Review Issue in Studio
-> Design Review use case
-> DesignReviewRepository
-> SQLite metadata + screenshot ObjectRef

Coding Agent invokes vistrea-review-design
-> Skill -> CLI or MCP
-> same Design Review use case
-> same Data API and version history
```

All entry points observe and mutate the same versioned data through the same use cases.

## 12. Initial implementation sequence

1. Define Data API and minimal Workspace identity.
2. Implement SQLite metadata and local content-addressed objects.
3. Add commit/ref semantics and `.vistrea-pack`.
4. Make Engine use cases and Data contract tests share the same Data API; Studio and integrations consume those Engine use cases.
5. Add search and retention.
6. Implement Hub sync and the remote service after local semantics are stable.
