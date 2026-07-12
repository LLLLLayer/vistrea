# Vistrea MCP Server

This module is a runnable Model Context Protocol stdio server built with the official `@modelcontextprotocol/sdk`. Every tool is a thin adapter over the same strict Host Local API client as the CLI. The server does not import Data, SQLite, Object Store, Runtime transport, or Workspace path implementations.

## Tools

| Tool | Engine operation | Behavior |
|---|---|---|
| `vistrea_get_workspace_status` | `GetWorkspaceStatus` | Read current Host/Workspace status |
| `vistrea_capture_snapshot` | `CaptureSnapshot` | Capture and persist a canonical Runtime Snapshot |
| `vistrea_list_snapshots` | `ListSnapshots` | Page persisted Snapshot summaries |
| `vistrea_get_snapshot` | `GetSnapshot` | Load a canonical Runtime Snapshot |

Successful synchronous tools return the domain result in `structuredContent` and as JSON text. Errors set `isError: true` and return `{ request_id, trace_id, error: { code, message, retryable } }` without exposing headers, configuration, fetch URLs, or credentials.

## Run locally

```bash
pnpm build:host
export VISTREA_HOST_URL=http://127.0.0.1:43123
# Provision VISTREA_HOST_TOKEN through the MCP client's protected environment map.
node .build/typescript/integrations/mcp/main.js
```

Configure an MCP client with that command and pass `VISTREA_HOST_URL` plus `VISTREA_HOST_TOKEN` in its controlled environment map. The token is intentionally not a tool argument or command-line option. Stdout is reserved exclusively for MCP JSON-RPC framing; startup failures write only one generic line to stderr.

`vistrea_list_snapshots` and `vistrea_get_snapshot` expose the currently implemented read operations for Phase 0B parity even though their MCP names were not yet reserved in the draft Operation Catalog. Capture currently returns the Host endpoint's canonical `RuntimeSnapshot` synchronously; it must migrate to the catalog's `OperationRef` lifecycle when that Engine capability exists.
