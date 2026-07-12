---
name: vistrea-verify-change
description: Validate persisted Runtime evidence with the core rule set and compare coverage between builds through the authenticated Vistrea Host. Use when a user asks to validate a Snapshot or the Screen Graph, run the CI quality gate, triage or suppress validation findings, or diff what two builds actually exhibited.
---

# Verify a change with validators and build diffs

Use the existing CLI, MCP, or CI gate as thin adapters over the Host.

## Choose the adapter

- For pipelines, prefer the single-command CI gate:
  `node .build/typescript/integrations/ci/main.js [--fail-on error]` — one
  JSON report, exit code `1` when open findings reach the threshold.
- For interactive work, use the CLI or MCP operations below with
  `VISTREA_HOST_URL` and `VISTREA_HOST_TOKEN` in a controlled environment.

Available operations:

| Intent | CLI | MCP |
|---|---|---|
| Validate one Snapshot | `validate snapshot --snapshot <id>` (optionally `--disable-rules a,b` and `--min-touch-target <points>`; overrides persist into the run for audit) | `vistrea_validate_snapshot` |
| Validate the Screen Graph | `validate graph --project <id> --application <id>` | `vistrea_validate_screen_graph` |
| Read a run | `validate get-run <id>` | `vistrea_get_validation_run` |
| Page findings | `validate findings [--statuses open]` | `vistrea_list_validation_findings` |
| Suppress with a reason | `validate suppress <finding_id> --json <command>` | `vistrea_suppress_validation_finding` |
| Diff two builds | `validate build-diff --project <id> --application <id> --left <build> --right <build>` | `vistrea_compare_builds` |

## Workflow

1. Validate the newest Snapshot of the change; the run persists with exact
   finding counts and every finding carries measurement evidence.
2. When exploration has populated the Screen Graph, also validate the graph
   for unreachable and dead-end states.
3. Report findings grouped by rule with severity and the measured
   expected/actual values; distinguish `open` from `suppressed`.
4. Suppress only with the user's explicit judgment, a reason code, and a
   justification; suppression is revisioned and auditable, not deletion.
5. For release comparisons, run the build diff between the previous and the
   new build; `removed` entries are screens or transitions the new build no
   longer exhibited and deserve attention first.
6. In CI, wire the gate's exit code directly; keep the JSON report as the
   pipeline artifact.

## Failure and safety rules

- Validators judge persisted evidence; they never execute app actions.
- A missing Screen Graph or unknown build is an input problem — capture and
  observe first, do not fabricate coverage.
- Do not suppress findings to make a gate pass without recording who decided
  and why.
- Never expose bearer tokens, Workspace paths, or raw storage details.
