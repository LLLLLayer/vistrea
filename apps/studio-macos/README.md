# Vistrea Studio for macOS

The desktop workspace for Host and Runtime connection, Snapshot inspection, the Screen State Canvas, the Deep Wiki, design review, exploration runs, and Debug Runtime UI tuning.

Validation surfaces and Coding Agent collaboration are **not** implemented here yet; they live in the product plan, not in this package.

The native SwiftUI workspace is a standalone Swift Package. Its window follows the product interaction design: a persistent context bar on top with an **Application + Version (build) scope picker** — the scopes are derived from the distinct runtime contexts across the persisted Snapshots, and the only scope is selected automatically in the common single-application case — plus the independent Host/Runtime status and the Capture entry; a left navigation column with three sections (**Canvas**, **Evidence**, **Wiki**); and a collapsible **Timeline** strip along the bottom. The Screen State Canvas is the landing surface for the selected scope: it loads as soon as the scope is chosen, before any Snapshot is clicked. Selecting a state on the Canvas opens its **single-screen Inspector** as the main right-hand experience — the evidence panes (screenshot, 2D view tree, 3D layers, and the design workbench) beside **one scrollable state context column**: the Screen State's persisted fields, its annotations (labels and summary), observations and curation actions, knowledge links, the Runtime Context of the state's canonical observation Snapshot, the selected node's properties with the tuning entry, and the Review Issues — one column, no stacked duplicate panels. All of it is driven by that state's canonical observation Snapshot resolved through the Host, not by a sidebar capture list. The flat Snapshot list survives as the secondary Evidence library section.

The Inspector layout is responsive. Every structural width lives in `StudioLayoutMetrics` (VistreaStudioCore), including the window minimum, so the panes and the window floor stay provably consistent. Labeled context values truncate in the middle with the full value in a tooltip instead of clipping at the window edge, and when the Inspector's actual width drops below `StudioLayoutMetrics.inspectorSideBySideMinWidth` the context column collapses behind a header **Context** toggle: the Inspector then shows the evidence panes or the context column one at a time rather than painting outside its bounds.

It currently provides:

