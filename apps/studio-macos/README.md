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
- `GET /v1/wiki/nodes`, `POST /v1/wiki/nodes`, `GET /v1/wiki/nodes/:id`, and `POST /v1/wiki/nodes/:id/revisions`
- `POST /v1/wiki/links` and `GET /v1/wiki/related`

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
