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

`runtime-connection/` implements the authenticated Snapshot-only loopback transport shared with the Node Host:

- literal `127.0.0.1` or `::1` endpoints only;
- HMAC-SHA256 mutual proof compatible with the Node reference implementation;
- bounded fatal UTF-8 JSON lines with duplicate-key and unknown-key rejection;
- negotiated line, object, and chunk limits;
- exact Snapshot-to-`ObjectRef` association plus size and SHA-256 verification;
- bounded concurrent captures, cancellation, clean close, and generic credential-free errors.

The current Snapshot slice intentionally supports only two exact field-mask combinations: `{trees}` with `screenshot: "none"`, or `{trees, screenshot}` with `screenshot: "reference"`. Duplicate, unknown, or unsatisfied paths produce `capture_error` without making the connection unusable. Capture completion, failure, and cancellation atomically claim the request before writing a terminal message, so the client makes a best-effort exactly-one choice among `capture_complete`, `capture_error`, and `capture_cancelled`; an unknown or late cancellation is a no-op, and a failed terminal write closes the session instead of attempting a second terminal message.

The connection source is compiled only into the Android library's `debug` and `internal` variants. The `release` AAR has no Runtime client, configuration, authentication, wire, or capture-provider class. `runtime-android` similarly exposes `AndroidViewRuntimeSnapshotCaptureProvider` only from its `debug` and `internal` variants; its Release variant retains observation-only capture without a Host entry point.

The Debug Demo Inspector and protected Host bootstrap exist under `examples/android/VistreaDemoApp/`. Protected Design Tuning, event capture, and the separate Compose Semantics adapter remain follow-up work.

## Verification

Run from this directory:

```bash
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew test :runtime-connection:testDebugUnitTest \
  :runtime-android:assembleDebug :runtime-android:assembleRelease \
  :runtime-android:lintDebug

ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew :runtime-android:connectedDebugAndroidTest

ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./tools/verify-runtime-release-boundary.sh
```

The checked-in Gradle wrapper pins the distribution and verifies its SHA-256 checksum.
