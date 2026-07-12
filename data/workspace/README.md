# Workspace Data

Creates, opens, upgrades, validates, compacts, backs up, and restores local Workspaces. It composes Metadata, Object Store, Versioning, Search, Exchange, and Sync implementations without owning exploration or design-review rules.

## Phase 0B local composition

`LocalDataWorkspace.open` is the production composition root used by the first Host vertical loop. It:

- canonicalizes and owns one local Workspace directory;
- acquires an exclusive `.host.lock` before opening writable storage;
- composes `SQLiteDataStore` at `metadata.sqlite` with `FileObjectStore` at `objects/`;
- keeps both implementations behind their public Data ports;
- releases the ownership lock only after every Unit of Work and the metadata store close cleanly.

The lock is product coordination, while SQLite locking remains the final transaction correctness guard. A crash can leave a stale lock; automatic lock breaking is intentionally unsupported because liveness and Workspace ownership must be established explicitly by a future maintenance command.

This composition does not yet implement the complete `WorkspaceRepository` lifecycle: atomic `workspace.json`/genesis/ref creation, WAL-aware backup, restore, compaction, and sync remain separate milestones.
