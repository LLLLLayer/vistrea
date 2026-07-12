# Vistrea CLI

The CLI is a deterministic JSON adapter over the authenticated Host Local API. It never imports Data, SQLite, Object Store, or Workspace path implementations.

## Implemented commands

```text
vistrea workspace status
vistrea snapshot capture [--include <field>]... [--screenshot none|reference] [--reason <reason>]
vistrea snapshot list [--limit <1..500>] [--cursor <opaque>]
vistrea snapshot get <snapshot_id>
```

Implemented global options are `--format json`, `--request-id`, `--trace-id`, `--deadline <Nms|Ns|Nm>`, and `--non-interactive`. Other documented command families remain unavailable until their Engine operations exist.

The success envelope is stable:

```json
{
  "request_id": "request_...",
  "trace_id": "trace_...",
  "data": {},
  "warnings": [],
  "error": null
}
```

Errors use the same envelope with `data: null` and `{ code, message, retryable }`. Exit codes follow `docs/interfaces/AGENT_INTERFACES.md`: invalid input `2`, not found `3`, conflict `4`, authentication `5`, unsupported `6`, unavailable/timeout/resource limit `7`, policy blocked `8`, integrity `9`, and internal `10`.

## Run locally

Build once, then pass the Host endpoint and token only through environment variables:

```bash
pnpm build:host
export VISTREA_HOST_URL=http://127.0.0.1:43123
# Provision VISTREA_HOST_TOKEN through the protected launcher or process environment.
node .build/typescript/integrations/cli/main.js workspace status --format json
```

There is intentionally no token command-line option. Do not place the token in argv, command output, shell tracing, or logs. See `../shared/README.md` for timeout and response-limit configuration.

Phase 0B capture waits for the current Host endpoint and returns its canonical `RuntimeSnapshot` directly. When the durable asynchronous `CaptureSnapshot` operation lifecycle in the Operation Catalog is implemented, this adapter must advance to immediate `OperationRef` plus `GetOperationResult` without changing capture behavior privately.
