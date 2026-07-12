# Vistrea Host Local API

This module is the authenticated loopback HTTP adapter shared by Vistrea Studio and local Agent integrations. It composes public Snapshot Engine use cases with `WorkspaceDataSource`, `ObjectStore`, and `ProtocolValidator` ports. It never opens SQLite, resolves physical object paths, or implements product logic.

## Security boundary

- The caller must bind an explicit literal `127.0.0.1` or `::1` address. Hostnames, wildcard addresses, and non-loopback interfaces fail closed.
- Every server start creates an independent 256-bit bearer token. The token is returned once in the `HostLocalApiHandle`, is not a Runtime transport credential, and is never persisted in the Workspace.
- Every route requires exactly one `Authorization: Bearer <token>` header.
- JSON request bodies default to a 64 KiB limit and cannot exceed a configured 1 MiB ceiling.
- JSON object keys must be unique at every nesting level and are checked before `JSON.parse` can normalize duplicate values.
- HTTP errors expose stable codes and sanitized messages, never stack traces, secrets, SQLite rows, or physical paths.

## Version 1 routes

All JSON uses `application/json; charset=utf-8`. Successful Snapshot responses are canonical protocol values and are not wrapped in an adapter-private model.

| Method | Route | Success body |
|---|---|---|
| `GET` | `/v1/status` | `{ "status": "ready" | "degraded", "runtime_connected": true, "message"?: string }` |
| `GET` | `/v1/snapshots?limit=<1..500>&cursor=<opaque>` | `{ "items": SnapshotSummary[], "next_cursor"?: string, "snapshot_version"?: string }` |
| `GET` | `/v1/snapshots/<snapshot_id>` | canonical `RuntimeSnapshot` |
| `POST` | `/v1/captures` | canonical `RuntimeSnapshot` with HTTP `201` |
| `GET` | `/v1/objects/<sha256:hex>` | exact encoded object bytes |

`POST /v1/captures` accepts `{}` and applies this deterministic default Engine command:

```json
{
  "include": { "paths": ["trees", "screenshot"] },
  "screenshot": "reference",
  "reason": "manual"
}
```

The same three fields may be provided explicitly. `screenshot` accepts `none` or `reference`; `reason` accepts `manual`, `before_action`, `after_action`, `review`, or `validation`. Unknown fields fail with `invalid_argument`.

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
