# Runtime Snapshot Protocol Semantics

Status: **Draft for protocol version 1.0**

## 1. Snapshot purpose

A `RuntimeSnapshot` is an immutable, internally consistent description of application UI state at a precise capture point. It correlates structured trees, screenshot evidence, runtime context, capture capabilities, and nearby events.

A Snapshot describes what Vistrea observed. It does not claim that every native or custom-drawn element was captured.

## 2. Top-level shape

```text
RuntimeSnapshot
├── identity and protocol version
├── capture time and runtime context
├── display and coordinate-space metadata
├── one or more flat UI trees
├── screenshot ObjectRef
├── related runtime event window
├── capture limitations
└── namespaced extensions
```

Initial required fields:

- `snapshot_id`
- `protocol_version`
- `captured_at`
- `runtime_context`
- `display`
- `trees`
- `capabilities`
- `capture_limitations`
- `extensions`

## 3. Node identity

Every UI node has two separate identity concepts:

- `node_id`: required runtime identity, unique only within one Snapshot;
- `stable_id`: optional semantic or business identity intended to correlate nodes across captures and builds.

Rules:

- Consumers never treat `node_id` as stable across Snapshots.
- Duplicate `node_id` values in one Snapshot are semantic-invalid.
- Duplicate `stable_id` values are permitted only when the adapter declares a scoped repeated-component strategy; otherwise they produce a validation warning or finding.
- Native object addresses, process pointers, and index paths are diagnostic extensions, not stable identity.
- State identity algorithms may use `stable_id` but must not rely on it alone.

## 4. Flat tree representation

Trees use flat node tables rather than recursive nested JSON:

```text
UiTree
├── tree_id
├── kind: semantic | view | layer
├── root_node_ids[]
└── nodes[]
    └── UiNode
        ├── node_id
        ├── parent_id?
        └── child_ids[]
```

Rules:

- `nodes` contains unique `node_id` values.
- Every `root_node_id` resolves to a node with no parent.
- Every `parent_id` and `child_id` resolves within the same tree.
- `child_ids` preserves native or semantic traversal order.
- Parent and child references agree in both directions.
- A node has at most one parent in a tree.
- Cycles are forbidden.
- Disconnected nodes are allowed only when an explicit capture limitation explains them.
- Different tree kinds link through explicit related-node references; they do not share implicit array positions.

Flat trees support streaming, partial loading, node indexing, and stable diff behavior better than recursive payloads.

## 5. Tree payload size

Small and medium captures may inline a flat node array. Large captures may store the same serialized tree as an `ObjectRef`.

Exactly one representation is selected per tree payload:

- `inline_nodes`; or
- `nodes_object` plus node count and encoding metadata.

Schema validation can validate an ObjectRef without loading its bytes, but complete tree semantic validation cannot. A validator must resolve the Object, validate the decoded `vistrea.ui-nodes+json` array, verify `node_count`, and then run the same identity and graph checks as an inline tree. An unresolved object-backed tree is explicitly incomplete and cannot receive a semantic-valid result.

Field masks may omit a tree entirely. Omission is represented in `capture_limitations` and never confused with an empty tree.

## 6. Coordinate system

All normalized UI geometry uses a Snapshot-level, top-left-origin logical screen coordinate space after device orientation is applied.

```text
origin: top-left
x: increases right
y: increases down
unit: logical_point
```

Adapters convert native coordinates:

- iOS points map directly to logical points after screen/window conversion;
- Android pixels convert through the effective display density into logical points;
- native and raw-pixel geometry may be retained in namespaced extensions.

`DisplayGeometry` includes:

- logical width and height;
- full display raster width and height, independent of screenshot cropping;
- pixel scale on each axis;
- orientation;
- safe-area or system-inset values in logical points;
- display and geometry revision;
- optional window mapping metadata.

`screenshot.coverage` is a non-empty crop in full-display logical coordinates. `screenshot.pixel_size` is the decoded raster size of the referenced canonical screenshot Object. Node geometry remains in full-display coordinates. Canonical screenshots are unscaled native raster crops; thumbnails and resized previews are derived artifacts.

Mapping a logical display point into screenshot pixels:

```text
screenshot_x = (logical_x - coverage.x) * pixel_scale_x
screenshot_y = (logical_y - coverage.y) * pixel_scale_y
```

Coverage edges must align to integer pixels, and coverage size multiplied by display scale must equal `screenshot.pixel_size`. `system_chrome` is independent from full versus partial coverage: it reports whether system UI pixels inside the coverage were included, excluded, partially captured, or unknown.

## 7. Node geometry

Initial normalized geometry fields:

