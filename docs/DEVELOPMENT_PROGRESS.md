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

The verified Snapshot loops do not imply that the complete product is verified. Device automation, exploration, Screen State identity, design review, protected tuning, Canvas and Deep Wiki, validation, build diff, the CI gate, and the optional Hub are implemented at the maturity recorded per workstream below; the workstream table is the current truth.

## Workstream status

| Workstream | Contract revision | Status | Current implementation truth | Verification |
|---|---|---|---|---|
| Product, architecture, and development contracts | `docs-2026-07-12` | Verified | Product invariants, layer boundaries, local-first storage, optional Hub, and multi-agent integration rules | English, local links, structure, and Markdown checks |
| Machine-readable protocol | `v1-pre-release-2` | Verified | Complete shared `DataUnitOfWork` value surface, strict JSON, semantic graph rules, and compatibility fixtures | 89 fixtures and 24 protocol contract tests |
| Shared Demo scenarios | `scenarios-1` | Verified | 12 required Scenario IDs, 6 deterministic profiles, 66 artifacts, and symmetric verified native first-loop contracts | Scenario validator and 14 scenario tests |
| Data API and in-memory adapter | `data-1` | Verified | All nine repositories, transaction-bound Unit of Work, deterministic reference adapter, semantic validation, revisions, and Commit/Ref CAS | 10 memory Data contract tests; commit `5496a24` |
| SQLite metadata | `sqlite-1` | Verified | Forward-only exact-byte migrations, all repositories, durable ObjectRef catalog and associations, transactions, reopen, health, and corruption rejection | 9 SQLite contracts in the 38-test Host contract suite; commit `08359d1` |
| Content-addressed Object Store | `objects-1` | Verified | Encoded-byte SHA-256 identity, atomic publication, integrity checks, range reads, retention, recovery, and symlink-safe paths | 11 Object Store contracts in the 38-test Host contract suite; commit `08359d1` |
| Portable exchange | `data-exchange-1` | Verified | Full and thin `.vistrea-pack` exporter/importer over the shared Commit and ObjectRef identity, protocol pack schema and fixtures, deterministic bytes, `LocalDataWorkspace.exchange` composition, and the Host API/CLI export and binary-import surfaces; readable exports remain later | 7 exchange contracts plus cross-Workspace and dual-Host API pack transfers; commits `b801349` and `e9d1f77` |
| Snapshot Engine and production local Host | `local-host-1` | Verified | Capture/Get/List, Object-before-metadata ordering, authenticated Runtime transport, Local API, Runtime session routing, production Workspace composition, and private connection descriptor | 38 Host contracts and 85 Host integrations; commits `87490c4`, `70a6c8f`, `6198de1`, and `28915b7` |
| Runtime events pipeline | `runtime-events-1` | Verified | Negotiated `runtime.events` capability with client-declared epochs, Host event pump with durable acknowledgement and reconnect resume, SQLite persistence, `/v1/events` timeline through Local API/CLI, Studio timeline pane, and bounded iOS/Android recorders with Demo transient reporting | Transport, pump, and composed-Host integrations plus Node/Swift and Node/Kotlin event interop; commits `e34d6da`, `7824f29`, `d11dd52`, and `fa9bf88` |
| iOS Runtime SDK and Demo App | `uikit-runtime-loop-2` | In progress | Canonical models, all shared scenarios, UIKit hierarchy/PNG capture, Debug Inspector, hardened Runtime connection, verified first Snapshot loop, negotiated event streaming, protected alpha tuning previews, and SwiftUI content captured as per-element accessibility nodes (requires an active accessibility runtime) exist; automatic UIKit event observation remains | 33 Swift tests in Debug and Release plus 13 UIKit-gated tests on a booted Simulator, 6 Node/Swift interop tests, real iOS E2E; commits `4c67fb2`, `be60c0b`, `7671364`, `74967a6`, `7824f29`, `3511bb5`, `f5ab283`, and `77a2cb1` |
| Android Runtime SDK and Demo App | `android-view-runtime-loop-2` | In progress | Canonical models, all shared scenarios, View/ViewGroup capture, Debug Inspector, protected Runtime connection, Release exclusion, verified first Snapshot loop, negotiated event streaming, protected alpha tuning previews, and full Compose semantics-tree capture through a registered view-semantics extension exist; automatic View event observation remains | 6 Node/Kotlin interop tests, 23 connection unit tests, 6 View-capture and 18 Compose-mapping unit tests, 13 API 36.1 instrumentation tests, artifact-level release-boundary verification of the tuning controller and the Compose surface, and real Android E2E; commits `1925b3a`, `d11dd52`, `4eebcb3`, `c4295f2`, and `a52c64c` |
| Vistrea Studio | `snapshot-studio-3` | In progress | Native SwiftUI Host status, capture/list, screenshot, 2D tree, node details with Debug alpha tuning previews (apply/revert with verbatim rejection reasons), Review Issues with legal lifecycle transitions, Wiki node creation and revisioned editing, Canvas state details with wiki linking, event timeline, SceneKit 3D Layer Inspector, fixture mode with full write parity, a Canvas Explore entry with live Operation progress, Canvas identity curation (merge/split), the Design Review comparison workbench (overlay, severity-colored difference regions, review mode), and the production acceptance probe; Wiki-driven Canvas annotation and issue creation from differences remain | 77 Studio tests and Release build; commits `6ccf9f2`, `534517d`, `fa9bf88`, `c62694e`, `85233cb`, `f5ab283`, `cbefdbe`, `831e37b`, `a0b3cb4`, and `a6191f4` |
| Agent integrations | `agent-surfaces-4` | In progress | One authenticated Host client exposes 54 operations spanning capture, events, design review, tuning, Screen Graph, exploration Operations, Deep Wiki, validation, build diffs, portable packs, and digest-proved object downloads through the strict JSON CLI as the single agent adapter (ADR-0008; named toolset focus via `VISTREA_CLI_TOOLSETS`), five agent skills, an installable Claude Code plugin packaging the exploration-and-assets surface over the CLI, and the headless CI gate that validates the newest Snapshot and fails on baseline-classified build regressions; readable exports remain | Agent adapter round trips, exploration operation integrations, and 5 CI gate integrations; commits `2e1d157`, `e9d1f77`, `914a450`, `7dab236`, `3b96e82`, `748ed8d`, and `433c3ea` |
| Automation and exploration | `automation-exploration-2` | Verified | Structural Screen State identity with dedup into one coherent materialized Screen Graph (Engine, Host API, CLI); semantic action resolution with stale conflicts, risk policy, and confirmation binding; real adb and WebDriverAgent providers behind one port; bounded deterministic exploration with frontier exclusions, frozen graph version tags, and diffs (ADR-0007); both real-input acceptances are verified on dedicated devices, exploration runs as an auditable background Operation through the Host (start/poll/cancel) with a configurable adb or WebDriverAgent provider and from Studio, manual merge/split curation corrects identity misjudgments with auditable decisions, and both devices prove the dangerous-action confirmation path | Graph, automation, WDA wire, exploration, curation, and exploration-operation suites plus both passed device acceptances including the safety segment; commits `ec12b1f`, `8417cab`, `80781ba`, `4c96b22`, `3b96e82`, `748ed8d`, and `be3bec9` |
| Design review and tuning | `design-review-2` | Verified | Design reference/asset registration, confirmed-region frame comparison with stable-ID node resolution, the full Review Issue lifecycle (legal transitions, atomic evidence-backed verification, canonical bundle semantics), and protected alpha tuning (canonical TuningPatch/TuningApplication, negotiated `design.tuning`, rejection reasons, TTL/disconnect reversion) through Engine, Host API, CLI, and a Studio issues pane, plus opt-in mean-color pixel comparison of mapped regions against the decoded design asset (honest partial-quality degrade when images are missing or undecodable); more allowlisted properties and the comparison workbench remain | Design, tuning, and pixel-comparison integrations plus both native tuning interops; commits `1f40a2f`, `c62694e`, `d7f7b9b`, `3511bb5`, `4eebcb3`, and `d02878c` |
| Canvas and Deep Wiki | `knowledge-canvas-1` | In progress | The Deep Wiki persists revisioned Markdown nodes with the draft/published/archived lifecycle, resource links, backlinks, related lookups, and text/kind/label/status search through Engine, Host API, and CLI; Studio renders the Screen State Canvas from the materialized graph, a Deep Wiki search pane, and a SceneKit 3D Layer Inspector; Collection publication (Commit/Ref binding), Wiki editing in Studio, and Canvas curation interactions remain | Knowledge engine integrations with production reopen, agent wiki round trip, and 77 Studio tests; commits `d8dd021` and `85233cb` |
| Validation and build diff | `validation-core-3` | In progress | The `ruleset.vistrea.core` validators judge structural identity coverage, touch targets, labels, geometry sanity, and Screen Graph reachability with persisted runs, exact finding counts, and justified suppressions, now with caller configuration (disabled rules, touch-target threshold) that fails closed on unknown rules and persists into the run for audit; Build Diffs report per-build coverage from observation evidence and classify removals against a frozen baseline graph version as regressed or intentionally removed, with the CI gate failing on regressions only; pixel-level visual regression baselines remain | Validation and build-diff engine integrations including configuration and baseline classification; commits `0fc4e18`, `cc1c139`, `d02878c`, and `433c3ea` |
| Vistrea Hub | `hub-pack-relay-2` | In progress | An optional loopback pack relay serves the contract's ref listing/resolution, precondition-guarded `refs:update`, and `packs:import`/`packs:export` over one shared remote Workspace; `HubPackSync` pushes with explicit fast-forwards (never force), fetches, and reports divergent refs as conflicts; one Hub serves many project namespaces, mints read-write and read-only tokens, and serves TLS (plain HTTP stays loopback-only); auditing, discovery, and collaboration endpoints remain | Hub sync integrations covering push, fetch, byte-identical objects, conflict preservation, fast-forward, namespace isolation, read-only enforcement, and a real TLS round trip; commits `d756cfe`, `7dab236`, and `d5b27b7` |

