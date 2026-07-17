# End-to-end Tests

Real native acceptance tests are opt-in because they create dedicated
simulators/emulators or explicitly install onto a selected physical device, and
they build native applications:

```bash
pnpm test:e2e:ios-real-vertical
pnpm test:e2e:android-real-vertical
VISTREA_IOS_DEVICE=<device-id-or-udid> \
VISTREA_IOS_DEVELOPMENT_TEAM=<team-id> \
  pnpm test:e2e:ios-physical-vertical
VISTREA_ANDROID_DEVICE_SERIAL=<adb-serial> \
  pnpm test:e2e:android-physical-vertical
pnpm test:e2e:android-real-automation
pnpm test:e2e:ios-real-automation
```

The vertical tests verify `demo.navigation.basic` from native Demo launch
through Runtime connection, canonical Snapshot and PNG capture, Host receipt,
Studio presentation, CLI readback, production SQLite/Object Store persistence,
and Data reopen. They also verify per-run credential rotation and scan generated
evidence for leaked Host credentials. The physical variants are implemented as
separate explicit opt-ins and are not part of pull request CI. The iOS variant
passed on an iPhone 14 Pro running iOS 26.5; Android hardware remains pending.

The Android physical variant refuses emulator serials, uses `adb reverse` for
the loopback Runtime path, installs the one-shot token through standard input,
and removes the app and reverse rule during cleanup. The iOS physical variant
requires a paired Developer Mode device, derives the Mac side of the CoreDevice
tunnel unless `VISTREA_IOS_RUNTIME_HOST` supplies an exact IP, creates an
ephemeral TLS 1.3 certificate, and launches the Demo with the exact certificate
pin and HMAC token in protected child environment. It builds with the requested
team by default. `VISTREA_IOS_PREBUILT_APP=/absolute/path/VistreaDemoApp.app`
may select an operator-built current-source artifact when another Xcode session
owns the global build service; the runner verifies its code signature, bundle
identifier, and Team ID before installation.

The Android automation test walks the same scenario with real user-level input: the Automation Engine resolves `demo.home.open_catalog` from a persisted Snapshot, `AdbAutomationProvider` injects a genuine tap and system back through `adb shell input`, and captured Snapshots prove the navigation. Both endpoint states, the deduplicated return to Home under one structural identity, and forward plus back Transitions are recorded through the Host `screen-graph` API and read back with a path query.

The iOS automation test mirrors the Android one through WebDriverAgent: it boots the XCUITest-hosted driver from an operator-provided checkout against a dedicated Simulator, taps and edge-swipes in logical points over the W3C actions protocol, and finishes with the same autonomous exploration and version tag. Prepare it once with the CLI's local driver commands: `pnpm --silent vistrea driver ios prepare` clones the pinned WebDriverAgent release into `~/.vistrea/cache/webdriveragent/<commit>` and refuses any other commit; export `VISTREA_WDA_PROJECT=$HOME/.vistrea/cache/webdriveragent/<commit>/WebDriverAgent.xcodeproj` for this lane (an operator-managed checkout keeps working through the same variable; without it the test skips with instructions). Outside the test lanes, `driver ios up` boots WebDriverAgent on a Simulator — or a real device with `--device <udid>`, resolving the signing team from `--team`, an `--app-project`, or the Keychain — waits for readiness, and prints the exact `--wda-url` the Host needs. `driver ios doctor` reports toolchain, checkout, signing, and forwarder readiness.

The Simulator iOS lanes require macOS, Xcode, and an available iOS Simulator
runtime. The emulator Android lanes require an API 36 or newer AVD, the Android
SDK, and `adb`; they transfer the one-shot Runtime token through standard input
to the app-private token installer and use `adb reverse` for loopback transport.
The basic iOS automation, dangerous-action path, raised Storefront walk, real
search clear, and targeted overlay dismiss have passed on a dedicated
Simulator. The physical iOS pinned-TLS vertical is verified on dedicated
hardware; the Android physical runner remains code-complete but intentionally
unverified until its opt-in command finishes on a selected device. Validation,
Canvas, and Deep Wiki participate in the production Studio core acceptance
workflow; broader workflow UI automation remains follow-up work.

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
