# Vistrea Android SDK

Android Runtime SDK and in-app Inspector. Traditional View/ViewGroup and Jetpack Compose Semantics are captured through separate adapters and mapped into the shared protocol.

## Implemented foundation

This directory currently contains a pure Kotlin/JVM protocol adapter for the canonical version 1 `RuntimeSnapshot`, `UiTree`, and `UiNode` JSON surface. It:

- is directly usable by Android code without depending on Android framework types;
- uses typed protocol identifiers and core enums;
- rejects unknown core JSON fields;
- preserves arbitrary namespaced extension JSON values;
- verifies the canonical minimal, Android View, and higher-minor compatibility fixtures.

`runtime-android/` is a separate Android library adapter over those models. Its `AndroidViewRuntimeCaptureAdapter`:

- walks a real View/ViewGroup hierarchy on the main thread without invoking application business methods;
- converts Android pixels into full-display logical points using effective display density;
- records stable IDs, parent/child identity, visibility, interaction actions, accessibility, and reviewable visual properties;
- redacts password text and accessibility values before they enter the Snapshot;
- optionally renders the observed root into canonical PNG bytes and returns a SHA-256 `ObjectRef` separately from transport and persistence;
- fails closed on empty roots, off-main-thread capture, display mismatch, node limits, screenshot limits, and encoding failure.

The Debug Demo Inspector exists under `examples/android/VistreaDemoApp/`. Host transport, protected Design Tuning, event capture, and the separate Compose Semantics adapter remain follow-up work.

## Verification

Run from this directory:

```bash
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew test :runtime-android:assembleDebug :runtime-android:lintDebug

ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew :runtime-android:connectedDebugAndroidTest
```

The checked-in Gradle wrapper pins the distribution and verifies its SHA-256 checksum.
