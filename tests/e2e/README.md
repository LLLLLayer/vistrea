# End-to-end Tests

Real native acceptance tests are opt-in because they create dedicated simulators or emulators and build native applications:

```bash
pnpm test:e2e:ios-real-vertical
pnpm test:e2e:android-real-vertical
```

The current tests verify `demo.navigation.basic` from native Demo launch through Runtime connection, canonical Snapshot and PNG capture, Host receipt, Studio presentation, CLI readback, production SQLite/Object Store persistence, and Data reopen. They also verify per-run credential rotation and scan generated evidence for leaked Host credentials.

The iOS lane requires macOS, Xcode, and an available iOS Simulator runtime. The Android lane additionally requires an API 36 or newer AVD, the Android SDK, and `adb`; it transfers the one-shot Runtime token through standard input to the app-private token installer and uses `adb reverse` for loopback transport. These tests do not yet claim device automation, exploration, Canvas/Deep Wiki persistence, design review, tuning, or validation coverage.
