# ADR-0010: Pinned TLS for physical-device Runtime connections

- Status: Accepted
- Date: 2026-07-14
- Owners: Runtime Connection and native SDK lanes
- Related contracts: `docs/interfaces/RUNTIME_CONNECTION.md`, ADR-0005

## Context

ADR-0005 deliberately chose a literal loopback TCP listener for the first
Simulator vertical. A physical iPhone cannot use the Mac's loopback address,
while exposing the existing plaintext Runtime listener on a tunnel or LAN
interface would make a development authorization token observable before the
protocol handshake. The Host Local API also contains broader Workspace powers
and must not become device-network reachable merely to accept Runtime capture.

Android already has a scoped local forwarding primitive through `adb reverse`.
CoreDevice exposes a routable point-to-point address for a paired iPhone, so the
iOS Runtime needs a transport profile that protects that direct connection
without changing canonical Runtime models or Engine use cases.

## Decision

The Runtime transport has two explicit development profiles:

1. Plaintext TCP remains restricted to literal `127.0.0.1` or `::1`.
2. A physical-device listener may bind one explicit non-wildcard IP only when
   configured with a certificate and private key. It accepts TLS 1.3 only.

The Host publishes the lowercase SHA-256 digest of the exact DER leaf
certificate. The authorized launcher passes that digest to the Debug/Internal
Runtime out of band. The Runtime completes TLS only when the peer presents the
exact pinned leaf certificate, then performs the existing per-run HMAC client
proof, Host proof, build eligibility, protocol negotiation, and capability
checks. Certificate pinning never replaces the protocol token.

The certificate may be ephemeral and self-signed because trust is the exact
pin rather than system PKI or a hostname. Hostnames, DNS resolution, wildcard
binds, TLS downgrade, Release clients, and fallback from TLS to plaintext all
fail closed.

The authenticated Host Local API remains on its independent literal loopback
listener. Runtime TLS configuration cannot change that bind address. Tokens,
certificate pins, and private keys do not enter argv, logs, Snapshots, the
Workspace, or committed configuration.

The opt-in iOS physical vertical runner may derive the Mac side of a
CoreDevice tunnel or accept an operator-provided exact IP, generate an
ephemeral certificate, install a specifically signed Debug Demo, and pass the
pin and token through `DEVICECTL_CHILD_` launch configuration. Android physical
acceptance continues to use an explicit serial, one-shot token, and temporary
`adb reverse` rule.

## Alternatives considered

### Expose the plaintext Runtime listener on the device interface

This preserves framing but exposes the authorization exchange to the local
network or tunnel. HMAC proofs do not provide transport confidentiality, so
this option is rejected.

### Expose the Host Local API and let the device call capture routes

This crosses the Runtime/Studio privilege boundary and gives an app process a
far broader Workspace surface than capture requires. It is rejected.

### Require public-PKI certificates and hostnames

Local CoreDevice and USB workflows do not have stable public hostnames, and
certificate issuance would add unrelated infrastructure. Exact ephemeral pinning
provides the required peer identity with a smaller trust surface.

### Disable certificate verification for self-signed local TLS

Encryption without peer authentication permits interception and is rejected.

## Consequences

### Positive

- Physical iOS capture can reach the Host without weakening plaintext loopback.
- The Local API remains private to Studio and local Agent integrations.
- Runtime framing, canonical models, capabilities, and Engine use cases remain
  unchanged across transport profiles.
- An ephemeral certificate limits the lifetime of transport identity and needs
  no persistent PKI state.

### Negative

- Operators must provide an explicit device and signing context.
- The iOS runner depends on a reachable CoreDevice/operator network path and
  OpenSSL for ephemeral test certificate generation.
- Hardware acceptance remains slower and cannot be inferred from pull request
  CI or from the cross-language TLS interoperability test.

### Risks and mitigations

- A leaked token is mitigated by TLS, one Host lifetime, and independent API
  credentials.
- A substituted certificate is rejected before the Runtime sends its HMAC
  proof.
- An accidental remote API exposure is prevented by the separate
  `HostLocalApiBindAddress` type and literal-loopback validation.
- Device selection side effects are contained by explicit opt-in variables,
  exact selectors, and deterministic app/forwarding cleanup.

## Compatibility and migration

The Runtime wire protocol and persisted data do not change. The Host connection
descriptor remains format version 1 and adds an additive `runtime.transport`
field plus `runtime.certificate_sha256` for TLS. Existing Studio composition
decodes only the API block and ignores the additive Runtime fields. Existing
loopback callers gain a `transport: "loopback"` endpoint discriminator; native
loopback initializers remain source-compatible.

## Validation

- Node transport rejects plaintext non-loopback and TLS wildcard binds.
- Swift configuration rejects hostnames, wildcard addresses, invalid ports,
  and non-32-byte pins.
- Node/Swift interoperability rejects a wrong pin before authentication and
  completes handshake plus Snapshot capture with the exact pin.
- The iOS physical command completed capture, Studio core acceptance, CLI
  equality, Workspace reopen, credential rotation, secret scanning, and
  deterministic cleanup on an explicitly selected iPhone 14 Pro running iOS
  26.5. Android retains the same hardware gate before its physical vertical is
  marked Verified.
