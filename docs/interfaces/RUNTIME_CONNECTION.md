# Runtime SDK to Host Connection

## 1. Scope

This contract connects an authorized iOS or Android Runtime SDK to the Host Connection Engine. It transports runtime facts and protected tuning commands. It does not perform user interactions.

## 2. Roles

- **Runtime SDK**: observes the application process, captures Snapshots and events, exposes protected tuning endpoints.
- **Host Connection Engine**: discovers SDKs, authenticates, negotiates capabilities, requests captures, receives event streams, and resolves ObjectRefs.
- **Automation Engine**: performs real UI actions through WDA/UIAutomator; it is not part of this connection.

## 3. Connection state machine

```text
disconnected
    -> discovered
    -> authenticating
    -> negotiating
    -> ready
    -> draining
    -> disconnected

Any state -> failed -> disconnected/retry
```

No capture, subscription, or tuning command is valid before `ready`.

## 4. Handshake

```ts
interface HostChallenge {
  connection_attempt_id: string;
  nonce: string;
  supported_versions: ProtocolVersion[];
  supported_auth_methods: string[];
  host_identity: string;
}

interface ClientHello {
  context: RequestContext;
  connection_attempt_id: string;
  runtime_instance_id: string;
  app: AppBuildDescriptor;
  platform: PlatformDescriptor;
  supported_versions: ProtocolVersion[];
  capabilities: CapabilitySet;
  selected_auth_method: string;
  challenge_response: string;
  client_nonce: string;
}

interface HostWelcome {
  connection_id: string;
  selected_version: ProtocolVersion;
  enabled_capabilities: CapabilitySet;
  session_policy: SessionPolicy;
  host_proof: string;
  event_epoch: EventEpochDescriptor;
}
```

Handshake order:

```text
transport established
-> HostChallenge
-> ClientHello with challenge response and client nonce
-> Host verifies Runtime SDK and build policy
-> HostWelcome with negotiated version, capabilities, host proof, and event epoch
-> ready
```

`runtime_instance_id` is stable for one application process lifetime. `connection_id` changes on every transport connection. Failed authentication never reaches negotiation.

Handshake must verify:

- Debug/Internal build eligibility;
- signed or locally trusted authorization;
- protocol compatibility;
- required redaction and tuning policy;
- maximum payload, event rate, and session duration.

`HostWelcome.selected_version` must exactly equal a version listed by both `HostChallenge` and `ClientHello`. Ready-state Snapshots, events, and batches use that selected version. A capability is usable only when it appears in `enabled_capabilities`; schema readability alone does not negotiate behavior.

## 5. Snapshot capture

```ts
interface CaptureSnapshotCommand {
  context: RequestContext;
  include: SnapshotFieldMask;
  screenshot: "none" | "reference";
  reason: "manual" | "before_action" | "after_action" | "review" | "validation";
}

interface CaptureSnapshotResult {
  snapshot: RuntimeSnapshot;
  objects: ObjectRef[];
  limitations: CaptureLimitation[];
}
```

Requirements:

- Snapshot and screenshot timestamps must be correlated.
- Large trees and screenshots use ObjectRefs.
- Partial capture and unsupported fields are explicit.
- A Snapshot is immutable after successful capture.

## 6. Event subscription

```ts
interface SubscribeRuntimeEventsCommand {
  context: RequestContext;
  event_epoch_id: string;
  event_kinds: string[];
  start: RuntimeEventStart;
  max_batch_size?: uint32;
}

type RuntimeEventStart =
  | { mode: "after_sequence"; sequence: JsonSafeUInt }
  | { mode: "oldest_retained" }
  | { mode: "tail" };

interface RuntimeEventBatch {
  protocol_version: ProtocolVersion;
  event_epoch_id: string;
  first_sequence: JsonSafeUInt;
  last_sequence: JsonSafeUInt;
  events: RuntimeEvent[];
  dropped_event_count: JsonSafeUInt;
  extensions: Record<string, JsonValue>;
}

interface AcknowledgeRuntimeEventsCommand {
  context: RequestContext;
  event_epoch_id: string;
  durable_through_sequence: JsonSafeUInt;
}
```

