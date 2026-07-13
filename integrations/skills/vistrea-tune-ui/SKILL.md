---
name: vistrea-tune-ui
description: Apply reversible, allowlisted visual tuning previews on the live connected Runtime through the authenticated Vistrea Host. Use when a user asks to preview a visual property change on the running app, create or apply a Tuning Patch, revert an active preview, or check which previews are active.
---

# Tune UI reversibly on the live Runtime

Use the existing CLI operations as thin adapters. Tuning never calls
application business methods and only touches the allowlisted properties the
Runtime accepts (currently `alpha`).

## Choose the adapter

- Run the built CLI (`.build/typescript/integrations/cli/main.js`) and
  consume its JSON envelope.
- Pass `VISTREA_HOST_URL` and `VISTREA_HOST_TOKEN` through a controlled process
  environment only.

Available operations:

| Intent | CLI |
|---|---|
| Describe the change | `tuning create-patch --json <command>` |
| Apply as a preview | `tuning apply --patch <patch_id> [--ttl <ms>]` |
| Revert precisely | `tuning revert <tuning_application_id>` |
| Inspect one preview | `tuning get-application <id>` |
| List active previews | `tuning list-active` |

## Workflow

1. Capture a fresh Snapshot first; a Tuning Patch targets exact nodes and
   `original_value`s from that Snapshot, and the Runtime rejects stale
   Snapshots (`stale_snapshot`).
2. Create the patch with one change per node property: `runtime_target` (use
   `stable_id`), `original_value`, and `preview_value` as canonical property
   values with units.
3. Apply the patch. Read the returned Tuning Application: `applied_changes`
   and `rejected_changes` partition the patch exactly; a partial failure
   restores everything (`policy_blocked`) rather than leaving a mixed state.
4. Prefer a `--ttl` for demonstrations: the Runtime reverts itself and
   reports the terminal application when the TTL expires.
5. Revert explicitly when the user is done. Disconnects always restore
   originals; never rely on a preview surviving.
6. After the source code is fixed, verify through the design review flow
   against a new build instead of keeping tuning previews alive.

## Failure and safety rules

- `unavailable` means no authorized Runtime is connected; report it, never
  simulate an application result.
- Rejections are explicit (`stale_snapshot`, `property_not_allowed`,
  `target_not_found`, `unsupported_value`, `original_value_mismatch`,
  `policy_blocked`); surface the reason codes verbatim.
- A tuning preview is never source-code truth. State clearly that previews
  are reversible runtime overrides.
- Never expose bearer tokens, Workspace paths, or raw storage details.
