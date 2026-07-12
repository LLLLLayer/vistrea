# Vistrea MCP Server

This module is a runnable Model Context Protocol stdio server built with the official `@modelcontextprotocol/sdk`. Every tool is a thin adapter over the same strict Host Local API client as the CLI. The server does not import Data, SQLite, Object Store, Runtime transport, or Workspace path implementations.

## Tools

| Tool | Engine operation | Behavior |
|---|---|---|
| `vistrea_get_workspace_status` | `GetWorkspaceStatus` | Read current Host/Workspace status |
| `vistrea_capture_snapshot` | `CaptureSnapshot` | Capture and persist a canonical Runtime Snapshot |
| `vistrea_list_snapshots` | `ListSnapshots` | Page persisted Snapshot summaries |
| `vistrea_get_snapshot` | `GetSnapshot` | Load a canonical Runtime Snapshot |
| `vistrea_get_event_timeline` | `GetEventTimeline` | Read the persisted Runtime event timeline with gap evidence |
| `vistrea_upload_design_asset` | `AddDesignAsset` | Store one design asset in the content-addressed Object Store |
| `vistrea_add_design_reference` | `AddDesignReference` | Register a design baseline over a stored asset |
| `vistrea_get_design_reference` | `GetDesignReference` | Load one design reference |
| `vistrea_map_design_region` | `MapDesignRegion` | Map a design region onto a Runtime node target |
| `vistrea_run_design_comparison` | `RunDesignComparison` | Compare confirmed mappings against a persisted Snapshot |
| `vistrea_get_design_comparison` | `GetDesignComparison` | Load one persisted comparison |
| `vistrea_create_review_issue` | `CreateReviewIssue` | Create a Review Issue |
| `vistrea_list_review_issues` | `ListReviewIssues` | Page Review Issues by state or reference |
| `vistrea_get_review_issue` | `GetReviewIssue` | Load one Review Issue |
| `vistrea_transition_review_issue` | `TransitionReviewIssue` | Apply one legal Review Issue state transition |
| `vistrea_verify_review_issue` | `VerifyReviewIssue` | Atomically record verification evidence and resolve |
| `vistrea_create_tuning_patch` | `CreateTuningPatch` | Persist an allowlisted Tuning Patch description |
| `vistrea_get_tuning_patch` | `GetTuningPatch` | Load one Tuning Patch |
| `vistrea_apply_tuning_patch` | `ApplyTuningPatch` | Apply a reversible preview over the live Runtime connection |
| `vistrea_revert_tuning_application` | `RevertTuningApplication` | Revert one active tuning preview |
| `vistrea_get_tuning_application` | `GetTuningApplication` | Load one Tuning Application |
| `vistrea_list_active_tuning` | `ListActiveTuning` | List active previews on the current connection |
| `vistrea_observe_screen_state` | `RecordStateObservation` | Record a persisted Snapshot as a deduplicated Screen State observation |
| `vistrea_observe_transition` | `RecordTransitionObservation` | Record one executed action as a deduplicated Transition |
| `vistrea_get_screen_graph` | `GetScreenGraph` | Read the materialized Screen Graph for a project and application |
| `vistrea_find_screen_path` | `FindScreenPath` | Find acyclic transition paths between two Screen States |
| `vistrea_create_wiki_node` | `CreateWikiNode` | Create one Deep Wiki knowledge node |
| `vistrea_update_wiki_node` | `UpdateWikiNode` | Revise one Deep Wiki node with optimistic concurrency |
| `vistrea_get_wiki_node` | `GetWikiNode` | Load one Deep Wiki node |
| `vistrea_search_wiki` | `ListWikiNodes` | Search Deep Wiki nodes by text, kind, label, and status |
| `vistrea_link_wiki_node` | `LinkWikiNode` | Link a node to another node or workspace resource |
| `vistrea_unlink_wiki_node` | `UnlinkWikiNode` | Remove one Deep Wiki link |
| `vistrea_get_wiki_backlinks` | `GetWikiBacklinks` | List links pointing at one node |
| `vistrea_related_wiki_nodes` | `GetRelatedWikiNodes` | List nodes related to one workspace resource |
| `vistrea_validate_snapshot` | `ValidateSnapshot` | Run the core structural/accessibility/visual validators over one Snapshot |
| `vistrea_validate_screen_graph` | `ValidateScreenGraph` | Run behavioral reachability validators over the Screen Graph |
| `vistrea_get_validation_run` | `GetValidationRun` | Load one Validation Run with finding counts |
| `vistrea_list_validation_findings` | `ListValidationFindings` | Page Findings by run, status, and severity |
| `vistrea_get_validation_finding` | `GetValidationFinding` | Load one Finding with evidence |
| `vistrea_suppress_validation_finding` | `SuppressValidationFinding` | Suppress one open Finding with a justified reason |
| `vistrea_compare_builds` | `CompareBuilds` | Diff observed coverage between two builds |
| `vistrea_get_build_diff` | `GetBuildDiff` | Load one persisted Build Diff |

Successful synchronous tools return the domain result in `structuredContent` and as JSON text. Errors set `isError: true` and return `{ request_id, trace_id, error: { code, message, retryable } }` without exposing headers, configuration, fetch URLs, or credentials.

## Run locally

```bash
pnpm build:host
export VISTREA_HOST_URL=http://127.0.0.1:43123
# Provision VISTREA_HOST_TOKEN through the MCP client's protected environment map.
node .build/typescript/integrations/mcp/main.js
```

Configure an MCP client with that command and pass `VISTREA_HOST_URL` plus `VISTREA_HOST_TOKEN` in its controlled environment map. The token is intentionally not a tool argument or command-line option. Stdout is reserved exclusively for MCP JSON-RPC framing; startup failures write only one generic line to stderr.

`vistrea_list_snapshots` and `vistrea_get_snapshot` expose the currently implemented read operations for Phase 0B parity even though their MCP names were not yet reserved in the draft Operation Catalog. Capture currently returns the Host endpoint's canonical `RuntimeSnapshot` synchronously; it must migrate to the catalog's `OperationRef` lifecycle when that Engine capability exists.
