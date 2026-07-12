# Exploration Engine

Screen State identity, deduplication, and Screen Graph materialization over persisted Snapshots.

`ScreenGraphEngine` implements the first verified slice:

- computes a deterministic structural identity per Snapshot: the ordered hierarchy of node roles, native types, and stable identifiers, excluding volatile node identifiers, geometry, and content, hashed into `layout_digest` under the `structural-v1` normalization profile;
- records state observations, deduplicating by structural identity into one active `ScreenState` per structure with append-only observation evidence and build coverage;
- records transition observations, deduplicating actions and transitions by semantic signature, counting occurrences as exactly the immutable Observation count;
- maintains one coherent materialized `ScreenGraph` per project and application under a deterministic graph identity, revalidating the complete document against the canonical schema and semantic rules on every write;
- reads states, materialized graphs, and acyclic transition paths through the `ScreenGraphRepository` port.

Action candidate generation, dangerous-operation filtering, deterministic BFS/DFS exploration, AI-assisted planning, and state restoration remain later slices.

The engine depends on shared protocol models and Data API ports, not UIKit, Android View, device automation providers, or a product frontend.
