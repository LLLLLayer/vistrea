# Development and Multi-Agent Workflow

## 1. Purpose

Vistrea is a multi-platform monorepo with high-contention shared contracts. Parallel work is encouraged only when agents or developers can operate behind stable module boundaries.

## 2. Work lanes

| Lane | Primary directories | Shared inputs | Expected output |
|---|---|---|---|
| Protocol | `protocol/`, `docs/protocol/` | Product invariants | Schemas, fixtures, compatibility tests |
| Interface contracts | `docs/interfaces/` | Product and layer boundaries | Commands, queries, events, errors, lifecycle semantics |
| Demo scenarios | `examples/scenarios/` | Protocol and interface contracts | Shared executable scenario requirements |
| Data | `data/`, `docs/architecture/DATA_LAYER.md` | Protocol and Data API | Local Workspace, versioning, search, sync clients |
| iOS SDK | `sdks/ios/`, `examples/ios/` | Protocol fixtures and Runtime Connection contract | Capture, Inspector, tuning, tests |
| Android SDK | `sdks/android/`, `examples/android/` | Protocol fixtures and Runtime Connection contract | Capture, Inspector, tuning, tests |
| Host Engine | `engine/` | Protocol and Data API | Connection, automation, exploration, design, knowledge, validation |
| Studio | `apps/studio-macos/` | Public Engine use cases | Product UI and composition root |
| Agent integrations | `integrations/` | Public Engine use cases | CLI, Skills, Claude Code plugin, and CI adapters |
| Hub | `services/hub/` | Protocol and sync contract | Remote commits, objects, permissions, search |
| Cross-module verification | `tests/` | All public contracts | Contract, integration, and end-to-end coverage |

## 3. Safe parallelization

Good parallel work:

- iOS and Android adapters implementing the same approved protocol fixture set.
- iOS and Android Demo Apps implementing the same approved Scenario IDs.
- Local object storage and SQLite metadata implementing separate Data API ports.
- Studio screens and CLI commands consuming stable Engine use cases.
- Validation rules that consume an unchanged Snapshot model.

Unsafe parallel work:

- Two agents independently defining `UiNode` or `ScreenState`.
- Studio and CLI inventing separate query semantics.
- iOS and Android creating incompatible identity, geometry, or tuning models.
- Multiple agents editing root schema, root build configuration, or the same central document without coordination.

## 4. Contract-first sequence

For cross-module work:

1. Write or update the shared contract.
2. Define public commands, queries, events, errors, and lifecycle behavior.
3. Add canonical fixtures, Demo scenarios, and compatibility expectations.
4. Agree on ownership and affected modules.
5. Implement modules in parallel.
6. Run module tests.
7. Run contract and integration tests.
8. Complete one end-to-end vertical loop through a Demo App.
9. Update architecture and operational documentation.

Directory creation alone does not satisfy a contract-first step. A usable contract includes semantics, version behavior, fixtures, and failure cases.

## 5. High-contention files

Coordinate before editing:

- `AGENTS.md`
- `README.md`
- `docs/PROJECT_OVERVIEW.md`
- `docs/REPOSITORY_STRUCTURE.md`
- `docs/interfaces/`
- `protocol/schema/`
- `protocol/fixtures/`
- `data/api/`
- `examples/scenarios/`
- root build and dependency files once they exist

Prefer a dedicated contract or integration owner for these surfaces during parallel development.

## 6. Task handoff

Every handoff should state:

- the owned scope and files changed;
- contracts consumed or changed;
- implementation status versus placeholders;
- validation commands and results;
- unresolved decisions or risks;
- whether generated files or migrations were added;
- any follow-up required from another lane.

Do not hand off a feature as complete when only one platform or one side of a transport contract was updated.

## 7. Integration order

Merge or integrate shared foundations before consumers:

```text
Protocol and fixtures
        |
        +--> Interface contracts and Demo scenarios
        +--> Data API and local implementations
        +--> iOS and Android SDK adapters and Demo Apps
        |
        v
Host Engine use cases
        |
        +--> Studio
        +--> CLI / Skills / CI
        |
        v
Cross-module tests and Hub sync
```

When a consumer must begin early, it should use a fixture-backed fake of the approved interface rather than a private model.

## 8. Change discipline

- Use English in the repository.
- Keep unrelated user or agent changes intact.
- Avoid broad mechanical rewrites during parallel work unless explicitly coordinated.
- Keep runtime artifacts under `.vistrea/`.
- Record replaceable architectural choices as ADRs.
- Update module README files only when their ownership or public boundary changes.
- Prefer additive protocol evolution. Breaking changes require explicit version and migration plans.

## 9. Completion criteria

A module task is complete when:

- its public contract is implemented;
- tests cover its primary behavior and failure boundaries;
- dependent fixtures or migrations are current;
- no UI layer bypasses Data or Engine boundaries;
- no runtime artifact is committed;
- documentation accurately distinguishes implemented behavior from planned behavior.

A cross-module feature additionally requires an integration test or a documented, repeatable end-to-end verification path.
