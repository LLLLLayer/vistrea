# Exploration Engine

Screen State identity, deduplication, and Screen Graph materialization over persisted Snapshots.

`ScreenGraphEngine` implements the first verified slice:

- computes a deterministic structural identity per Snapshot: the ordered hierarchy of node roles, native types, and stable identifiers, excluding volatile node identifiers, geometry, and content, hashed into `layout_digest` under the `structural-v1` normalization profile;
- records state observations, deduplicating by structural identity into one active `ScreenState` per structure with append-only observation evidence and build coverage;
- records transition observations, deduplicating actions and transitions by semantic signature, counting occurrences as exactly the immutable Observation count;
- maintains one coherent materialized `ScreenGraph` per project and application under a deterministic graph identity, revalidating the complete document against the canonical schema and semantic rules on every write;
- reads states, materialized graphs, and acyclic transition paths through the `ScreenGraphRepository` port.

`ExplorationEngine` adds bounded deterministic exploration and path versioning on top:

- walks the running application depth-first over real executed actions: tap candidates come only from nodes the captured tree declares tappable, in sorted stable-identifier order, and system back physically returns after a branch is exhausted;
- captures before and after every action, deduplicates both endpoint states, and records every Transition, so repeated runs create nothing new and only accumulate occurrence evidence;
- stops on the explicit action budget, an exhausted frontier, or a stuck back gesture, and never generates dangerous or forbidden actions;
- freezes the current materialized graph under `tag` version selectors (`tagGraphVersion`) and diffs two frozen materializations (`compareGraphVersions`) so partial and complete coverage runs compare precisely.

The identity and exploration design is recorded in [ADR-0007](../../docs/decisions/0007-screen-state-identity-and-device-automation.md). AI-assisted planning and state restoration remain later slices.

The engine depends on shared protocol models and Data API ports, not UIKit, Android View, device automation providers, or a product frontend.
