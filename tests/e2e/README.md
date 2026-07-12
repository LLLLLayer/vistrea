# End-to-end Tests

Real native acceptance tests are opt-in because they create dedicated simulators or emulators and build native applications:

```bash
pnpm test:e2e:ios-real-vertical
pnpm test:e2e:android-real-vertical
pnpm test:e2e:android-real-automation
pnpm test:e2e:ios-real-automation
```

The vertical tests verify `demo.navigation.basic` from native Demo launch through Runtime connection, canonical Snapshot and PNG capture, Host receipt, Studio presentation, CLI readback, production SQLite/Object Store persistence, and Data reopen. They also verify per-run credential rotation and scan generated evidence for leaked Host credentials.

The Android automation test walks the same scenario with real user-level input: the Automation Engine resolves `demo.home.open_catalog` from a persisted Snapshot, `AdbAutomationProvider` injects a genuine tap and system back through `adb shell input`, and captured Snapshots prove the navigation. Both endpoint states, the deduplicated return to Home under one structural identity, and forward plus back Transitions are recorded through the Host `screen-graph` API and read back with a path query.

The iOS automation test mirrors the Android one through WebDriverAgent: it boots the XCUITest-hosted driver from an operator-provided checkout against a dedicated Simulator, taps and edge-swipes in logical points over the W3C actions protocol, and finishes with the same autonomous exploration and version tag. Prepare it once with `git clone https://github.com/appium/WebDriverAgent` and export `VISTREA_WDA_PROJECT=<checkout>/WebDriverAgent.xcodeproj`; without the variable the test skips with instructions.

The iOS lanes require macOS, Xcode, and an available iOS Simulator runtime. The Android lanes additionally require an API 36 or newer AVD, the Android SDK, and `adb`; they transfer the one-shot Runtime token through standard input to the app-private token installer and use `adb reverse` for loopback transport. These tests do not yet claim iOS device automation, exploration, Canvas/Deep Wiki persistence, or validation coverage.
