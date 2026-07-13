---
name: vistrea-record-assets
description: Capture and read canonical Runtime evidence through the Vistrea CLI — Snapshots with UI trees and screenshots, the persisted event timeline, content-addressed Objects, and portable packs. Use when a user asks to capture what an app is showing, inspect a persisted Snapshot, pull a screenshot or artifact, review runtime events, or move recorded evidence between Workspaces.
---

# Record and read Runtime assets

Every asset flows through the authenticated local Host into the Workspace:
Snapshots are canonical protocol documents, binary evidence (screenshots,
artifacts, packs) lives in the content-addressed Object Store, and events
persist as an ordered timeline. Nothing here executes device actions — capture
observes the connected Runtime and records what it saw.

Every command below is the strict JSON CLI, run from the repository root as
`node .build/typescript/integrations/cli/main.js <command>` with
`VISTREA_HOST_URL` and `VISTREA_HOST_TOKEN` in the environment (never argv).
Each invocation prints one JSON envelope on stdout; a non-zero exit code maps
the envelope's error code.

| Intent | Command |
|---|---|
| Check the Workspace and Runtime status | `workspace status` |
| Capture one canonical Snapshot | `snapshot capture [--reason <reason>]` |
| Page persisted Snapshots | `snapshot list [--limit n] [--cursor c]` |
| Read one Snapshot document | `snapshot get <snapshot_id>` |
| Read the persisted event timeline | `events list [--epoch <event_epoch_id>]` |
| Download an Object's bytes to a new local file | `object get --hash <sha256:...> --output <path>` |
| Export refs and commits as a portable pack | `pack export --json <command>` |
| Import a pack into this Workspace | `pack import --file <path>` |

## Workflow

1. Check `workspace status` first; capture needs `runtime_connected: true`,
   while reading already-persisted assets does not.
2. Capture with an explicit `--reason` (`manual`, `before_action`,
   `after_action`, `review`) so the evidence explains why it exists.
   Structured nodes locate and reason; the screenshot remains the final
   visual authority.
3. Read Snapshots by id, and honor their `capture_limitations`: a limitation
   is the capture telling you what it could not see. Never treat a limited
   tree as complete.
4. Screenshot and artifact bytes never travel through JSON envelopes. Resolve
   the Object hash from the Snapshot document, then `object get` with an
   `--output` path naming a new file; the download is digest-proved.
5. Use the event timeline for transient states (toasts, banners) that no
   single Snapshot preserves; events carry epochs and sequence numbers, so
   report them in persisted order.
6. Move evidence between Workspaces only through packs: export produces one
   content-addressed pack Object, import verifies every byte against its
   digest and reports ref conflicts instead of overwriting.

## Boundaries

- Runtime output belongs to the Workspace (`.vistrea/`); never commit it to a
  repository.
- Snapshots are immutable evidence. Correcting a wrong capture means capturing
  again, not editing what was recorded.
- `object get` refuses to overwrite: `--output` must name a new writable
  file, so an existing artifact is never silently replaced.
- Report exactly what was persisted — ids, digests, counts — and distinguish
  "captured now" from "already existed" (`created: false` on repeats).
- Never expose bearer tokens, Workspace paths, or raw storage details.
