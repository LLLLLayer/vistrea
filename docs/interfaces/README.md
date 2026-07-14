# Interface Specifications

Status: **Draft for protocol version 1.0**

These documents define the initial cross-module contracts for parallel implementation. The accepted module boundaries are normative; operation details remain draft until backed by machine-readable schemas, canonical fixtures, and contract tests. They are intentionally independent of the final programming language, IDL, and transport choices.

## Contract map

| Contract | Producers | Consumers | Specification |
|---|---|---|---|
| Common envelopes, IDs, errors, versions | All modules | All modules | `COMMON_CONTRACTS.md` |
| Operation ownership and adapter parity | Host Engine | Studio, CLI, Skills, CI | `OPERATION_CATALOG.md` |
| Runtime SDK connection | iOS/Android SDKs | Connection Engine | `RUNTIME_CONNECTION.md` |
| Real device actions | WDA/UIAutomator adapters | Automation and Exploration Engines | `AUTOMATION_API.md` |
| Product use cases | Host Engine | Studio, CLI, Skills, CI | `ENGINE_API.md` |
| Persistence ports | Data implementations | Host Engine | `DATA_API.md` |
| Agent-facing surfaces | CLI, Skills | Coding Agents and CI | `AGENT_INTERFACES.md` |
| Cross-team synchronization | Vistrea Hub | Local Sync Client | `HUB_API.md` |

Product interaction mapping is defined separately in `../product/STUDIO_INTERACTIONS.md`.

## Authority

- Product invariants remain authoritative in `docs/PROJECT_OVERVIEW.md`.
- Layer ownership remains authoritative in `docs/REPOSITORY_STRUCTURE.md`.
- These specifications own public operation names, input/output semantics, errors, and lifecycle behavior.
- Accepted machine-readable schemas, fixtures, and `protocol/model-coverage/v1.json` are canonical for the complete shared `DataUnitOfWork` value surface. `integrations/shared/host-operation-manifest.ts` is canonical for implemented Host operation, route, and CLI parity. Documentation remains authoritative for Phase 0B request, query, pagination, transaction, and reserved operation types that do not yet have executable contracts.

## Change policy

Any breaking contract change must include:

1. compatibility impact;
2. protocol or API version change;
3. updated canonical fixtures;
4. affected module owners;
5. migration or rollout plan;
6. contract and integration test updates.

Do not implement a private variant of a documented shared interface.
