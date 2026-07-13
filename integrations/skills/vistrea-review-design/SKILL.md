---
name: vistrea-review-design
description: Compare a persisted Runtime Snapshot against a registered design baseline and manage Review Issues through the authenticated Vistrea Host. Use when a user asks to register a design reference, map design regions onto live UI nodes, run a frame comparison, create or triage design Review Issues, or verify a fix against new runtime evidence.
---

# Review a design against Runtime evidence

Use the existing CLI operations as thin adapters. Never read SQLite,
construct Object Store paths, or perform pixel edits yourself.

## Choose the adapter

- Run the built CLI (`.build/typescript/integrations/cli/main.js`, build once
  with `pnpm build:host`) and consume its JSON envelope.
- Pass `VISTREA_HOST_URL` and `VISTREA_HOST_TOKEN` through a controlled process
  environment only.

Available operations:

| Intent | CLI |
|---|---|
| Store the baseline image | `design upload-asset --file <path> --media-type image/png` |
| Register the baseline | `design add-reference --json <command>` |
| Map a region to a node | `design map --json <command>` |
| Run the comparison | `design compare --reference <id> --snapshot <id>` (add `--pixel true` for mean-color region comparison against the design asset) |
| Create an issue | `issue create --json <command>` |
| Triage issues | `issue list` / `issue transition` |
| Verify a fix | `issue verify <id> --revision <n> --basis real_build --result passed --snapshot <id> --build <id>` |

## Workflow

1. Confirm Workspace readiness, then capture or locate the target Snapshot
   (see `vistrea-inspect-runtime`).
2. Upload the design asset and register the design reference with its canvas
   and pixel sizes; keep the returned `design_reference_id`.
3. Map each design region onto a runtime target using the node's `stable_id`
   whenever one exists; fall back to `node_id` only for unlabeled nodes.
4. Run the comparison against the persisted Snapshot and read its
   per-mapping frame deviations from the result.
5. Create one Review Issue per real deviation with exact `expected` and
   `actual` values from the comparison; never merge unrelated deviations.
6. Move issues only along the legal lifecycle:
   `open -> in_progress -> ready_for_verification -> resolved`, with
   `wont_fix` and reopen edges. Every transition needs the current revision.
7. Verification is atomic: `issue verify` records evidence and resolves in
   one step. Always verify against a fresh Snapshot from the fixed build.

## Failure and safety rules

- Comparisons read persisted evidence only; capture a new Snapshot first if
  the UI changed.
- A `conflict` on transition or verify means a stale revision: reload the
  issue and retry with the current revision, never force.
- Report deviations as observed measurements with units; keep design intent
  questions for the human reviewer.
- Never expose bearer tokens, Workspace paths, or raw storage details.
