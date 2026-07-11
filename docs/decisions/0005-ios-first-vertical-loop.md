# ADR 0005: iOS-first runtime vertical loop

- Status: Accepted
- Date: 2026-07-12

## Context

Vistrea needs one real end-to-end path before broad feature development can prove that the protocol, Runtime SDK, Host Engine, Data Layer, Studio, and Agent adapters compose without private models or storage bypasses. Building both native platforms and every product mode at once would leave the most important integration risks unresolved for too long.

The first path must still preserve the cross-platform contract. It cannot make UIKit types, simulator paths, or Studio-specific values canonical.

## Decision

The first complete vertical loop uses the iOS UIKit Demo App and the shared `demo.navigation.basic` Scenario ID. Android implements the same executable Scenario contract in parallel where shared boundaries are stable, but Android completion does not gate this first integration proof.

The vertical path is:

```text
iOS UIKit Demo App
-> protected Runtime SDK capture
-> loopback Runtime transport
-> Host connection and snapshot use case
-> Object Store plus metadata DataUnitOfWork
-> Host local API
-> macOS Studio and CLI adapters
```

### Runtime transport for the first loop

- The Host owns a loopback-only TCP listener.
- The Runtime SDK connects outbound to an explicitly configured Host endpoint.
- Messages are length-bounded UTF-8 JSON lines carrying the semantic handshake, capture, result, object-transfer, error, ping, and disconnect messages defined by the Runtime connection contract.
- The first implementation uses an explicit endpoint rather than pretending that device discovery is complete.
- The listener requires a per-run development authorization token, negotiates the protocol version and capabilities, and rejects non-Debug App builds.
- UIKit and Node transport values are adapter-owned. Persisted values remain canonical protocol models.

This transport is an implementation seam, not the final physical-device discovery or tunneling decision. A future provider may use Bonjour, a USB tunnel, WebSocket, or another framed transport without changing Engine use cases or Runtime Snapshot models.

### Capture scope

The first Runtime SDK capture includes:

- one protocol-valid UIKit view tree with cross-platform stable IDs where the Demo scenario declares them;
- current display and Runtime Context values;
- a correlated screenshot transferred as verified object bytes;
- explicit capabilities and capture limitations;
- no direct business-method invocation or synthetic navigation.

Real navigation remains a user action or an automation-provider action. The SDK observes the resulting state.

### Host and Data scope

- The Host validates inbound values before persistence.
- Screenshot bytes enter the content-addressed Object Store before their metadata reference becomes visible.
- Snapshot metadata and object references become visible through one Data Unit of Work.
- Studio and CLI read the captured Snapshot through public Host Engine queries; neither opens SQLite nor constructs object paths.
- Fixture-backed adapters remain available so Engine, Studio, CLI, and MCP work can proceed without a running native app.

### Studio scope

The first Studio screen is intentionally narrow. It shows connection state, selected Scenario ID, screenshot, view tree, node selection, and persisted capture identity. It talks to the Host local API as a separate process and contains no Data implementation.

## Acceptance path

The slice is complete only when one repeatable verification demonstrates all of the following:

1. Create or open a local Workspace and start the Host.
2. Launch the iOS Demo App in the `demo.navigation.basic` scenario.
3. Complete the authenticated Runtime handshake and reach `ready`.
4. Capture a Snapshot and screenshot from the real UIKit hierarchy.
5. Validate the Snapshot against the canonical protocol and verify screenshot object identity.
6. Commit the object and Snapshot metadata through the Data boundary.
7. Load and render the same capture in Studio through the Host API.
8. Read the same capture through the CLI adapter.
9. Restart the Host, reopen the Workspace, and retrieve the identical Snapshot and object from production local storage.

Contract tests may use fixture-backed transports and Data implementations, but the final acceptance run must use the real iOS Demo App, production SQLite metadata adapter, and file-backed Object Store.

## Consequences

### Positive

- Cross-boundary integration problems surface before broader feature work.
- iOS and Android retain one Scenario and protocol source of truth.
- Studio and Agent adapters can develop early against the same fixture-backed Engine surface.
- The first UI remains useful for structure inspection and visual verification without claiming that Canvas, exploration, tuning, or Deep Wiki are complete.

### Costs and constraints

- The initial explicit loopback endpoint is a development-only connection path.
- Physical-device discovery, resilient reconnect, event replay, tuning, and automation remain follow-up slices.
- The first Studio UI proves the boundary but does not satisfy the complete Studio interaction design.

## Rejected alternatives

### Build iOS and Android full loops before integrating

This duplicates unresolved boundary risk and delays the first persisted product proof.

### Let Studio read SQLite or captured files directly

This would bypass Engine behavior and create a second Data API.

### Use a fixture-only SDK path as final acceptance

Fixtures are necessary for parallel development, but they cannot prove UIKit capture, transport framing, screenshot transfer, or application-build protection.

### Put Runtime artifacts in Git

Git may record source revisions and exported review artifacts. High-volume screenshots and Snapshots remain in Vistrea's content-addressed local storage and version model.
