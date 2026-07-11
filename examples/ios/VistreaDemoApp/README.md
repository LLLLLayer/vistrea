# VistreaDemoApp for iOS

The canonical native UIKit executable fixture for Vistrea.

## Implemented slice

- The app loads all required Scenario IDs directly from the shared manifest and fixture files under `../../scenarios/`; it does not maintain a private scenario catalog.
- `VISTREA_SCENARIO_ID` and `VISTREA_SCENARIO_PROFILE` select a deterministic launch state. Without them, the app shows the complete scenario list.
- Scenario-required nodes use the shared stable node IDs as UIKit accessibility identifiers.
- The data-driven UIKit renderer supports screen, loading, error, transient, overlay, dialog, banner, tap, type, wait, dismiss, and back fixtures needed by the current suite.
- A Debug-only in-app Runtime Inspector captures the real hierarchy and screenshot through `VistreaRuntimeUIKit`, then shows the canonical Snapshot identity and View Tree.
- Release builds do not expose the Inspector entry point.

The loopback Host transport and automation provider are separate implementation slices. User and automation actions operate UIKit controls; the Runtime SDK only observes their results.

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
