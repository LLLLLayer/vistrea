# Vistrea Host Local API

This module is the authenticated loopback HTTP adapter shared by Vistrea Studio and local Agent integrations. It composes public Snapshot Engine use cases with `WorkspaceDataSource`, `ObjectStore`, and `ProtocolValidator` ports. It never opens SQLite, resolves physical object paths, or implements product logic.

## Security boundary

- The caller must bind an explicit literal `127.0.0.1` or `::1` address. Hostnames, wildcard addresses, and non-loopback interfaces fail closed.
- Every server start creates an independent 256-bit bearer token. The token is returned once in the `HostLocalApiHandle`, is not a Runtime transport credential, and is never persisted in the Workspace.
- Every route requires exactly one `Authorization: Bearer <token>` header.
- JSON request bodies default to a 64 KiB limit and cannot exceed a configured 1 MiB ceiling; Deep Wiki node writes get a fixed 2 MiB budget so the documented 262144-character Markdown capacity stays reachable.
- JSON object keys must be unique at every nesting level and are checked before `JSON.parse` can normalize duplicate values.
- HTTP errors expose stable codes and sanitized messages, never stack traces, secrets, SQLite rows, or physical paths.

## Version 1 routes

All JSON uses `application/json; charset=utf-8`. Successful Snapshot responses are canonical protocol values and are not wrapped in an adapter-private model.

| Method | Route | Success body |
|---|---|---|
| `GET` | `/v1/status` | `{ "status": "ready" | "degraded", "runtime_connected": boolean, "message"?: string }` |
| `GET` | `/v1/snapshots?limit=<1..500>&cursor=<opaque>` | `{ "items": SnapshotSummary[], "next_cursor"?: string, "snapshot_version"?: string }` |
| `GET` | `/v1/snapshots/<snapshot_id>` | canonical `RuntimeSnapshot` |
| `POST` | `/v1/captures` | canonical `RuntimeSnapshot` with HTTP `201` |
| `GET` | `/v1/objects/<sha256:hex>` | exact encoded object bytes |
| `GET` | `/v1/events` | persisted Runtime event timeline with gap evidence |

The remaining implemented route families return canonical domain resources
(creations use HTTP `201`) and map one-to-one to the operations in
`docs/interfaces/OPERATION_CATALOG.md`:

| Family | Routes |
|---|---|
| Design assets and references | `POST /v1/design-assets`, `POST /v1/design-references`, `GET /v1/design-references/<id>`, `POST /v1/design-mappings`, `POST /v1/design-comparisons`, `GET /v1/design-comparisons/<id>` |
| Review issues | `POST /v1/review-issues`, `GET /v1/review-issues`, `GET /v1/review-issues/<id>`, `POST /v1/review-issues/<id>/transitions`, `POST /v1/review-issues/<id>/verifications` |
| Protected tuning | `POST /v1/tuning-patches`, `GET /v1/tuning-patches/<id>`, `POST /v1/tuning-applications`, `GET /v1/tuning-applications/active`, `GET /v1/tuning-applications/<id>`, `POST /v1/tuning-applications/<id>/revert` |
| Identity curation | `POST /v1/screen-graph/state-merges`, `POST /v1/screen-graph/state-splits` — manual merge/split with expected graph revision, recorded as StateIdentityDecisions |
| Exploration Operations | `POST /v1/exploration/operations`, `GET /v1/exploration/operations/<id>`, `POST /v1/exploration/operations/<id>/cancel` — require a Host started with a configured automation provider, otherwise they fail closed as `unsupported` |
| Screen graph | `POST /v1/screen-graph/state-observations`, `POST /v1/screen-graph/transition-observations`, `GET /v1/screen-graph`, `GET /v1/screen-graph/paths`, `GET /v1/screen-states/<id>` |
| Deep Wiki | `POST /v1/wiki/nodes`, `GET /v1/wiki/nodes`, `GET /v1/wiki/nodes/<id>`, `POST /v1/wiki/nodes/<id>/revisions`, `GET /v1/wiki/nodes/<id>/backlinks`, `POST /v1/wiki/links`, `POST /v1/wiki/links/<id>/unlink`, `GET /v1/wiki/related` |
| Validation and build diff | `POST /v1/validation/snapshot-runs`, `POST /v1/validation/graph-runs`, `GET /v1/validation/runs/<id>`, `GET /v1/validation/findings`, `GET /v1/validation/findings/<id>`, `POST /v1/validation/findings/<id>/suppress`, `POST /v1/validation/build-diffs`, `GET /v1/validation/build-diffs/<id>` |
| Portable exchange | `POST /v1/exchange/exports`, `POST /v1/exchange/imports` |

