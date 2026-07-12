# Vistrea Development Progress

Last updated: 2026-07-12

## Status legend

- **Planned**: documented intent; no implementation exists.
- **In progress**: an owned implementation task is active or the broader workstream has verified only a bounded slice.
- **Implemented**: code exists but the required verification is incomplete.
- **Verified**: the stated acceptance boundary has passed and evidence is recorded here.
- **Blocked**: work cannot continue without a decision or external dependency.

## Current delivery status

Two roadmap boundaries are tracked independently:

- **Phase 0: contracts and local data foundation — Verified.** Phase 0A1, Phase 0A2, the Phase 0B local Data foundation, and portable `.vistrea-pack` export/import are verified, which completes the Phase 0 boundary. Readable Markdown/HTML exports remain a later exchange slice.
- **Phase 1: native Snapshot loop — Verified for iOS UIKit and Android View.** Both real native Demo Apps can connect to the production Host, capture a canonical Snapshot and PNG, render the evidence through Studio, read the same Snapshot through CLI, persist it through SQLite and the content-addressed Object Store, and reopen identical data.

The verified Snapshot loops do not imply that the complete product is implemented. Runtime events, device automation, exploration, Screen State identity, design review, protected tuning, full Canvas and Deep Wiki workflows, validation, build diff, CI orchestration, and Vistrea Hub remain later slices.

## Workstream status

| Workstream | Contract revision | Status | Current implementation truth | Verification |
|---|---|---|---|---|
| Product, architecture, and development contracts | `docs-2026-07-12` | Verified | Product invariants, layer boundaries, local-first storage, optional Hub, and multi-agent integration rules | English, local links, structure, and Markdown checks |
| Machine-readable protocol | `v1-pre-release-2` | Verified | Complete shared `DataUnitOfWork` value surface, strict JSON, semantic graph rules, and compatibility fixtures | 78 fixtures and 24 protocol contract tests |
| Shared Demo scenarios | `scenarios-1` | Verified | 12 required Scenario IDs, 6 deterministic profiles, 66 artifacts, and symmetric verified native first-loop contracts | Scenario validator and 14 scenario tests |
| Data API and in-memory adapter | `data-1` | Verified | All nine repositories, transaction-bound Unit of Work, deterministic reference adapter, semantic validation, revisions, and Commit/Ref CAS | 10 memory Data contract tests; commit `5496a24` |
| SQLite metadata | `sqlite-1` | Verified | Forward-only exact-byte migrations, all repositories, durable ObjectRef catalog and associations, transactions, reopen, health, and corruption rejection | 9 SQLite contracts in the 30-test Host contract suite; commit `08359d1` |
| Content-addressed Object Store | `objects-1` | Verified | Encoded-byte SHA-256 identity, atomic publication, integrity checks, range reads, retention, recovery, and symlink-safe paths | 11 Object Store contracts in the 30-test Host contract suite; commit `08359d1` |
| Portable exchange | `data-exchange-1` | Verified | Full and thin `.vistrea-pack` exporter/importer over the shared Commit and ObjectRef identity, protocol pack schema and fixtures, deterministic bytes, and `LocalDataWorkspace.exchange` composition; readable exports remain later | 7 exchange contracts in the 37-test Host contract suite plus a cross-Workspace integration; commit `b801349` |
| Snapshot Engine and production local Host | `local-host-1` | Verified | Capture/Get/List, Object-before-metadata ordering, authenticated Runtime transport, Local API, Runtime session routing, production Workspace composition, and private connection descriptor | 30 Host contracts and 28 Host integrations; commits `87490c4`, `70a6c8f`, `6198de1`, and `28915b7` |
| iOS Runtime SDK and Demo App | `uikit-runtime-loop-1` | In progress | Canonical models, all shared scenarios, UIKit hierarchy/PNG capture, Debug Inspector, hardened Runtime connection, and verified first Snapshot loop exist; events and protected tuning remain | 17 Swift tests in Debug and Release, 4 Node/Swift interop tests, real iOS E2E; commits `4c67fb2`, `be60c0b`, `7671364`, and `74967a6` |
| Android Runtime SDK and Demo App | `android-view-runtime-loop-1` | In progress | Canonical models, all shared scenarios, View/ViewGroup capture, Debug Inspector, protected Runtime connection, Release exclusion, and verified first Snapshot loop exist; events and protected tuning remain | 4 Node/Kotlin interop tests, 5 API 36.1 instrumentation tests, release-boundary verification, and real Android E2E; commit `1925b3a` |
| Vistrea Studio | `snapshot-studio-1` | In progress | Native SwiftUI Host status, capture/list, screenshot, 2D tree, node details, scenario/build/source context, fixture mode, and production acceptance probe; broader product modes remain | 21 Studio tests and Release build; commits `6ccf9f2` and `534517d` |
| Agent integrations | `snapshot-agent-adapters-1` | In progress | Strict JSON CLI and official-SDK stdio MCP expose status plus Snapshot capture/list/get through one authenticated Host client; `vistrea-inspect-runtime` composes inspection | 2 Agent adapter integration tests; commits `2e1d157` and `3dcef77` |
| Automation and exploration | `interfaces-draft-1` | Planned | WDA/UIAutomator contracts and scenario expectations only | No provider or exploration implementation |
| Design review and tuning | `protocol-v1` | Planned | Protocol models, fixtures, interface behavior, and Studio interaction design only | No live comparison, issue, or protected tuning loop |
| Canvas and Deep Wiki | `protocol-v1` | Planned | Protocol models, Data ports, and product interaction design only | No complete product persistence or UI workflow |
| Validation and build diff | `protocol-v1` | Planned | Protocol models, fixtures, and scenario expectations only | No production validator Engine slice |
| Vistrea Hub | `interfaces-draft-1` | Planned | Optional synchronization and collaboration contract only | No service implementation |