- independent Host and Runtime connection status in the context bar;
- an Application + Version scope picker deriving its choices from the listed Snapshot runtime contexts; selecting a scope reloads the Canvas for that project and application and filters the Evidence library, and a refresh never yanks a still-available scope selection;
- a demoted Snapshot Evidence library (per scope) as a secondary navigation section;
- selected Snapshot identity and canonical `vistrea.scenario_id` context;
- canonical Runtime Snapshot decoding through `VistreaRuntimeModels`;
- screenshot Object loading with explicit missing-object placeholders;
- iterative reconstruction of canonical flat UI nodes into a View Tree outline;
- node selection and canonical property details;
- a collapsible bottom Timeline strip with the persisted Runtime events in newest-first order, transient payload summaries, and the Host event-pump state from `GET /v1/status` (its epoch, persisted sequence, and error code in the tooltip) — events are timeline evidence, not a sidebar destination;
- a Review Issues panel listing persisted issues with lifecycle state, severity, and category, most recently updated first;
- the Screen State Canvas as the landing surface, rendering the materialized Screen Graph with a deterministic layered layout: entry states in the first column, breadth-first depth columns, unreachable states last, and observed transitions drawn as edges;
- a single-screen Screen State Inspector: clicking a Canvas state resolves the state's `canonical_snapshot_id` through the Host and drives the screenshot, 2D tree, node properties, 3D layers, and design workbench from that observation Snapshot; a canonical Snapshot that no longer resolves is an explicit Inspector failure;
- a 3D Layer Inspector exploding the captured hierarchy into depth-ordered SceneKit layers with camera control. Each layer is textured with the node's real pixels: the logical frame maps through the screenshot coverage and pixel scale into a clamped raster crop. The selected node gets a subtle accent tint; a node outside the covered region keeps a neutral placeholder; and a Snapshot without screenshot bytes (the fixture intentionally ships none) degrades to the role-colored placeholder boxes under an honest caption — pixels are never fabricated;
- a Deep Wiki section searching persisted knowledge nodes by text with kind, status, and label facets;
- an alpha tuning preview in the node-details pane: a slider plus Preview button creates a single-change Tuning Patch bound to the selected node and Snapshot, applies it over the live Runtime, shows applied versus rejected changes with the canonical rejection reason codes verbatim, and lists active previews with per-row Revert. The capability is protected on the server side, not by a build flag: this package contains no `#if DEBUG` guard, and a Host without an authorized Debug Runtime rejects the tuning routes (HTTP 503 `unavailable`), which the pane shows as inline error text. Release protection is owned by the Runtime SDKs and the Host, not by Studio;
- Review Issue lifecycle transitions: selecting an issue loads its persisted revision and offers only the legal target states from the canonical lifecycle (`open`, `in_progress`, `ready_for_verification`, `resolved`, `wont_fix`) with an optional reason; optimistic-concurrency conflicts reload the issue and show a changed-elsewhere note;
- Deep Wiki editing: a New node sheet (schema kind picker, title, summary, Markdown) and a per-node Edit sheet that loads the full node, revises it guarded by `expected_revision`, and offers only legal status transitions; conflicts reload the node and show a changed-elsewhere note;
- Canvas Screen State details: the Inspector's context column shows the state's persisted title, kind, status, first/last seen, and canonical Snapshot ID, shows how many observations the state deduplicates, lists the Wiki nodes already linked to it, and can create a `relates_to` Wiki link to the state;
- Screen State annotations: Canvas cards render the state's annotation labels as small chips with the summary as a secondary line, and the Inspector context column shows them prominently with an inline **Edit annotations** editor (a comma-separated label field and a summary field with a live 280-character counter). The write posts `POST /v1/screen-graph/state-annotations` guarded by the graph revision the edit **began** against — captured when the editor opens, exactly like merge and split — so a background reload conflicts with the changed-elsewhere note and re-arms after the reloaded graph is shown, instead of laundering a concurrent change into the edit. Emptying the labels field submits the empty array and emptying the summary submits the empty string: both explicitly clear that field on the state;
- a Canvas Explore entry driving the Host's background exploration Operation: a small form (maximum actions, settle milliseconds, excluded stable IDs) starts the run and a status line polls the Operation once per second. The poll loop belongs to the run, not to the visible tab: switching tabs keeps the progress line, the report, the automatic Canvas refresh, and Cancel alive. Cancel stays reachable for as long as the Host has not settled the Operation — including after a rejected start — so a started exploration can never be orphaned. A succeeded run shows the report summary (states discovered, actions, stop reason) and reloads the Canvas graph; failed, cancelled, and `unsupported` Hosts (no automation provider, HTTP 501) surface the error code and message verbatim with the controls re-enabled;
- Canvas identity curation: Cmd-click multi-selects active Screen State cards, a Merge sheet picks the survivor (defaulting to the first selection) with an optional justification; the state-details panel offers a Split sheet that lists the state's observation IDs and moves a strict subset (at least one moved, at least one left behind) into a new state with an optional title and justification. Both writes are guarded by the `graph_revision` the decision **began** against — captured when the sheet opens, not read at submit time — so a background reload (a refresh, or the automatic reload after an exploration succeeds) can never launder a concurrent change into the decision: a stale decision takes the same changed-elsewhere path as an HTTP 409 `conflict` from the Host, and the survivor is revalidated against the current selection before anything is posted. Merged tombstones render dimmed with their status, are excluded from selection, and report their real status when a split is attempted on them;
- a Design Review tab inside the Inspector panes: a persisted design-reference list (name, kind, canvas and pixel size) plus the past comparisons for the selected reference and Snapshot; Compare posts a design comparison of the selected reference against the selected Snapshot with an include-pixel toggle. The workbench overlays the design asset at slider-adjustable opacity by mapping the reference's `canvas_size` through the *same* screenshot-coverage transform the difference rectangles use, so the overlay and the differences always share one coordinate frame even when the screenshot covers less than the whole canvas; the asset keeps its own aspect ratio, and a design whose asset cannot fill its declared canvas — or a screenshot whose pixel scale is not uniform — is captioned honestly instead of being stretched. Severity-colored difference rectangles come from the canonical expected/actual rect values (other categories are located in the loaded tree by stable ID or node ID), the expected design position is drawn dashed for the selected frame difference, every difference is listed (category, severity, delta, expected versus actual) with selection-driven highlighting and a stepping review mode; `quality: partial` and the canonical `extensions["vistrea.pixel"]` verdict render as honest captions, and a Snapshot without a screenshot or a failed asset load degrades to inline text instead of an invented overlay;
- loading, empty, detail-error, connection-error, capture-error, and write-conflict states;
- a capture action over the Host Local API;
- a canonical fixture-backed development mode when no Host is configured, including in-memory fixture implementations of every write flow above.

