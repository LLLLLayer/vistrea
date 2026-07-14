# Examples

Repeatable native Demo Apps serve as executable contract fixtures for protocol development, SDK integration, connection, automation, exploration, design review, tuning, validation, and end-to-end acceptance.

- `scenarios/`: canonical cross-platform Scenario IDs and expected behavior
- `ios/VistreaDemoApp/`: native iOS implementation
- `android/VistreaDemoApp/`: native Android implementation

Both applications must implement the same required semantic scenarios before platform-specific scenarios are added.

The iOS UIKit and Android View applications implement all 17 required Scenario IDs. Their `demo.navigation.basic` Snapshot and Runtime connection capabilities are verified through real native SDK-to-Host-to-Studio-to-Data-reopen loops. Runtime events, reversible design tuning, basic real-input automation, state identity, exploration, dangerous-action confirmation, and the deeper Storefront walk are verified on both platforms. The iOS lane additionally verifies real search clearing and overlay dismissal. Design comparison and validation scenario coverage remain later slices; `scenarios/manifest.json` records the authoritative per-platform capability status.
