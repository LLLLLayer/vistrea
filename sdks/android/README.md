# Vistrea Android SDK

Android Runtime SDK and in-app Inspector. Traditional View/ViewGroup and Jetpack Compose Semantics are captured through separate adapters and mapped into the shared protocol.

## Implemented foundation

This directory currently contains a pure Kotlin/JVM protocol adapter for the canonical version 1 `RuntimeSnapshot`, `UiTree`, and `UiNode` JSON surface. It:

- is directly usable by Android code without depending on Android framework types;
- uses typed protocol identifiers and core enums;
- rejects unknown core JSON fields;
- preserves arbitrary namespaced extension JSON values;
- verifies the canonical minimal, Android View, and higher-minor compatibility fixtures.

The Runtime capture adapter, Inspector, protected Design Tuning, and transport are not implemented yet. Keep those concerns separate from these platform-neutral models.

## Verification

Run from this directory:

```bash
./gradlew test
```

The checked-in Gradle wrapper pins the distribution and verifies its SHA-256 checksum.
