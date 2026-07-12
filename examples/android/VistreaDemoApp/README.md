# VistreaDemoApp for Android

The canonical native Android View/ViewGroup executable fixture for Vistrea.

## Contract source

The project does not own a second Scenario manifest. `syncScenarioContracts` copies these authoritative files into generated APK assets before every build or unit test:

```text
../../scenarios/manifest.json
../../scenarios/fixtures/v1/*.json
```

The runtime repository decodes those assets directly. All 12 required Scenario IDs are available from the launcher. Shared stable node IDs are assigned to both Android `contentDescription` and `tag` whenever the node is visible.

## Build and test

The reproducible wrapper uses Gradle 8.13 with a pinned distribution checksum. The app uses AGP 8.11.2, Kotlin 2.1.20, JDK 17, and compile SDK 36.

```bash
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew assembleDebug assembleRelease test lintDebug
```

## Deterministic launch

Launch a Scenario and profile with canonical extras:

```bash
adb shell am start -n dev.vistrea.demo.debug/dev.vistrea.demo.MainActivity \
  --es vistrea.scenario_id demo.navigation.basic \
  --es vistrea.profile_id baseline
```

Environment-style aliases are also accepted as intent extras:

```text
VISTREA_SCENARIO_ID
VISTREA_PROFILE_ID
```

Omitting the Scenario extra opens the manifest-driven chooser. Omitting the profile selects the fixture's first declared profile.

`MainActivity` is `singleTop`. A new Intent containing `VISTREA_RUNTIME_HOST` or `VISTREA_RUNTIME_PORT` is treated as an explicit Runtime endpoint update: a complete valid configuration with a fresh one-shot token constructs and starts a replacement connection after stopping the old one. An invalid or incomplete update leaves the active connection unchanged. A Scenario-only Intent changes the displayed Scenario while preserving the existing Runtime connection.

## Security boundary

Debug builds expose the local View Tree and can opt into the authenticated loopback Runtime transport. Both entry points live only in the `debug` source set. Release builds compile null factories, contain no transport implementation or network permission, and expose neither entry point. The underlying Android SDK also publishes an empty Release connection artifact, so a Release consumer cannot select a Debug enum at runtime to recover the client.

The authorization token never travels through `am start`, process arguments, Intent extras, logs, or a Snapshot. Install it as a one-shot app-private mode-0600 file through `run-as` stdin:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:$VISTREA_RUNTIME_PORT tcp:$VISTREA_RUNTIME_PORT

# The input file contains the exact per-run token bytes and should itself be mode 0600.
./tools/install-runtime-token.sh < "$VISTREA_RUNTIME_TOKEN_FILE"

adb shell am start -n dev.vistrea.demo.debug/dev.vistrea.demo.MainActivity \
  --es VISTREA_RUNTIME_HOST 127.0.0.1 \
  --es VISTREA_RUNTIME_PORT "$VISTREA_RUNTIME_PORT" \
  --es vistrea.scenario_id demo.navigation.basic
```

The Debug App opens the token with `O_NOFOLLOW`, verifies its owner, regular-file type, byte bound, and group/other permission bits, then deletes it after the single read even when configuration fails. Host and port are non-secret and may use Intent extras. The helper accepts a token file as its first argument or stdin and never puts token bytes in `adb` arguments.

Run the automated AAR/APK boundary check from `sdks/android/`:

```bash
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./tools/verify-runtime-release-boundary.sh
```

The Activity handles API 33+ system back through `OnBackInvokedDispatcher`, while older devices retain the legacy callback. Delayed local transitions are invalidated when a Scenario is stopped, so a prior Scenario cannot overwrite the currently displayed state.

Stable semantic state is fixture-driven; real device automation remains outside the app.
