# Device Automation API

## 1. Scope

The Device Automation API abstracts WDA, UIAutomator, and future real-device providers. It performs genuine user-level operations and returns evidence. It does not inspect private in-process state or decide exploration strategy.

## 2. Two-layer interface

The Automation Engine owns semantic target resolution, stale-Snapshot checks, and policy evaluation. Provider adapters only execute an already resolved and authorized operation.

```ts
interface AutomationEngine {
  listDevices(query?: DeviceQuery): Page<DeviceDescriptor>;
  openSession(command: OpenAutomationSessionCommand): AutomationSession;
  closeSession(session_id: string): void;

  execute(command: SemanticActionCommand): ActionResult;
  screenshot(command: ScreenshotCommand): ObjectRef;
  startVideo(command: StartVideoCommand): RecordingRef;
  stopVideo(command: StopVideoCommand): ObjectRef;
}

interface AutomationProvider {
  execute(command: ProviderActionCommand): ProviderActionResult;
  screenshot(command: ScreenshotCommand): ObjectRef;
  startVideo(command: StartVideoCommand): RecordingRef;
  stopVideo(command: StopVideoCommand): ObjectRef;
}
```

Concrete methods may become asynchronous operations depending on provider behavior.

## 3. Semantic and resolved targets

```ts
interface SemanticActionTarget {
  node_id?: string;
  stable_id?: string;
  accessibility_query?: AccessibilityQuery;
  normalized_point?: Point;
  absolute_point?: Point;
  expected_frame?: Rect;
  expected_snapshot_id?: string;
}

interface ResolvedActionTarget {
  provider_locator?: ProviderLocator;
  absolute_point?: Point;
  resolved_frame?: Rect;
  resolution_method: "accessibility" | "runtime_node" | "coordinate";
  validated_snapshot_id?: string;
  device_geometry_revision: string;
}
```

Target resolution order is explicit and recorded in the result. The Automation Engine resolves a semantic node to a provider locator or coordinate, validates geometry against the latest available Snapshot, evaluates policy, and then calls the provider.

If `expected_snapshot_id` or `expected_frame` no longer matches, the Automation Engine returns `conflict` before provider execution. A provider is not expected to understand Runtime Snapshot identity.

## 4. Action command and result

```ts
interface SemanticActionCommand {
  context: RequestContext;
  automation_session_id: string;
  kind: ActionKind;
  target?: SemanticActionTarget;
  intent: ActionIntent;
  timeout_ms?: JsonSafeUInt;
  capture_before?: boolean;
  capture_after?: boolean;
}

interface ProviderActionCommand {
  automation_session_id: string;
  kind: ActionKind;
  target?: ResolvedActionTarget;
  authorization: ActionAuthorization;
  payload?: ActionPayload;
  timeout_ms?: JsonSafeUInt;
}

interface ActionResult {
  action_id: string;
  provider: string;
  started_at: Timestamp;
  finished_at: Timestamp;
  target_resolution?: TargetResolution;
  outcome: "succeeded" | "failed" | "blocked" | "uncertain";
  before_screenshot?: ObjectRef;
  after_screenshot?: ObjectRef;
  system_alert?: SystemAlertObservation;
  warnings?: Warning[];
  error?: VistreaError;
}
```

`uncertain` means the provider delivered the action but cannot prove the expected UI response. Verification belongs to Engine logic.

## 5. Safety

```ts
interface ActionIntent {
  requested_effect: string;
  caller_classification?: string;
  confirmation_token?: string;
}

interface ActionAuthorization {
  decision_id: string;
  decision: "allow" | "allow_once" | "deny";
  risk: "safe" | "sensitive" | "dangerous" | "forbidden";
  policy_id: string;
  bound_action_digest: string;
  actor_id: string;
  session_id: string;
  expires_at: Timestamp;
}
```

- Caller-provided classification is untrusted input. The Automation Engine evaluates current Snapshot, action, target, environment, actor, and policy to produce `ActionAuthorization`.
- Forbidden actions never execute.
- Dangerous actions require explicit confirmation or a pre-authorized isolated environment policy.
- Exploration Engine classifies risk; Automation Engine enforces it again.
- A confirmation token is bound to action kind, resolved target, session, policy, actor, and expiry. It cannot authorize a different action after UI state changes.
- Provider adapters reject missing, expired, mismatched, or denied authorization.
- Action evidence records the applied decision and policy.

## 6. Session lifecycle

```text
created -> ready -> busy -> ready -> closing -> closed
                 \-> failed
```

Only one mutating action runs per device session unless a provider explicitly supports safe concurrency. Read-only screenshot or status queries may run concurrently under documented limits.

## 7. Provider requirements

Adapters must report:

- supported platform and OS versions;
- device/simulator/real-device distinction;
- action and recording capabilities;
- accessibility-tree limitations;
- system alert support;
- maximum concurrency and timeout behavior.

Provider-specific data remains under namespaced extensions.

## 8. Required contract tests

- stale target precondition;
- normalized and absolute coordinate mapping;
- provider capability negotiation;
- action timeout and cancellation;
- safety enforcement;
- action evidence and screenshot association;
- system alert handling;
- disconnect and session recovery.
