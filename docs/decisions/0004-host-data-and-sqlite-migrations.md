# ADR-0004: TypeScript Host and local SQLite metadata stack

- Status: Accepted
- Date: 2026-07-12
- Owners: Host and Data owners
- Related contracts: `docs/interfaces/DATA_API.md`, `docs/architecture/DATA_LAYER.md`, `data/api/`, `data/metadata/`, `data/objects/`

## Context

Phase 0A froze the cross-platform value models and the complete `DataUnitOfWork` surface. Phase 0B needs one implementation language for the Host Engine and local Data Layer, one production SQLite adapter, and a migration policy that can safely open Workspaces created by older application versions.

The repository is already an ECMAScript-module Node project, pins Node `22.14.0` in `.node-version`, pins pnpm `10.33.0`, and uses Node's built-in test runner. The development machine also has a compatible Node `23.6.1`, SQLite CLI `3.51.0`, Swift `6.2.4`, and Xcode `26.3`, but the operating-system SQLite CLI is not a reproducible application dependency.

The selected stack must preserve these existing boundaries:

- protocol JSON Schemas remain the canonical cross-platform value definitions;
- Engine code depends on `data/api`, never on SQLite or object paths;
- SQLite owns transactional metadata while large immutable payloads belong in the Object Store;
- Studio, CLI, MCP, Skills, and CI invoke the same Engine use cases;
- a local Workspace remains usable without Vistrea Hub;
- migration failure must not expose a partially upgraded schema.

## Decision

### Host and Data language

The Host Engine, Data API, local Data implementations, CLI, and MCP server use strict TypeScript compiled to native ESM and executed by Node.js.

- Phase 0B's release and CI baseline is Node `22.14.0`, matching `.node-version`.
- Source is TypeScript. Hand-maintained JavaScript plus parallel `.d.ts` files is not an accepted substitute for public Data contracts.
- TypeScript emits ESM and declarations before execution. Production and contract tests run emitted JavaScript with Node; they do not depend on runtime type stripping.
- Compiler settings use `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2022"`, `strict: true`, `verbatimModuleSyntax: true`, `declaration: true`, `sourceMap: true`, `declarationMap: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`.
- Relative ESM imports include the emitted `.js` extension in TypeScript source.
- Node's built-in `node:test` runner remains the default test framework.
- Protocol values are generated from or checked against the canonical schemas and fixtures. TypeScript types do not become a second wire-model authority.

The Phase 0B root dependency set is exact rather than ranged:

```json
{
  "dependencies": {
    "better-sqlite3": "12.11.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "7.6.13",
    "@types/node": "22.14.0",
    "typescript": "7.0.2"
  }
}
```

The in-memory `DataUnitOfWork` does not depend on `better-sqlite3`. The driver becomes a runtime dependency when the SQLite adapter is integrated. No ORM, query builder, migration framework, `tsx`, or separate test framework is selected for Phase 0B.

### Product and process boundary

One Node Host process owns each writable local Workspace and composes Engine plus concrete Data implementations. The SQLite connection and native driver stay inside that process.

- The macOS Studio remains a native SwiftUI application in a separate process. It may launch and supervise the Host, but it communicates through public Engine operations over a separately selected local transport.
- CLI and MCP are thin Engine adapters. They connect to the owning Host or start a transient Host composition root when the Workspace is not already owned.
- Studio Views, ViewModels, CLI commands, MCP tools, and Skills never import `better-sqlite3`, execute SQL, or construct object paths.
- Fixture-backed consumers and tests may compose Engine with the in-memory Data implementation in-process.
- The SDK-to-Host transport and the Studio-to-Host local RPC format remain separate decisions. Selecting Node does not change the Runtime Snapshot protocol.

Direct concurrent access to `metadata.sqlite` by multiple product processes is unsupported. SQLite's locking remains a final correctness guard, not the product coordination API.

### SQLite driver and version policy

The production metadata adapter uses `better-sqlite3` `12.11.1` from the committed pnpm lockfile.

Reasons:

