# VistreaDemoApp for iOS

The canonical iOS executable fixture for Vistrea.

Initial implementation target:

- native UIKit application;
- deterministic local data with no external service dependency;
- Runtime SDK and in-app Inspector integration;
- all required scenarios from `../../scenarios/README.md`;
- launch arguments for build profiles and test state;
- stable semantic IDs matching the Android Demo App;
- explicit Debug-only tuning capability;
- predictable reset to a known initial state.

The Xcode project will be generated after the iOS toolchain and package-boundary ADRs are accepted.
