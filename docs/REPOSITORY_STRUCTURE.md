# Vistrea Repository Structure

## 1. Design goals

Vistrea uses a monorepo for the cross-platform protocol, native Runtime SDKs, reusable Host Engine, local-first Data Layer, macOS Studio, Agent integrations, and optional Hub service.

The repository structure must ensure:

- one source of truth for cross-platform models;
- one Data API consumed by Engine use cases and Data contract tests; Studio and integrations access it only through Engine;
- explicit separation between SDK observation and device automation;
- explicit separation between domain logic and storage implementations;
- product UI independent from SQLite, file layout, and Hub transport;
- a local Workspace that remains usable without Hub;
- stable module ownership for parallel Agent development;
- platform implementations that cannot silently diverge.

## 2. Directory tree

```text
vistrea/
├── .github/
│   └── workflows/
│       └── protocol-contracts.yml
├── .gitignore
├── .node-version
├── AGENTS.md
├── CLAUDE.md -> AGENTS.md
├── README.md
├── package.json
├── pnpm-lock.yaml
├── apps/
│   ├── README.md
│   ├── host/                    # production Host composition and Local API
│   │   ├── README.md
│   │   ├── local-api.ts
│   │   ├── local-host.ts
│   │   └── serve.ts
│   └── studio-macos/            # native SwiftUI Snapshot workspace
│       ├── Package.swift
│       ├── Sources/
│       ├── Tests/
│       └── README.md
├── protocol/
│   ├── README.md
│   ├── schema/
│   │   ├── README.md
│   │   └── v1/                 # executable JSON Schema contracts
│   ├── model-coverage/
│   │   └── v1.json             # DataUnitOfWork canonical model inventory
│   └── fixtures/
│       ├── README.md
│       └── v1/                 # valid, invalid, and compatibility fixtures
├── sdks/
│   ├── README.md
│   ├── ios/
│   │   ├── Package.swift
│   │   ├── Sources/             # models, UIKit capture, Runtime connection
│   │   ├── Tests/
│   │   └── README.md
│   └── android/
│       ├── runtime-android/      # Android View capture and Debug bridge
│       ├── runtime-connection/   # protected Runtime transport
│       ├── src/                  # canonical Kotlin protocol adapter
│       ├── tools/
│       ├── build.gradle.kts
│       ├── settings.gradle.kts
│       └── README.md
├── engine/
│   ├── README.md
│   ├── workspace/
│   │   └── README.md
│   ├── connection/
│   │   ├── README.md
│   │   ├── snapshot-engine.ts
│   │   └── loopback-runtime-transport.ts
│   ├── automation/
│   │   └── README.md
│   ├── exploration/
│   │   └── README.md
│   ├── design/
│   │   └── README.md
│   ├── knowledge/
│   │   └── README.md
│   ├── validation/
│   │   └── README.md
│   ├── operations/
│   │   └── README.md
│   ├── versioning/
│   │   └── README.md
│   └── sync/
│       └── README.md
├── data/
│   ├── README.md
│   ├── api/
│   │   ├── README.md
│   │   ├── models.ts
│   │   └── ports.ts
│   ├── internal/                # shared implementation support, not public ports
│   ├── memory/                  # deterministic reference Data adapter
│   ├── workspace/
│   │   ├── README.md
│   │   └── local-data-workspace.ts
│   ├── metadata/
│   │   ├── README.md
│   │   ├── MIGRATIONS.md
│   │   ├── migrations/
│   │   └── sqlite-data.ts
│   ├── objects/
│   │   ├── README.md
│   │   └── file-object-store.ts
│   ├── versioning/
│   │   └── README.md
│   ├── search/
│   │   └── README.md
│   ├── sync/
│   │   └── README.md
│   └── exchange/
│       ├── README.md
│       └── pack-exchange.ts
├── services/
│   ├── README.md
│   └── hub/
│       └── README.md
├── integrations/
│   ├── README.md
│   ├── shared/                  # strict authenticated Host client
│   ├── cli/
│   │   ├── README.md
│   │   └── main.ts
│   ├── mcp/
│   │   ├── README.md
│   │   ├── main.ts
│   │   └── server.ts
│   ├── skills/
│   │   ├── README.md
│   │   └── vistrea-inspect-runtime/
│   └── ci/
│       └── README.md
├── examples/
│   ├── README.md
│   ├── scenarios/
│   │   └── README.md
│   ├── ios/
│   │   ├── README.md
│   │   └── VistreaDemoApp/
│   │       ├── Sources/
│   │       ├── UITests/
│   │       └── README.md
│   └── android/
│       ├── README.md
│       └── VistreaDemoApp/
│           ├── app/
│           ├── tools/
│           └── README.md
├── tests/
│   ├── README.md
│   ├── contract/
│   │   ├── README.md
│   │   ├── protocol-fixtures.test.mjs
│   │   └── strict-json.test.mjs
│   ├── integration/
│   │   ├── README.md
│   │   ├── agent-adapters.test.ts
│   │   ├── ios-runtime-client-interop.test.ts
│   │   └── android-runtime-client-interop.test.ts
│   └── e2e/
│       ├── README.md
│       ├── ios-real-vertical-loop.test.ts
│       └── android-real-vertical-loop.test.ts
├── tools/
│   ├── README.md
│   └── protocol/
│       ├── phase0a2-semantic-checks.mjs
│       ├── semantic-checks.mjs
│       ├── strict-json.mjs
│       └── validate-fixtures.mjs
└── docs/
    ├── README.md
    ├── PROJECT_OVERVIEW.md
    ├── REPOSITORY_STRUCTURE.md
    ├── DEVELOPMENT.md
    ├── DEVELOPMENT_PROGRESS.md
    ├── architecture/
    │   ├── README.md
    │   └── DATA_LAYER.md
    ├── interfaces/
    │   ├── README.md
    │   ├── COMMON_CONTRACTS.md
    │   ├── OPERATION_CATALOG.md
    │   ├── RUNTIME_CONNECTION.md
    │   ├── AUTOMATION_API.md
    │   ├── ENGINE_API.md
    │   ├── DATA_API.md
    │   ├── AGENT_INTERFACES.md
    │   └── HUB_API.md
    ├── product/
    │   ├── README.md
    │   └── STUDIO_INTERACTIONS.md
    ├── protocol/
    │   ├── README.md
    │   ├── DATA_MODEL_COVERAGE.md
    │   └── RUNTIME_SNAPSHOT.md
    ├── decisions/
    │   ├── README.md
    │   ├── 0000-template.md
    │   ├── 0001-contract-boundaries.md
    │   ├── 0002-json-schema-protocol.md
    │   └── 0003-object-and-commit-identity.md
    └── roadmap/
        └── README.md
```

