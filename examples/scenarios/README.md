# Cross-platform Demo Scenarios

The planned iOS and Android Demo Apps must implement the same required Scenario IDs and semantic outcomes. Layout may follow native platform conventions, but stable node identity, state transitions, events, and expected validation behavior must remain comparable.

## Required scenarios

| Scenario ID | Purpose | Required evidence |
|---|---|---|
| `demo.navigation.basic` | Home, list, and detail navigation | Screen States and forward/back Transitions |
| `demo.form.validation` | Text entry and validation error | Node state, text handling, error event |
| `demo.transient.success` | Two-second success toast/banner | Appearance/disappearance events and key frame |
| `demo.loading.outcomes` | Loading, success, failure, retry | Timed Events and multiple states |
| `demo.modal.dialog` | Modal presentation and dismissal | Overlay state and dismissal Transition |
| `demo.layout.occlusion` | Covered or clipped interactive node | Structural validation finding |
| `demo.accessibility.defects` | Missing label and small hit area | Accessibility findings |
| `demo.design.tuning` | Typography, color, spacing, and corner properties | Design comparison and reversible Tuning Patch |
| `demo.dynamic.normalization` | Changing time, user, or list content | Stable Screen State identity |
| `demo.safety.dangerous` | Destructive-looking action | Exploration policy block |
| `demo.version.new-feature` | New screen and path in a later build profile | Graph and build diff |
| `demo.version.regression` | Intentional visual or behavioral regression | Validation and Review Issue re-verification |

## Stable identity

Shared semantic nodes use cross-platform stable IDs:

```text
demo.home.open_catalog
demo.catalog.item_primary
demo.detail.open_form
demo.form.name_input
demo.form.submit
demo.toast.success
demo.design.preview_card
```

Native runtime IDs remain separate and platform-specific.

## Build profiles

Each Demo App implementation must support deterministic launch profiles rather than separate long-lived forks:

- `baseline`: expected passing behavior;
- `new-feature`: adds an intentional Screen State and path;
- `design-regression`: changes reviewable visual properties;
- `behavior-regression`: breaks an expected Transition or timing rule;
- `accessibility-regression`: introduces controlled accessibility defects;
- `dynamic-content`: changes values that state identity must normalize.

Every profile declares its expected graph, events, findings, and design comparison result in shared fixtures once the fixture schema is selected.

## Platform parity

- Required scenarios must exist on both platforms.
- Platform-only scenarios use namespaced IDs such as `ios.uikit.layer_mismatch` or `android.compose.semantics_merge`.
- A platform implementation may report an explicit limitation instead of silently omitting required evidence.
- Contract tests compare normalized results, not pixel-identical native UI.
