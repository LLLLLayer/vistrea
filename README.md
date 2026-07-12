# Vistrea

Vistrea is a local-first runtime UI knowledge, design review, tuning, exploration, and verification platform for native iOS and Android applications.

It combines in-app runtime SDKs, real device automation, a macOS workspace, a versioned Deep Wiki, design review workflows, and Coding Agent integrations around one stable Runtime Snapshot protocol.

## Product surfaces

- iOS and Android Runtime SDKs
- In-app UI Inspector for internal builds
- Vistrea Studio for macOS
- Runtime UI exploration through WDA and UIAutomator
- Screen State Canvas and versioned UI Deep Wiki
- Design baseline comparison and review issues
- Reversible Debug-only UI tuning
- 2D View Tree and Lookin-style 3D Inspector
- Structural, visual, behavioral, accessibility, design, and build-diff validation
- CLI, MCP, Skills, and CI integrations for Coding Agents
- Optional Vistrea Hub for cross-team sharing

## One-line definition

> Vistrea lets designers, developers, QA engineers, and Coding Agents explore, review, tune, verify, and retain knowledge about the same native application runtime UI.

## Architecture at a glance

```text
Studio / CLI / MCP / Skills / CI
                 |
                 v
        Reusable Host Engine
                 |
                 v
             Data API
          /             \
Local Workspace      Vistrea Hub

iOS / Android SDK ---- Runtime Snapshot Protocol
WDA / UIAutomator ---- Real user interaction
```

The SDK observes and describes application state. Device automation performs real interactions. The Data Layer isolates all product surfaces from SQLite, files, object storage, version history, and synchronization details.

## Contract-first implementation

Vistrea is designed for parallel implementation behind stable interfaces:

```text
Runtime SDK <-> Host Connection
Automation Provider <-> Automation Engine
Studio / CLI / MCP / Skills <-> Engine Use Cases
Engine <-> Data API <-> Local Workspace / Hub Sync
```

The interface specifications define shared IDs, errors, operation behavior, SDK transport semantics, device actions, Engine commands and queries, Data ports, Agent surfaces, and Hub synchronization. Protocol v1 is executable as JSON Schema and canonical fixtures. The current implementation uses a Node.js/TypeScript Host and Data stack, Swift packages for iOS and Studio, and Gradle/Kotlin modules for Android without changing those language-neutral boundaries.

## Native Demo Apps

The native iOS UIKit and Android View Demo Apps implement the same 12 required cross-platform Scenario IDs. Both provide a verified `demo.navigation.basic` Runtime Snapshot loop through the SDK connection, Host, Studio presentation, SQLite metadata, and content-addressed screenshot storage, plus verified Runtime events and reversible tuning; real-input automation is verified on Android. Design comparison and validation scenario coverage remain staged, with `examples/scenarios/manifest.json` as the authoritative per-platform status.

- `examples/ios/VistreaDemoApp/`
- `examples/android/VistreaDemoApp/`
- `examples/scenarios/`

## Documentation

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [Repository structure](docs/REPOSITORY_STRUCTURE.md)
- [Data Layer](docs/architecture/DATA_LAYER.md)
- [Executable Data model coverage](docs/protocol/DATA_MODEL_COVERAGE.md)
- [Interface specifications](docs/interfaces/README.md)
- [Studio interaction design](docs/product/STUDIO_INTERACTIONS.md)
- [Development and multi-agent workflow](docs/DEVELOPMENT.md)
- [Development progress](docs/DEVELOPMENT_PROGRESS.md)
- [Documentation index](docs/README.md)

## Recommended implementation sequence

1. Run the implemented iOS WebDriverAgent automation lane on a real Simulator and re-run the Android lane's exploration segment to verify those capabilities.
2. Extend the SwiftUI and Compose annotation bridges into full semantic-tree capture.
3. Cover the design comparison and validation scenario contracts in both Demo Apps.
4. Add Canvas curation and Deep Wiki editing to Studio.
5. Grow Vistrea Hub beyond the loopback pack relay: namespaces, permissions, discovery, and collaboration.

Parallel work should follow [the multi-agent workflow](docs/DEVELOPMENT.md) and use fixture-backed interfaces rather than private module models.

## Current status

Phase 0 is verified: the shared `DataUnitOfWork` surface has machine-readable JSON Schemas, 84 canonical fixtures, language-owned Data ports, an in-memory reference adapter, SQLite metadata, a file-backed content-addressed Object Store, and portable full/thin `.vistrea-pack` export/import over the same Commit and ObjectRef identity.

The Phase 1 native Snapshot milestone is verified on both iOS UIKit and Android View, and Runtime event streaming and protected reversible tuning are also verified on both platforms. Device automation, deterministic exploration, the Screen Graph, design review, the Deep Wiki, core validation and build diff, and an optional loopback Hub pack relay are implemented behind the same production Host, with the Android real-input automation acceptance verified and the iOS WebDriverAgent lane awaiting its first device run. Agents consume this surface through 45 Host operations exposed by the strict CLI, 44 stdio MCP tools, four Skills, and a headless CI gate. `docs/DEVELOPMENT_PROGRESS.md` records the exact per-workstream status and verification evidence.

Run the current executable checks with:

```bash
pnpm install --frozen-lockfile
pnpm check
```