## 3. Ownership and boundaries

| Directory | Owns | Must not own |
|---|---|---|
| `protocol/` | Canonical runtime, design, version, object, and sync models; schemas; fixtures | UIKit/Android classes, database implementation, product UI |
| `sdks/ios/` | iOS capture, adapters, Inspector, protected tuning endpoint, transport | WDA control, global exploration, Workspace storage |
| `sdks/android/` | Android capture, adapters, Inspector, protected tuning endpoint, transport | UIAutomator orchestration, global exploration, Workspace storage |
| `engine/workspace/` | Workspace lifecycle, health, import/export, usage, and garbage-collection use cases | Concrete SQLite, file, or Hub implementation |
| `engine/connection/` | SDK discovery, sessions, transport, capabilities | Device action planning or storage implementation |
| `engine/automation/` | WDA/UIAutomator lifecycle and real interactions | In-app View scanning or knowledge persistence |
| `engine/exploration/` | Candidates, safety, planning, recovery, state identity, transitions | Platform UI internals or product presentation |
| `engine/design/` | Baseline mapping, comparison, Review Issues, reversible Tuning Patches | Arbitrary business calls or untracked permanent mutation |
| `engine/knowledge/` | Runtime Graph and Deep Wiki semantics, links, backlinks, derived views | SQLite schema, object paths, Hub transport |
| `engine/validation/` | Structural, visual, behavioral, accessibility, design, and build-diff rules | Product UI state or platform-specific capture |
| `engine/operations/` | Generic long-running lifecycle, progress, cancellation, results, and durable operation history | Exploration or validation domain logic |
| `engine/versioning/` | Commit, ref, tag, baseline, diff, and history use cases | Physical version tables or object persistence |
| `engine/sync/` | Fetch, pull, push, publish, subscribe, and conflict-resolution use cases | Low-level Hub HTTP or object-transfer implementation |
| `data/api/` | Repository, query, transaction, object, version, search, and sync ports | Concrete SQL, file layout, or remote provider logic |
| `data/internal/` | Reusable implementation support hidden behind Data ports | Public contracts or product behavior |
| `data/memory/` | Deterministic reference adapter and fixture-backed Data composition | Production persistence or private protocol variants |
| `data/workspace/` | Local Workspace lifecycle and composition | Product use cases |
| `data/metadata/` | SQLite schema, migrations, transactions, metadata queries | Large binary artifacts or domain decisions |
| `data/objects/` | Content-addressed artifact persistence and lifecycle | Screen State identity or review rules |
| `data/versioning/` | Commit, parent, ref, tag, baseline, and diff metadata | Git repository management or UI workflow |
| `data/search/` | Rebuildable search indexes | Authoritative product data |
| `data/sync/` | Client push/pull and object negotiation | Hub authorization implementation |
| `data/exchange/` | `.vistrea-pack` and generated exports | Independent sharing protocol |
| `apps/host/` | Production Host composition, Runtime session routing, and authenticated loopback Local API | Product UI, private protocol models, direct UI behavior |
| `apps/studio-macos/` | Presentation, interaction, navigation, and composition root | SQL, artifact paths, duplicated Engine behavior |
| `services/hub/` | Shared commits, objects, namespaces, RBAC, audit, discovery | Required local product behavior |
| `integrations/` | CLI, MCP, Skills, and CI adapters | Reimplemented Engine or Data logic |
| `examples/scenarios/` | Required cross-platform Scenario IDs, expected states, events, and findings | Platform-specific implementation details |
| `examples/ios/` | Native iOS Demo App executable fixture | Android-only scenarios or production business logic |
| `examples/android/` | Native Android Demo App executable fixture | iOS-only scenarios or production business logic |
| `tests/` | Cross-module contracts, integration, and end-to-end behavior | Module-private unit tests |
| `tools/` | Generation, validation, fixture, and repository tooling | Product runtime dependencies |