- `frame`: required axis-aligned bounding rectangle in Snapshot logical screen space when geometry is available;
- `visible_rect`: optional actually visible region after clipping and screen intersection;
- `hit_rect`: optional effective interaction region;
- `bounds`: optional local-node coordinate rectangle;
- `z_index`: optional normalized sibling or drawing-order hint;
- `clipped`: optional capture result;
- `occlusion`: optional computed evidence, not a native truth field.

Coordinates are finite numbers. Width and height are non-negative. Subpixel values are preserved. Consumers choose display rounding and must not rewrite stored evidence.

Complex transforms and 3D matrices are namespaced extensions until the Layer protocol is stabilized.

## 8. Node semantics

Initial node property groups:

- identity: node, stable, native type, semantic role;
- content: text, value, placeholder, content description;
- state: visible, enabled, selected, focused, checked, expanded;
- interaction: actionable operations and hit geometry;
- visual: alpha, background/foreground color, font, corner, border, shadow when captured;
- accessibility: label, value, traits/role, hidden state, focus order when captured;
- relationships: parent, ordered children, related view/semantic/layer nodes;
- source context: route, controller/activity/fragment, module or component hints;
- capture metadata: redacted fields, limitations, namespaced extensions.

Missing, redacted, unsupported, and false are distinct states.

## 9. Runtime context

`RuntimeContext` records the dimensions required to interpret and compare evidence:

- project and application identity;
- build ID, application version, and source Git SHA when known;
- platform, OS, device, simulator/real-device state;
- environment and account-profile identifiers without secrets;
- feature/experiment configuration references;
- locale, theme, text scale, orientation, and accessibility settings;
- Runtime SDK and adapter versions/capabilities.

Dynamic values belong in captured content but state-deduplication policy may normalize them later. The Snapshot remains immutable raw evidence.

## 10. Screenshot correlation

Screenshot metadata includes:

- `ObjectRef`;
- capture start and finish time;
- closest Snapshot monotonic offset;
- decoded pixel size and logical display coverage;
- color-space and alpha metadata when available;
- redaction profile;
- capture skew used by validation policy to classify exact or delayed evidence.

If the structured tree and screenshot cannot be captured atomically, the adapter reports the measured or estimated skew. Validation policy decides whether the skew is acceptable. An unavailable screenshot is represented by an absent `screenshot` plus an explicit capture limitation.

## 11. Runtime event correlation

Snapshots reference an event window by epoch and sequence range:

```text
event_epoch_id
first_sequence?
last_sequence?
```

Events remain separate immutable records. A Snapshot does not duplicate the complete event stream. Missing sequences or dropped events are explicit limitations.

A `RuntimeEventBatch` advances an inclusive sequence range within one epoch. Retained events are strictly ordered and use the same epoch and negotiated protocol version. Subscription-filtered gaps are not dropped events; `dropped_event_count` records only matched events lost or sampled within the range. Empty batches may advance a filtered or fully dropped range.

## 12. Capture limitations

Each limitation contains:

- stable limitation code;
- affected tree, node, field, or artifact scope;
- severity;
- human diagnostic message;
- adapter capability or platform reason;
- whether retry may improve the result.

Examples:

- tree omitted by field mask;
- SwiftUI semantics incomplete;
- custom-drawn content unavailable;
- screenshot blocked by protected content;
- event gap after reconnect;
- geometry unavailable for off-process system UI;
- text redacted by policy.

## 13. Extension policy

`extensions` is an object whose keys use reverse-domain or platform namespaces such as:

```text
ios.uikit.layer_tree
android.compose.semantics
com.example.checkout.component
```

Extensions must not redefine core field meaning. A widely required extension may be considered for the next major protocol version with migration and compatibility fixtures; it cannot become a new `1.x` core field.

## 14. Semantic validation

JSON Schema validates field shape. The protocol validator additionally checks:

- unique node and tree IDs;
- root, parent, child, and related-node references;
- parent/child agreement;
- absence of cycles;
- full-display scale, screenshot crop bounds, pixel alignment, and raster-size consistency;
- finite geometry and valid rectangles;
- event range ordering;
- namespaced extension keys;
- content hash and byte-size fixtures where bytes are available.

## 15. First fixtures

The first fixture set includes:

- minimal Snapshot with one semantic root;
- iOS UIKit Snapshot;
- Android View Snapshot;
- transient success event correlated to a Snapshot;
- ordered, filtered-gap, fully dropped, and invalid event batches;
- full and partial screenshot evidence;
- namespaced compatibility extension;
- invalid duplicate node ID;
- invalid dangling child reference;
- invalid cycle;
- invalid screenshot/geometry mapping.
