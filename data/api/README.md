# Data API

Strict TypeScript storage ports independent of database and transport implementations. Canonical persisted values are branded by their accepted JSON Schema IDs and must pass a `ProtocolValidator`; the Data API does not redefine protocol-owned wire models.

The public source entry point is `index.ts`. Initial ports include:

- `WorkspaceRepository`
- `WorkspaceMaintenancePort`
- `SnapshotRepository`
- `ObservationRepository`
- `RuntimeEventRepository`
- `ScreenGraphRepository`
- `WikiRepository`
- `DesignReviewRepository`
- `ValidationRepository`
- `OperationRepository`
- `VersionRepository`
- `ObjectStore`
- `SearchIndex`
- `ExchangeService`
- `SyncClient`

Interfaces use models from `protocol/` and one transaction-bound `DataUnitOfWork`. They must not expose SQLite rows, file handles, physical paths, or HTTP responses.

`WorkspaceMaintenancePort` is the online-safe recovery-point boundary. It
creates and lists verified retained metadata backups and releases one retention
policy without exposing offline restore, lock recovery, or object paths.

All repositories expose an opaque Unit of Work identity. A composition using repositories from different transactions fails before mutation. Revisioned values use creation revision `1` and compare-and-set replacement revision `N + 1`; immutable evidence rejects a second create.

After `ObjectStore.put` verifies and returns an `ObjectRef`, the composition registers that value with `WorkspaceDataSource.registerVerifiedObjects` before opening a metadata Unit of Work that references it. Registration is an unreachable-object catalog entry, not product reachability.

Operation-level semantics are defined in `docs/interfaces/DATA_API.md`.
