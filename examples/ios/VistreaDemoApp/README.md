# VistreaDemoApp for iOS

The canonical native UIKit executable fixture for Vistrea.

## Implemented slice

- The app loads all required Scenario IDs directly from the shared manifest and fixture files under `../../scenarios/`; it does not maintain a private scenario catalog.
- `VISTREA_SCENARIO_ID` and `VISTREA_SCENARIO_PROFILE` select a deterministic launch state. Without them, the app shows the complete scenario list.
- Scenario-required nodes use the shared stable node IDs as UIKit accessibility identifiers.
- The data-driven UIKit renderer supports screen, loading, error, transient, overlay, dialog, banner, tap, type, wait, dismiss, and back fixtures needed by the current suite.
- Five scenarios route through dedicated controllers via `ScenarioEntryFactory`: the storefront (`demo.store.navigation`) keeps every screen on one navigation stack with a snap-aligned recycled catalog whose scrolled tree stays structurally identical; search (`demo.store.search`) filters the deterministic catalog on every keystroke and restores the exact entry structure on clear; the bottom sheet (`demo.store.sheet`) is an in-tree overlay; the cart (`demo.store.cart-states`) toggles between two real structures in memory; and `demo.mixed.declarative` hosts SwiftUI content whose stable nodes carry `.accessibilityIdentifier`.
- `ScenarioInputAliases` maps the fixtures' `input_alias` values (`VALID_NAME`, `QUERY_MATCHING`, `QUERY_UNMATCHED`) to the deterministic strings automation types.
- The hosted `VistreaDemoAppTests` unit bundle freezes the required scenario-id set (`ScenarioContractTests`, mirroring Android's `ScenarioContractTest`) and covers the dedicated controllers' structural state machines.
- A Debug-only in-app Runtime Inspector captures the real hierarchy and screenshot through `VistreaRuntimeUIKit`, then shows the canonical Snapshot identity and View Tree.
- A Debug-only Runtime connection entry composes the same UIKit capture with `VistreaRuntimeConnection` and serves authenticated Host `capture_request` messages.
- Debug builds report transient banner presentation and dismissal as canonical Runtime events through the SDK's bounded `RuntimeEventRecorder`, which streams acknowledged event batches to the connected Host.
- Release builds do not expose the Inspector entry point.

The automation provider remains a separate implementation slice. User and automation actions operate UIKit controls; the Runtime SDK only observes their results.

## Debug Runtime connection

The checked-in Debug scheme contains disabled placeholders for these launch variables:

- `VISTREA_RUNTIME_HOST`: `127.0.0.1` or `::1`;
- `VISTREA_RUNTIME_PORT`: the ephemeral Node Host port;
- `VISTREA_RUNTIME_TOKEN`: a per-run token of at least 32 bytes.

Enable and populate all three only for the active Host run. The token is never committed, placed in command-line arguments, included in a Snapshot, or reflected in transport errors. The bootstrap source is compiled under `#if DEBUG`; Release has no launch-variable lookup and the SDK configuration also fails closed outside Debug or an explicitly compiled Internal build.

The current direct path targets the iOS Simulator. Physical-device discovery and trusted Host forwarding remain separate follow-up work.

## Generate and verify

The checked-in Xcode project is generated from `project.yml`:

```bash
xcodegen generate
xcodebuild -project VistreaDemoApp.xcodeproj \
  -scheme VistreaDemoApp \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

The UI test launches `demo.navigation.basic`, follows its shared stable IDs to
the Detail state, opens the Debug Inspector, and proves that a real UIKit
capture produced a non-empty View Tree:

```bash
xcodebuild -project VistreaDemoApp.xcodeproj \
  -scheme VistreaDemoApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  test
```

The shared `demo.navigation.basic` scenario is the first complete Host/Data acceptance path.
