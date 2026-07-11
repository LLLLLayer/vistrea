# In-memory Data Adapter

`data/memory` is the deterministic, driver-free reference implementation of the Phase 0B Data API. It provides:

- one consistent read snapshot per Unit of Work;
- atomic write commit and rollback;
- runtime rejection of repositories from another Unit of Work;
- revision `1` creation and compare-and-set `N + 1` updates;
- immutable Snapshot, Observation, event, comparison, verification, Build Diff, Commit, and Tag records;
- atomic Validation Run/Finding summaries;
- durable Operation event/result lifecycle semantics;
- Working Set and Ref compare-and-set behavior;
- deterministic clocks and IDs;
- a seed assembled from Phase 0A2 canonical fixtures.

The adapter has no SQLite or Object Store driver dependency. Verified ObjectRefs are registered before metadata transactions, matching the production rule that object bytes finish and verify before metadata references become visible.

It is a reference and test adapter, not durable storage. The SQLite implementation must pass the same public contract tests.
