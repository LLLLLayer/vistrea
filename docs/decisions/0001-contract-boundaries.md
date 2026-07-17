# ADR-0001: Contract-first module boundaries

- Status: Accepted
- Date: 2026-07-12
- Owners: Project architecture owner
- Related contracts: `docs/interfaces/`

## Context

Vistrea will be implemented in parallel across iOS, Android, Host Engine, Data Layer, Studio, Agent integrations, tests, and an optional Hub service. The implementation languages and transport/schema technologies are not yet selected.

Without language-neutral contracts, parallel modules are likely to create incompatible models, duplicate business logic, or couple UI directly to persistence and device providers.

## Decision

Vistrea adopts contract-first boundaries with these rules:

1. `protocol/` owns shared wire models and compatibility fixtures.
2. `engine/` owns product use cases and domain behavior.
3. `data/api/` owns storage ports; concrete Data implementations remain replaceable.
4. Runtime SDK and device automation are separate contracts.
5. Studio, CLI, MCP, Skills, and CI map to the same Engine use cases.
6. Hub sync uses the same Commit Manifest and ObjectRef semantics as local pack exchange.
7. Public commands, queries, events, errors, IDs, versions, and operation behavior are documented before parallel implementation.
8. The current interface documents are semantically normative but transport- and language-neutral until an IDL ADR is accepted.

## Alternatives considered

### Let each platform define native models first

This accelerates individual prototypes but creates incompatible identity, geometry, event, design, and version semantics. It was rejected.

### Select one implementation language and expose its types everywhere

This creates fast initial code sharing but couples mobile, Host, storage, and Hub evolution to one runtime and does not remove the need for wire compatibility. It was rejected.

### Use UI-facing view models as the shared contract

This couples domain behavior to Studio and makes CLI, MCP, Skills, and tests secondary implementations. It was rejected.

## Consequences

### Positive

- Parallel agents can implement separate modules against one contract.
- Studio and Agent adapters cannot silently diverge.
- Local and Hub storage remain replaceable.
- Protocol fixtures become executable integration evidence.
- Toolchain selection can happen after semantic design.

### Negative

- Contract work precedes visible product implementation.
- Interface changes require coordinated fixtures and tests.
- Some pseudocode contracts will need translation into the selected IDL and languages.

### Risks and mitigations

- Risk: documentation drifts from code. Mitigation: generate public models, validate fixtures, and add adapter parity tests.
- Risk: excessive abstraction before the first loop. Mitigation: implement only operations required by the first vertical milestone, while reserving names for later phases.
- Risk: one contract becomes a bottleneck. Mitigation: assign a single integration owner and enable module work behind approved revisions.

## Compatibility and migration

The first machine-readable protocol version starts at `1.0` after the schema-format ADR is accepted. Pre-implementation documents may change without data migration but must preserve explicit change history once parallel implementation begins.

## Validation

- canonical fixtures consumed by Swift, Kotlin, Host, Data, and Hub tests;
- Host operation manifest, CLI, and public-catalog parity tests;
- SDK-to-Host handshake tests;
- Data API in-memory and SQLite contract tests;
- one complete Demo App vertical loop.
