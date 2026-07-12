# Examples

Repeatable native Demo Apps serve as executable contract fixtures for protocol development, SDK integration, connection, automation, exploration, design review, tuning, validation, and end-to-end acceptance.

- `scenarios/`: canonical cross-platform Scenario IDs and expected behavior
- `ios/VistreaDemoApp/`: native iOS implementation
- `android/VistreaDemoApp/`: native Android implementation

Both applications must implement the same required semantic scenarios before platform-specific scenarios are added.

The iOS UIKit and Android View applications implement all 12 required Scenario IDs. Their `demo.navigation.basic` Snapshot and Runtime connection capabilities are verified through real native SDK-to-Host-to-Studio-to-Data-reopen loops, Runtime events and reversible design tuning are verified on both platforms, and real-input automation is verified on Android with exploration implemented pending device verification. Design comparison and validation scenario coverage remain later slices; `scenarios/manifest.json` records the authoritative per-platform capability status.
