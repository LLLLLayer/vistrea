# Data Model Coverage

Status: **Verified for protocol version 1.0 pre-release 2**

## 1. Purpose

Phase 0A2 freezes the executable shared model surface required by one complete `DataUnitOfWork`. Swift, Kotlin, Host, Data, Studio, Hub, CLI, and Skills must consume these models from `protocol/`; they must not create private canonical equivalents.

The machine-readable coverage manifest is `protocol/model-coverage/v1.json`. Validation fails when a declared model fragment is absent or cannot compile under strict Ajv 2020 mode.

## 2. Repository coverage

| Data repository | Canonical shared values |
|---|---|
| Snapshots | `RuntimeSnapshot`, `UiNode` |
| Observations | `Observation` |
| Runtime events | `RuntimeEvent`, `RuntimeEventBatch` |
| Screen graph | `GraphContext`, `Action`, `ScreenState`, `Transition`, `StateIdentityDecision`, `ScreenGraph` |
| Wiki | `WikiNode`, `WikiLink`, `KnowledgeCollection`, `KnowledgeGraph` |
| Design reviews | `DesignReference`, `DesignRegionMapping`, `DesignComparison`, `ReviewIssue`, `ReviewVerificationRecord`, `TuningPatch`, `TuningApplication`, `DesignReviewBundle` |
| Validation | `ValidationRun`, `ValidationFinding`, `ValidationSuppression`, `ValidationEvidence`, `BuildDiff`, `ValidationBundle` |
| Operations | `OperationRef`, `OperationResult`, `OperationEvent`, `OperationRecord` |
| Versions | `Commit`, `CommitManifest`, `Ref`, `Tag`, `WorkingChange`, `WorkingSet`, `VersionSelector`, `RefUpdatePrecondition` |

Shared support contracts include protocol versions, actors, resource references, mutation preconditions, runtime context, geometry, objects, artifacts, and Workspace bootstrap.

## 3. Aggregate integrity

JSON Schema owns closed field shape and discriminated variants. Repository semantic validation additionally owns relationships that JSON Schema cannot express locally:

- Screen Graph references, context selectors, observation evidence, time ranges, and supersession cycles;
- Wiki links, collection membership, version agreement, timestamps, and supersession;
- design mappings and Difference ownership, Review Issue history, verification evidence, Tuning property/value contracts, application partitioning, and complete reversion;
- Validation lifecycle, current finding summaries, suppression ownership, and Build Diff counts;
- Operation event ordering, state transitions, atomic terminal results, progress consistency, and declared inline result schemas;
- Working Set change identity, object and Commit identity, canonical UTC time ordering, Snapshot trees, screenshot geometry, and Runtime Event Batch integrity.

The aggregate fixtures are transport-neutral interchange examples. Data implementations may normalize them into tables and object files, but reading the same revision must reconstruct an equivalent valid aggregate.

## 4. Phase 0B boundary

Phase 0A2 freezes persisted and exchanged domain values. Phase 0B still defines language-owned Data port request types such as queries, filters, pages, field masks, maintenance commands, and transaction handles. Those types may compose canonical protocol values but cannot redefine their identity, lifecycle, or serialized meaning.

Generated language bindings are optional. Whether generated or handwritten, they must be checked against the same schemas, fixtures, semantic rules, and model coverage manifest.

## 5. Verification

Run:

```bash
pnpm protocol:validate
pnpm test:contract
pnpm check
```

Every fixture is owned by `protocol/fixtures/v1/manifest.json`. Undeclared fixture files, missing fixture files, unregistered coverage references, schema errors, or semantic expectation mismatches fail the check.