- it provides explicit synchronous transactions and `BEGIN IMMEDIATE` support that match one synchronous `DataUnitOfWork` transaction;
- its API keeps all SQL work within one Host process and does not encourage holding a transaction across asynchronous event-loop turns;
- it embeds SQLite rather than depending on the macOS `/usr/bin/sqlite3` or Homebrew CLI version;
- it exposes the SQLite backup API needed for consistent WAL-aware backups;
- it supports ESM and supported Node LTS releases.

`node:sqlite` is rejected for this phase because the pinned Node `22.14.0` documentation marks it Stability `1.1` (Active development). Its API is not covered by Node semantic-version guarantees suitable for the first persistent Workspace format. Reconsidering it requires a later driver ADR and the complete SQLite contract suite; it does not require changing the Data API.

Driver and SQLite upgrades are deliberate changes:

1. update the exact dependency and lockfile in one scoped change;
2. record `SELECT sqlite_version()` and `PRAGMA compile_options` in verification output;
3. run every migration from an empty database and from every retained schema-version fixture;
4. run the full in-memory/SQLite parity suite, backup/restore tests, and a native-load smoke test on each release architecture;
5. confirm the new binary can still open the oldest supported Workspace before release.

The adapter requires SQLite features used by committed migrations and probes them at startup. Initial migrations may rely on foreign keys, JSON1, `STRICT` tables, and FTS5 only after their availability is verified. SQL integer columns representing `JsonSafeUInt` must enforce the protocol-safe range instead of silently accepting larger SQLite integers.

### Native module installation and packaging

pnpm `10.33.0` must explicitly allow only the reviewed `better-sqlite3` install script in root `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "better-sqlite3@12.11.1": true
```

Release artifacts bundle the exact Node runtime and the matching `better_sqlite3.node` native binary. Native binaries are built or installed separately for macOS arm64 and x86_64; they are not copied between Node ABIs or committed to the repository. A Node runtime, driver, CPU architecture, or deployment-target change requires reinstalling or rebuilding the addon and rerunning the native-load smoke test.

Supported Node LTS versions normally use the driver's prebuilt binary. A source fallback requires Python 3, `make`, and an appropriate C/C++ toolchain; macOS builders require Xcode Command Line Tools. CI must fail rather than silently skipping the install script or falling back to a different SQLite provider.

### Connection policy

Every writable metadata connection applies and verifies this policy before repositories become available:

| Setting | Required value | Purpose |
|---|---:|---|
| `PRAGMA application_id` | `0x56535452` (`1448301650`, `VSTR`) | Reject unrelated SQLite files |
| `PRAGMA journal_mode` | `WAL` | Concurrent consistent reads and crash-safe atomic commits on one host |
| `PRAGMA synchronous` | `FULL` | Preserve committed transactions across power loss as far as the platform permits |
| `PRAGMA foreign_keys` | `ON` | Enforce metadata relations on every connection |
| `PRAGMA trusted_schema` | `OFF` | Do not trust schema expressions to invoke application-defined functions |
| `PRAGMA busy_timeout` | `5000` milliseconds | Bound lock contention before returning a typed busy error |
| `PRAGMA wal_autocheckpoint` | `1000` pages | Bound ordinary WAL growth with SQLite's standard checkpoint cadence |

`PRAGMA user_version` mirrors the highest committed migration version for fast inspection. The checksum ledger is authoritative. A read-only connection applies all connection-scoped safety settings it can and rejects unsupported schema versions before exposing repositories.

The Host uses one metadata connection per open Workspace in Phase 0B. A `DataUnitOfWork` never awaits while its SQLite transaction is open. Write units use `BEGIN IMMEDIATE`; read units use one explicit read transaction to retain a consistent snapshot.

### Migration files and ledger

Migration source lives under `data/metadata/migrations/` and uses this immutable naming convention:

```text
000001_initialize_metadata.sql
000002_add_runtime_events.sql
```

- The filename matches `^[0-9]{6}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$`.
- Versions are positive, unique, gap-free integers. The first migration is `000001`.
- Files are UTF-8 without a byte-order mark, use LF line endings, and contain deterministic SQL only.
- Version and identity come from the filename. The ledger stores the exact basename, and SHA-256 is calculated over the exact committed file bytes.
- An applied migration is immutable. A correction is a new migration, never an edit to an applied file.
- Migrations contain no `BEGIN`, `COMMIT`, `ROLLBACK`, `VACUUM`, journal-mode changes, `ATTACH`, or external filesystem side effects.
- The build copies SQL files byte-for-byte beside the emitted metadata package and verifies that the packaged migration manifest matches source checksums.

