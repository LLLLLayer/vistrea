# Vistrea Development Progress

Last updated: 2026-07-12

## Status legend

- **Planned**: documented intent; no implementation exists.
- **In progress**: an owned implementation task is active.
- **Implemented**: code exists but the required verification is incomplete.
- **Verified**: acceptance checks have passed and evidence is recorded here.
- **Blocked**: work cannot continue without a decision or external dependency.

## Current phase

**Phase 0: contracts and local data foundation — In progress**

Current objective:

> Compose the verified local Data foundation, native Runtime capture, Host Engine, Studio, and Agent adapters into the first production-backed vertical loop without introducing private canonical models or storage bypasses.

## Workstream status

| Workstream | Owner | Contract revision | Status | Current scope | Verification |
|---|---|---|---|---|---|
| Product and architecture documents | Architecture integration | `docs-2026-07-12` | Verified | Product invariants, layers, local-first storage, Hub boundary | English, links, structure, and Markdown checks passed |
| Public interface specifications | Contract integration | `interfaces-draft-1` | Verified | Common, Runtime connection, automation, Engine, Data, Agent, Hub, operation parity | Cross-boundary architecture and interface review completed; blocking findings resolved |
| Multi-agent development contract | Architecture integration | `workflow-1` | Verified | Work lanes, contention rules, handoff and integration order | `AGENTS.md` and `CLAUDE.md` symlink equivalence verified |
| Native Demo App scenarios | Scenario contract owner | `scenarios-1` | Verified | Executable shared Scenario IDs, manifests, profiles, artifacts, and fixture-backed expectations for iOS/Android parity | 12 scenarios, 6 profiles, 66 deterministic artifacts, and 12 tests pass |
| Machine-readable protocol | Protocol owner | `v1-pre-release-2` | Verified | Complete shared model surface for every Data Unit of Work repository | 78 fixtures, model coverage, and 24 contract tests pass |
| Local Data API | Data API owner | `data-1` | Verified | Language-owned ports, deterministic in-memory Unit of Work, semantic validation, and shared contract tests | Strict TypeScript passes; 10 memory contract tests pass; commit `5496a24` |
| Host/Data implementation stack | Host/Data architecture owner | `stack-1` | Verified | Node/TypeScript runtime, SQLite driver, process boundary, migrations, backup, and recovery | ADR and migration runbook reviewed; document checks and `pnpm check` passed |
| SQLite metadata store | SQLite adapter owner | `sqlite-1` | Verified | Real SQLite transactions, all nine repositories, exact-byte migrations, durable ObjectRef catalog and associations, reopen, health, and corruption rejection | 9 SQLite contracts pass inside the 30-test Host contract suite |
| Content-addressed Object Store | Object Store owner | `objects-1` | Verified | Encoded-byte SHA-256 storage, atomic publication, encryption metadata, range reads, retention, recovery, and symlink-safe paths | 11 Object Store contracts pass inside the 30-test Host contract suite |
| Host Snapshot Engine | Connection Engine owner | `fixture-engine-1` | In progress | Fixture-backed Capture/Get/List, Object-before-metadata ordering, validation, rollback/orphan behavior, and authenticated loopback transport | 4 Snapshot Engine integration tests pass; transport implementation active |
| iOS Runtime SDK and Demo App | iOS vertical-loop owner | `uikit-capture-1` | In progress | Canonical Swift models, real UIKit hierarchy/screenshot capture, shared data-driven scenarios, and a Debug-only in-app Inspector are verified; Host connection and protected tuning remain | 9 Swift model tests, Simulator build/launch, and 1 UI navigation/capture test pass; commit `be60c0b` |
| Android Runtime SDK | Android adapter owner | `models-1` | In progress | Canonical Kotlin Runtime Snapshot models are verified; View capture, Inspector, connection, and protected tuning remain | 8 Gradle tests and changed-code detekt review pass; commit `1812e63` |
| Vistrea Studio | Unassigned | `studio-draft-1` | Planned | First vertical-loop UI | Interaction design only |
| Automation and exploration | Unassigned | `interfaces-draft-1` | Planned | WDA/UIAutomator plus bounded exploration | Interface design only |
| Vistrea Hub | Unassigned | `interfaces-draft-1` | Planned | Optional remote sync and collaboration | Interface design only |

## Architecture review

Review scope:

