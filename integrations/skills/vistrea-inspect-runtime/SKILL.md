---
name: vistrea-inspect-runtime
description: Capture and inspect canonical Vistrea Runtime UI evidence through the authenticated Host. Use when a user asks to inspect the current native app screen, capture a Runtime Snapshot or screenshot, examine the View Tree and stable node IDs, retrieve a persisted Snapshot, or give a Coding Agent concrete current-screen context without performing user actions.
---

# Inspect Vistrea Runtime UI

Use the existing CLI operations as thin adapters. Never read SQLite,
construct Object Store paths, define a private Snapshot model, or invoke app
business methods.

## Choose the adapter

- Run the built CLI from the repository root and consume its JSON envelope.
- If `.build/typescript/integrations/cli/main.js` is absent, run
  `pnpm build:host` once.
- Pass `VISTREA_HOST_URL` and `VISTREA_HOST_TOKEN` through a controlled process
  environment. Never put a token in argv, chat, logs, shell tracing, or output.

Available operations:

| Intent | CLI |
|---|---|
| Check readiness | `workspace status --format json` |
| Capture evidence | `snapshot capture --format json` |
| List captures | `snapshot list --format json` |
| Load one capture | `snapshot get <snapshot_id> --format json` |

## Workflow

1. Read Workspace status first.
2. Require `status` to be `ready`. If `runtime_connected` is false, report that
   an authorized Debug/Internal app must connect; do not attempt or invent a
   capture.
3. Capture with screenshot `reference` unless the user explicitly requests
   structure-only evidence. Keep the default reason `manual` unless the user
   provides a supported reason.
4. Treat the returned envelope `data` as the canonical Runtime Snapshot. Preserve its `snapshot_id` for every follow-up.
5. Inspect, as relevant:
   - `extensions.vistrea.scenario_id` and Runtime Context;
   - View/Semantic Tree nodes, `stable_id`, role, state, accessibility, actions,
     and geometry;
   - screenshot Object reference and capture timing;
   - capabilities and `capture_limitations`.
6. Use `snapshot get` for a later exact read. Do not substitute the latest list
   item when the user supplied a Snapshot ID.
7. Report observed facts separately from inferences and limitations. Include
   the Snapshot ID so Studio and another Agent can open the same evidence.

## Failure and safety rules

- A capture observes state only. Use WDA, UIAutomator, or a future Automation
  operation for real navigation and input.
- Do not claim exploration, design comparison, tuning, node query, or
  validation support; those operations are not implemented by this Skill.
- On `unavailable`, `timeout`, `cancelled`, or integrity errors, return the
  stable error code and safe remediation. Never fabricate a Snapshot.
- Never expose bearer tokens, Runtime authorization tokens, physical Workspace
  paths, Object Store paths, or raw SQLite details.
