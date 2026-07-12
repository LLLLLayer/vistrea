# Vistrea CLI

The CLI is a deterministic JSON adapter over the authenticated Host Local API. It never imports Data, SQLite, Object Store, or Workspace path implementations.

## Implemented commands

```text
vistrea workspace status
vistrea snapshot capture [--include <field>]... [--screenshot none|reference] [--reason <reason>]
vistrea snapshot list [--limit <1..500>] [--cursor <opaque>]
vistrea snapshot get <snapshot_id>
vistrea events list [--epoch <event_epoch_id>] [--kinds a,b] [--first-sequence <n>] [--last-sequence <n>]
vistrea design upload-asset --file <path> --media-type <type> [--name <logical>]
vistrea design add-reference --json <command>
vistrea design get-reference <design_reference_id>
vistrea design map --json <command>
vistrea design compare --reference <id> --snapshot <id> [--actor <id>]
vistrea design get-comparison <comparison_id>
vistrea issue create --json <command>
vistrea issue list [--states a,b] [--reference <id>] [--limit n] [--cursor c]
vistrea issue get <issue_id>
vistrea issue transition <issue_id> --revision <n> --to <state> [--reason <text>] [--actor <id>]
vistrea issue verify <issue_id> --revision <n> --basis <basis> --result <result> --snapshot <id> --build <id> [--rationale <text>] [--actor <id>]
vistrea tuning create-patch --json <command>
vistrea tuning get-patch <patch_id>
vistrea tuning apply --patch <patch_id> [--ttl <ms>]
vistrea tuning revert <tuning_application_id>
vistrea tuning get-application <tuning_application_id>
vistrea tuning list-active
vistrea graph observe-state --snapshot <snapshot_id> [--title <text>] [--kind <state_kind>] [--entry true|false] [--source <capture_source>] [--session <session_id>]
vistrea graph observe-transition --before <snapshot_id> --after <snapshot_id> --action <json> [--source <capture_source>] [--session <session_id>]
vistrea graph show --project <project_id> --application <application_id>
vistrea graph get-state <screen_state_id>
vistrea graph find-path --from <screen_state_id> --to <screen_state_id> [--graph <screen_graph_id>] [--max-depth <n>]
vistrea wiki create --json <command>
vistrea wiki update <wiki_node_id> --json <command>
vistrea wiki get <wiki_node_id>
vistrea wiki search [--text <phrase>] [--kinds a,b] [--labels a,b] [--statuses a,b] [--limit n] [--cursor c]
vistrea wiki link --json <command>
vistrea wiki unlink <wiki_link_id> --revision <n>
vistrea wiki backlinks <wiki_node_id>
vistrea wiki related --kind <resource_kind> --id <resource_id>
vistrea validate snapshot --snapshot <snapshot_id> [--categories structural,accessibility,visual]
vistrea validate graph --project <project_id> --application <application_id>
vistrea validate get-run <validation_run_id>
vistrea validate findings [--run <id>] [--statuses a,b] [--severities a,b] [--limit n] [--cursor c]
vistrea validate get-finding <finding_id>
vistrea validate suppress <finding_id> --json <command>
vistrea validate build-diff --project <project_id> --application <application_id> --left <build_id> --right <build_id>
vistrea validate get-build-diff <build_diff_id>
vistrea pack export --json <command>
vistrea pack import --file <path>
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
