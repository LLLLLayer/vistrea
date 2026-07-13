---
name: vistrea-explore-ui
description: Drive bounded deterministic exploration of the connected application through the Vistrea MCP tools, read the resulting Screen Graph, and curate the Screen State identity it inferred. Use when a user asks to explore an app's screens automatically, map reachable states and transitions, grow the Screen Graph with real device actions, or fix a screen the graph wrongly split into two or wrongly collapsed into one.
---

# Explore the running application

Exploration executes real device actions (adb or WebDriverAgent) against the
connected Runtime, deduplicates every observed screen into the persistent
Screen Graph, and records the walk as one auditable Operation. It requires a
Vistrea Host started with a configured automation provider
(`--automation adb --automation-serial <serial>` or
`--automation wda --wda-url <loopback-url>`); without one the operations fail
closed as `unsupported`. The application under exploration must embed the
Vistrea Runtime SDK (Debug or internal builds only) and have an active Runtime
connection — exploration is snapshot-driven, and without the SDK the first
capture fails as `unavailable`.

Available MCP tools:

| Intent | Tool |
|---|---|
| Check the Runtime is connected | `vistrea_get_workspace_status` |
| Start a bounded walk | `vistrea_run_exploration` |
| Poll progress and the report | `vistrea_get_exploration_operation` |
| Cancel the running walk | `vistrea_cancel_exploration` |
| Read the materialized graph | `vistrea_get_screen_graph` |
| Resolve one state | `vistrea_get_screen_state` |
| Find a path between states | `vistrea_find_screen_path` |
| Freeze the graph as a named version | `vistrea_tag_graph_version` |
| Merge states that are one screen | `vistrea_merge_screen_states` |
| Split one state into two screens | `vistrea_split_screen_state` |

## Workflow

1. Confirm the Runtime is connected (`vistrea_get_workspace_status` reports
   `runtime_connected: true`) and capture one Snapshot to anchor the walk.
2. Start the run with an explicit action budget (`maximum_actions`). Exclude
   stable IDs that are not application frontier: Vistrea's in-app Inspector
   launcher and platform navigation chrome such as UIKit's `BackButton`.
3. Poll the Operation until its state leaves `running`. Progress events report
   each executed tap or back step; the succeeded result is the inline
   `ExplorationReport` with discovered states, steps, and the stop reason.
4. Read the Screen Graph for the walked project and application; repeated runs
   create nothing new and only accumulate occurrence evidence.
5. Cancellation is honest: cancel stops before the next action, the Operation
   terminates as `cancelled`, and observations already recorded stay in the
   graph.
6. Structural identity is a judgment, and it can be wrong. When one screen
   appears as two states because its content differed (a populated list versus
   an empty one), merge them: the survivor absorbs the observations and aliases
   the absorbed structures, so future captures of either deduplicate into it.
   When two genuinely different screens collapsed into one state, split the
   observations that belong to the other screen out of it.
7. When a walk completes a coverage milestone, freeze it with
   `vistrea_tag_graph_version` so later comparisons have a fixed reference.

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
- Both curation tools take `expected_graph_revision`, the graph revision the
  decision was made against. Pass the revision you actually read; a mismatch is
  a real conflict, so re-read the graph and re-judge instead of retrying with a
  fresh number.
- Never expose bearer tokens, Workspace paths, or raw storage details.
