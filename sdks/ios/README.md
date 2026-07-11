# Vistrea iOS SDK

iOS Runtime SDK and in-app Inspector. UIKit is the first adapter; SwiftUI semantics should be added through an explicit separate adapter.

## Implemented foundation

`VistreaRuntimeModels` is a Foundation-only Swift Package target for the canonical protocol v1 Runtime Snapshot surface. It provides:

- strongly typed Snapshot, Project, Build, Device, Tree, Node, and Event Epoch IDs;
- canonical `RuntimeSnapshot`, `UiTree`, `UiNode`, geometry, runtime-context, screenshot, and Object Reference values;
- closed-core decoding that rejects unknown protocol fields;
- lossless relay of arbitrary JSON values under validated namespaced extension keys;
- fixture-backed tests against the repository's minimal, iOS UIKit, and higher-minor compatibility Snapshots.

The canonical model target does not import UIKit or Core Graphics. A later UIKit capture target will translate platform values into these neutral protocol values.

Runtime capture, UIKit and SwiftUI adapters, the in-app Inspector, protected Design Tuning, and Host transport are not implemented yet. Keep those concerns in separate targets as they are added.

## Verify

From this directory:

```bash
swift test
```
