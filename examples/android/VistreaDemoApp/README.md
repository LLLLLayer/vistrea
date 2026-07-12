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

## Security boundary

Debug builds expose a local View Tree placeholder that describes the current native hierarchy and explicitly reports that Host transport is not implemented. Its implementation and entry View live only in the `debug` source set. Release builds compile a null factory and contain no View Tree implementation or visible Inspector entry.

The Activity handles API 33+ system back through `OnBackInvokedDispatcher`, while older devices retain the legacy callback. Delayed local transitions are invalidated when a Scenario is stopped, so a prior Scenario cannot overwrite the currently displayed state.

The Demo App contains no network permission or external service dependency. Stable semantic state is fixture-driven; real device automation remains outside the app.
