---
name: vistrea-verify-change
description: Validate persisted Runtime evidence with the core rule set, freeze a baseline graph version, and compare coverage between builds through the authenticated Vistrea Host. Use when a user asks to validate a Snapshot or the Screen Graph, run the CI quality gate, triage or suppress validation findings, diff what two builds actually exhibited, or gate a release on coverage regressions.
---

# Verify a change with validators and build diffs

Use the existing CLI or CI gate as thin adapters over the Host.

## Choose the adapter

- For pipelines, prefer the single-command CI gate:
  `node .build/typescript/integrations/ci/main.js [--fail-on error]` — one
  JSON report, exit code `1` when open findings reach the threshold.
- For interactive work, use the CLI operations below with
  `VISTREA_HOST_URL` and `VISTREA_HOST_TOKEN` in a controlled environment.

Available operations:

| Intent | CLI |
|---|---|
| Validate one Snapshot | `validate snapshot --snapshot <id>` (optionally `--disable-rules a,b` and `--min-touch-target <points>`; overrides persist into the run for audit) |
| Validate the Screen Graph | `validate graph --project <id> --application <id>` |
| Read a run | `validate get-run <id>` |
| Page findings | `validate findings [--statuses open]` |
| Suppress with a reason | `validate suppress <finding_id> --json <command>` |
| Freeze a baseline | `graph tag --project <id> --application <id> --tag <name>` |
| Diff two builds | `validate build-diff --project <id> --application <id> --left <build> --right <build>` (add `--baseline <tag>` to classify removals) |

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
6. A removal is only a regression against something. Tag the graph version a
   release is expected to preserve (`graph tag ... --tag v1.4`), then pass
   `--baseline v1.4` to the diff: each removal carries
   `extensions["vistrea.baseline"].classification`, which is `regression` when
   the baseline exhibited the screen and `expected` when it did not. Screens the
   baseline never had are intentional removals, not new breakage.
7. In CI, wire the gate's exit code directly; keep the JSON report as the
   pipeline artifact. `--baseline-tag <tag>` makes the gate fail on
   `regression` removals only, so an intentionally deleted screen does not
   block the pipeline.

## Failure and safety rules

- Validators judge persisted evidence; they never execute app actions.
- A missing Screen Graph or unknown build is an input problem — capture and
  observe first, do not fabricate coverage.
- An unknown baseline tag is an input problem too: freeze the baseline from a
  graph the team actually observed. Never re-tag a name to make a gate pass —
  the tag is the evidence the comparison rests on.
- Do not suppress findings to make a gate pass without recording who decided
  and why.
- Never expose bearer tokens, Workspace paths, or raw storage details.