`POST /v1/captures` accepts `{}` and applies this deterministic default Engine command:

```json
{
  "include": { "paths": ["trees", "screenshot"] },
  "screenshot": "reference",
  "reason": "manual"
}
```

The same three fields may be provided explicitly. `screenshot` accepts `none` or `reference`; `reason` accepts `manual`, `before_action`, `after_action`, `review`, or `validation`. Unknown fields fail with `invalid_argument`.

The initial UIKit and Android View providers currently accept exactly the
`trees` field set with `screenshot: "none"`, or the `trees` plus `screenshot`
field set with `screenshot: "reference"`. Field order is irrelevant. An
unsupported field mask produces a sanitized capture failure while the
authenticated Runtime session remains usable.

Object reads support one RFC 9110-style `bytes` range, including bounded, open-ended, and suffix forms. Multiple or unsatisfiable ranges return HTTP `416` and `Content-Range: bytes */<size>`. Payload bytes remain the exact encoded bytes identified by the canonical `ObjectRef`; the HTTP adapter does not transparently decompress them.

Errors use one sanitized shape:

```json
{
  "request_id": "request_<uuidv7>",
  "error": {
    "code": "invalid_argument",
    "message": "Diagnostic text safe for a local client.",
    "retryable": false
  }
}
```

`x-vistrea-request-id` carries the same correlation ID. Authentication failures also return `WWW-Authenticate`; method failures return `Allow`.

## Composition

`startLocalHost` is the production local composition root. It acquires the
Workspace ownership lock, opens SQLite metadata and the file-backed Object
Store, starts the authenticated Runtime listener, tracks the active Runtime
session, and then starts the Local API. Its Runtime token and API bearer token
are independent and rotate on every start.

```ts
const host = await startLocalHost({
  workspaceRoot: "/absolute/path/to/workspace",
  validator,
});

await host.waitForRuntime();
// Pass host.runtime only to an authorized Debug/Internal App process.
// Pass host.api only to Studio or an authorized local Agent adapter.
await host.close();
```

Before a Runtime is authenticated, `/v1/status` reports
`runtime_connected: false` and capture returns a sanitized retryable
`unavailable` response. Reconnecting a Runtime does not reopen storage or
change the Local API token.

The executable composition writes credentials to a newly created mode-`0600`
ephemeral descriptor instead of printing them or accepting them in arguments:

```bash
node .build/typescript/apps/host/serve.js \
  --workspace /absolute/path/to/workspace \
  --connection-file /private/tmp/vistrea-host.json
```

Stdout contains only the process ID, Workspace path, and descriptor path. A
clean `SIGINT` or `SIGTERM` closes API, Runtime, and storage ownership in order,
then removes the descriptor. The descriptor contains live secrets and must
never be committed or shared.

For focused adapter tests, `startHostLocalApi` can still be composed directly
over explicit ports:

```ts
const api = await startHostLocalApi({
  host: "127.0.0.1",
  runtime,
  workspace,
  objects,
  validator,
});

// Pass api.baseUrl and api.bearerToken to one authorized local client.
await api.close();
```

The composition root owns the Local Workspace and closes the API before closing storage. Restarting the API rotates the bearer token while the persisted Snapshot and Object data remain available through the same public ports.