Platform `implementation_status` remains `in-progress` in `examples/scenarios/manifest.json` because only `runtime.snapshot` and `runtime.connection` are verified. The broader per-platform capabilities remain planned.

## Accepted decisions

| Decision | Status | Record |
|---|---|---|
| Contract-first module boundaries | Accepted | `docs/decisions/0001-contract-boundaries.md` |
| JSON Schema Draft 2020-12 for protocol v1 | Accepted | `docs/decisions/0002-json-schema-protocol.md` |
| Closed `1.x` core with capability and namespaced-extension evolution | Accepted | `docs/decisions/0002-json-schema-protocol.md` |
| Object, Commit, Ref, and Working Set identity | Accepted | `docs/decisions/0003-object-and-commit-identity.md` |
| Flat UI trees and full-display logical coordinates | Accepted for pre-release v1 | `docs/protocol/RUNTIME_SNAPSHOT.md` and executable schemas |
| Complete `DataUnitOfWork` shared model coverage | Accepted for pre-release v1 | `docs/protocol/DATA_MODEL_COVERAGE.md` and `protocol/model-coverage/v1.json` |
| Host and local Data stack | Accepted | Node.js/TypeScript, `better-sqlite3`, forward-only migrations, and file-backed content-addressed objects in ADR-0004 |
| First vertical-loop boundary | Accepted and verified | iOS-first acceptance in ADR-0005, followed by the symmetric Android View loop |
| `.vistrea-pack` version 1 container and import order | Accepted and verified | ADR-0006 with `protocol/schema/v1/exchange-pack.schema.json` and canonical fixtures |
| Native Runtime transport | Verified | Authenticated bounded loopback JSON lines, best-effort exactly-one capture termination, and Debug/Internal clients only |
| Local product adapter | Implemented | Authenticated loopback HTTP Host Local API with independent per-run credentials |
| macOS UI stack | Implemented for Snapshot scope | Native SwiftUI package and application |

## Implementation checkpoints

| Commit | Outcome |
|---|---|
| `6df8af6` | Completed the Phase 0A2 executable protocol model surface. |
| `4836ff5` | Accepted the Host/Data stack, migration policy, and iOS-first loop boundary. |
| `4c67fb2` | Added the canonical Swift Runtime Snapshot model adapter. |
| `70798f0` | Added executable cross-platform Demo scenarios. |
| `5496a24` | Added the Data API and deterministic in-memory Unit of Work. |
| `1812e63` | Added the canonical Kotlin Runtime Snapshot model adapter. |
| `be60c0b` | Added UIKit Demo scenarios, real capture, and Debug Inspector. |
| `08359d1` | Added production SQLite metadata and content-addressed local storage. |
| `87490c4` | Added the Snapshot Engine, Runtime transport, and local Workspace composition. |
| `560b752` | Added the native Android View scenario Demo and Debug Inspector. |
| `59a237b` | Added canonical Android View runtime capture. |
| `70a6c8f` | Added the authenticated Host Local API. |
| `6ccf9f2` | Added the native macOS Snapshot Studio. |
| `6198de1` | Composed the production local Host and Runtime session router. |
| `7671364` | Connected the iOS Runtime client and UIKit Demo to the Host. |
| `534517d` | Added Studio vertical-loop acceptance evidence and source context. |
| `2e1d157` | Added authenticated CLI and MCP adapters. |
| `3dcef77` | Added the `vistrea-inspect-runtime` Agent Skill. |
| `74967a6` | Added and passed the real persisted iOS vertical-loop acceptance test. |
| `3d7092c` | Added and passed the symmetric real persisted Android vertical-loop acceptance test. |
| `28915b7` | Hardened Host and iOS capture cancellation races and unsupported field-mask handling. |
| `1925b3a` | Connected the protected Android Runtime to Host with Release exclusion and race-safe cancellation. |
| `b801349` | Added portable full/thin `.vistrea-pack` exchange and completed the Phase 0 boundary. |

