---
name: vistrea-explore-ui
description: Drive bounded deterministic exploration of the connected application through the authenticated Vistrea Host and read the resulting Screen Graph. Use when a user asks to explore an app's screens automatically, map reachable states and transitions, or grow the Screen Graph with real device actions.
---

# Explore the running application

Exploration executes real device actions (adb or WebDriverAgent) against the
connected Runtime, deduplicates every observed screen into the persistent
Screen Graph, and records the walk as one auditable Operation. It requires a
Host started with a configured automation provider
(`--automation adb --automation-serial <serial>` or
`--automation wda --wda-url <loopback-url>`); without one the operations fail
closed as `unsupported`.

Available operations:

| Intent | CLI | MCP |
|---|---|---|
| Start a bounded walk | `explore run --max-actions <n> [--max-depth <n>] [--settle <ms>] [--exclude id1,id2]` | `vistrea_run_exploration` |
| Poll progress and the report | `explore get <operation_id>` | `vistrea_get_exploration_operation` |
| Cancel the running walk | `explore cancel <operation_id>` | `vistrea_cancel_exploration` |
| Read the materialized graph | `graph show --project <id> --application <id>` | `vistrea_get_screen_graph` |
| Resolve one state | `graph get-state <screen_state_id>` | `vistrea_get_screen_state` |
| Find a path between states | `graph find-path --from <id> --to <id>` | `vistrea_find_screen_path` |

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

## Boundaries

- One Host drives at most one exploration at a time; a second start reports
  `conflict` with the active operation id.
- Exploration only taps nodes the captured tree declares tappable and never
  generates dangerous or forbidden actions.
- Report results from the persisted Operation and graph, never from your own
  bookkeeping; the workspace is the single source of truth.