The migrator owns this infrastructure table; domain migrations do not create or alter it:

```sql
CREATE TABLE __vistrea_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  filename TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  sqlite_version TEXT NOT NULL
) STRICT;
```

Before upgrading, the migrator verifies the application ID, migration sequence, every applied filename/checksum, `user_version`, and `PRAGMA quick_check`. A non-empty database with application ID `0`, a foreign application ID, a ledger gap, a checksum mismatch, or a schema newer than the binary is opened only far enough to report a typed health error; it is never adopted or mutated automatically.

All pending migrations through the requested target run in one `BEGIN IMMEDIATE` transaction. Initializing an empty database sets the Vistrea application ID and creates the ledger inside that transaction. For each file the migrator executes its SQL, inserts its ledger row, and advances `user_version`. It then runs `PRAGMA foreign_key_check` and verifies expected schema invariants before committing. Any error or process termination rolls the whole pending batch back to the prior committed version. Workspace open remains unavailable until the target version passes post-migration health checks.

The exact operational algorithm and author checklist live in [`data/metadata/MIGRATIONS.md`](../../data/metadata/MIGRATIONS.md).

### Backup, recovery, and compatibility

- Creating a brand-new version-zero Workspace applies the current schema and genesis Workspace bootstrap in one initialization flow; there is no empty database to back up.
- Before upgrading any non-empty supported Workspace, `WorkspaceRepository` must create and verify a backup through SQLite's backup API. The backup payload is handed to the Object Store and pinned by Workspace recovery policy before migration begins. Copying only `metadata.sqlite` with a filesystem copy while WAL mode is active is forbidden.
- A migration failure normally needs no restore because the pending batch rolls back. The pre-migration backup remains retained for corruption, disk, or operator recovery.
- Automatic down migrations are not supported. `target_version` may be the current or a higher bundled version only.
- Restore is explicit: close the Workspace, materialize the verified backup to a temporary same-filesystem path, validate application ID, schema version, and `quick_check`, atomically replace the closed database, then reopen it through the normal migration path. Preserve the failed database for diagnostics until recovery is confirmed.
- A metadata backup is not a complete Workspace backup. Workspace backup/export also includes or references every required content-addressed object. SQLite never embeds large artifact bytes to make metadata backup appear complete.
- Support for an old Workspace schema may be retired only after a release note, a tested upgrade path into a still-supported version, and a portable backup/export path exist.

### Object Store boundary

SQLite stores canonical `ObjectRef` values and transactional relations, not screenshots, videos, complete Snapshot trees, design assets, logs, or metadata-backup bytes.

Object writes complete, hash-verify, and atomically publish before a metadata transaction may reference them. Metadata rollback can therefore leave an unreachable object; it must never delete the object inline. Workspace GC later combines Version Repository reachability, Working Sets, pins, retention, and backup policy before authorizing `ObjectStore.deletePhysical`.

No SQLite transaction spans an asynchronous object stream or filesystem operation. This preserves deterministic transaction duration and the Data API rule that metadata visibility is atomic even though files and SQLite cannot share one physical transaction.

## Alternatives considered

### Swift Host and Data Layer

Swift would integrate directly with a SwiftUI Studio and the installed Apple toolchain is capable. It would, however, make CLI and MCP secondary bridges, diverge from the existing Node contract tooling, and still require a separate cross-process Host boundary for non-UI adapters. Swift remains the Studio language, not the shared Host/Data language.

### Handwritten JavaScript with `.d.ts` files

This avoids adding a compiler but creates two manually synchronized public contract surfaces. Phase 0B specifically needs stable, reviewable Data port types, so one strict TypeScript source is preferred.

### Node's built-in `node:sqlite`

It removes a native dependency, but the pinned Node release labels the module Active development and outside normal semantic-version stability. Persistent Workspace compatibility should not depend on that API yet.

### `sqlite3`, an ORM, or a general migration framework