- product and repository boundaries;
- public command, query, event, operation, and error contracts;
- SDK versus device-automation separation;
- Data Unit of Work, versioning, object storage, and Hub synchronization;
- Studio interaction mapping;
- native Demo App parity;
- multi-agent implementation readiness.

Review result: **Approved for Phase 0 implementation**.

The review resolved the blocking inconsistencies found in the initial draft:

- Studio, CLI, MCP, Skills, and CI now consume Data only through Engine use cases.
- Workspace, versioning, sync, and operation ownership exists in both repository structure and Engine contracts.
- Data mutations use one repository-bound Unit of Work; Commit creation and ref compare-and-set are atomic.
- Runtime connection authentication, version negotiation, event acknowledgement, reconnect, and tuning reversion are explicit.
- Automation safety and stale-target checks are owned by Engine, ahead of provider execution.
- Agent operations share one catalog, result model, async lifecycle, and CLI/MCP parity contract.
- Hub objects, commits, refs, resumable uploads, conflicts, and collaboration projections use one local-first truth model.

No current architecture or protocol issue blocks the first vertical loop. iOS UIKit, the Node/TypeScript Host, SQLite metadata, and the file-backed Object Store are accepted and executable; the remaining work is cross-process composition and product-adapter acceptance.

## Accepted decisions

| Decision | Status | Record |
|---|---|---|
| Contract-first module boundaries | Accepted | `docs/decisions/0001-contract-boundaries.md` |
| JSON Schema Draft 2020-12 for protocol v1 | Accepted | `docs/decisions/0002-json-schema-protocol.md` |
| Closed `1.x` core with capability and namespaced-extension evolution | Accepted | `docs/decisions/0002-json-schema-protocol.md` |
| Object, Commit, Ref, and Working Set identity | Accepted | `docs/decisions/0003-object-and-commit-identity.md` |
| Flat UI trees and full-display logical coordinates | Accepted for pre-release v1 | `docs/protocol/RUNTIME_SNAPSHOT.md` and executable schemas |
| Complete `DataUnitOfWork` shared model coverage | Accepted for pre-release v1 | `docs/protocol/DATA_MODEL_COVERAGE.md` and `protocol/model-coverage/v1.json` |
| First native vertical platform | Selected for the first loop | iOS UIKit; Android keeps the same executable Scenario IDs and follows in parallel where the shared contract is stable |
| Host and local Data implementation toolchain | Accepted | `docs/decisions/0004-host-data-and-sqlite-migrations.md` |
| First complete vertical-loop boundary | Accepted | `docs/decisions/0005-ios-first-vertical-loop.md` |

## Completed implementation slice: Phase 0A1

- Added versioned JSON Schema 2020-12 contracts under `protocol/schema/v1/`.
- Added a manifest-owned fixture corpus covering valid, compatibility-valid, JSON-invalid, schema-invalid, and semantic-invalid inputs.
- Added strict JSON parsing that rejects duplicate keys and unsafe integer literals before ordinary decoding.
- Added fatal UTF-8 decoding and Unicode scalar validation so malformed bytes and lone surrogates cannot change identity across platforms.
- Added semantic graph checks for Snapshot-wide node identity, tree references, parent/child agreement, cycles, disconnected nodes, and deep non-recursive traversal.
- Made object-backed tree validation fail closed until the referenced node array is resolved and schema-validated.
- Added full-display and partial-screenshot geometry checks, including bounds, pixel-grid alignment, and decoded raster size.
- Added Runtime Event Batch ordering, epoch, version, range, duplicate, and dropped-count checks.
- Added canonical Commit serialization and digest verification plus Object hash, size, and canonical Base64 checks.
- Defined atomic Workspace genesis Commit/default-ref bootstrap and added a cross-fixture test linking the parentless Commit, Ref, and first Working Set base.
- Added repository-local pnpm commands and GitHub Actions contract verification.

## Completed implementation slice: Phase 0A2

