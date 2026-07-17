# Device Automation

Semantic device automation over provider adapters, following the two-layer contract in [Device Automation API](../../docs/interfaces/AUTOMATION_API.md).

`AutomationEngine` implements the first verified slice:

- resolves semantic targets against persisted Snapshots: stable identifiers become accessibility locators with center-point geometry, node identifiers resolve live frames, and normalized or absolute points map through the Snapshot's display geometry and `geometry_revision`;
- returns `conflict` before provider execution when the expected Snapshot is missing, the target vanished, the live frame moved, or a point leaves the display;
- classifies risk with untrusted caller input that may only raise the baseline, issues `ActionAuthorization` decisions under `policy.vistrea.default-v1`, binds confirmation tokens to the action kind, resolved target, and session digest, blocks dangerous actions without a bound confirmation or a pre-authorized isolated environment, and never executes forbidden actions;
- runs exactly one mutating action per session with busy-conflict gating, timeout enforcement, caller cancellation, and evidence carrying the applied decision, digest, and target resolution.

`AutomationProviderPort` executes one already resolved, authorized operation and reports `succeeded`, `failed`, `blocked`, or `uncertain` without interpreting Snapshot identity or policy.

`AdbAutomationProvider` is the real Android adapter: it injects genuine tap, long-press, type, clear, swipe, back/dismiss, and activity-launch input through `adb shell input` and `am start` — the same InputManager layer UIAutomator uses — converts logical points to pixels with the device's reported density, re-verifies the bound authorization digest and expiry before executing, and honestly reports injected input as `uncertain` because injection cannot prove the UI responded; capture comparison owns verification. Targeted dismiss taps the resolved control; targetless dismiss uses the Android back key. The opt-in `pnpm test:e2e:android-real-automation` acceptance drives the real Demo scenario with it.

`WdaAutomationProvider` is the real iOS adapter: it wraps a loopback WebDriverAgent endpoint (the XCUITest-hosted driver Appium uses) over the W3C actions protocol with logical-point coordinates, types through `/wda/keys`, clears accessibility-resolved fields through the W3C element endpoint, launches through `/wda/apps/launch`, dismisses a resolved control or a system alert, and performs `back` as the interactive left-edge pop gesture because iOS has no system back key. It lazily creates and recreates the driver session exactly once on invalidation, re-verifies the bound authorization digest and expiry before touching the wire, and reports injected input as `uncertain`. The wire protocol is verified against a local fixture driver; the opt-in `pnpm test:e2e:ios-real-automation` acceptance boots an operator-provided WebDriverAgent checkout (`VISTREA_WDA_PROJECT`) against a dedicated Simulator and awaits real-device verification.

Screenshot and video evidence and system alert handling remain later slices; unit-level tests use a deterministic scripted provider. Provider decisions are recorded in [ADR-0007](../../docs/decisions/0007-screen-state-identity-and-device-automation.md).
