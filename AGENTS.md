# Vistrea Repository Guidance

## Required reading

Before designing, implementing, or splitting work, read:

1. `README.md`
2. `docs/PROJECT_OVERVIEW.md`
3. `docs/REPOSITORY_STRUCTURE.md`
4. `docs/architecture/DATA_LAYER.md` for storage, versioning, or sync work
5. `docs/DEVELOPMENT.md` before parallel or cross-module work
6. `docs/interfaces/README.md` before implementing a public interface
7. `docs/product/STUDIO_INTERACTIONS.md` before Studio UI or workflow work
8. `docs/DEVELOPMENT_PROGRESS.md` to understand current implementation truth

## Language

- Use English for source code, comments, identifiers, README files, architecture documents, ADRs, schemas, tests, generated project content, commit messages, and pull-request content.
- User-facing product localization is separate from repository language.
- Communicate with the current project owner in Chinese unless they request another language.

## Product invariants

- Vistrea is a runtime UI knowledge, design review, tuning, exploration, and verification platform. It is not only an SDK, inspector, automation wrapper, canvas, or test-report generator.
- The product covers native iOS and Android. Cross-platform consistency depends on a stable Runtime Snapshot protocol; platform differences belong in adapters and explicit extensions.
- Runtime SDKs primarily observe and describe application state. WDA, UIAutomator, or equivalent device automation performs real user interactions.
- Debug UI tuning may override an explicit allowlist of visual properties. Every override must be reversible, versioned, and clearly distinguished from source-code truth. It must never call arbitrary business methods.
- Structured runtime information is the primary input for location and reasoning. Screenshots remain the final visual truth. Short video and event streams preserve transient states and failure evidence.
- The global Canvas contains Screen States and Transitions. View and Layer nodes belong in the single-screen Inspector, not directly in the global graph.
- The Deep Wiki is a persistent, searchable, linked, and versioned knowledge system, not a one-time generated report.
- Local-first does not mean local-only. A local Workspace must remain fully usable offline; Vistrea Hub is an optional synchronization, discovery, permission, and collaboration layer.
- High-privilege SDK and Inspector capabilities must be absent from or strictly protected in Release builds.

## Layer boundaries

- `protocol/` is the only source of truth for cross-platform wire models and compatibility fixtures.
- `sdks/ios/` and `sdks/android/` contain in-process capture, adapters, Inspector UI, and protected tuning endpoints.
- `engine/` contains reusable application and domain logic. It must not depend on product UI.
- `data/api/` defines storage ports. Engine code must not depend on SQLite rows, file paths, object-store implementations, or Hub transport details.
- `data/` implements local Workspace, metadata, object storage, versioning, search, exchange, and Hub sync.
- `apps/studio-macos/` composes product UI and Engine use cases. Views and ViewModels must not issue SQL or construct artifact paths.
- `services/hub/` contains optional cross-team server capabilities and must not be required for local workflows.
- `integrations/cli/`, `mcp/`, `skills/`, and `ci/` expose the same Engine capabilities. They must not duplicate product logic.
- `tests/` owns cross-module contract, integration, and end-to-end coverage. Unit tests stay beside their owning module.
- `examples/scenarios/` defines cross-platform Demo App behavior. Both Demo Apps must implement required Scenario IDs before adding unpaired platform behavior.
- Runtime output belongs in `.vistrea/` and must never be committed.

## Dependency direction

```text
apps/* and integrations/*
            |
            v
         engine/* ---------> data/api
            |                    ^
            v                    |
         protocol <--------- data implementations

sdks/* ---------------------> protocol
services/hub ----------------> protocol and sync contracts
```

No lower layer may import a product UI layer. Concrete Data implementations are selected only in composition roots.

## Default implementation order

1. Runtime Snapshot, UI Node, Screen State, Transition, Event, Artifact, and design-review protocol models.
2. Data API plus a local Workspace using SQLite metadata and a content-addressed object store.
3. Shared Demo App scenarios plus one vertical platform loop: Demo App to SDK to connection to Snapshot to macOS display.
4. In-app Inspector and protected UI tuning.
5. Design baseline comparison, Review Issues, Tuning Patches, and re-verification.
6. Device automation, exploration, Screen State deduplication, and path versioning.
7. Canvas and Deep Wiki persistence.
8. Validation, build diff, 3D Inspector, CLI, MCP, Skills, CI, and Vistrea Hub.

Explicit user priorities override this default order.

## Multi-agent development rules

- Divide work by stable module ownership, not by arbitrary file counts.
- Assign only one active owner to a file or schema at a time. Parallel agents may work in different modules against an agreed contract.
- Stabilize protocol and Data API changes before parallel platform implementations begin.
- Treat `protocol/schema/`, shared fixtures, `data/api/`, `docs/interfaces/`, shared Demo scenarios, root build files, and central documentation as high-contention surfaces. Coordinate changes before editing them.
- Do not create competing iOS, Android, Studio, or storage models for the same concept. Extend the shared protocol or record an ADR.
- Cross-module changes must update the contract, fixtures, affected module documentation, and contract tests in the same change.
- Preserve other agents' and users' work. Never discard or rewrite unrelated changes to obtain a clean tree.
- Keep commits scoped to one contract or one module outcome whenever possible.
- If a task reveals a missing shared abstraction, stop local duplication and promote the decision to the owning shared layer.
- Generated models must come from the canonical schema once code generation exists. Never hand-edit generated output.

See `docs/DEVELOPMENT.md` for work lanes, handoff requirements, and integration order.

## Documentation and implementation truth

- Module names in architecture documents describe intended boundaries, not completed implementations.
- Never claim a capability exists because a directory or README exists.
- Keep product invariants in `docs/PROJECT_OVERVIEW.md`, replaceable engineering decisions in ADRs, and operational instructions close to the owning module.
- Update documentation when a boundary or public contract changes. Do not duplicate the same normative rule across multiple files unless one location clearly links to the source of truth.
- Update `docs/DEVELOPMENT_PROGRESS.md` whenever a development slice starts, becomes blocked, is implemented, or is verified. Record the exact verification command or evidence.

## Validation expectations

- Validate the narrowest affected module first.
- Run protocol contract tests for any shared model or fixture change.
- Run integration tests when changing connection, Data API, persistence, sync, or public Engine use cases.
- Run an end-to-end vertical loop before declaring a cross-module feature complete.
- Verify that documentation links resolve, generated files are current, and runtime artifacts remain ignored.
