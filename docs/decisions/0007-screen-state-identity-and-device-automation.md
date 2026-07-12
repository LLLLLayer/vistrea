# ADR 0007: Structural Screen State identity and device automation providers

- Status: Accepted
- Date: 2026-07-12
- Owners: Engine and platform owners
- Related contracts: `protocol/schema/v1/graph.schema.json`, `docs/interfaces/AUTOMATION_API.md`, `docs/architecture/DATA_LAYER.md`

## Context

Phase 3 needs three decisions that shape every later Canvas, Deep Wiki, and
validation workflow:

1. how two Snapshots are recognized as the same Screen State so the global
   graph deduplicates instead of growing one node per capture;
2. how the materialized Screen Graph is persisted, revalidated, and versioned
   over time;
3. how real user-level device actions are executed on iOS and Android without
   violating the observation-only Runtime SDK boundary.

The protocol already defines `ScreenStateIdentity` with `semantic`,
`structural`, `visual`, `composite`, and `manual` strategies, and the
Automation API fixes a two-layer engine/provider contract, but neither pins a
first executable strategy or provider technology.

## Decision

### Structural identity `structural-v1`

The first identity strategy is deterministic and purely structural. For each
captured tree the engine builds a nested signature per node containing exactly
`role`, `native_type`, `stable_id` (empty when absent), and the ordered child
signatures, prefixed with the tree `kind`. The canonical JSON of all tree
signatures is hashed into `layout_digest` (`sha256:<hex>`) under the
normalization profile `identity_profile/structural-v1`; the sorted set of
valid stable identifiers is recorded as `stable_node_ids`.

Volatile inputs are excluded on purpose: node and tree UUIDs (new every
capture), geometry (device and animation dependent), text content and state
flags (data dependent), and screenshots (rendering dependent). Two captures
deduplicate into one active Screen State exactly when their `layout_digest`
values match.

### One coherent materialized graph per project and application

Each `(project_id, application_id)` pair owns exactly one live `ScreenGraph`
document under a deterministic identifier (SHA-256 of a fixed seed string,
formatted as a typed UUIDv7). Every ingest — state observation or transition
observation — rewrites the complete document in one Unit of Work, and the
repository revalidates it against the canonical schema plus all graph semantic
rules, so a dangling reference or occurrence miscount cannot be persisted.
Observations are embedded in the graph and appended to the standalone
Observation repository. Actions and Transitions deduplicate by semantic
signature (kind, stable target, canonical parameters) stored under
namespaced extensions; an observed Transition's `occurrence_count` always
equals its Observation count.

Version history uses frozen copies: tagging a version writes an immutable
snapshot of the current document under a derived graph identifier and maps the
`tag` VersionSelector to it, so `compare` diffs two real materializations
while the live graph keeps its stable identity.

### Device automation providers

The Automation Engine owns semantic resolution, stale-Snapshot conflicts,
risk policy, and confirmation-token binding; providers execute one already
resolved, authorized operation:

- Android: `AdbAutomationProvider` injects input through `adb shell input`
  and `am start` — the same InputManager layer UIAutomator uses — and converts
  logical points to pixels with the device-reported density.
- iOS: `WdaAutomationProvider` wraps a WebDriverAgent endpoint (the
  XCUITest-hosted driver Appium uses) over the W3C actions protocol.
  WebDriverAgent consumes logical points directly. iOS has no system back
  key, so `back` performs the interactive left-edge pop gesture.

Providers re-verify the authorization digest and expiry before touching the
device, and report injected input as `uncertain` because injection cannot
prove the UI responded; Engine-level capture comparison owns verification.

## Alternatives considered

### Visual identity first (screenshot digests)

Rejected as the first strategy: rendering differences (fonts, scale, minor
animation frames) break byte equality, and perceptual hashing introduces
thresholds that are not deterministic across platforms. Visual factors remain
available as a later composite refinement.

### Including text and geometry in the structural signature

Rejected: list contents, localized labels, and device sizes would split one
logical screen into unbounded states. The scenario contract already treats
dynamic fields as non-identifying.

### Per-observation graph documents instead of one live document

Rejected: reads would need a merge step before every query and the semantic
rules could not be enforced atomically. The single-document write is bounded
by application screen count, not observation count, because observations are
compact and states deduplicate.

### iOS input via `simctl` or private APIs

Rejected: `simctl` cannot inject taps, and private input APIs are neither
stable nor honest about user-level behavior. WebDriverAgent is the
industry-standard XCUITest host with a documented wire protocol.

### Bundling WebDriverAgent into the repository

Rejected for now: it is a large external Xcode project with its own release
cadence. The acceptance test boots an operator-provided checkout via
`VISTREA_WDA_PROJECT` and skips honestly when absent.

## Consequences

### Positive

- Cross-platform state identity is reproducible byte-for-byte from any
  conforming Snapshot, with no thresholds to tune.
- Every persisted graph is guaranteed coherent; consumers never defend
  against dangling references.
- Both providers sit behind one port, so exploration and later validation
  are platform-agnostic.

### Negative

- Structural identity over-merges screens whose difference is text-only; the
  composite strategy must extend `structural-v1` before text-driven flows are
  explored.
- Frozen version copies duplicate graph bytes per tag; acceptable while
  graphs are small, revisit when Canvas-scale graphs arrive.

### Risks and mitigations

- Interactive pop may be disabled on some iOS screens: record `uncertain`
  outcomes and rely on capture comparison; add explicit back-button targets to
  scenarios if a screen blocks the gesture.
- `adb shell input text` has a restricted charset: the provider fails closed
  with an explicit detail instead of guessing device shell quoting.

## Compatibility and migration

No protocol schema changes: `structural-v1` uses existing
`ScreenStateIdentity` fields, and dedup keys live under namespaced
extensions. The `ScreenGraphRepository` port gained create/update/get/tag
operations implemented by the shared state Unit of Work, so memory and SQLite
storage stay byte-compatible.

## Validation

- `tests/integration/screen-graph-engine.test.ts` — identity determinism,
  dedup, occurrence counting, semantic revalidation, SQLite reopen.
- `tests/integration/automation-engine.test.ts` — resolution, stale
  conflicts, policy, confirmation binding, timeout, cancellation.
- `tests/integration/wda-provider.test.ts` — W3C wire protocol against a
  local fixture driver, session recreation, authorization rejection.
- `tests/integration/exploration-engine.test.ts` — deterministic discovery,
  dedup on repeat runs, version tags and diffs.
- `pnpm test:e2e:android-real-automation` — real emulator input, verified.
- `pnpm test:e2e:ios-real-automation` — real Simulator input through
  WebDriverAgent; implemented, pending device verification.