## Native vertical-loop evidence

### iOS UIKit

- Command: `pnpm test:e2e:ios-real-vertical`
- Result: 1 test passed on iOS 26.3.1 with an iPhone 15 Pro Simulator.
- Scenario: `demo.navigation.basic`
- Snapshot: `snapshot_019f54a5-798c-7481-9be8-76e92c2ae4a9`
- Runtime nodes: 65, including `demo.home.open_catalog`
- PNG: 188,490 bytes, `sha256:c5eb3f5a1f71b00601b581e876bef9b5b040c62e9ef5f1a463c8a15f25868d15`
- Canonical protocol validation passed.
- The production Studio probe and a visible WindowServer window presented the same Snapshot evidence.
- CLI output matched the captured Snapshot exactly.
- Closing and reopening the production SQLite/Object Store returned the identical Snapshot and PNG.
- API and Runtime credentials rotated; generated artifacts were credential-free; temporary Simulator and Workspace resources were removed.
- Acceptance checkpoint: commit `74967a6`.

### Android View

- Command: `pnpm test:e2e:android-real-vertical`
- Result: 1 test passed on a dedicated read-only Android 36.1 emulator.
- Scenario: `demo.navigation.basic`
- Snapshot: `snapshot_019f54a6-8ec8-7fd6-a83b-6ce0feeec9ec`
- Runtime nodes: 12, including `demo.home.open_catalog`
- PNG: 51,800 bytes, `sha256:31888791ee3b98eb4e0efc0112d9f3dbf8c1d30ed16343c76e58fa55d34e22cf`
- Canonical protocol validation passed.
- The 43-byte one-shot Runtime token was installed through standard input with mode `0600`, consumed after handshake, and never entered arguments, child environment, or command output.
- The production Studio probe and CLI read the same Snapshot; SQLite/Object Store reopen returned identical Snapshot and PNG bytes.
- Host credentials rotated; `dumpsys`, `logcat`, Workspace, Studio scratch build, and APK scans were credential-free.
- `adb reverse`, the Demo, emulator, Workspace, and temporary resources were removed.
- Acceptance checkpoint: commit `3d7092c`.

## Verification log

