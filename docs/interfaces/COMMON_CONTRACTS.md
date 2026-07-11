# Common Interface Contracts

## 1. Purpose

All SDK, Host, Data, Agent, and Hub interfaces use the same identity, version, operation, error, pagination, and object-reference semantics.

The examples use TypeScript-like pseudocode only for readability. They are not an implementation-language decision.

## 2. Identity

Domain IDs are opaque strings with a readable type prefix and UUIDv7 payload:

```text
workspace_019f...
session_019f...
snapshot_019f...
node_019f...
screen_019f...
transition_019f...
observation_019f...
issue_019f...
patch_019f...
operation_019f...
```

Rules:

- IDs never encode mutable business meaning.
- IDs remain stable across serialization and synchronization.
- Runtime object identity and stable business identity are separate fields.
- Content identity uses `sha256:<lowercase-hex>` rather than a UUID.
- Commit identity is content-derived as `commit:sha256:<lowercase-hex>`.
- Consumers treat unknown IDs as opaque and do not parse UUID fields.

```ts
interface ActorRef {
  kind: "human" | "agent" | "service";
  id: string;
  display_name?: string;
  extensions: Record<string, JsonValue>;
}
```

Persisted authorship uses `ActorRef` so human, Coding Agent, and service changes remain distinguishable without encoding mutable identity details into domain IDs.

## 3. Time

```ts
type Timestamp = string; // canonical RFC 3339 UTC with zero to nine fractional digits

interface EventTime {
  wall_time: Timestamp;
  monotonic_offset_ns?: JsonSafeUInt;
}
```

Timestamps use uppercase `T` and a required `Z`; numeric UTC offsets are not canonical protocol values. Fractional seconds contain one through nine digits when present. Validators compare the complete fractional value rather than truncating through a millisecond-only platform date type.

`JsonSafeUInt` is an integer from `0` through `9,007,199,254,740,991`. Version 1 JSON never encodes a wider integer as a number because common JSON runtimes would lose precision. Wall time enables cross-system correlation. Monotonic offset preserves ordering and duration within one runtime event epoch even if the system clock changes. A new epoch is required before a counter approaches the safe-integer limit.

`Revision` is a `JsonSafeUInt` starting at `1`. Revision zero is never a persisted resource version.

## 4. Version and capabilities

```ts
interface ProtocolVersion {
  major: uint32;
  minor: uint32;
}

interface CapabilitySet {
  names: string[];
  extensions: Record<string, JsonValue>;
}
```

- Major mismatch is incompatible unless an explicit bridge exists.
- All `1.x` representations share the same closed core schema.
- Minor versions introduce only negotiated capabilities and namespaced extension contracts.
- Unknown core properties are invalid.
- Consumers may ignore unknown capabilities and extension values; lossless stores and relays preserve extension entries.
- Active peers select an exact common minor and capability intersection before optional behavior is invoked.
- A caller must not invoke a capability that was not negotiated.
- Platform-specific extensions use namespaced keys such as `ios.uikit.layer_tree`.

## 5. Request context

```ts
interface RequestContext {
  request_id: string;
  trace_id: string;
  actor?: ActorRef;
  workspace_id?: string;
  project_id?: string;
  session_id?: string;
  idempotency_key?: string;
  deadline?: Timestamp;
}
```

Every mutation carries an idempotency key when retries may cross process or network boundaries.

## 6. Command, query, and event semantics

- A **query** reads state and has no product-visible side effect.
- A **command** requests a mutation or operation.
- An **event** reports an immutable fact that already occurred.
- Long-running commands return an `OperationRef` and publish progress events.
- Cancellation is explicit and best-effort; a completed side effect is never represented as cancelled.

```ts
interface OperationRef {
  operation_id: string;
  kind: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: Timestamp;
  updated_at: Timestamp;
  progress?: OperationProgress;
  result_ref?: ResourceRef;
  error?: VistreaError;
}

type OperationResult<T> =
  | {
      operation_id: string;
      result_type: string;
      schema_id?: string;
      storage: "inline";
      value: T;
    }
  | {
      operation_id: string;
      result_type: string;
      schema_id?: string;
      storage: "resource";
      result_ref: ResourceRef;
    };
```

Every asynchronous use case immediately returns `OperationRef`. After it succeeds, `GetOperationResult` returns a durable typed completion envelope. Small results are stored inline; large or independently addressable results use a required resource reference. `result_type` and optional `schema_id` make generic decoding explicit. When `schema_id` names a local `$defs` fragment, its name matches `result_type`; inline values must validate against that already-registered schema. Validators never load result schemas from the network. Adapters must not substitute the immediate `OperationRef` for the completion result.

