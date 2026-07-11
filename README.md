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

The initial interface specifications define shared IDs, errors, operation behavior, SDK transport semantics, device actions, Engine commands and queries, Data ports, Agent surfaces, and Hub synchronization before a concrete IDL or implementation language is selected.

## Executable Demo Apps

Planned native iOS and Android Demo Apps will implement the same cross-platform Scenario IDs. They will become executable contract fixtures for SDK capture, connection, automation, transient events, exploration, design review, tuning, validation, and build diff.

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

1. Stabilize protocol models, common contracts, and shared Demo scenarios.
2. Implement Data API, SQLite metadata, and the local content-addressed Object Store.
3. Complete one native Demo App vertical loop through SDK, Host connection, Studio, and persistence.
4. Add Inspector, design review, and reversible tuning.
5. Add automation, exploration, Canvas, Deep Wiki, validation, and build diff.
6. Expose stable CLI/MCP operations, create real Skills, and implement Hub synchronization.

Parallel work should follow [the multi-agent workflow](docs/DEVELOPMENT.md) and use fixture-backed interfaces rather than private module models.

## Current status

The repository is in Phase 0. Phase 0A1 and Phase 0A2 are complete: the shared `DataUnitOfWork` model surface now has machine-readable JSON Schemas, 78 canonical fixtures, aggregate semantic validation, a model coverage manifest, and contract tests. Phase 0B will turn the documented Data ports into language-owned contracts and a deterministic in-memory reference adapter. No platform project, storage engine, Runtime SDK, Studio application, automation provider, or Hub service has been implemented yet.

Run the current executable checks with:

```bash
pnpm install --frozen-lockfile
pnpm check
```
