# Workspace Data

Creates, opens, upgrades, validates, compacts, backs up, and restores local Workspaces. It composes Metadata, Object Store, Versioning, Search, Exchange, and Sync implementations without owning exploration or design-review rules.

## Local composition and lifecycle

`LocalDataWorkspace.open` is the production composition root used by the first Host vertical loop. It:

- canonicalizes and owns one local Workspace directory;
- acquires an exclusive `.host.lock` before opening writable storage;
- composes `SQLiteDataStore` at `metadata.sqlite` with `FileObjectStore` at `objects/`;
- keeps both implementations behind their public Data ports;
- creates independently verified and retained SQLite backups through the
  content-addressed Object Store;
- automatically backs up an existing Workspace before forward migration;
- restores only while offline, with pre-restore evidence and a durable recovery
  journal;
- provides explicit interrupted-restore and dead-owner lock recovery;
- performs conservative offline object GC with dry-run, reachability,
  retention, and age gates;
- releases the ownership lock only after every Unit of Work and the metadata store close cleanly.

The lock is product coordination, while SQLite locking remains the final
transaction correctness guard. Normal open never breaks a stale lock or guesses
through an interrupted restore. Recovery requires an explicit maintenance call
and preserves the old lock or SQLite files under `.recovery/` as evidence.

`LocalDataWorkspace.backup` is safe while the Host owns the Workspace, provided
all Units of Work are closed. `restore`, `recoverInterruptedRestore`, and
`collectGarbage` are static offline operations and acquire the same `.host.lock`
as the Host. GC defaults to dry-run and exported packs/readable documents plus
backup objects are pinned.

The remaining complete `WorkspaceRepository` lifecycle work is atomic
`workspace.json`/genesis/default-ref bootstrap, cache/index compaction, and Hub
sync composition. The current Host's established metadata database and Object
Store remain the implementation truth until that bootstrap contract lands.