| Date | Scope | Command or evidence | Result |
|---|---|---|---|
| 2026-07-12 | Dependency reproducibility | `pnpm install --frozen-lockfile` | Passed with locked pnpm 10.33.0 |
| 2026-07-12 | Protocol fixtures and coverage | `pnpm protocol:validate` | Model coverage and 78 of 78 fixtures passed |
| 2026-07-12 | Protocol contracts | `pnpm test:contract` | 24 of 24 tests passed |
| 2026-07-12 | Data API memory adapter | `pnpm test:host-contract` | 10 memory contracts passed inside the 30-test Host contract suite |
| 2026-07-12 | Production local storage | `pnpm test:host-contract` | 30 of 30 tests passed: 10 shared repository, 11 Object Store, and 9 SQLite contracts |
| 2026-07-12 | Snapshot Engine, Runtime transport, Host API, local Host, iOS interop, and Agent adapters | `pnpm test:host-integration` before Android transport integration | 24 of 24 tests passed |
| 2026-07-12 | Complete executable check before Android transport integration | `pnpm check` | 78 fixtures, 24 protocol contracts, 30 Host contracts, 24 Host integrations, and 12 Scenario tests passed |
| 2026-07-12 | iOS Runtime models and connection | `swift test --package-path sdks/ios` in Debug and Release | 17 of 17 tests passed in each configuration |
| 2026-07-12 | iOS cross-language transport | Node/Swift interoperability suite | 4 of 4 tests passed, including authentication, coalesced frames, cancellation, close, and token redaction |
| 2026-07-12 | Studio | `swift test --package-path apps/studio-macos`; Release build | 21 of 21 tests and Release acceptance-probe build passed |
| 2026-07-12 | Agent adapters | CLI plus real stdio MCP integration suite | 2 of 2 tests passed |
| 2026-07-12 | Runtime inspection Skill | Skill package validator | Passed for `integrations/skills/vistrea-inspect-runtime` |
| 2026-07-12 | iOS production-backed vertical loop | `pnpm test:e2e:ios-real-vertical` | 1 of 1 passed; exact evidence recorded above |
| 2026-07-12 | Cross-process cancellation hardening | Deterministic Host crossing-completion test, Node/Swift interop, Node/Kotlin stress, and stalled-handshake unit tests | Exactly one of complete/error/cancelled wins; crossing frames drain without poisoning the session; close/caller cancellation cannot strand a connection attempt |
| 2026-07-12 | Android cross-language transport | Node/Kotlin interoperability suite | 4 of 4 tests passed, including 100 near-completion cancellation races, field-mask recovery, capture/object transfer, corruption, close, concurrency, authentication, and redaction |
| 2026-07-12 | Android real View bridge | API 36.1 instrumentation | 5 of 5 tests passed on the main-thread bridge, including unsupported field-mask rejection |
| 2026-07-12 | Android Release security boundary | `sdks/android/tools/verify-runtime-release-boundary.sh` | The Release connection AAR contained no transport classes, the Release Runtime AAR contained no connection bridge, and the Release Demo contained no transport markers or Internet permission; Debug controls remained present |
| 2026-07-12 | Native Scenario contract status | `node examples/scenarios/validate.mjs`; `node --test examples/scenarios/tests/*.test.mjs` | 12 scenarios, 6 profiles, 66 artifacts, both verified loops, and 14 of 14 tests passed |
| 2026-07-12 | Android production-backed vertical loop | `pnpm test:e2e:android-real-vertical` | 1 of 1 passed; exact evidence recorded above |
| 2026-07-12 | Android connection lifecycle regression | `./gradlew :runtime-connection:testDebugUnitTest`; final changed-code detekt | 12 of 12 Debug unit tests passed; stalled-handshake caller cancellation and explicit close both resume without waiting for the 300-second timeout; detekt reported 0 issues |
| 2026-07-12 | Final integrated repository check | `pnpm install --frozen-lockfile`; `pnpm check` | Locked install passed; 78 fixtures, 24 protocol contracts, 30 Host contracts, 28 Host integrations, and 14 Scenario tests passed |
| 2026-07-12 | Exchange pack protocol schema and fixtures | `pnpm protocol:validate` | Model coverage and 84 of 84 fixtures passed, including 6 exchange-pack fixtures |
| 2026-07-12 | Portable `.vistrea-pack` exchange contracts | `pnpm test:host-contract` | 37 of 37 tests passed, including 7 pack contracts: full round trip, deterministic bytes, thin prerequisites, tamper and truncation rejection, ref-conflict reporting, payload rejection, and command validation |
| 2026-07-12 | Cross-Workspace pack transfer | `pnpm test:host-integration` | 29 of 29 tests passed, including one full pack moved between two production local Workspaces through `LocalDataWorkspace.exchange` |
| 2026-07-12 | Complete executable check after exchange | `pnpm check` | 84 fixtures, 24 protocol contracts, 37 Host contracts, 29 Host integrations, and 14 Scenario tests passed |

## Known follow-up gaps

- Readable Markdown/HTML exports (`exportReadable`) and compressed pack payload support remain later exchange slices.
- Compressed Object fixtures do not yet include executable gzip/zstd and byte-range vectors.
- Runtime Event Batch production capture and event timeline are not implemented.
- WDA and UIAutomator providers, action safety enforcement, exploration, recovery, and Screen State deduplication are not implemented.
- Design reference comparison, Review Issue workflow, protected allowlisted tuning, Tuning Patch re-verification, and design-oriented Studio modes are not implemented.
- Full Screen State Canvas, Deep Wiki persistence/search/history, product versioning workflows, validation, and build diff are not implemented.
- SwiftUI and Compose capture adapters remain future platform work.
- CI orchestration and Vistrea Hub synchronization, permissions, discovery, and collaboration are not implemented.

## Next milestones

1. Add production Runtime Event Batch capture and expose the event timeline through Host and Studio.
2. Implement one design-reference comparison, one Review Issue flow, and one protected allowlisted tuning property with apply/revert and re-verification.
3. Add real WDA/UIAutomator actions, safety policy, bounded exploration, and Screen State identity before building the full Canvas and Deep Wiki workflows.
4. Expand validation, build diff, Agent operations, CI, and optional Hub synchronization only after those local workflows are stable.