Writes that the Host contract stamps with the Studio actor `{"kind": "human", "id": "studio"}` are: Review Issue transitions (`changed_by`), Wiki node creation (`created_by`), Wiki node revisions (`updated_by`), Wiki links (`created_by`), Tuning Patch creation (`created_by`), Screen State merges (`merged_by`), splits (`split_by`), and annotations (`annotated_by`), and design comparisons (`completed_by`). Capture, tuning apply and revert, and exploration run and cancel carry no actor field in the current Host contract.

The presentation layer depends on the `HostClient` abstraction. It does not access SQLite, Workspace paths, Object Store paths, or Runtime transports directly. Reusable product behavior remains in `engine/`, while storage implementations remain in `data/`.

## Run with the canonical fixture

From the repository root:

```bash
swift run --package-path apps/studio-macos VistreaStudio
```

The app locates `protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json`. Override the path only when running outside the repository checkout:

```bash
VISTREA_FIXTURE_PATH=/absolute/path/to/ios-uikit.json \
  swift run --package-path apps/studio-macos VistreaStudio
```

`FixtureWorkspace.makeClient(snapshot:)` composes that Snapshot with a deterministic in-memory Workspace: a materialized Screen Graph (three active states, two of them mergeable, the entry state carrying two observations so a split is possible), two Deep Wiki nodes, one open Review Issue, and a design baseline minted from the Snapshot's own screenshot Object. Every read pane and every write flow above is therefore reachable without a Host — the Canvas included.

The fixture intentionally contains screenshot Object metadata without bundling the binary. Studio displays this as a missing-object evidence placeholder rather than inventing screenshot bytes, so the Design Review overlay degrades to inline text and a requested pixel comparison reports the canonical `unavailable` verdict.

## Run against the Host Local API

Every Host route requires an independent bearer token:

```bash
VISTREA_HOST_URL=http://127.0.0.1:47831 \
VISTREA_HOST_TOKEN=replace-with-the-43-character-base64url-token \
  swift run --package-path apps/studio-macos VistreaStudio
```

The client accepts only literal `http://127.0.0.1` and `http://[::1]` endpoints plus the fresh 43-character base64url token returned by that Host start. Hostnames, HTTPS, remote addresses, and arbitrary bearer strings fail closed.

The adapter consumes these frozen local endpoints:

- `GET /v1/status`
- `GET /v1/snapshots`
- `GET /v1/snapshots/:id`
- `GET /v1/objects/:hash`
- `POST /v1/captures`
- `GET /v1/events`
- `GET /v1/review-issues` and `GET /v1/review-issues/:id`
- `POST /v1/review-issues/:id/transitions`
- `POST /v1/tuning-patches`
- `POST /v1/tuning-applications`, `POST /v1/tuning-applications/:id/revert`, and `GET /v1/tuning-applications/active`
- `GET /v1/screen-graph` and `GET /v1/screen-states/:id`
- `POST /v1/screen-graph/state-merges`, `POST /v1/screen-graph/state-splits`, and `POST /v1/screen-graph/state-annotations`
- `GET /v1/design-references` and `GET /v1/design-references/:id`
- `GET /v1/design-comparisons` and `POST /v1/design-comparisons`
- `GET /v1/wiki/nodes`, `POST /v1/wiki/nodes`, `GET /v1/wiki/nodes/:id`, and `POST /v1/wiki/nodes/:id/revisions`
- `POST /v1/wiki/links` and `GET /v1/wiki/related`
- `POST /v1/exploration/operations`, `GET /v1/exploration/operations/:id`, and `POST /v1/exploration/operations/:id/cancel`

Canonical Runtime Snapshot responses use the strict shared decoder. Host envelopes also reject unknown core fields.
URLSession streams into bounded buffers before decoding: JSON responses are capped at 64 MiB and Object responses at 256 MiB. Full Object reads verify `ETag`, `Content-Length`, and SHA-256; byte ranges verify `ETag`, `Content-Length`, canonical `Content-Range`, and exact body length.

## Verify

```bash
swift test --package-path apps/studio-macos
swift build --package-path apps/studio-macos --product VistreaStudio
```

See [Studio interaction design](../../docs/product/STUDIO_INTERACTIONS.md) and [Engine use cases](../../docs/interfaces/ENGINE_API.md).

`VistreaStudioAcceptanceProbe` is a non-UI end-to-end verifier used by the real
iOS vertical acceptance. It exercises this same bounded Host client, canonical
decoder, Object integrity path, and presentation projection before the native
window launch smoke test. Credentials and the expected Snapshot ID are accepted
only through environment variables; its JSON output contains evidence identity
and counts, never credentials.
