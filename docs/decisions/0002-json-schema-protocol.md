# ADR-0002: JSON Schema for protocol version 1

- Status: Accepted
- Date: 2026-07-12
- Owners: Protocol owner
- Related contracts: `docs/interfaces/`, `protocol/schema/`, `protocol/fixtures/`

## Context

Vistrea needs machine-readable cross-platform contracts before Swift, Kotlin, Host, Data, and Hub implementations can proceed in parallel. The final transport and performance characteristics are not yet known, and selecting a binary protocol now would couple the first implementation slice to premature transport decisions.

## Decision

Protocol version 1 uses JSON Schema Draft 2020-12 for committed JSON representations and canonical fixtures.

Rules:

1. Core objects reject unknown fields by default.
2. Forward-compatible product or platform additions use a namespaced `extensions` object.
3. Schema validation is supplemented by semantic checks for graph references, duplicate IDs, cycles, ordering, and cross-object consistency.
4. Valid, schema-invalid, semantic-invalid, and compatibility-valid fixtures are committed.
5. Validation uses repository-locked Ajv tooling in strict mode with all errors and format support.
6. JSON Schema is the version 1 interchange and fixture contract. A later binary transport may be added through a separate ADR while preserving the same semantics and compatibility tests.
7. Using Node for protocol validation does not select Node as the Host Engine or Data implementation language.
8. The `/schema/v1/` core shape is invariant for all `1.x` representations after `1.0` is accepted. Minor versions may register capability names and namespaced extension contracts only.
9. JSON fixture parsing rejects duplicate object keys and integer literals outside the interoperable safe range before ordinary JSON decoding.

## Alternatives considered

### Protobuf first

Strong generation and efficient binary transport are attractive, but Snapshot structure, compatibility extensions, transport boundaries, and Host language are not yet stable. It was deferred until measurements justify it.

### Platform-native models first

Swift and Kotlin models would accelerate isolated prototypes but would not provide one neutral source of truth. It was rejected.

### Documentation-only contracts

Documentation cannot automatically prevent platform drift. It was rejected as the sole contract.

## Consequences

### Positive

- Human-readable fixtures and diffs.
- Early contract validation without choosing Host implementation language.
- Straightforward compatibility fixtures across platforms.
- Clear separation between schema constraints and semantic graph checks.

### Negative

- Large JSON Snapshots may be slower or larger than a future binary encoding.
- Generated platform models require additional tooling.
- Some invariants cannot be expressed in JSON Schema alone.

### Risks and mitigations

- Schema and semantic checker drift: run both from one repository command and test negative fixtures.
- Extension abuse: require namespaced keys and review additions that should become core fields.
- Performance limits: preserve ObjectRef boundaries and measure before selecting a binary representation.

## Compatibility and migration

All `1.x` representations use the same closed core schema. An unknown higher minor is not itself incompatible. Adding a core property, including an optional property, extending a closed enum, or changing requiredness, validation constraints, identity, units, geometry, canonicalization, or existing field meaning requires a new major version. Compatible `1.x` evolution uses negotiated capabilities and namespaced extensions.

## Validation

- Ajv strict schema compilation;
- valid and invalid fixture manifest;
- semantic reference checks;
- namespaced-extension compatibility fixture;
- higher-minor compatibility fixture with a closed core shape;
- strict duplicate-key and safe-integer parsing fixtures;
- contract test entry point suitable for CI.
