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
- keeps caller-declared `excluded_stable_ids` out of the frontier, so Vistrea's own debug tooling (the in-app Inspector launcher) and platform navigation chrome (UIKit's `BackButton`) never count as application behavior;
- captures before and after every action, deduplicates both endpoint states, and records every Transition, so repeated runs create nothing new and only accumulate occurrence evidence;
- treats a lost Runtime capture after an action as a bounded crash-recovery boundary: it relaunches the captured application identity, replays the known stable-ID path from the entry state, verifies every structural Screen State identity, and retries the interrupted action only after exact restoration;
- counts relaunches and restoration replays inside the caller's action budget and reports recovery attempts, successes, and replay counts in `ExplorationReport`; an unknown path or exhausted recovery bound fails honestly instead of guessing;
- stops on the explicit action budget, an exhausted frontier, or a stuck back gesture, and never generates dangerous or forbidden actions;
- freezes the current materialized graph under `tag` version selectors (`tagGraphVersion`) and diffs two frozen materializations (`compareGraphVersions`) so partial and complete coverage runs compare precisely.

Manual identity curation corrects structural misjudgments: `mergeScreenStates` collapses states into one survivor (absorbed digests become dedup aliases, transitions re-point, tombstones keep history) and `splitScreenState` separates observations into a `manual`-identity state that only grows through explicit curation. Both require the expected graph revision and record auditable `StateIdentityDecision`s; the shared semantic rules resolve observation ownership through those decisions and supersession chains.

`ExplorationOperationEngine` runs one walk as a canonical background Operation: created/started/progressed events persist per discovered graph step, the succeeded inline `ExplorationReport` accounts for all provider actions and recovery work, cancellation terminates honestly as `cancelled`, and one Host drives at most one run at a time.

The identity and exploration design is recorded in [ADR-0007](../../docs/decisions/0007-screen-state-identity-and-device-automation.md). AI-assisted planning remains a later slice.

The engine depends on shared protocol models and Data API ports, not UIKit, Android View, device automation providers, or a product frontend.
