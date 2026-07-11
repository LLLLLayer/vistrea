# VistreaDemoApp for Android

The canonical Android executable fixture for Vistrea.

Initial implementation target:

- native View/ViewGroup application;
- deterministic local data with no external service dependency;
- Runtime SDK and in-app Inspector integration;
- all required scenarios from `../../scenarios/README.md`;
- launch arguments or instrumentation configuration for build profiles and test state;
- stable semantic IDs matching the iOS Demo App;
- explicit Debug-only tuning capability;
- predictable reset to a known initial state.

The Gradle project will be generated after the Android toolchain and module-boundary ADRs are accepted.