- Added executable Screen Graph contracts for context, actions, states, transitions, immutable observations, and identity decisions.
- Added executable Deep Wiki, design mapping and comparison, Review Issue, verification, Tuning Patch, and Tuning Application contracts.
- Added Validation Run, Finding, Suppression, Build Diff, durable Operation, Artifact, Tag, Working Change, actor, revision, and mutation-precondition contracts.
- Canonicalized UTC timestamps and preserved nanosecond ordering in semantic validation.
- Added aggregate semantic checks for references, time and revision ordering, Issue history, tuning reversion, current Validation summaries, Operation event streams, and locally declared inline result schemas.
- Added `protocol/model-coverage/v1.json` as the executable inventory for all nine `DataUnitOfWork` repositories and their support values.
- Hardened Data port contracts around mutable-resource concurrency, atomic suppression summaries, atomic Operation lifecycle persistence, and persisted design/validation results.

## Active implementation slice: Phase 0B

1. Convert the documented Data ports into language-owned contracts generated from or checked against the shared schemas.
2. Implement a deterministic in-memory `DataUnitOfWork` reference adapter.
3. Add contract tests for atomic Commit/ref update, optimistic concurrency, immutable records, and rollback.
4. Record the Host/Data toolchain and SQLite migration choice in an ADR.
5. Implement SQLite metadata and the file-backed content-addressed Object Store behind the same tests.

## Known follow-up gaps

- Compressed Object fixtures currently cover the encoded-byte identity rules in documentation but not executable gzip/zstd and byte-range vectors.
- Ref fixtures cover a valid team ref and an empty segment; additional category, length, and reserved-segment negatives remain planned.
- Operation inline values validate against a declared local schema, but the complete operation-kind-to-result-type catalog remains documentation until the Phase 0B operation manifest is executable.
- Data query, filter, page, field-mask, maintenance-command, and transaction-handle types remain Phase 0B language contracts; they may compose but cannot redefine shared protocol values.
- The iOS native Demo App and Debug Runtime Inspector now exist. Android Demo parity, the standalone Studio app, automation providers, and Hub service remain open.

## Verification log

| Date | Scope | Command or evidence | Result |
|---|---|---|---|
| 2026-07-12 | Dependency reproducibility | `pnpm install --frozen-lockfile` | Passed with locked pnpm 10.33.0 |
| 2026-07-12 | Phase 0A1 protocol fixtures | `pnpm protocol:validate` | 34 of 34 fixtures passed |
| 2026-07-12 | Phase 0A1 contract tests | `pnpm test:contract` | 21 of 21 tests passed, including Workspace bootstrap and a 15,000-node tree |
| 2026-07-12 | Phase 0A2 protocol fixtures and coverage | `pnpm protocol:validate` | Model coverage and 78 of 78 fixtures passed |
| 2026-07-12 | Phase 0A2 contract tests | `pnpm test:contract` | 24 of 24 tests passed |
| 2026-07-12 | Complete executable check | `pnpm check` | Passed after Phase 0A2 integration |
| 2026-07-12 | Phase 0A2 final review | Independent protocol, interface/documentation, and repository-hygiene audits | All P0/P1 findings resolved; final rechecks passed |
| 2026-07-12 | Phase 0A2 Git checkpoint | Commit `6df8af6` | Phase 0A2 committed on `main`; local branch is one commit ahead of `origin/main` |
| 2026-07-12 | Phase 0B decision checkpoint | Commit `4836ff5` | Host/Data stack, SQLite migration policy, and iOS-first vertical-loop acceptance path committed locally |
| 2026-07-12 | iOS canonical model adapter | `swift test --package-path sdks/ios`; commit `4c67fb2` | 9 of 9 fixture, extension, strict-core, Unicode-limit, and timestamp tests passed |
| 2026-07-12 | Executable Demo scenarios | `node examples/scenarios/validate.mjs`; `node --test examples/scenarios/tests/*.test.mjs`; commit `70798f0` | 12 scenarios, 6 profiles, 66 artifacts, all semantic checks, and 12 of 12 tests passed |
| 2026-07-12 | Data API and in-memory Unit of Work | `pnpm typecheck`; emitted-JS Host contract tests; commit `5496a24` | All nine repositories, semantic-invalid rejection, UoW isolation, rollback, ObjectRef visibility, revisions, operations, validation summaries, Commit/Ref CAS, and deterministic IDs verified in 10 tests |
| 2026-07-12 | Android canonical model adapter | `./gradlew test`; changed-code detekt review; commit `1812e63` | 8 of 8 fixture, extension, strict-core, and timestamp tests passed; detekt passed with no remaining issues |
| 2026-07-12 | iOS UIKit Runtime capture and Demo App | `swift test --package-path sdks/ios`; Simulator package/app builds; `VistreaDemoAppUITests`; commit `be60c0b` | 9 model tests and 1 real navigation-to-Inspector UI test passed; all 12 shared Scenario fixtures decoded at launch and the captured View Tree was non-empty |
| 2026-07-12 | Production local storage | `pnpm test:host-contract` | 30 of 30 tests passed: 10 shared repository, 11 Object Store, and 9 SQLite migration/reopen/transaction contracts |
| 2026-07-12 | Integrated Phase 0B check | `pnpm check` | 78 protocol fixtures, 24 protocol contracts, 30 Host contracts, 4 Snapshot Engine integrations, and 12 Scenario tests passed |
| 2026-07-12 | Final architecture and interface review | Parallel read-only document, interface, and protocol audits | No remaining P0/P1 findings |
| 2026-07-12 | Documentation language | Han-character scan over project Markdown | Passed |
| 2026-07-12 | Documentation integrity | Local-link and code-fence validation | Passed |
| 2026-07-12 | Agent guidance | `CLAUDE.md -> AGENTS.md` symlink and byte comparison | Passed |
| 2026-07-12 | Repository hygiene | Trailing-whitespace scan, runtime-artifact check, and Git status inspection | Passed at the Phase 0A2 checkpoint; tracked working tree was clean after commit |

