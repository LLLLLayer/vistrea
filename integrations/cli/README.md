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
vistrea design promote-baseline --json <command>
vistrea design get-reference <design_reference_id>
vistrea design map --json <command>
vistrea design compare --reference <id> --snapshot <id> [--actor <id>] [--pixel true|false]
vistrea design get-comparison <comparison_id>
vistrea design list-references [--limit <n>] [--cursor <cursor>]
vistrea design list-comparisons [--reference <id>] [--snapshot <id>] [--limit <n>] [--cursor <cursor>]
vistrea issue create --json <command>
vistrea issue create-from-difference --json <command>
vistrea issue list [--states a,b] [--reference <id>] [--screen-state <id>] [--limit n] [--cursor c]
vistrea issue get <issue_id>
vistrea issue transition <issue_id> --revision <n> --to <state> [--reason <text>] [--actor <id>]
vistrea issue verify <issue_id> --revision <n> --basis <basis> --result <result> --snapshot <id> --build <id> [--rationale <text>] [--actor <id>]
vistrea issue recapture-verify --json <command>
vistrea tuning create-patch --json <command>
vistrea tuning get-patch <patch_id>
vistrea tuning source-suggestions <patch_id>
vistrea tuning apply --patch <patch_id> [--ttl <ms>]
vistrea tuning revert <tuning_application_id>
vistrea tuning get-application <tuning_application_id>
vistrea tuning list-active
vistrea graph observe-state --snapshot <snapshot_id> [--title <text>] [--kind <state_kind>] [--entry true|false] [--source <capture_source>] [--session <session_id>]
vistrea graph observe-transition --before <snapshot_id> --after <snapshot_id> --action <json> [--source <capture_source>] [--session <session_id>]
vistrea graph show --project <project_id> --application <application_id> [--build <build_id> --version <application_version>]
vistrea graph get-state <screen_state_id> [--build <build_id> --version <application_version>]
vistrea graph tag --project <project_id> --application <application_id> --tag <tag_name>
vistrea screen merge --project <id> --application <id> --states a,b [--into <state_id>] --revision <n> [--actor <id>] [--justification <text>]
vistrea screen split --project <id> --application <id> --state <state_id> --observations a,b [--title <text>] --revision <n> [--actor <id>] [--justification <text>]
vistrea screen annotate <screen_state_id> --project <id> --application <id> [--labels a,b] [--summary <text>] --revision <n> [--actor <id>]
vistrea graph find-path --from <screen_state_id> --to <screen_state_id> [--graph <screen_graph_id>] [--max-depth <n>] [--max-paths <n>]
vistrea wiki create --json <command>
vistrea wiki update <wiki_node_id> --json <command>
vistrea wiki get <wiki_node_id>
vistrea wiki search [--text <phrase>] [--kinds a,b] [--labels a,b] [--statuses a,b] [--limit n] [--cursor c]
vistrea wiki link --json <command>
vistrea wiki unlink <wiki_link_id> --revision <n>
vistrea wiki backlinks <wiki_node_id> [--limit <n>] [--cursor <cursor>]
vistrea wiki related --kind <resource_kind> --id <resource_id> [--limit <n>] [--cursor <cursor>]
vistrea collection create --json <command>
vistrea collection update <collection_id> --json <command>
vistrea collection get <collection_id>
vistrea collection list [--text <phrase>] [--states draft,published,archived] [--limit <n>] [--cursor <cursor>]
vistrea collection publish <collection_id> --json <command>
vistrea collection export <collection_id> [--formats markdown,html]
vistrea validate snapshot --snapshot <snapshot_id> [--categories structural,accessibility,visual] [--disable-rules a,b] [--min-touch-target <points>]
vistrea validate graph --project <project_id> --application <application_id> [--disable-rules a,b] [--min-touch-target <points>]
vistrea validate get-run <validation_run_id>
vistrea validate findings [--run <id>] [--statuses a,b] [--severities a,b] [--limit n] [--cursor c]
vistrea validate get-finding <finding_id>
vistrea validate suppress <finding_id> --json <command>
vistrea validate build-diff --project <project_id> --application <application_id> --left <build_id> --right <build_id> [--baseline <tag>]
vistrea validate get-build-diff <build_diff_id>
vistrea pack export --json <command>
vistrea pack import --file <path>
vistrea object get --hash <sha256:...> --output <path>
vistrea explore run --max-actions <n> [--max-depth <n>] [--settle <ms>] [--application <id>] [--recovery-attempts <0-5>] [--exclude id1,id2] [--actor <id>]
vistrea explore get <operation_id>
vistrea explore cancel <operation_id>
```

Implemented global options are `--format json`, `--request-id`, `--trace-id`, `--deadline <Nms|Ns|Nm>`, and `--non-interactive`. Other documented command families remain unavailable until their Engine operations exist.

Every implemented command that accepts `--json <command>` also accepts
`--json-file <path>`. File-backed input is strict UTF-8, is capped at 2 MiB,
and avoids platform command-line argument limits for long Wiki content. The
caller owns the input file; Vistrea neither modifies nor removes it.

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
# Optional: focus the exposed command surface (unset means every command).
# export VISTREA_CLI_TOOLSETS=assets,exploration
node .build/typescript/integrations/cli/main.js workspace status --format json
```

There is intentionally no token command-line option. Do not place the token in argv, command output, shell tracing, or logs. See `../shared/README.md` for timeout and response-limit configuration.

Phase 0B capture waits for the current Host endpoint and returns its canonical `RuntimeSnapshot` directly. When the durable asynchronous `CaptureSnapshot` operation lifecycle in the Operation Catalog is implemented, this adapter must advance to immediate `OperationRef` plus `GetOperationResult` without changing capture behavior privately.

## Local driver commands

`driver ios <doctor|prepare|up>` manages the iOS automation driver
(WebDriverAgent) on the local machine and needs no Host connection. These are
toolchain helpers, not Host operations, so they are deliberately absent from
the operation catalog. `prepare` clones the pinned release
(tag and commit are constants in `ios-driver.ts`; any other commit is
refused). `up` boots a Simulator by default or signs for a real device with
`--device <udid>` — the team comes from `--team`/`VISTREA_WDA_TEAM_ID`, the
`--app-project`'s `DEVELOPMENT_TEAM`, or a single Keychain development
identity whose matching certificate `OU` supplies the Apple Team ID (the
certificate-name suffix is only its UID); private keys never leave the
Keychain. It refuses a port that is
already serving, prints the ready `--wda-url` envelope, and runs until
Ctrl+C. They belong to the `exploration` toolset.

## Toolset focus

`VISTREA_CLI_TOOLSETS` selects which named command surfaces the CLI exposes,
keyed by the first command word: `workspace` (always on), `assets`
(`snapshot`, `events`, `object`, `pack`), `exploration` (`explore`, `graph`,
`screen`, `driver`), `knowledge` (`wiki`, `collection`), and `verification` (`design`, `issue`,
`tuning`, `validate`). Unset means every surface. A masked command group
disappears from `help` and fails closed as `unsupported` (exit 6) at dispatch;
an unknown set name is `invalid_argument` (exit 2) naming the valid sets.
Toolset names are configuration, not secrets. The masking is a composition
choice, not a security boundary — the Host's authentication remains the real
boundary. The repository's Claude Code plugin
(`integrations/claude-plugin/`) is the packaged `assets,exploration`
composition.