## 4. Dependency direction

```text
                 apps/*
                    |
                    v
              Engine use cases <--------- integrations/*
              /              \
             v                v
        protocol           data/api
                               ^
                               |
                    data implementations

sdks/* ----------------------> protocol
services/hub ----------------> protocol and sync contracts
tests/* ---------------------> public contracts and composition roots

apps/* composition root -----> concrete Data implementations
apps/* Views/ViewModels -X---> concrete Data implementations
```

Rules:

1. `protocol/` does not depend on product, platform, Engine, Data, or service code.
2. SDKs do not depend on Host Engine or local Data implementations.
3. Engine depends only on protocol and Data API abstractions.
4. Data implementations depend on protocol and Data API, not Engine business rules or UI.
5. Product views and ViewModels consume Engine use cases, never concrete storage.
6. Composition roots may instantiate concrete Data implementations but must not leak them into presentation code.
7. Hub shares contracts with local sync but is not required for offline use.
8. Platform differences use adapters and explicit extensions, never duplicate core models.

## 5. Agent entry points

```text
Coding Agent
├── CLI --------------------------┐
├── MCP --------------------------┼──> public Engine use cases
└── Skill -> CLI / MCP / local API┘
```

- CLI is the stable scriptable foundation.
- MCP exposes structured tools.
- Skills compose concrete task workflows.
- CI drives repeatable build validation.
- No integration is the sole access path to core capabilities.

## 6. Local runtime data

Runtime data is not source code:

```text
.vistrea/
├── workspace.json
├── .host.lock
├── metadata.sqlite
├── objects/
├── refs/
├── exports/
└── cache/
```

The entire `.vistrea/` directory is ignored. SQLite metadata, content-addressed object storage, and portable `.vistrea-pack` export/import are implemented and verified. A pack is a defined framed byte stream (ADR-0006), not a raw copy of a live SQLite database.

## 7. Implemented toolchains and future projects

The first implementation keeps the language-neutral contracts while using toolchains suited to each boundary:

- JSON Schema Draft 2020-12 plus canonical fixtures for protocol v1;
- Node.js and strict TypeScript for the Host, Engine slice, Data implementations, CLI, and MCP;
- `better-sqlite3` with exact-byte forward-only migrations for metadata;
- file-backed SHA-256 content-addressed objects;
- Swift Package Manager for iOS Runtime modules and native SwiftUI Studio;
- Gradle/Kotlin Android libraries with Debug/Internal Runtime transport excluded from Release artifacts;
- UIKit and Android View as the verified initial native adapters;
- authenticated, bounded JSON-lines Runtime transport and an authenticated loopback HTTP Local API.

Future SwiftUI/Compose capture adapters, automation providers, CI packaging, and Hub deployment projects must preserve the documented public boundaries. Toolchain-specific layouts must not create competing protocol, Engine, or Data models.

## 8. Parallel development

Parallel agents should own separate modules behind approved shared contracts. Protocol schemas, fixtures, Data API, interface specifications, shared Demo scenarios, root build files, and central documents are integration surfaces with a single active owner.

See `docs/DEVELOPMENT.md` for work lanes, handoffs, high-contention files, and integration order.
