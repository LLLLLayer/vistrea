# Vistrea Studio for macOS

The primary desktop workspace for device and SDK connection, Screen State Canvas, Deep Wiki, design review, live Debug tuning, 2D/3D inspection, validation, and Coding Agent collaboration.

The first native SwiftUI Snapshot workspace is implemented as a standalone Swift Package. It currently provides:

- independent Host and Runtime connection status;
- a persisted Snapshot list;
- selected Snapshot identity and canonical `vistrea.scenario_id` context;
- canonical Runtime Snapshot decoding through `VistreaRuntimeModels`;
- screenshot Object loading with explicit missing-object placeholders;
- iterative reconstruction of canonical flat UI nodes into a View Tree outline;
- node selection and canonical property details;
- a persisted Runtime event timeline pane with newest-first ordering, transient payload summaries, and the Host event-pump status;
- a Review Issues pane listing persisted issues with lifecycle state, severity, and category, most recently updated first;
- a Screen State Canvas tab rendering the materialized Screen Graph with a deterministic layered layout: entry states in the first column, breadth-first depth columns, unreachable states last, and observed transitions drawn as edges;
- a 3D Layer Inspector tab exploding the selected Snapshot's captured hierarchy into depth-ordered SceneKit layers with camera control, interactive nodes highlighted;
- a Deep Wiki tab searching persisted knowledge nodes by text with kind, status, and label facets;
- a Debug-only alpha tuning preview in the node-details pane: a slider plus Preview button creates a single-change Tuning Patch bound to the selected node and Snapshot, applies it over the live Runtime, shows applied versus rejected changes with the canonical rejection reason codes verbatim, and lists active previews with per-row Revert; a Host without an authorized Runtime degrades to inline error text;
- Review Issue lifecycle transitions: selecting an issue loads its persisted revision and offers only the legal target states from the canonical lifecycle (`open`, `in_progress`, `ready_for_verification`, `resolved`, `wont_fix`) with an optional reason; optimistic-concurrency conflicts reload the issue and show a changed-elsewhere note;
- Deep Wiki editing: a New node sheet (schema kind picker, title, summary, Markdown) and a per-node Edit sheet that loads the full node, revises it guarded by `expected_revision`, and offers only legal status transitions; conflicts reload the node and show a changed-elsewhere note;
- Canvas Screen State details: clicking a state opens a side panel with its persisted title, kind, status, first/last seen, and canonical Snapshot ID, lists the Wiki nodes already linked to it, and can create a `relates_to` Wiki link to the state;
- a Canvas Explore entry driving the Host's background exploration Operation: a small form (maximum actions, settle milliseconds, excluded stable IDs) starts the run, a status line polls the Operation once per second behind a generation guard that stops when the pane disappears or a newer request supersedes it, Cancel requests cancellation, a succeeded run shows the report summary (states discovered, actions, stop reason) and refreshes the Canvas graph automatically, and failed, cancelled, or `unsupported` Hosts (no automation provider, HTTP 501) surface the error code and message verbatim with the controls re-enabled;
- Canvas identity curation: Cmd-click multi-selects active Screen State cards, a Merge sheet picks the survivor (defaulting to the first selection) with an optional justification and posts the merge guarded by the loaded `graph_revision`; the state-details panel lists the state's observation IDs and offers a Split sheet that moves a strict subset (at least one moved, at least one left behind) into a new state with an optional title and justification; merged tombstones render dimmed with their status and are excluded from selection, and a revision conflict (HTTP 409 `conflict`) reloads the graph with a changed-elsewhere note instead of overwriting concurrent curation;
- a Design Review tab: a persisted design-reference list (name, kind, canvas and pixel size) plus the past comparisons for the selected reference and Snapshot; Compare posts a design comparison of the selected reference against the selected Snapshot with an include-pixel toggle; the workbench overlays the design asset image on the Snapshot screenshot at slider-adjustable opacity (asset scaled to the screenshot), draws severity-colored difference rectangles — frame differences from the canonical expected/actual rect values scaled from logical points through the screenshot coverage, other categories located from the loaded tree by stable ID or node ID — shows the expected design position dashed for the selected frame difference, lists every difference (category, severity, delta, expected versus actual) with selection-driven highlighting, and steps differences with a review mode; `quality: partial` and the canonical `extensions["vistrea.pixel"]` verdict render as honest captions, and a Snapshot without a screenshot or a failed asset load degrades to inline text instead of an invented overlay;
- loading, empty, detail-error, connection-error, capture-error, and write-conflict states;
- a capture action over the Host Local API;
- a canonical fixture-backed development mode when no Host is configured, including in-memory fixture implementations of every write flow above.

Every write is stamped with the Studio actor `{"kind": "human", "id": "studio"}`.

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

The fixture intentionally contains screenshot Object metadata without bundling the binary. Studio displays this as a missing-object evidence placeholder rather than inventing screenshot bytes.

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
- `POST /v1/screen-graph/state-merges` and `POST /v1/screen-graph/state-splits`
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