- Sequence numbers are monotonic within an event epoch, not a transport connection.
- Subscription start has no implicit default: callers explicitly resume after a durable sequence, replay from the oldest retained event, or start at the current tail.
- `[first_sequence, last_sequence]` is the inclusive cursor range advanced by one batch.
- Retained events are strictly ordered, unique by sequence, inside the range, and use the batch epoch and protocol version.
- Subscription-filtered sequences may create gaps and do not count as dropped. `dropped_event_count` reports only events lost or sampled after subscription matching.
- An empty event array is valid when a filtered or fully dropped range still advances the cursor.
- The Host explicitly sends `AcknowledgeRuntimeEvents` after durable processing.
- Backpressure may batch or sample low-priority layout events.
- Transient appearance/disappearance events must not be silently coalesced away.
- Dropped events are reported explicitly.
- On reconnect to the same runtime instance and event epoch, the Host resumes after its durable acknowledgement.
- If the SDK has started a new epoch or discarded the requested sequence range, it returns `conflict` with the oldest available sequence and dropped range. The Host records the gap and captures a reconciliation Snapshot.
- After durably persisting retained events and gap evidence, the Host may acknowledge `last_sequence`.

## 7. Object transfer

The Snapshot or event references large content through `ObjectRef`.

The selected transport must support:

- chunked reads;
- integrity verification by hash;
- cancellation;
- resumable transfer when practical;
- content size and media-type limits;
- redaction metadata.

Physical device paths are never exposed to product layers.

## 8. Tuning commands

```ts
interface ApplyTuningPatchCommand {
  context: RequestContext;
  patch: TuningPatch;
  expected_snapshot_id: string;
  preview_ttl_ms?: JsonSafeUInt;
}

interface TuningApplication {
  patch_id: string;
  tuning_application_id: string;
  connection_id: string;
  applied_changes: AppliedTuningChange[];
  rejected_changes: RejectedTuningChange[];
  resulting_snapshot_id?: string;
}
```

Rules:

- Capability `design.tuning` must be negotiated.
- Every property must pass platform and project allowlists.
- The target node and expected original value must match.
- Partial success is explicit and reversible.
- TTL expiry, `PrepareDisconnect`, transport loss, connection close, and application termination always revert active previews.
- Saving a `TuningPatch` persists only its description and review history. It never exempts a runtime preview from automatic reversion.
- `patch_id` identifies the reusable description; `tuning_application_id` identifies one concrete runtime application and is the target of precise reversion and audit. Every application is bound to the originating handshake `connection_id`; a reconnect cannot inherit an active preview.
- Persistence means Vistrea history, not runtime persistence or application source modification.

Additional commands:

- `RevertTuningApplication(tuning_application_id)`
- `RevertAllTuning(connection_id)`
- `ListActiveTuning()`

## 9. Health and lifecycle

- `Ping` verifies control-path health.
- `GetRuntimeStatus` reports current screen, capture load, active tuning, and limitations.
- `PrepareDisconnect` flushes event acknowledgements and reverts all tuning scoped to the closing `connection_id`.
- Unexpected disconnect must trigger Host reconciliation on reconnect.

## 10. Security requirements

- Never expose an arbitrary method-invocation endpoint.
- Reject Release builds unless an explicit signed policy allows connection.
- Keep credentials outside Snapshots and logs.
- Apply redaction before data leaves the application process when policy requires it.
- Record tuning commands, connection actor, and affected nodes in an audit trail.

## 11. Required contract tests

- major/minor version negotiation;
- missing capability rejection;
- Snapshot field-mask compatibility;
- challenge-response ordering and host proof;
- event ordering, acknowledgement, reconnect resume, epoch reset, backpressure, and dropped-event reporting;
- object hash verification;
- tuning allowlist and original-value precondition;
- disconnect reversion;
- unsupported platform extension preservation.
