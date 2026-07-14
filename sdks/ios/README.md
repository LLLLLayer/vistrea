# Vistrea iOS SDK

iOS Runtime SDK and in-app Inspector. UIKit is the first adapter; SwiftUI semantics should be added through an explicit separate adapter.

## Implemented targets

`VistreaRuntimeModels` is a Foundation-only Swift Package target for the canonical protocol v1 Runtime Snapshot surface. It provides:

- strongly typed Snapshot, Project, Build, Device, Tree, Node, and Event Epoch IDs;
- canonical `RuntimeSnapshot`, `UiTree`, `UiNode`, geometry, runtime-context, screenshot, and Object Reference values;
- closed-core decoding that rejects unknown protocol fields;
- lossless relay of arbitrary JSON values under validated namespaced extension keys;
- fixture-backed tests against the repository's minimal, iOS UIKit, and higher-minor compatibility Snapshots.

The canonical model target does not import UIKit or Core Graphics.

`VistreaRuntimeUIKit` is the observation-only UIKit adapter. On the main actor it:

- selects the visible application window without invoking business methods;
- flattens the actual UIKit view hierarchy into canonical `UiTree` and `UiNode` values;
- synthesizes per-element child nodes for non-view accessibility elements that container views expose (`UIAccessibilityElement` and SwiftUI's accessibility nodes): screen-coordinate element frames convert into the same logical window space as view frames, declared traits map to the canonical role vocabulary, valid identifiers become `stable_id`, button and link traits yield `tap`, and the hosting view records the `ios.capture.semantics_source = "accessibility"` extension so synthesized provenance stays explicit. A synthetic element has no coordinate space or layer of its own, so its node carries frame, role, text, state, actions, and accessibility facts but no `bounds`, `z_index`, `clipped`, or `visual` values;
- bounds the element walk with explicit depth and per-container count limits plus a cycle guard, reporting every omission as an `ios.capture.accessibility-elements-omitted` limitation; views that are themselves accessibility elements are leaves and capture exactly as before;
- records an `ios.capture.content-not-observable` limitation for any view that declares an accessibility container yet exposes no elements, rather than emitting it as a childless leaf (see below);
- preserves `accessibilityIdentifier` as the cross-platform `stable_id` when valid;
- records full-display logical geometry, state, text, accessibility, actions, and visual facts for every UIView node;
- captures PNG bytes, computes their encoded SHA-256 identity, and embeds the matching canonical `ObjectReference`;
- returns object bytes separately so Host transport and persistence remain outside the SDK adapter.

`VistreaRuntimeConnection` implements the first Runtime-to-Host transport slice. It:

- connects only to explicit IPv4 or IPv6 TCP loopback endpoints;
- requires a per-run token with HMAC-SHA256 client proof and verifies the Host proof;
- negotiates exactly protocol `1.0` and capability `runtime.snapshot`, plus `runtime.events` when a `RuntimeEventRecorder` is attached and the Host echoes the declared event epoch;
- uses bounded strict UTF-8 JSON-lines, rejects duplicate keys after escape decoding, and applies the Host-advertised line, Object, and chunk limits;
- accepts `capture_request`, returns the canonical `RuntimeSnapshot`, then transfers canonical `ObjectReference` payloads in declared order with Base64 chunks;
- verifies every Object byte count, SHA-256 identity, and Snapshot association before transfer;
- arbitrates cancellation against completion or failure so each capture emits exactly one terminal frame and a crossing late cancel remains a best-effort no-op;
- answers `subscribe_events` from the bounded `RuntimeEventRecorder`, streams strictly ordered `event_batch` frames with explicit dropped-range evidence, releases retained events only after `acknowledge_events`, and reports unresolvable epochs or ranges as `subscribe_error` conflicts;
- negotiates `design.tuning` when a `RuntimeTuningApplying` controller is attached, applies only the alpha allowlist with stale-snapshot, original-value, and target checks, returns the canonical `TuningApplication`, and always restores captured originals on explicit revert, TTL expiry, partial failure, disconnect, and close;
- handles disconnect, transport failure, and concurrent request bounds without logging credentials.

`RuntimeSnapshotCaptureProvider` is the injectable observation boundary. The package tests and Swift/Node interoperability executable use fixture providers. The separate `VistreaRuntimeUIKitConnection` bridge target adapts that port to `UIKitRuntimeCaptureAdapter` on the main actor without making the observation-only UIKit target depend on transport.

The initial UIKit bridge accepts only `trees` with screenshot mode `none`, or
`trees` plus `screenshot` with mode `reference`. It rejects unsupported or
contradictory field masks as a capture failure instead of silently ignoring
them; the authenticated connection remains available for a corrected request.

Build eligibility is compile-time protected. Debug builds accept Debug/Internal declarations. An explicit `VISTREA_INTERNAL_RUNTIME` Swift compilation condition accepts only Internal declarations. Other builds, including Release, reject configuration before opening a socket even if runtime input claims to be Debug.

This first TCP loopback slice connects directly from the iOS Simulator. A physical device requires an external trusted USB or network forwarding layer that presents the Host on device loopback; discovery and forwarding are not implemented by this target.

The adapter is compiled only where UIKit is available. It is included only by internal Debug Demo App builds in the current vertical slice.

The first in-app Inspector is implemented by the iOS Demo App as a Debug-only consumer of this adapter. `RuntimeEventRecorder` provides bounded per-epoch event retention with monotonic sequences; the Demo App records transient banner presentation and dismissal through it in Debug builds. `UIKitRuntimeTuningController` resolves stable identifiers to live views and previews allowlisted alpha, foreground/background color, font, spacing, content-inset, and corner-radius changes on the main actor. Unsupported view/property combinations reject explicitly and every accepted preview is reversible.

`VistreaRuntimeSwiftUI` is the SwiftUI semantic annotation bridge: `.vistreaSemantics(stableID:role:label:)` declares the cross-platform `stable_id`, a canonical role, and an optional label as standard accessibility facts, and the UIKit capture adapter maps declared accessibility traits back to the canonical role vocabulary for hosted content whose view classes are private. Two role limits are deliberate: `.listItem` and `.container` carry no accessibility traits, so these structural roles do not round-trip through the accessibility bridge and are captured as `container`; `.textField` maps to the search-field trait, which VoiceOver announces as a search field, so annotate production text fields deliberately. Automatic UIKit event observation and physical-device acceptance of the broader UIKit tuning matrix remain separate follow-up capabilities.

### SwiftUI hosted content, and what the capture does when it cannot observe it

A SwiftUI hosting view builds its accessibility node tree only while an app-level accessibility runtime is active — the state VoiceOver and the Accessibility Inspector establish.

**While that runtime is active**, hosted content captures as real per-element child nodes through the accessibility-element synthesis above: one node per exposed element, with its frame in the same logical window space as view frames, its role from declared traits, its `stable_id` from a valid identifier, and `tap` for button and link traits. SwiftUI's accessibility nodes implement the standard `accessibilityIdentifier` accessor without declaring `UIAccessibilityIdentification` conformance, so the adapter reads the identifier dynamically through that public selector.

**While that runtime is dormant**, the hosting view returns an empty `accessibilityElements` array, so no child nodes can be synthesized. The capture does not report this as an empty screen. It records a node-scoped `ios.capture.content-not-observable` limitation (severity `warning`, field `child_ids`) on the hosting view's node, stating that the content is only observable while an accessibility runtime is active. A consumer can therefore distinguish "this screen has no content" from "this capture could not observe its content". This matters beyond honesty: structural identity is hashed from the node tree, so without the limitation the same SwiftUI screen would hash to two different identities depending on whether an accessibility runtime happened to be active. The code string is a cross-module contract — the Screen Graph Engine keys on it to refuse a state observation from an unobservable Snapshot — so it must not be renamed.

The detection signal is the present-but-empty accessibility container: a view that is not itself an accessibility element and returns a non-`nil`, empty `accessibilityElements`. Measured on the iOS 26 Simulator, a dormant `_UIHostingView` returns `[]`, while `UIView`, `UIImageView`, and every view of a 144-view UIKit hierarchy return `nil`, with the runtime both dormant and active. Subview count is deliberately not part of the signal: a dormant hosting view whose content includes a UIKit-backed control does have subviews while its drawn content is still unobservable. One case is knowingly conservative: SwiftUI content hidden with `.accessibilityHidden(true)` also vends zero elements and does not set `accessibilityElementsHidden` on the hosting view, so it is reported the same way; the two states are indistinguishable at the UIKit boundary, and "content not observed" stays the honest statement.

The SDK only observes this runtime state and never toggles it. What the tests actually prove, and what they do not:

- **Proven unconditionally by `swift test`** (the UIKit adapter itself does not compile on macOS): the limitation value carries the exact code `ios.capture.content-not-observable`, severity `warning`, `retryable: false`, and a node scope on `child_ids`, and its code satisfies the protocol v1 `CaptureLimitation.code` pattern.
- **Proven unconditionally by the UIKit suite on a Simulator**: a capture records the limitation, scoped to the right node, for a hosting-style view that declares an empty accessibility container — both with and without UIKit-backed subviews, whose real subviews are still captured; it records nothing for a container that does expose elements, nothing for plain UIKit views, and nothing for a real SwiftUI hosting view captured while the accessibility runtime is active.
- **Proven conditionally**: the dormant-capture assertions against real SwiftUI run only when the accessibility runtime is dormant at test start. The test probes the hosting view's actual exposure and skips those assertions when a runtime is already live, because once SwiftUI has built its accessibility node tree, disabling the runtime does not tear it down. The hosted-capture test flips the simulator's persistent runtime flag itself and restores the prior state; that toggle stays strictly inside the test bundle.
- **Expected but unverified**: that a WebDriverAgent or XCUITest session activates the accessibility runtime for the target app. Nothing in this repository verifies that third-party behavior, so the capture does not depend on it — a dormant capture degrades honestly through the limitation above rather than assuming automation has enabled the runtime.

## Verify

From this directory:

```bash
swift test
swift test --configuration release
```

Compile the UIKit target for the Simulator rather than relying on the macOS conditional build:

```bash
xcodebuild -scheme VistreaRuntimeUIKit \
  -destination 'generic/platform=iOS Simulator' \
  build
```

Run the UIKit-gated capture tests (including the real SwiftUI hosted-capture
round-trip) on a booted Simulator:

```bash
xcodebuild test -scheme VistreaIOSSDK-Package \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  -only-testing:VistreaRuntimeUIKitTests
```

Known pre-existing iOS-only failures outside this target: two
`VistreaRuntimeModelsTests` cases assert macOS-specific `DecodingError`
message wording ("Unknown core field") that the iOS runtime formats
differently; the rejection behavior itself passes on both platforms.

From the repository root, the cross-language integration test starts the real Node `LoopbackRuntimeHost` plus a raw coalescing Host fixture, runs the Swift fixture client, and verifies authentication, Snapshot/Object transfer, negotiated framing, coalesced state dispatch, cancellation, continued use, close, and token-safe failures:

```bash
pnpm build:host
node --test .build/typescript/tests/integration/ios-runtime-client-interop.test.js
```
