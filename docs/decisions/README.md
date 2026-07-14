# Architecture Decision Records

Record schema format, transport, storage, implementation language, state deduplication, and other replaceable decisions with context, alternatives, selection, and consequences.

- `0000-template.md`: ADR template
- `0001-contract-boundaries.md`: accepted contract-first module boundaries
- `0002-json-schema-protocol.md`: accepted JSON Schema version 1 protocol
- `0003-object-and-commit-identity.md`: accepted object, commit, ref, and Working Set identity
- `0004-host-data-and-sqlite-migrations.md`: accepted Host/Data toolchain, SQLite driver, and migration policy
- `0005-ios-first-vertical-loop.md`: accepted first native end-to-end slice and its boundary-level acceptance path
- `0006-vistrea-pack-container.md`: accepted `.vistrea-pack` version 1 container framing and import verification order
- `0007-screen-state-identity-and-device-automation.md`: accepted the `structural-v1` Screen State identity, single coherent materialized graph with frozen version tags, and the adb/WebDriverAgent provider pair
- `0008-cli-only-agent-adapter.md`: retired the stdio MCP server; the strict JSON CLI with `VISTREA_CLI_TOOLSETS` focus is the single agent adapter
- `0009-direct-macos-distribution.md`: accepted Developer ID, notarized GitHub Releases, and signed Sparkle updates for direct Studio distribution
- `0010-physical-runtime-tls.md`: accepted exact-IP TLS 1.3 with leaf-certificate pinning for physical-device Runtime connections while the Host Local API stays loopback-only
- `0011-hub-rbac-and-operational-audit.md`: accepted project-scoped Hub RBAC, per-principal grants, separate append-only operational audit, and a least-privilege activity projection