Platform `implementation_status` remains `in-progress` in `examples/scenarios/manifest.json`. Verified per-platform capabilities now cover `runtime.snapshot`, `runtime.connection`, `runtime.events`, `design.tuning`, `automation.actions`, `state-identity.normalization`, and `exploration.graph` on both platforms; `automation.safety` is now verified on both devices as well; design comparison and validation scenario coverage remain `planned`.

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
| `e34d6da` | Added negotiated Runtime event transport, the durable Host event pump, and timeline surfaces. |
| `7824f29` | Streamed iOS Runtime events through the bounded recorder and Demo transient reporting. |
| `d11dd52` | Streamed Android Runtime events through the bounded recorder and Demo transient reporting. |
| `fa9bf88` | Added the persisted Runtime event timeline pane to Studio. |
| `1f40a2f` | Added design comparisons and the verified Review Issue lifecycle across Engine, Host, CLI, and MCP. |
| `c62694e` | Listed persisted Review Issues in Studio. |
| `d7f7b9b` | Applied and reverted protected tuning through the Host, Engine, CLI, and MCP. |
| `3511bb5` | Previewed and reverted alpha tuning in the iOS Runtime. |
| `4eebcb3` | Previewed and reverted alpha tuning in the Android Runtime. |
| `ec12b1f` | Deduplicated Screen States and Transitions into the coherent materialized Screen Graph. |
| `8417cab` | Resolved and authorized semantic device actions in the Automation Engine. |
| `80781ba` | Drove real Android input through the adb automation provider. |
| `abdcf03` | Explored deterministically and versioned the Screen Graph. |
| `f0e1602` | Wrapped WebDriverAgent as the iOS automation provider. |
| `d8dd021` | Persisted, searched, and linked the Deep Wiki. |
| `0fc4e18` | Validated Snapshots and the Screen Graph with the core rule set. |
| `cc1c139` | Diffed observed coverage between builds. |
| `85233cb` | Rendered the Canvas, Deep Wiki, and 3D Layer Inspector in Studio. |
| `e9d1f77` | Moved portable packs through the Host API, CLI, and MCP. |
| `914a450` | Gated CI on the core validators and shipped three agent skills. |
| `d756cfe` | Synced Workspaces through the optional Hub pack relay. |
| `9b0ffb5` | Bridged SwiftUI and Compose semantics into capture annotations. |
| `7dab236` | Hardened the host stack from the whole-project review: production clock and identity defaults, newest-Snapshot CI gating, bounded path search, Hub response validation, and digest-proved object downloads. |
| `f5ab283` | Hardened the Swift SDK and Studio: JSON-safe wire bounds, truncating capture limitations, off-main screenshot encoding, and tuning stacking parity. |
| `c4295f2` | Hardened the Android SDK: cancellation-safe reversible tuning, contained controller failures, and the recoverable Compose role property. |
| `4c96b22` | Verified both real-device automation acceptances end to end, with display/boot readiness, connection retries, polled navigation evidence, and exploration frontier exclusions. |
| `3b96e82` | Ran exploration as auditable Host Operations with CLI/MCP surfaces and the vistrea-explore-ui skill. |
| `cbefdbe` | Added the Studio operation surfaces: tuning previews, issue transitions, wiki editing, and Canvas wiki linking. |
| `d02878c` | Configured the core validators and compared design pixels through a dependency-free PNG decoder. |
| `748ed8d` | Curated Screen State identity with auditable merges and splits across the stack. |
| `831e37b` | Drove exploration from Studio with live Operation progress. |
| `02d62ac` | Captured the full Compose semantics tree as canonical UI nodes. |
| `9fea473` | Captured SwiftUI content as per-element accessibility nodes. |
| `d5b27b7` | Grew the Hub to multi-project namespaces, TLS, and read-only tokens. |
| `433c3ea` | Classified build-diff removals against a tagged baseline and gated CI on regressions. |
| `be3bec9` | Proved dangerous-action confirmation on both real devices. |
| `a0b3cb4` | Curated Canvas identity and reviewed designs in Studio. |
| `0493d58` | Coalesced the duplicate transition a merge produced instead of stranding an unreachable twin. |
| `6bee4cf` | Kept curation evidence immutable and its invariants unforgeable: redirects live on the decision, not in rewritten Observations. |
| `bdf3452` | Made the baseline reachable through `TagGraphVersion` and isolated the Hub per project, streaming exports without persisting them. |
| `77a2cb1` | Refused Snapshots whose content the capture could not observe, so an unobservable SwiftUI tree cannot become identity. |
| `a6191f4` | Kept a Studio exploration addressable across tab switches and its curation revision guard honest against background reloads. |
| `a52c64c` | Filtered unplaced Compose nodes, bounded captured text, and reported the Compose visual gap instead of fabricating it. |
| `1216dfd` | Focused the agent surface on exploration and assets with MCP toolsets and an installable Claude Code plugin. |
| `671fec4` | Retired the MCP server per ADR-0008; the CLI with `VISTREA_CLI_TOOLSETS` focus is the single agent adapter. |

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
| 2026-07-12 | Runtime event transport, pump, and composed Host | `pnpm test:host-integration` | 39 of 39 tests passed, including subscription negotiation, ordered acknowledged batches, epoch conflicts, pump resume after reconnect, and the composed Host persisting a live TCP event stream |
| 2026-07-12 | Agent event surfaces | `pnpm test:host-integration` (agent adapters) | CLI `events list` and MCP `vistrea_get_event_timeline` returned identical persisted timelines |
| 2026-07-12 | iOS Runtime events | `swift test --package-path sdks/ios` in Debug and Release; Node/Swift interop | 20 of 20 tests passed in each configuration; the Swift client streamed pre-recorded transients and live batches with acknowledgements to the Node Host |
| 2026-07-12 | Android Runtime events | `./gradlew :runtime-connection:testDebugUnitTest`; Node/Kotlin interop; Demo `assembleDebug assembleRelease test lintDebug`; release boundary script | Recorder units, scripted event interop, Demo builds/tests/lint, and the Release boundary all passed |
| 2026-07-12 | Studio event timeline | `swift test --package-path apps/studio-macos`; Release build | 22 of 22 tests and the Release build passed |
| 2026-07-12 | Complete executable check after Runtime events | `pnpm check` | 84 fixtures, 24 protocol contracts, 37 Host contracts, 39 Host integrations, and 14 Scenario tests passed |
| 2026-07-12 | Design review engine, Host API, and adapters | `pnpm test:host-integration` | 43 of 43 tests passed, including stable-ID comparison differences, legal/illegal issue transitions, atomic evidence-backed verification, canonical bundle semantics, and the CLI/MCP design round trip |
| 2026-07-12 | Studio Review Issues pane | `swift test --package-path apps/studio-macos`; Release build | 23 of 23 tests and the Release build passed |
| 2026-07-12 | Protected tuning transport, engine, and agent surfaces | `pnpm test:host-integration` | 49 of 49 tests passed, including tuning capability negotiation, canonical TuningApplication validation, exact applied/rejected partitioning, revert revisioning, and the CLI/MCP tuning round trip |
| 2026-07-12 | iOS Runtime tuning | `swift test --package-path sdks/ios` in Debug and Release; `node --test .build/typescript/tests/integration/ios-runtime-client-interop.test.js` | 22 of 22 tests passed in each configuration; 6 of 6 interop tests passed with the Swift client applying, explicitly reverting, conflict-rejecting, stale-rejecting, and TTL-expiring alpha previews against the Node Host |
| 2026-07-12 | Android Runtime tuning | `./gradlew test :runtime-android:assembleDebug :runtime-android:assembleRelease :runtime-android:lintDebug`; release boundary script; `node --test .build/typescript/tests/integration/android-runtime-client-interop.test.js`; Demo `assembleDebug assembleRelease test lintDebug` | All builds, 17 connection unit tests, the Release boundary, Demo gates, and 6 of 6 interop tests passed with the Kotlin client mirroring the full apply/revert/conflict/stale/TTL tuning sequence |
| 2026-07-12 | Complete executable check after protected tuning | `pnpm check` | 84 fixtures, 24 protocol contracts, 37 Host contracts, 49 Host integrations, and 14 Scenario tests passed |
| 2026-07-12 | Screen State identity, dedup, and graph surfaces | `pnpm test:host-integration` | 53 of 53 tests passed, including structural-identity dedup, transition occurrence counting, semantic revalidation on every graph write, production SQLite reopen, the Host `screen-graph` routes, and the CLI/MCP graph round trip |
| 2026-07-12 | Automation Engine semantic actions | `pnpm test:host-integration` | 55 of 55 tests passed, including stale-target conflicts, coordinate mapping, capability negotiation, risk policy with confirmation-token binding, timeout, cancellation, and busy/closed session gating |
| 2026-07-12 | Real Android adb automation acceptance | `pnpm test:e2e:android-real-automation` | 1 of 1 passed on a dedicated API 36.1 emulator: a real InputManager tap resolved from the persisted Snapshot navigated Home to Catalog, system back returned to Home under one structural identity (deduplicated, no third state), and the Host recorded 2 states, 2 transitions, and a resolvable path |
| 2026-07-12 | WebDriverAgent wire protocol | `node --test .build/typescript/tests/integration/wda-provider.test.js` | 2 of 2 passed against a local fixture driver: W3C pointer sequences in logical points, edge-pop back, `/wda/keys` typing, launch, single cached session with one recreation on invalidation, and tampered-authorization rejection before any wire traffic |
| 2026-07-12 | Deterministic exploration and path versioning | `node --test .build/typescript/tests/integration/exploration-engine.test.js` | 2 of 2 passed: depth-first discovery of three screens with physical back, zero new records on a repeat run, action-budget stop, frozen version tags, and a precise partial-versus-complete coverage diff |
| 2026-07-12 | Complete executable check after Phase 3 engines | `pnpm check` | 84 fixtures, 24 protocol contracts, 37 Host contracts, 59 Host integrations, and 14 Scenario tests passed |
| 2026-07-12 | Deep Wiki lifecycle, search, and links | `pnpm test:host-integration` | 62 of 62 tests passed, including revisioned draft/published/archived transitions, fail-closed link targets, backlinks, related lookups, text search, production Workspace reopen, and the CLI/MCP wiki round trip |
| 2026-07-12 | Core validators and suppressions | `pnpm test:host-integration` | 65 of 65 tests passed, including seven findings across six rules on a seeded problem Snapshot, a clean-Snapshot zero-finding run, category narrowing, count-synchronized suppression with conflict rejection, and behavioral graph reachability |
| 2026-07-12 | Build coverage diffs | `pnpm test:host-integration` | 66 of 66 tests passed, including per-build state and transition coverage entries with exact summary counts, canonical schema and semantic validation, and same/unknown-build rejection |
| 2026-07-12 | Studio Canvas, Deep Wiki, and 3D Inspector | `swift test --package-path apps/studio-macos`; Release build | 28 of 28 tests and the Release build passed, covering lenient graph projection, deterministic layered Canvas layout, hierarchy-depth 3D layer projection, and Canvas/Wiki model phases |
| 2026-07-12 | Portable packs over the Host API | `pnpm test:host-integration` | 67 of 67 tests passed, including a full pack exported from one Host, downloaded as bytes, and imported into a second Host with byte-identical objects and created refs |
| 2026-07-12 | Headless CI gate | `node --test .build/typescript/tests/integration/ci-gate.test.js` | 3 of 3 passed: a clean Snapshot passes, a seeded duplicate stable identifier fails at the default `error` threshold and passes at `critical`, and usage versus unavailable-Host exits stay distinct |
| 2026-07-12 | Optional Hub pack relay and sync | `pnpm test:host-integration` | 71 of 71 tests passed, including push, fetch into a fresh Workspace with byte-identical objects, divergent refs preserved as conflicts, and an explicit `must_match` fast-forward |
| 2026-07-12 | SwiftUI semantic bridge | `swift test --package-path sdks/ios` in Debug and Release | 25 of 25 tests passed in each configuration, including canonical role vocabulary and trait-bridge mappings; the UIKit target still builds for the iOS Simulator |
| 2026-07-12 | Compose semantic bridge | `./gradlew :runtime-compose:assembleDebug :runtime-compose:assembleRelease :runtime-compose:testDebugUnitTest :runtime-compose:lintDebug`; full SDK gates; release boundary script | All builds, the unit test, lint, existing module tests, and the Release boundary passed |
| 2026-07-12 | Whole-project review hardening — host stack | `pnpm check` | 84 fixtures, 24 protocol contracts, 38 Host contracts, 73 Host integrations, and 14 Scenario tests passed, including the production SystemClock/SystemIdGenerator defaults, forced-Ref fail-closed, newest-Snapshot CI gating (4 CI gate tests), event-pump resume past one 500-item repository page, typed UUIDv7 connection ids on the wire, bounded `maximum_paths` search, the CLI `object get`/MCP `vistrea_get_object` digest-proved byte round trip, and a 138 KB Deep Wiki document through CLI and MCP |
| 2026-07-12 | Whole-project review hardening — iOS and Studio | `swift test --package-path sdks/ios`; `swift test --package-path apps/studio-macos`; Release builds; `node --test .build/typescript/tests/integration/ios-runtime-client-interop.test.js` | 32 of 32 SDK tests (UIKit truncation and stable-ID limitation tests also passed on a booted iPhone 17 Pro Max Simulator), 29 of 29 Studio tests, both Release builds, and 6 of 6 interop tests passed, including `policy_blocked` stacking rejection and reverse-order shutdown restore |
| 2026-07-12 | Whole-project review hardening — Android | `./gradlew test :runtime-connection:testDebugUnitTest :runtime-android:assembleDebug :runtime-android:assembleRelease :runtime-android:lintDebug :runtime-compose:test :runtime-compose:assembleRelease`; release boundary script; `node --test .build/typescript/tests/integration/android-runtime-client-interop.test.js`; Demo gates | All builds and lint, 23 connection unit tests, 6 Compose bridge tests, the extended Release boundary (tuning controller proven absent), Demo `assembleDebug assembleRelease test lintDebug`, and 6 of 6 interop tests passed |
| 2026-07-12 | Real Android automation acceptance with exploration | `pnpm test:e2e:android-real-automation` | 1 of 1 passed on a dedicated cold-booted API 36.1 emulator: real InputManager tap verified by capture, system back deduplicated under one structural identity (2 states, 2 transitions, path found), and the autonomous exploration segment discovered 3 states in 5 actions, stopped on frontier_exhausted, and froze the `acceptance/explored` version tag |
| 2026-07-12 | Exploration Operations through the Host | `node --test .build/typescript/tests/integration/exploration-operations.test.js`; `pnpm check` | 2 of 2 passed: a scripted three-screen application walked through the real HTTP API with lifecycle events, per-step progress, the inline ExplorationReport, the persisted graph, start conflict, honest cancellation, and the no-provider fail-closed path; full gate 84 fixtures, 24 protocol, 38 Host contracts, 75 Host integrations, 14 scenarios |
| 2026-07-12 | Studio operation surfaces | `swift test --package-path apps/studio-macos`; Release build | 46 of 46 tests and the Release build passed, covering HTTP encoding of every new write, issue and wiki optimistic-concurrency conflicts, a rejected-tuning path with verbatim reason codes, and the runtime-disconnected degrade |
| 2026-07-13 | Identity curation across the stack | `pnpm check`; `node --test .build/typescript/tests/integration/screen-graph-engine.test.js` | 87 fixtures (3 new curation graph fixtures), 24 protocol, 38 Host contracts, 79 Host integrations, 14 scenarios; merge collapses states with alias-digest dedup, re-pointed transitions, and tombstones, split creates a manual-identity state that never auto-matches, and both fail closed on a stale graph revision |
| 2026-07-13 | Studio exploration, curation, and design workbench | `swift test --package-path apps/studio-macos`; Release build | 68 of 68 tests and the Release build passed, covering the exploration poll loop with cancellation and unsupported degrade, merge/split conflict reloads, and the workbench overlay projection, review stepping, and honest degradations |
| 2026-07-13 | Compose semantics-tree capture | Android SDK gate; release boundary script; `:runtime-android:connectedDebugAndroidTest`; `:runtime-compose:connectedDebugAndroidTest` | All builds and lint passed with 66 JVM unit tests; on an API 36 emulator 7 of 7 walker tests and 2 of 2 Compose capture tests passed with dp-accurate frames, and the Release boundary held with zero androidx in the release APK |
| 2026-07-13 | SwiftUI per-element capture | `swift test --package-path sdks/ios` (Debug and Release); booted-Simulator run | 32 of 32 macOS tests in each configuration; 11 of 11 UIKit-gated tests on an iPhone 17 Pro Max Simulator including a real UIHostingController round trip of the SwiftUI bridge annotation, with the dormant-accessibility degradation documented |
| 2026-07-13 | Hub namespaces, TLS, and roles | `node --test .build/typescript/tests/integration/hub-pack-sync.test.js` | 3 of 3 passed: namespace isolation, read-only token enforcement with unauthenticated rejection, the non-loopback plain-HTTP refusal, and a real TLS round trip against a test-generated certificate |
| 2026-07-13 | Baseline-classified build regressions | `pnpm check` | 82 Host integrations including a baseline run classifying one removal as regressed and one as intentionally removed, an unknown-tag fail-closed, and the CI gate's usage validation for --baseline-tag |
| 2026-07-13 | Real-device automation safety | `pnpm test:e2e:android-real-automation`; `VISTREA_WDA_PROJECT=<checkout> pnpm test:e2e:ios-real-automation` | 1 of 1 passed on each device: a dangerous-classified tap denied without a confirmation token left the device on Home, the bound token authorized exactly one real execution confirmed by capture, and the full walk plus exploration still passed (Android 3 states / 5 actions; iOS the same) |
| 2026-07-12 | Validator configuration and pixel comparison | `node --test .build/typescript/tests/integration/{validation-engine,design-review-engine}.test.js`; `pnpm check` | 8 of 8 passed including disabled-rule counts, threshold overrides, fail-closed unknown rules, a major mean-color deviation against a real encoded screenshot, the honest no-screenshot degrade, and exact PNG filter reconstruction; full gate 24 protocol, 38 Host contracts, 77 Host integrations, 14 scenarios |
| 2026-07-12 | Real iOS WebDriverAgent automation acceptance | `VISTREA_WDA_PROJECT=<WebDriverAgent checkout> pnpm test:e2e:ios-real-automation` | 1 of 1 passed on a dedicated booted Simulator: WebDriverAgent compiled and served W3C actions, a real tap resolved from the persisted Snapshot navigated Home to Catalog (verified by capture), the left-edge pop returned to a deduplicated Home, and exploration discovered 3 states in 5 actions with the `acceptance/explored` version tag — the first device run of this lane |
| 2026-07-13 | Curation invariants after adversarial review | `node --test .build/typescript/tests/integration/screen-graph-engine.test.js`; `pnpm protocol:validate` | 8 of 8 graph tests passed, including a merge that coalesces a duplicate transition without rewriting Observations and a split that reclaims a merged alias digest; 89 of 89 fixtures passed, with 3 forged curation graphs now rejected (`graph_identity_decision_shape_invalid`, `graph_active_state_superseded`) |
| 2026-07-13 | Unobservable captures barred from identity | `node --test .build/typescript/tests/integration/screen-graph-engine.test.js` | A Snapshot carrying `ios.capture.content-not-observable` is refused at both the observation and the transition-endpoint entry point; the graph kept 1 state, 1 observation, and 0 transitions |
| 2026-07-13 | Host trust boundary for curation bodies | `node --test .build/typescript/tests/integration/host-local-api.test.js` | 5 of 5 tests passed; a merge whose `state_ids` is a string and a split whose `expected_graph_revision` is a string both fail with 400 at the Host instead of reaching the Engine |
| 2026-07-13 | iOS SwiftUI observability | `swift test --package-path sdks/ios` in Debug and Release; `-only-testing:VistreaRuntimeUIKitTests` on a booted iPhone 17 Pro Max (iOS 26.0) | 33 of 33 Swift tests and 13 of 13 UIKit-gated Simulator tests passed; a 144-view UIKit hierarchy produced zero false positives in both runtime states |
| 2026-07-13 | Compose structural stability under scroll | `./gradlew :runtime-compose:connectedDebugAndroidTest :runtime-android:connectedDebugAndroidTest` on API 36.1 | 4 of 4 and 9 of 9 instrumented tests passed; a 30-item LazyColumn scrolled away by real deltas and back produced an identical structural digest, and the unplaced-node test fails when the filter is reverted |
| 2026-07-13 | Android Release boundary including Compose | `sdks/android/tools/verify-runtime-release-boundary.sh` | Exit 0; the Release Demo APK contained no `dev/vistrea/runtime/compose/`, no `ComposeSemanticsCaptureExtension`, and no `androidx/` at all, while the Debug APK contained each as a positive control; flipping the dependency to `implementation` fails the script |
| 2026-07-13 | Studio exploration and curation guards | `swift test --package-path apps/studio-macos`; `swift build -c release` | 77 of 77 tests and the Release build passed, including a run that stays cancellable after its poll loop is torn down and a merge that posts nothing when a background reload moves the graph under an open decision |
| 2026-07-13 | Complete executable check after review hardening | `pnpm check` | 89 fixtures, 24 protocol contracts, 38 Host contracts, 85 Host integrations, and 14 Scenario tests passed |
| 2026-07-13 | MCP toolset focus and the Claude Code plugin | `node --test .build/typescript/tests/integration/agent-adapters.test.js`; `claude plugin validate` | 2 of 2 adapter tests passed: the default server still lists all 54 tools, a `VISTREA_MCP_TOOLSETS=assets,exploration` server lists exactly 19 and fails a masked `vistrea_validate_snapshot` call closed as `unsupported`; the plugin manifest and the repository marketplace both validate |
| 2026-07-13 | CLI-only agent adapter (ADR-0008) | `pnpm check`; `node --test .build/typescript/tests/integration/agent-adapters.test.js`; `claude plugin validate` | 89 fixtures, 24 protocol, 38 Host contracts, 85 Host integrations, 14 scenarios; 2 of 2 adapter tests passed with the full CLI flow (wiki, validation reads, object clobber refusal now CLI-driven), a `VISTREA_CLI_TOOLSETS=assets,exploration` invocation failing `validate`/`design` closed as exit 6 with filtered help, and an unknown toolset failing as exit 2; the MCP module and its SDK dependency are gone and the plugin (CLI skills only) still validates |

