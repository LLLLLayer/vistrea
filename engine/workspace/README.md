# Workspace Engine

Owns Workspace application use cases without owning storage layout.

The implemented `WorkspaceMaintenanceEngine` applies product policy to the
online-safe recovery-point lifecycle:

- create a verified manual recovery point with an explicit generated retention
  policy;
- list canonical recovery points and their active policies;
- release exactly one requested policy.

Offline restore, plan-bound garbage collection, interrupted-restore recovery,
and stale-lock recovery remain strict composition-root operations because the
owning Host must be stopped before they run. Broader create, open, close,
upgrade, health, storage-usage, and import/export orchestration stays reserved
until its public Engine contract is stabilized.

It depends on `data/api` ports and never exposes concrete SQLite, file, or Hub implementations to product surfaces.
