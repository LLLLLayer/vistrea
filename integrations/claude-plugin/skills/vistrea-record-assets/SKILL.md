---
name: vistrea-record-assets
description: Capture and read canonical Runtime evidence through the Vistrea MCP tools — Snapshots with UI trees and screenshots, the persisted event timeline, content-addressed Objects, and portable packs. Use when a user asks to capture what an app is showing, inspect a persisted Snapshot, pull a screenshot or artifact, review runtime events, or move recorded evidence between Workspaces.
---

# Record and read Runtime assets

Every asset flows through the authenticated local Host into the Workspace:
Snapshots are canonical protocol documents, binary evidence (screenshots,
artifacts, packs) lives in the content-addressed Object Store, and events
persist as an ordered timeline. Nothing here executes device actions — capture
observes the connected Runtime and records what it saw.

Available MCP tools:

| Intent | Tool |
|---|---|
| Check the Workspace and Runtime status | `vistrea_get_workspace_status` |
| Capture one canonical Snapshot | `vistrea_capture_snapshot` |
| Page persisted Snapshots | `vistrea_list_snapshots` |
| Read one Snapshot document | `vistrea_get_snapshot` |
| Read the persisted event timeline | `vistrea_get_event_timeline` |
| Download an Object's bytes to a new local file | `vistrea_get_object` |
| Export refs and commits as a portable pack | `vistrea_export_pack` |
| Import a pack into this Workspace | `vistrea_import_pack` |

## Workflow

1. Check `vistrea_get_workspace_status` first; capture needs
   `runtime_connected: true`, while reading already-persisted assets does not.
2. Capture with an explicit `reason` (`manual`, `before_action`,
   `after_action`, `review`) so the evidence explains why it exists. Request
   `screenshot: "reference"` when visual truth matters — structured nodes
   locate and reason, the screenshot remains the final visual authority.
3. Read Snapshots by id, and honor their `capture_limitations`: a limitation
   is the capture telling you what it could not see. Never treat a limited
   tree as complete.
4. Screenshot and artifact bytes never travel through tool results. Resolve
   the Object hash from the Snapshot document, then `vistrea_get_object` with
   an absolute `output_path` naming a new file; the download is digest-proved.
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
- `vistrea_get_object` refuses to overwrite: `output_path` must name a new
  writable file, so an existing artifact is never silently replaced.
- Report exactly what was persisted — ids, digests, counts — and distinguish
  "captured now" from "already existed" (`created: false` on repeats).
- Never expose bearer tokens, Workspace paths, or raw storage details.