An asynchronous callback driver makes transaction ownership easier to misuse across event-loop turns. An ORM would add another model authority over a protocol-driven graph and does not remove the need for hand-designed indexes, immutable evidence rules, and compare-and-set SQL. General migration frameworks add CLI/runtime packaging assumptions without improving the small forward-only ledger required here. These choices can be revisited only behind the unchanged Data API and its parity suite.

## Consequences

### Positive

- Host, Data, CLI, and MCP share one strict language and module system.
- The in-memory and SQLite adapters can run the same Data contract suite.
- SwiftUI Studio remains isolated from storage and native Node dependencies.
- SQLite transactions map directly to synchronous Units of Work.
- Migration history is deterministic, tamper-evident, forward-only, and crash recoverable.
- SQLite, Object Store, pack, and Hub implementations remain replaceable behind approved contracts.

### Negative

- Studio distribution must bundle and supervise a Node Host process.
- `better-sqlite3` is a native addon that requires architecture- and ABI-specific packaging.
- Synchronous SQL must stay off UI processes and long-running queries may require Worker Threads later.
- Forward-only migrations require backup/restore rather than automatic schema downgrade.

### Risks and mitigations

- Native addon fails to load: build on every release architecture, explicitly allow its pnpm install script, and run a packaged native-load smoke test.
- Event-loop stalls on expensive queries: keep large bytes outside SQLite, require pagination, inspect query plans, and move measured heavy read work to a dedicated Host Worker Thread without changing the Data API.
- Migration drift: checksum every applied file and test every retained version fixture.
- Two product processes write one Workspace: enforce one owning Host process and surface bounded SQLite busy errors instead of exposing direct database access.
- WAL copied without its committed state: require SQLite's backup API and forbid raw live-file copies.
- Driver upgrade changes embedded SQLite behavior: exact-pin the driver and gate upgrades on migration, parity, backup, and compatibility tests.

## Compatibility and migration

This ADR does not change protocol version `1.x` or canonical model identity. It selects the first Host/Data implementation and Workspace schema evolution mechanism.

Changing the Host implementation language, replacing the production SQLite driver, changing migration identity/checksum rules, or changing the application ID requires a superseding ADR. Adding a forward migration, tuning an index, or upgrading an exact dependency within the accepted stack requires the validation above but not a new ADR unless persisted semantics change.

## Validation

- compile all Host/Data TypeScript with the pinned compiler and strict settings;
- run emitted tests on Node `22.14.0` and the repository's supported Node CI range;
- install from the frozen pnpm lockfile with only the reviewed native build enabled;
- load `better-sqlite3`, run `SELECT sqlite_version()`, and verify required compile options;
- validate the complete PRAGMA policy on a new and reopened database;
- migrate empty, every retained prior-version, corrupted-ledger, checksum-mismatch, foreign-application-ID, newer-version, and injected-failure fixtures;
- prove all pending migrations roll back together on every injected failure boundary;
- verify backup, restore, WAL recovery, abrupt-process termination, and disk-full behavior;
- run the same Data contract suite against in-memory and SQLite adapters;
- prove Object Store success plus metadata rollback leaves an unreachable but integrity-valid object for later GC;
- package and smoke-test macOS arm64 and x86_64 Host artifacts;
- verify Studio, CLI, and MCP fixtures use Engine operations rather than concrete Data imports.

## Evidence

- [Node.js `22.14.0` SQLite documentation](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html) records `node:sqlite` as Stability `1.1`.
- [TypeScript compiler guidance](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options) recommends NodeNext semantics for code compiled and run by Node.
- [better-sqlite3 documentation](https://github.com/WiseLibs/better-sqlite3) documents synchronous transactions, WAL use, ESM, Node LTS prebuilds, and driver/SQLite upgrade risks.
- [SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html) defines `BEGIN IMMEDIATE` and consistent read snapshots.
- [SQLite PRAGMA documentation](https://www.sqlite.org/pragma.html) defines application ID, user version, foreign keys, and trusted schema behavior.
- [SQLite WAL documentation](https://www.sqlite.org/wal.html) defines same-host requirements, durability tradeoffs, and WAL-safe handling.
