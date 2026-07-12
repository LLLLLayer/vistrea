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

The native iOS UIKit and Android View Demo Apps implement the same 12 required cross-platform Scenario IDs. Both now provide a verified `demo.navigation.basic` Runtime Snapshot loop through the SDK connection, Host, Studio presentation, SQLite metadata, and content-addressed screenshot storage. The remaining scenario contracts continue to stage later event, automation, exploration, design, tuning, validation, and build-diff work.

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

1. Complete portable `.vistrea-pack` exchange over the verified protocol and local Data foundation.
2. Add Runtime events plus protected design review and reversible tuning.
3. Add WDA/UIAutomator actions, exploration, and Screen State identity.
4. Persist Canvas and Deep Wiki knowledge, then add validation and build diff.
5. Expand CLI, MCP, Skills, and CI with those Engine use cases.
6. Implement optional Vistrea Hub synchronization after local semantics are stable.

Parallel work should follow [the multi-agent workflow](docs/DEVELOPMENT.md) and use fixture-backed interfaces rather than private module models.

## Current status

Phase 0A1, Phase 0A2, and the Phase 0B local Data foundation are verified: the shared `DataUnitOfWork` surface has machine-readable JSON Schemas, 78 canonical fixtures, language-owned Data ports, an in-memory reference adapter, SQLite metadata, and a file-backed content-addressed Object Store. Phase 0 remains open because portable `.vistrea-pack` exchange is not implemented.

The Phase 1 native Snapshot milestone is verified on both iOS UIKit and Android View. A production local Host, macOS Snapshot Studio, strict CLI, stdio MCP server, and `vistrea-inspect-runtime` Skill consume the same persisted Snapshot path. This does not yet implement Runtime events, device automation, exploration, design tuning, full Canvas or Deep Wiki workflows, `.vistrea-pack`, CI validation, or Vistrea Hub.

Run the current executable checks with:

```bash
pnpm install --frozen-lockfile
pnpm check
```
