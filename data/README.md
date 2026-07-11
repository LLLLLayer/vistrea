# Data Layer

The local-first Data Layer isolates product UI, Agent integrations, and domain engines from SQLite, file objects, version history, search, import/export, and remote synchronization.

- `api/`: storage ports used by Engine use cases
- `workspace/`: local Workspace lifecycle and implementation composition
- `metadata/`: SQLite metadata, relations, migrations, and transactions
- `objects/`: content-addressed screenshots, videos, Snapshots, and design assets
- `versioning/`: commits, parents, refs, tags, and diff metadata
- `search/`: rebuildable text, structure, and future vector indexes
- `sync/`: Vistrea Hub push, pull, missing-object negotiation, and conflict handling
- `exchange/`: `.vistrea-pack`, Markdown, HTML, and manifest import/export

UI and Agent integrations must never access SQLite or object paths directly. Engine use cases consume `data/api`, and composition roots select concrete implementations.

See [Data Layer architecture](../docs/architecture/DATA_LAYER.md) and [Data API ports](../docs/interfaces/DATA_API.md).
