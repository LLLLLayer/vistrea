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
- consults explicitly registered `ViewSemanticsCaptureExtension`s (a constructor parameter, no global registry) for every View before recursing: the first extension returning a subtree replaces that View's children with capture-time semantic nodes, the host node records `extensions["android.capture.semantics_source"]` plus any limitation the extension attributes to it, replaced-but-present embedded child Views surface as an `android.capture.interop-view-children-skipped` limitation, and semantic nodes count toward the node limit and share the walker's deterministic node-identifier scheme;
- bounds every observed string against the canonical `ui-node` field limits (65536 code points for text, value, content description, and both accessibility strings; 4096 for the placeholder) through the shared `CaptureContentLimits`, truncating on a code-point boundary — never splitting a surrogate pair — and recording one node-scoped `android.capture.text-truncated` limitation per affected field, so an over-long TextView or log console degrades that node instead of failing the whole Snapshot at Host schema validation;
- reports an observed identifier that is not a canonical `stable_id` as an `android.capture.stable-id-invalid` limitation instead of dropping stable identity silently;
- redacts password text and accessibility values before they enter the Snapshot;
- optionally renders the observed root into canonical PNG bytes and returns a SHA-256 `ObjectRef` separately from transport and persistence; `beginCapture` stages the main-thread observation and bitmap draw so PNG encoding and hashing can run on a background dispatcher, which the connection capture provider does;
- fails closed on empty roots, off-main-thread capture, display mismatch, node limits, screenshot limits, and encoding failure.

`runtime-connection/` implements the authenticated loopback transport shared with the Node Host:

- literal `127.0.0.1` or `::1` endpoints only;
- HMAC-SHA256 mutual proof compatible with the Node reference implementation;
- bounded fatal UTF-8 JSON lines with duplicate-key rejection; unknown optional fields in Host frames are tolerated for forward compatibility, matching the iOS client;
- negotiated line, object, and chunk limits;
- exact Snapshot-to-`ObjectRef` association plus size and SHA-256 verification;
- bounded concurrent captures, cancellation, clean close, and generic credential-free errors;
- `runtime.events` negotiation when a `RuntimeEventRecorder` is attached: the hello declares the recorder epoch, `subscribe_events` streams strictly ordered `event_batch` frames with explicit dropped-range evidence, retained events release only after `acknowledge_events`, and unresolvable epochs or ranges answer `subscribe_error` conflicts;
- `design.tuning` negotiation when a `RuntimeTuningApplying` controller is attached: only the alpha allowlist applies, with stale-snapshot, original-value, and target checks, the canonical `TuningApplication` is returned, and captured originals always restore on explicit revert, TTL expiry, partial failure, disconnect, and close — restores run non-cancellably in reverse apply order, a change targeting a `(stable_id, property)` another active application already covers rejects with `policy_blocked` instead of stacking, and a restore that fails is reported (`internal`) or tracked instead of being claimed as success.

The current Snapshot slice intentionally supports only two exact field-mask combinations: `{trees}` with `screenshot: "none"`, or `{trees, screenshot}` with `screenshot: "reference"`. Duplicate, unknown, or unsatisfied paths produce `capture_error` without making the connection unusable. Capture completion, failure, and cancellation atomically claim the request before writing a terminal message, so the client makes a best-effort exactly-one choice among `capture_complete`, `capture_error`, and `capture_cancelled`; an unknown or late cancellation is a no-op, and a failed terminal write closes the session instead of attempting a second terminal message.

The connection source is compiled only into the Android library's `debug` and `internal` variants. The `release` AAR has no Runtime client, configuration, authentication, wire, or capture-provider class. `runtime-android` similarly exposes `AndroidViewRuntimeSnapshotCaptureProvider` only from its `debug` and `internal` variants; its Release variant retains observation-only capture without a Host entry point.

`runtime-compose` is observation-only capture, so — like the View capture adapter — it exists in its own Release AAR; the boundary that matters is the application one. Applications must consume it through `debugImplementation`, and `tools/verify-runtime-release-boundary.sh` proves that at the artifact level: the Release Demo APK contains no `dev/vistrea/runtime/compose/` class, no `ComposeSemanticsCaptureExtension`, no `androidx/compose`, and in fact no `androidx/` at all, while the Debug APK contains each one as a positive control. Because the Debug variant now consumes Jetpack Compose, the Demo can no longer fail an accidental AndroidX dependency at build time with `android.useAndroidX=false`; those artifact assertions replace that guard, so flipping any Runtime dependency from `debugImplementation` to `implementation` fails the script instead of shipping.