## Known follow-up gaps

- Readable Markdown/HTML exports (`exportReadable`) and compressed pack payload support remain later exchange slices.
- Compressed Object fixtures do not yet include executable gzip/zstd and byte-range vectors.
- Automatic UIKit and Android View event observation is not implemented; the verified event slice reports transients through explicit Demo instrumentation of the bounded recorders.
- Exploration recovery after crashes, AI-assisted planning, state restoration, and `clear_text`/`dismiss` provider actions are not implemented; exploration is bounded depth-first with physical back navigation and caller-declared stable-ID exclusions.
- Protected tuning covers only the alpha property; additional allowlisted properties and tuning-driven re-verification composition remain later slices. The design comparison workbench (overlay, severity-colored differences, review mode) shipped in `a0b3cb4`.
- Knowledge Collection publication (Commit/Ref binding), Review Issue creation from comparison differences, and Wiki-driven Canvas annotation are not implemented.
- Compose capture is the semantics tree: composables contributing no semantics produce no node, nodes measured but never placed (LazyList prefetch) are excluded because they carry no layout truth, and `AndroidView` interop children under a replaced subtree are skipped with an explicit capture limitation. Per-node visual properties and z-order are genuinely unavailable from Compose semantics — the host node reports `android.capture.compose-visual-unavailable` rather than fabricating them, and the screenshot stays the visual truth for those subtrees.
- SwiftUI per-element capture requires an active accessibility runtime (VoiceOver, the Accessibility Inspector, or a WDA session). A dormant capture now reports `ios.capture.content-not-observable` and the Screen Graph refuses it as identity evidence, so the same screen can no longer become two Screen States depending on whether a runtime happened to be live. SwiftUI content hidden with `.accessibilityHidden(true)` is indistinguishable from dormant content at the UIKit boundary and is reported the same way.
- The Host validates curation command field types, but most other routes still check field names only and rely on the Engine to reject wrong types; a wrong type there surfaces as a misleading `not_found` rather than an honest `invalid_argument`.
- CI target-environment orchestration (booting devices inside pipelines) and Hub auditing, discovery, subscriptions, and richer role models are not implemented.

## Next milestones

The product focus is exploration and asset recording; the verification surface (design review, review issues, tuning, validators, build diffs) stays implemented and tested but is shelved as a roadmap priority and maskable per composition (`VISTREA_MCP_TOOLSETS`).

1. Harden real-app exploration: `clear_text`/`dismiss` provider actions so text fields and dialogs stop blocking the frontier, and recovery after an application crash mid-walk.
2. Automatic UIKit and Android View event observation, so transient evidence no longer depends on explicit Demo instrumentation.
3. Publish Knowledge Collections (Commit/Ref binding) so curated knowledge versions like the graph does.

Shelved (verification): Review Issues from comparison differences, tuning-driven re-verification, pixel-level visual regression baselines.
