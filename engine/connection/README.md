# Connection Engine

Discovers Runtime SDKs, establishes sessions, transports Snapshots, events, and artifacts, and negotiates protocol versions and capabilities.

It does not perform WDA/UIAutomator actions or choose exploration steps.

See [Runtime SDK to Host connection](../../docs/interfaces/RUNTIME_CONNECTION.md).

## Implemented Snapshot slice

The current fixture-backed Host slice provides:

- a public `RuntimeCapturePort` for observation-only capture;
- `CaptureSnapshotUseCase` with canonical protocol and semantic validation;
- Object Store writes and exact `ObjectRef` verification before metadata visibility;
- verified-object registration followed by one write `DataUnitOfWork`;
- rollback that leaves already written objects unreachable for later Workspace GC;
- immutable `GetSnapshotQuery` and `ListSnapshotsQuery` results;
- `FixtureRuntimeCapturePort` for deterministic canonical-fixture integration tests.

## Loopback Runtime transport

`LoopbackRuntimeHost.listen` implements the ADR-0005 development transport:

- TCP binds only to `127.0.0.1` or `::1` and uses an explicit ephemeral or configured port;
- every wire message is a bounded, fatal UTF-8 JSON line;
- `HostChallenge`, `ClientHello`, and `HostWelcome` ordering is mandatory;
- a per-run token produces HMAC-SHA256 client challenge and Host proofs;
- only Debug/Internal clients that share protocol `1.0` and `runtime.snapshot` become ready;
- the snapshot-only `HostWelcome` omits `event_epoch`; it becomes required only when `runtime.events` is enabled;
- `LoopbackRuntimeSession` implements `RuntimeCapturePort` and refuses capture outside ready state;
- capture objects transfer in declared order through canonical Base64 chunks with strict sequence, size, SHA-256, duplicate, completion, cancellation, and disconnect checks;
- the advertised chunk limit is capped so a maximum-sized canonical Base64 chunk still fits inside the advertised JSON-line limit.

The token is never placed in a wire error, public transport error, or log. Callers should generate a fresh high-entropy token for each Host run and deliver it to the authorized Debug/Internal application through protected development configuration.

The HMAC payloads are UTF-8 lines joined with `\n`:

```text
client:
vistrea-runtime-client-v1
connection_attempt_id
host_nonce
client_nonce
runtime_instance_id
build_configuration
sorted comma-separated versions
sorted comma-separated capabilities

host:
vistrea-runtime-host-v1
connection_attempt_id
connection_id
host_nonce
client_nonce
runtime_instance_id
selected version
sorted comma-separated enabled capabilities
```

`computeLoopbackClientProof` and `computeLoopbackHostProof` are the Node reference implementations for this adapter-owned handshake. Wire envelopes do not redefine `RuntimeSnapshot` or `ObjectRef`; canonical values pass through unchanged and remain subject to protocol validation in `CaptureSnapshotUseCase`.

Runtime discovery, physical-device tunneling, resilient reconnect, live native capture, and event streaming remain planned. Device actions remain owned by WDA/UIAutomator automation adapters.
