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
- loading, empty, detail-error, connection-error, and capture-error states;
- a capture action over the Host Local API;
- a canonical fixture-backed development mode when no Host is configured.

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
