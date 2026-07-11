# Protocol Fixtures

Shared valid, JSON-invalid, schema-invalid, semantic-invalid, compatibility, and platform-extension examples under `v1/`. The versioned `manifest.json` defines each fixture's schema, expected outcome, and exact required error evidence. Every JSON fixture file must appear in the manifest.

These fixtures are the executable compatibility input for Swift, Kotlin, Host Engine, Data Layer, CLI, and Hub implementations. The Phase 0A2 corpus also exercises cross-model references, Review Issue history, tuning reversion, Validation summaries, and durable Operation state.
