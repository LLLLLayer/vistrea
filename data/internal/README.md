# Data Adapter Internals

This private module contains deterministic state and repository mechanics shared by the in-memory reference adapter and the production SQLite adapter.

It is not a public Data API. Engine, Studio, integrations, and other consumers must import `data/api` ports instead.

Storage adapters provide their own transaction shells:

- `data/memory` clones and atomically swaps deterministic state;
- `data/metadata` loads and persists that state through real SQLite transactions.

Keeping repository invariants here prevents the two adapters from diverging on revision checks, immutable records, Validation summaries, Operation streams, and Commit/Ref compare-and-set behavior. Concrete SQLite rows, migrations, paths, and driver types must not enter this module.
