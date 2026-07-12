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
- preserves `accessibilityIdentifier` as the cross-platform `stable_id` when valid;
- records full-display logical geometry, state, text, accessibility, actions, and visual facts;
- captures PNG bytes, computes their encoded SHA-256 identity, and embeds the matching canonical `ObjectReference`;
- returns object bytes separately so Host transport and persistence remain outside the SDK adapter.

`VistreaRuntimeConnection` implements the first Runtime-to-Host transport slice. It:

- connects only to explicit IPv4 or IPv6 TCP loopback endpoints;
- requires a per-run token with HMAC-SHA256 client proof and verifies the Host proof;
- negotiates exactly protocol `1.0` and capability `runtime.snapshot`;
- uses bounded strict UTF-8 JSON-lines, rejects duplicate keys after escape decoding, and applies the Host-advertised line, Object, and chunk limits;
- accepts `capture_request`, returns the canonical `RuntimeSnapshot`, then transfers canonical `ObjectReference` payloads in declared order with Base64 chunks;
- verifies every Object byte count, SHA-256 identity, and Snapshot association before transfer;
- arbitrates cancellation against completion or failure so each capture emits exactly one terminal frame and a crossing late cancel remains a best-effort no-op;
- handles disconnect, transport failure, and concurrent request bounds without logging credentials.

`RuntimeSnapshotCaptureProvider` is the injectable observation boundary. The package tests and Swift/Node interoperability executable use fixture providers. The separate `VistreaRuntimeUIKitConnection` bridge target adapts that port to `UIKitRuntimeCaptureAdapter` on the main actor without making the observation-only UIKit target depend on transport.

The initial UIKit bridge accepts only `trees` with screenshot mode `none`, or
`trees` plus `screenshot` with mode `reference`. It rejects unsupported or
contradictory field masks as a capture failure instead of silently ignoring
them; the authenticated connection remains available for a corrected request.

Build eligibility is compile-time protected. Debug builds accept Debug/Internal declarations. An explicit `VISTREA_INTERNAL_RUNTIME` Swift compilation condition accepts only Internal declarations. Other builds, including Release, reject configuration before opening a socket even if runtime input claims to be Debug.

This first TCP loopback slice connects directly from the iOS Simulator. A physical device requires an external trusted USB or network forwarding layer that presents the Host on device loopback; discovery and forwarding are not implemented by this target.

The adapter is compiled only where UIKit is available. It is included only by internal Debug Demo App builds in the current vertical slice.

The first in-app Inspector is implemented by the iOS Demo App as a Debug-only consumer of this adapter. Protected Design Tuning, runtime events, and the SwiftUI semantic adapter remain separate follow-up capabilities.

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

From the repository root, the cross-language integration test starts the real Node `LoopbackRuntimeHost` plus a raw coalescing Host fixture, runs the Swift fixture client, and verifies authentication, Snapshot/Object transfer, negotiated framing, coalesced state dispatch, cancellation, continued use, close, and token-safe failures:

```bash
pnpm build:host
node --test .build/typescript/tests/integration/ios-runtime-client-interop.test.js
```