## Progress log

### 2026-07-12

- Defined product scope, repository layers, Data Layer, local versioning, and optional Hub sharing.
- Defined public interfaces for Runtime connection, automation, Engine, Data, Agent adapters, operation parity, and Hub.
- Defined Studio information architecture and shared native Demo App scenarios.
- Completed architecture, interface, and repository-structure review and resolved all Phase 0 blockers.
- Accepted ADRs for module boundaries, schema format, compatibility, and persisted identity.
- Implemented and verified the Phase 0A1 machine-readable protocol slice.
- Established and pushed the initial Git baseline.
- Implemented and verified Phase 0A2 with separate Screen Graph, Knowledge/Design, and Validation/Operation work lanes plus one integration owner.
- Froze executable shared model coverage for the complete `DataUnitOfWork` and cleared Phase 0B to begin.
- Committed the verified Phase 0A2 checkpoint as `6df8af6`.
- Opened parallel Phase 0B lanes for the Data API and in-memory Unit of Work, the Host/Data stack and SQLite migration ADR, and executable cross-platform Scenario contracts.
- Selected iOS UIKit for the first complete SDK-to-Data vertical loop while retaining shared Scenario IDs for Android parity.
- Accepted the Node/TypeScript Host, `better-sqlite3`, and forward-only SQLite migration policy in ADR-0004.
- Recorded the iOS-first `demo.navigation.basic` acceptance path in ADR-0005, including Data reopen, Studio, and CLI proof requirements.
- Implemented and committed the Foundation-only Swift Runtime Snapshot model adapter without UIKit types or a private wire model.
- Implemented and committed the executable cross-platform Scenario suite; native implementations remain required before its platform statuses can advance.
- Started the Kotlin Runtime Snapshot adapter and file-backed content-addressed Object Store in parallel with Data API contract testing.
- Implemented and committed the complete TypeScript Data port surface and deterministic fixture-backed in-memory Unit of Work.
- Implemented and committed the platform-neutral Kotlin Runtime Snapshot adapter; Android framework capture remains a separate follow-up.
- Froze explicit verified-ObjectRef registration between Object Store success and metadata Unit of Work visibility.
- Started production SQLite metadata and file-backed Object Store implementations behind the verified Data contracts.
- Implemented and committed the native UIKit Demo App, all shared Scenario IDs, real canonical hierarchy/screenshot capture, and a Debug-only in-app Runtime Inspector.
- Completed production SQLite metadata and file-backed Object Store adapters, including exact-byte packaged migrations, durable reopen, encryption metadata, retention recovery, and symlink-safe content paths.

## Next milestones

1. Finish the authenticated loopback Runtime transport and compose the Snapshot Engine with production local storage.
2. Implement the standalone Host local API, first Studio screen, CLI, and MCP adapters over the same Engine use cases.
3. Run and record the complete `demo.navigation.basic` iOS Data-reopen vertical loop.
4. Finish the Android Demo App and Runtime capture against the same Scenario IDs.
5. Advance automation, graph exploration, design review, tuning, and validation slice by slice.