The Data Layer persists an `OperationRecord` containing a positive revision, the current `OperationRef`, its contiguous event history, and the optional terminal result. Callers that mutate lifecycle state read the record revision; public status adapters may project only its `OperationRef`.

## 7. Result and error model

```ts
type Result<T> =
  | { ok: true; value: T; warnings?: Warning[] }
  | { ok: false; error: VistreaError; warnings?: Warning[] };

interface VistreaError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, JsonValue>;
  cause_id?: string;
}
```

Initial error codes:

| Code | Meaning |
|---|---|
| `invalid_argument` | Input failed validation |
| `not_found` | Requested resource does not exist or is not visible |
| `already_exists` | Unique resource already exists |
| `conflict` | Current version or state conflicts with the request |
| `unauthenticated` | Authentication is missing or invalid |
| `forbidden` | Actor lacks permission |
| `unsupported` | Capability, platform, or version is unsupported |
| `policy_blocked` | Safety, tuning, publication, or retention policy denied the operation |
| `unavailable` | Required device, service, or provider is unavailable |
| `timeout` | Deadline expired |
| `cancelled` | Operation was cancelled before completion |
| `integrity_error` | Hash, schema, or persisted state failed verification |
| `resource_exhausted` | Quota, storage, memory, or concurrency limit reached |
| `internal` | Unexpected implementation failure |

Error messages are diagnostic, not a stable machine contract. Consumers branch on `code` and structured `details`.

## 8. Pagination and filtering

```ts
interface PageRequest {
  limit?: uint32;       // default 50, maximum 500
  cursor?: string;
}

interface Page<T> {
  items: T[];
  next_cursor?: string;
  snapshot_version?: string;
}
```

Cursors are opaque, stable only for the documented query scope, and may expire. Large tree and artifact payloads use streaming or ObjectRefs rather than oversized pages.

## 9. Resource and object references

```ts
interface ResourceRef {
  kind: string;
  id: string;
  version?: string;
}

interface ObjectRef {
  hash: string;             // sha256:<hex>
  media_type: string;
  byte_size: JsonSafeUInt;        // encoded bytes after compression, before encryption
  decoded_byte_size?: JsonSafeUInt;
  compression: "none" | "gzip" | "zstd";
  encryption?: EncryptionRef;
  redaction_profile?: string;
  logical_name?: string;
  extensions: Record<string, JsonValue>;
}
```

Public contracts pass ObjectRefs, not physical file paths. A consumer retrieves the content through an Object Store or authorized transfer channel. Hash, byte size, and byte-range reads refer to the exact encoded payload after declared compression and before transparent encryption, as defined by ADR-0003.

## 10. Optimistic concurrency

Mutable resources expose a `revision` or current commit/ref target. Mutations provide an expected revision:

```ts
interface MutationPrecondition {
  expected_revision?: Revision;
  expected_commit_id?: string;
}

interface RevisionPrecondition extends MutationPrecondition {
  expected_revision: Revision;
}
```

`MutationPrecondition` requires at least one of its two fields; `{}` is invalid. A revisioned-resource update uses the refined `RevisionPrecondition`, so `expected_commit_id` may supplement but never replace `expected_revision`. A mismatch returns `conflict` and the current revision in error details. Last-write-wins is not the default for Review Issues, refs, or tuning changes.

Revisioned-resource rules are uniform across in-memory, SQLite, Hub, and test implementations:

- creation persists revision `1`;
- an update precondition carries the currently read revision `N`;
- a submitted replacement model carries revision `N + 1`; a command-style mutation that does not submit the full model derives and persists revision `N + 1`, and returns it when that contract has a result;
- the repository atomically verifies both values and persists exactly `N + 1`, with no gaps or caller-selected jumps;
- a composite mutation applies the same rule independently to every changed revisioned resource;
- a deletion persists revision `N + 1` as tombstone or versioned change evidence even when the public domain value is no longer returned;
- immutable evidence is created once, normally at revision `1`, and is never updated in place.

An overflow at the JSON-safe integer limit fails instead of wrapping. For a revisioned resource, `expected_commit_id` may additionally pin version context but never replaces `expected_revision` unless that repository contract explicitly identifies the Commit as its sole concurrency token.

## 11. Redaction and field presence

- Redaction is represented explicitly; absence and redaction are not the same.
- Optional fields remain absent when not captured.
- A node or artifact may report `redacted_fields` and `capture_limitations`.
- Consumers must not infer false values from missing unsupported fields.

## 12. Logging and tracing

Every boundary propagates `request_id` and `trace_id`. Logs must avoid sensitive UI text by default. User-visible errors include a `cause_id` that can correlate with local or Hub diagnostics without exposing internal stack traces.
