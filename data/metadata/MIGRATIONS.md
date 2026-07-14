# SQLite Migration Runbook

This runbook implements [ADR-0004](../../docs/decisions/0004-host-data-and-sqlite-migrations.md). The ADR is authoritative when this guide and the accepted decision differ.

## Layout

```text
data/metadata/
├── MIGRATIONS.md
├── copy-migrations.mjs
├── index.ts
├── migrations/
│   └── 000001_initialize_metadata.sql
├── migrations.ts
├── persistence.ts
└── sqlite-data.ts
```

Migration filenames match:

```text
^[0-9]{6}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$
```

Versions start at `000001`, increase by one, and contain no gaps. The build copies SQL files byte-for-byte into the emitted metadata package. It must fail if a source file is missing from the packaged manifest, if an unexpected SQL file is present, or if a packaged SHA-256 differs from source.

## Authoring rules

Each migration must:

- use UTF-8 without a byte-order mark and LF line endings;
- be deterministic and safe inside one caller-owned transaction;
- use explicit column lists for data copies and inserts;
- define foreign keys and indexes intentionally;
- use `STRICT` tables unless a documented SQLite feature prevents it;
- constrain protocol-safe integer ranges where a value maps to `JsonSafeUInt`;
- preserve immutable observations, commits, evidence, and operation events;
- preserve compare-and-set revisions and ref semantics;
- include a contract or migration test that fails before the change and passes after it.

A migration must not contain:

- `BEGIN`, `COMMIT`, `ROLLBACK`, or `SAVEPOINT`;
- `VACUUM` or `PRAGMA journal_mode`;
- `ATTACH` or cross-database mutation;
- filesystem, network, Object Store, or Hub side effects;
- application-domain decisions that belong in Engine;
- large artifact blobs that belong in `data/objects/`;
- a destructive drop before data has been copied and verified in the same migration plan.

Never edit an applied migration. Add the next numbered file to correct it.

## Connection preflight

Before loading migration files, the adapter opens one writable connection with a `5000` millisecond timeout and verifies:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
```

It then checks:

1. `PRAGMA application_id` is `0x56535452`, or the database is a genuinely empty new database that can be initialized;
2. `PRAGMA user_version` equals the highest ledger version;
3. applied versions are contiguous from one through the current version;
4. every applied filename and exact-byte SHA-256 matches the bundled source;
5. the current version is not newer than the binary;
6. `PRAGMA quick_check` returns `ok`;
7. required SQLite features and compile options are available.

A non-empty database with application ID zero is not a Vistrea database and must not be adopted automatically.

## Ledger

The migrator, not a migration file, creates and owns this table in the migration transaction:

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

`PRAGMA user_version` is a fast mirror. The table is the authoritative history because it records exact filenames and checksums.

## Upgrade algorithm

The implementation follows this order:

1. Discover and validate the complete packaged migration sequence before opening a write transaction.
2. Open the Workspace only far enough to run preflight and determine current and target versions.
3. Reject a lower target, a target newer than the binary, modified history, or an incompatible database.
4. For an existing non-empty Workspace, `LocalDataWorkspace.open` first opens
   the current schema without upgrading, creates a WAL-aware backup through
   SQLite's backup API, independently verifies its schema, ledger, integrity,
   foreign keys, catalog, and metadata, stores it through the Object Store, and
   pins it for migration recovery. The low-level `SQLiteDataStore` still
   requires a synchronous authorization callback and never assumes that a
   backup exists.
5. Start one `BEGIN IMMEDIATE` transaction for the complete pending sequence.
6. Set `PRAGMA application_id = 1448301650` and create the migration ledger when initializing version zero.
7. For each pending migration in ascending order:
   1. execute its exact SQL bytes;
   2. insert one ledger row with version, exact filename, checksum, current UTC time, application version, and `sqlite_version()`;
   3. set `PRAGMA user_version` to that version;
   4. run migration-specific assertions supplied by code, not by later product queries.
8. Run `PRAGMA foreign_key_check` and required schema assertions.
9. Commit only after the requested target is fully valid.
10. Reopen through the normal health path before making the Workspace available.

Migration code is synchronous while the transaction is active. It must not `await`, stream an object, call the network, or yield ownership of the connection.

## Failure and recovery

| Failure | Required result |
|---|---|
| Lock unavailable | Return a typed busy/in-use error after the configured timeout; do not mutate |
| Preflight mismatch | Return a typed compatibility or integrity error; do not mutate |
| SQL or assertion failure | Roll back the entire pending migration batch |
| Process termination | Let SQLite recover the uncommitted WAL transaction on next open |
| Disk full or I/O error | Roll back when possible, close the Workspace, retain backup and diagnostics |
| Version newer than binary | Refuse write access; require a compatible application |
| Migration checksum mismatch | Refuse write access; never rewrite the ledger to match edited source |
| Post-commit health failure | Close the Workspace and offer explicit restore from the verified backup |

There are no automatic down migrations. Restore closes every connection, materializes a verified backup to a temporary file on the same filesystem, validates it, atomically replaces the closed database, preserves the failed database for diagnosis, and reopens through the standard migration path.

Never restore metadata alone when the recovery point references objects that are unavailable. Full Workspace backup and `.vistrea-pack` rules remain responsible for required Object Store payloads.

## Review checklist

Before accepting a migration:

- [ ] filename is the next six-digit version and uses a lowercase snake-case name;
- [ ] prior migration files are byte-identical;
- [ ] new database reaches the latest schema;
- [ ] every retained prior-version fixture reaches the latest schema;
- [ ] the pending sequence rolls back when failure is injected before and after every statement group;
- [ ] `user_version`, ledger rows, filenames, and checksums agree after success;
- [ ] `quick_check` and `foreign_key_check` pass;
- [ ] immutable rows remain immutable and revisioned rows preserve revisions;
- [ ] relevant query plans use intended indexes;
- [ ] backup and explicit restore pass;
- [ ] in-memory and SQLite Data contract suites remain behaviorally equivalent;
- [ ] no artifact bytes or product-domain behavior moved into SQLite;
- [ ] packaged migrations have the same bytes and checksums as source.

## Upgrade checklist for `better-sqlite3`

When changing the exact driver version:

- review the driver release notes and embedded SQLite release history;
- reinstall or rebuild the native addon for every release Node ABI and CPU architecture;
- record `SELECT sqlite_version()` and `PRAGMA compile_options`;
- run native-load, migration, parity, backup/restore, abrupt-termination, and disk-full tests;
- verify the oldest supported Workspace still opens and upgrades;
- verify the packaged Studio Host locates the bundled native binding without relying on the developer machine.
