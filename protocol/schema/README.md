# Protocol Schemas

Machine-readable canonical definitions for protocol major version 1 use JSON Schema Draft 2020-12 under `v1/`. The closed core shape applies to every `1.x` representation; compatible minor evolution uses capabilities and namespaced extensions.

Core objects reject unknown fields. Forward-compatible additions use namespaced `extensions`. JSON Schema covers shape; repository semantic checks cover graph references, identity, geometry, object integrity, and Commit identity.

Run `pnpm protocol:validate` from the repository root. The validator uses strict JSON parsing before Ajv so duplicate keys and unsafe integer literals cannot be silently normalized.
