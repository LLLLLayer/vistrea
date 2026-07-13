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

The iOS automation test mirrors the Android one through WebDriverAgent: it boots the XCUITest-hosted driver from an operator-provided checkout against a dedicated Simulator, taps and edge-swipes in logical points over the W3C actions protocol, and finishes with the same autonomous exploration and version tag. Prepare it once with `pnpm wda prepare`, which clones the pinned WebDriverAgent release into `~/.vistrea/cache/webdriveragent/<commit>` and refuses any other commit, then export `VISTREA_WDA_PROJECT=$HOME/.vistrea/cache/webdriveragent/<commit>/WebDriverAgent.xcodeproj` (an existing operator-managed checkout keeps working through the same variable; without it the test skips with instructions). Outside the test lanes, `pnpm wda up` boots WebDriverAgent on a Simulator — or a real device with `--device <udid>`, resolving the signing team from `--team`, an `--app-project`, or the Keychain — waits for readiness, and prints the exact `--wda-url` the Host needs. `pnpm wda doctor` reports toolchain, checkout, signing, and forwarder readiness.

The iOS lanes require macOS, Xcode, and an available iOS Simulator runtime. The Android lanes additionally require an API 36 or newer AVD, the Android SDK, and `adb`; they transfer the one-shot Runtime token through standard input to the app-private token installer and use `adb reverse` for loopback transport. The iOS automation lane is implemented but has not yet passed on a device; validation, Canvas, and Deep Wiki workflows have no end-to-end lane yet.

## Device regression cadence

Both automation lanes are opt-in because they create dedicated devices and
take minutes, not seconds. Run them before releasing a change that touches
capture, the Runtime transport, automation providers, identity, or
exploration:

```bash
pnpm test:e2e:android-real-automation
VISTREA_WDA_PROJECT=<checkout>/WebDriverAgent.xcodeproj pnpm test:e2e:ios-real-automation
```

Each lane now proves `automation.safety` on the real device as well: a
dangerous-classified action is denied without a confirmation token and the
bound token authorizes exactly one real execution. Emulator hazards the lanes
defend against — a slept display swallowing injected input, cold-boot SystemUI
ANR dialogs, and launcher churn — are handled inside the tests, so a failure
means a real product problem; failed navigation preserves window focus, the UI
tree, and a screenshot for triage.
