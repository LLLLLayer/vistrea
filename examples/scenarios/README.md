# Cross-platform Demo Scenarios

This directory is the executable, platform-neutral acceptance contract for the Vistrea iOS and Android Demo Apps.

It owns shared Scenario IDs, deterministic launch profiles, semantic checkpoints, required evidence, and normalized outcomes. It does not define native layouts or replace the canonical wire models under `protocol/`.

## Contract layout

```text
examples/scenarios/
├── README.md
├── manifest.json
├── validate.mjs
├── schema/v1/
│   ├── manifest.schema.json
│   └── scenario.schema.json
├── fixtures/v1/
│   └── demo.*.json
└── tests/
    └── scenarios.test.mjs
```

- `manifest.json` freezes the required Scenario IDs and build profiles, records per-platform implementation and capability status, and defines vertical-loop acceptance slices.
- `fixtures/v1/` describes platform-neutral reset, state, action, evidence, and result expectations for each shared scenario.
- `schema/v1/` validates the shape of the manifest and fixtures with JSON Schema Draft 2020-12.
- `validate.mjs` adds cross-file ownership, reference, coverage, artifact, platform-parity, and build-diff semantic checks.
- `tests/` proves both the accepted suite and important failure boundaries.

## Required scenarios

| Scenario ID | Purpose | Executable coverage |
|---|---|---|
| `demo.navigation.basic` | Home, list, detail, and back navigation | Snapshot and exploration graph |
| `demo.form.validation` | Text entry and validation recovery | Snapshot, event, and exploration graph |
| `demo.transient.success` | Two-second success feedback | Snapshot, Runtime Event Batch, and key frame |
| `demo.loading.outcomes` | Loading, success, failure, retry, and timeout | Snapshot, events, graph, and validation |
| `demo.modal.dialog` | Modal presentation and dismissal | Overlay Snapshot, events, and graph |
| `demo.layout.occlusion` | Covered interactive node | Snapshot and structural finding |
| `demo.accessibility.defects` | Missing label and small hit area | Snapshot and accessibility findings |
| `demo.design.tuning` | Design comparison and reversible preview | Snapshot, Design Review Bundle, Tuning Patch, Tuning Application lifecycle, and validation |
| `demo.dynamic.normalization` | Changing time, user, and list content | Snapshots and same-state identity expectation |
| `demo.safety.dangerous` | Destructive-looking action | Snapshot and policy block without a Transition |
| `demo.version.new-feature` | New screen and path | Graph and build diff |
| `demo.version.regression` | Visual and behavioral regression | Review re-verification, validation, and build diff |

All required fixtures declare iOS and Android support as required. Platform-specific scenarios may use namespaced IDs such as `ios.uikit.layer_mismatch` or `android.compose.semantics_merge`, but they cannot replace this shared set.

## Stable identity

Shared semantic nodes use logical cross-platform IDs, for example:

```text
demo.home.open_catalog
demo.catalog.item_primary
demo.detail.open_form
demo.form.name_input
demo.form.submit
demo.toast.success
demo.design.preview_card
```

Native accessibility identifiers, UIKit classes, Android resource IDs, and TestTags remain adapter-owned. A platform implementation maps those native values to the shared semantic IDs; it must not add native-only fields to the shared fixture schema.

## Determinism and artifacts

Every scenario declares:

- a reset state, local seed, and no external service dependency;
- the build profiles on which its steps run;
- stable nodes, semantic states, and deterministic driver steps;
- logical artifact keys and the checkpoint that produces each artifact;
- structured Snapshot, event, exploration, design/tuning, validation, or build-diff expectations.

Design/tuning fixtures require both active and explicitly reverted `TuningApplication` artifacts. This proves the preview lifecycle separately from the versioned `TuningPatch` and keeps source-code truth unchanged.

`after_step_id` identifies the checkpoint immediately after that deterministic driver step completes. Event `order` is contiguous within one profile. `deadline_ms` is the maximum monotonic elapsed time from the associated checkpoint; it includes capture tolerance, while an explicit `wait` step retains the scenario's logical duration.

Artifact keys are stable acceptance handles, not content hashes. Protocol objects use canonical structured comparison, Screen Graphs use semantic normalization, and screenshots or key frames use platform-visual comparison. Native screenshots are not expected to be pixel-identical across iOS and Android.

## Build profiles

The manifest defines exactly six deterministic profiles:

- `baseline`: expected passing behavior;
- `new-feature`: adds an intentional Screen State and path;
- `design-regression`: changes reviewable visual properties;
- `behavior-regression`: breaks an expected Transition or timing rule;
- `accessibility-regression`: introduces controlled accessibility defects;
- `dynamic-content`: changes values that Screen State identity must normalize.

Profiles use local fixture data and fixed or profile-seeded clocks. Native implementations select them through platform-appropriate launch configuration without changing their semantic meaning.

## Platform status and capability reporting

`manifest.json` is the current implementation-status source of truth for both Demo Apps. A platform capability moves from `planned` to `implemented` and then `verified` only when its native implementation and scenario evidence exist. Use `limited` plus an explicit limitation when a platform can provide only partial evidence; never silently omit a required scenario.

Per-scenario `platform_support` describes required capabilities, not current implementation completion. The validator checks that both platforms are required and that every requested capability is declared by the platform status matrix.

## Verified native Snapshot loops

The manifest defines symmetric `ios.first-snapshot-loop` and `android.first-snapshot-loop` acceptance slices using the shared `demo.navigation.basic` scenario. Each verified loop requires the same logical Home Snapshot and screenshot to pass through:

```text
Demo App launch
-> SDK connect
-> Snapshot capture
-> Host receive
-> Studio render
-> Data persist
-> Data reopen
```

Both loop statuses are `verified`. Their real-device acceptance tests validate canonical protocol structure, the required `demo.home.open_catalog` stable node, PNG object integrity, Studio presentation, CLI equality, production SQLite/Object Store reopen, credential rotation, and secret-free artifacts. This evidence verifies the native Snapshot and Runtime connection capabilities; each platform remains `in-progress` because events, automation, exploration, design tuning, and validation are not implemented.

## Validation

Install the root dependencies, then run the lane directly:

```bash
pnpm install --frozen-lockfile
node examples/scenarios/validate.mjs
node --test examples/scenarios/tests/*.test.mjs
```

The validator compiles both schemas with strict Ajv settings, validates every manifest-owned fixture, rejects fixture drift, checks all local references, recomputes build-diff summaries, verifies deterministic artifact coverage, and enforces both native first-loop contracts. A loop cannot be marked `verified` unless every capability it requires is also `verified` for that platform.

## Native implementation handoff

An iOS or Android scenario is ready for verification only when the native Demo App:

1. resets to the declared state and seed without a remote dependency;
2. maps native nodes to every required shared semantic ID;
3. executes the declared profile-specific steps through real device interaction where applicable;
4. emits every required logical artifact at its checkpoint;
5. satisfies structured expectations after platform normalization;
6. records any explicit limitation instead of omitting evidence.

Contract tests compare normalized semantic outcomes, not private platform models or pixel-identical layouts.
