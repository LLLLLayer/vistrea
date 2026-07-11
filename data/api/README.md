# Data API

Storage ports independent of database and transport implementations. Initial ports include:

- `WorkspaceRepository`
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

Operation-level semantics are defined in `docs/interfaces/DATA_API.md`.
