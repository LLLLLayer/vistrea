# Device Automation

Semantic device automation over provider adapters, following the two-layer contract in [Device Automation API](../../docs/interfaces/AUTOMATION_API.md).

`AutomationEngine` implements the first verified slice:

- resolves semantic targets against persisted Snapshots: stable identifiers become accessibility locators with center-point geometry, node identifiers resolve live frames, and normalized or absolute points map through the Snapshot's display geometry and `geometry_revision`;
- returns `conflict` before provider execution when the expected Snapshot is missing, the target vanished, the live frame moved, or a point leaves the display;
- classifies risk with untrusted caller input that may only raise the baseline, issues `ActionAuthorization` decisions under `policy.vistrea.default-v1`, binds confirmation tokens to the action kind, resolved target, and session digest, blocks dangerous actions without a bound confirmation or a pre-authorized isolated environment, and never executes forbidden actions;
- runs exactly one mutating action per session with busy-conflict gating, timeout enforcement, caller cancellation, and evidence carrying the applied decision, digest, and target resolution.

`AutomationProviderPort` executes one already resolved, authorized operation and reports `succeeded`, `failed`, `blocked`, or `uncertain` without interpreting Snapshot identity or policy. Real WDA and UIAutomator adapters, screenshot and video evidence, and system alert handling remain later slices; tests use a deterministic scripted provider.
