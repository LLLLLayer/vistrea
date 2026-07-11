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

The adapter is compiled only where UIKit is available. It is included only by internal Debug Demo App builds in the current vertical slice.

The first in-app Inspector is implemented by the iOS Demo App as a Debug-only consumer of this adapter. Protected Design Tuning, runtime events, the SwiftUI semantic adapter, and the Host transport remain separate follow-up capabilities.

## Verify

From this directory:

```bash
swift test
```

Compile the UIKit target for the Simulator rather than relying on the macOS conditional build:

```bash
xcodebuild -scheme VistreaRuntimeUIKit \
  -destination 'generic/platform=iOS Simulator' \
  build
```