The Debug Demo Inspector and protected Host bootstrap exist under `examples/android/VistreaDemoApp/`; its Debug variant records transient banner presentation and dismissal through the bounded `RuntimeEventRecorder`, while the Release variant installs no reporter. `AndroidViewRuntimeTuningController` resolves stable identifiers to live views with the capture adapter's candidate order and previews only their alpha on the main thread; it compiles only into the debug and internal variants.

`runtime-compose/` is the Compose bridge, with two halves:

- `Modifier.vistreaSemantics(stableId, role, label)` declares the cross-platform stable identifier as the test tag (exposed as the resource identifier when the application enables `testTagsAsResourceId`), the canonical role wire name as a dedicated `VistreaRole` semantics property for every role, and the optional label as the content description. Only three roles also carry a native Compose semantics fact — `button` sets `Role.Button`, `image` sets `Role.Image`, and `header` calls `heading()`; `link`, `text`, `text-field`, `list-item`, and `container` have no lossless Compose equivalent and travel on the `VistreaRole` key alone, which is exactly why that key exists.
- `ComposeSemanticsCaptureExtension` implements the View walker's semantics extension point for `AndroidComposeView`, which it recognizes through the public `androidx.compose.ui.node.RootForTest` interface (no reflection). It reads the owner's unmerged semantics tree and maps every **placed** semantics node — annotated or not — to a canonical `UiNode`: `testTag` becomes `stable_id` (a testTag that is not a canonical `stable_id` is reported as `android.capture.stable-id-invalid`, not silently dropped), the `VistreaRole` fact (falling back to Compose `Role`, heading, editable-text, and text facts, then `container`) becomes `role`, text/content description fill the shared content fields and are bounded by the same `CaptureContentLimits` as the View path, `Password` semantics redact text and value, `OnClick`/`OnLongClick`/`SetText`/`ScrollBy` become observation-level actions, and pixel geometry converts with the same density and frame-origin math as View nodes. Each node also carries its Compose semantics id under `extensions["android.compose.semantics_node_id"]`.

`SemanticsNode.children` filters detached and deactivated nodes but not unplaced ones, so the walk applies the `layoutInfo.isPlaced` filter that Compose's own accessibility bridge applies. Without it a never-placed node — most visibly an item a `LazyColumn` or `LazyRow` prefetches ahead of the viewport — reports `Offset.Zero` and would be emitted as a phantom node stacked on the Compose root's top-left corner that automation could target, and the captured node set would depend on scroll velocity and frame timing, so one screen would split into several Screen States run to run. `:runtime-compose:connectedDebugAndroidTest` proves both halves on a device: a measured-but-never-placed composable never becomes a node, and a 30-item `LazyColumn` scrolled away by real deltas and back yields an identical node set and an identical structural digest (the same `[role, native_type, stable_id, children]` canonical form the exploration engine's `computeStructuralIdentity` uses).

Known Compose capture limits: the capture is the semantics tree, so composables that contribute no semantics produce no node, and the semantics tree exposes no rendering facts at all — no `visual` (colors, fonts, alpha), no `z_index`, and no `source_context` — because `SemanticsNode` carries none of them and the only route to text layout is invoking a semantics action, which an observation-only capture must never do. Rather than inventing values, the Compose host node records an `android.capture.compose-visual-unavailable` limitation so design review, pixel comparison, and UI tuning read those facts as unavailable rather than as defaults; a Compose screen therefore has no visual source of truth beyond the screenshot until a rendering-side adapter exists. Child Views embedded through `AndroidView` interop are skipped and flagged on the host node; Compose UI tuning is not implemented. Automatic View event observation and additional tuning properties also remain follow-up work. The pure `SemanticsConfiguration`-to-`UiNode` mapping is covered by plain JVM unit tests; the live `AndroidComposeView` loop is covered by `:runtime-compose:connectedDebugAndroidTest`, and a fake-extension `:runtime-android:connectedDebugAndroidTest` proves the walker-side subtree replacement without Compose.

## Verification

Run from this directory:

```bash
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew test :runtime-connection:testDebugUnitTest \
  :runtime-android:assembleDebug :runtime-android:assembleRelease \
  :runtime-android:lintDebug \
  :runtime-compose:test :runtime-compose:assembleDebug \
  :runtime-compose:assembleRelease :runtime-compose:lintDebug

ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew :runtime-android:connectedDebugAndroidTest \
  :runtime-compose:connectedDebugAndroidTest

ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./tools/verify-runtime-release-boundary.sh
```

The checked-in Gradle wrapper pins the distribution and verifies its SHA-256 checksum.
