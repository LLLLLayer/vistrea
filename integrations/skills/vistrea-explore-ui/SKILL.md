---
name: vistrea-explore-ui
description: Drive bounded deterministic exploration of the connected application through the authenticated Vistrea Host, read the resulting Screen Graph, and curate the Screen State identity it inferred. Use when a user asks to explore an app's screens automatically, map reachable states and transitions, grow the Screen Graph with real device actions, or fix a screen the graph wrongly split into two or wrongly collapsed into one.
---

# Explore the running application

Exploration executes real device actions (adb or WebDriverAgent) against the
connected Runtime, deduplicates every observed screen into the persistent
Screen Graph, and records the walk as one auditable Operation. It requires a
Host started with a configured automation provider
(`--automation adb --automation-serial <serial>` or
`--automation wda --wda-url <loopback-url>`); without one the operations fail
closed as `unsupported`. `pnpm wda up` (from the repository root) boots a
pinned WebDriverAgent and prints the ready `--wda-url`.

Available operations:

| Intent | CLI |
|---|---|
| Start a bounded walk | `explore run --max-actions <n> [--max-depth <n>] [--settle <ms>] [--exclude id1,id2]` |
| Poll progress and the report | `explore get <operation_id>` |
| Cancel the running walk | `explore cancel <operation_id>` |
| Read the materialized graph | `graph show --project <id> --application <id>` |
| Resolve one state | `graph get-state <screen_state_id>` |
| Find a path between states | `graph find-path --from <id> --to <id>` |
| Merge states that are one screen | `screen merge --project <id> --application <id> --states a,b [--into <state_id>] --revision <n> --actor <id> [--justification <text>]` |
| Split one state into two screens | `screen split --project <id> --application <id> --state <id> --observations a,b [--title <text>] --revision <n> --actor <id> [--justification <text>]` |

## Workflow

1. Confirm the Runtime is connected (`workspace status` reports
   `runtime_connected: true`) and capture one Snapshot to anchor the walk.
2. Start the run with an explicit action budget. Exclude stable IDs that are
   not application frontier: Vistrea's in-app Inspector launcher and platform
   navigation chrome such as UIKit's `BackButton`.
3. Poll the Operation until its state leaves `running`. Progress events
   report each executed tap or back step; the succeeded result is the inline
   `ExplorationReport` with discovered states, steps, and the stop reason.
4. Read the Screen Graph for the walked project and application; repeated
   runs create nothing new and only accumulate occurrence evidence.
5. Cancellation is honest: `explore cancel` stops before the next action,
   the Operation terminates as `cancelled`, and observations already
   recorded stay in the graph.
6. Structural identity is a judgment, and it can be wrong. When one screen
   appears as two states because its content differed (a populated list versus
   an empty one), merge them: the survivor absorbs the observations and aliases
   the absorbed structures, so future captures of either deduplicate into it.
   When two genuinely different screens collapsed into one state, split the
   observations that belong to the other screen out of it.
7. Curation is auditable and reversible. Every merge and split records an
   actor, an optional justification, and a decision on the graph; splitting a
   wrongly merged structure gives that structure its own identity back.

## Boundaries

- One Host drives at most one exploration at a time; a second start reports
  `conflict` with the active operation id.
- Exploration only taps nodes the captured tree declares tappable and never
  generates dangerous or forbidden actions.
- Report results from the persisted Operation and graph, never from your own
  bookkeeping; the workspace is the single source of truth.
- Curation moves what a screen *means*, never the evidence. Observations are
  immutable: a merge re-points identity, it does not rewrite what a device was
  seen to do.
- Both curation commands take `--revision`, the graph revision the decision was
  made against. Pass the revision you actually read; a mismatch is a real
  conflict, so re-read the graph and re-judge instead of retrying with a fresh
  number.
