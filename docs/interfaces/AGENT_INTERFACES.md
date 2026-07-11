# Agent-facing Interfaces

## 1. Principles

- CLI is the deterministic scriptable foundation.
- MCP exposes structured Engine operations as tools.
- Skills compose user goals into CLI, MCP, or local API workflows.
- Every adapter uses the same Engine use cases and error codes.
- Destructive or dangerous actions require explicit confirmation or policy authorization.
- Machine output is stable and separate from human presentation.

## 2. CLI shape

```text
vistrea <resource> <verb> [options]
```

Global options:

```text
--workspace <path-or-id>
--project <project-id>
--ref <ref-name>
--format text|json|ndjson
--request-id <id>
--trace-id <id>
--deadline <duration>
--non-interactive
```

Initial command families:

```text
vistrea workspace create|open|status|health|export|import|gc
vistrea device list|connect|disconnect|launch|terminate
vistrea snapshot capture|get|list|compare
vistrea node get|query
vistrea screen list|get|path|compare
vistrea explore run|status|pause|resume|cancel
vistrea design reference-add|compare|issue-create|issue-update
vistrea design tune-create|tune-apply|tune-revert|tune-export
vistrea verify run|status|findings|compare-builds
vistrea wiki get|search|backlinks|link|export
vistrea version commit|log|ref|get|diff|tag
vistrea sync status|fetch|pull|push|publish|subscribe
```

JSON output envelope:

```json
{
  "request_id": "request_...",
  "trace_id": "trace_...",
  "data": {},
  "warnings": [],
  "error": null
}
```

Exit codes:

| Exit | Meaning |
|---|---|
| `0` | Success |
| `2` | Invalid arguments |
| `3` | Not found |
| `4` | Conflict |
| `5` | Authentication or permission failure |
| `6` | Unsupported capability |
| `7` | Unavailable or timeout |
| `8` | Validation or policy blocked the operation |
| `9` | Integrity failure |
| `10` | Internal failure |

Long-running commands print or return an `operation_id`. `--wait` may stream NDJSON progress events.

## 3. Initial MCP tools

Tool names use the `vistrea_` prefix and map one-to-one to public Engine use cases where practical:

```text
vistrea_get_workspace_status
vistrea_list_devices
vistrea_connect_runtime
vistrea_capture_snapshot
vistrea_query_ui_nodes
vistrea_get_screen_graph
vistrea_find_path
vistrea_run_exploration
vistrea_get_operation
vistrea_compare_design
vistrea_create_review_issue
vistrea_create_tuning_patch
vistrea_apply_tuning_patch
vistrea_revert_tuning_application
vistrea_run_validation
vistrea_search_wiki
vistrea_compare_builds
vistrea_get_sync_status
vistrea_publish_ref
```

MCP resources may expose read-heavy stable content such as Workspace status, selected Screen State, protocol documentation, or operation logs. Mutations remain tools.

Synchronous tool responses return structured domain objects and common errors rather than CLI text. Asynchronous tools immediately return `OperationRef`; progress and the typed completion result use the generic operation APIs.

## 4. Initial Skills

### `vistrea-explore-ui`

1. inspect Workspace, device, runtime, and safety status;
2. establish SDK and automation sessions;
3. define bounded scope and risky-action policy;
4. run or resume exploration;
5. inspect discovered states and blocked actions;
6. atomically commit the Working Set and compare-and-set update the requested ref.

### `vistrea-review-design`

1. resolve Screen State, build, and design reference;
2. capture or load matching evidence;
3. run design comparison;
4. create structured Review Issues;
5. optionally publish a review ref.

### `vistrea-tune-ui`

1. verify protected tuning capability;
2. read source visual properties;
3. create and preview an allowlisted patch;
4. capture comparison evidence;
5. revert or retain the preview intentionally;
6. save and export a Tuning Patch.

### `vistrea-verify-change`

1. resolve source Git SHA and Vistrea baseline;
2. identify affected Screen States and paths;
3. capture or explore affected runtime states;
4. run validation and graph/build diff;
5. report evidence and update version history.

Do not create real `SKILL.md` packages until the referenced CLI/MCP operations exist.

## 5. Deep links

```text
vistrea://workspace/<workspace_id>
vistrea://project/<project_id>/screen/<screen_state_id>?ref=<ref>
vistrea://project/<project_id>/snapshot/<snapshot_id>
vistrea://project/<project_id>/issue/<issue_id>
vistrea://project/<project_id>/patch/<patch_id>
vistrea://project/<project_id>/commit/<commit_id>
vistrea://operation/<operation_id>
```

Links are stable resource locators. Studio resolves permissions, local availability, remote subscription, and selected version before opening content.

## 6. Confirmation and policy

Agent adapters must request confirmation before:

- dangerous device actions;
- applying tuning outside an approved internal environment;
- updating a shared ref;
- publishing sensitive artifacts;
- deleting retained objects;
- suppressing validation findings.

An organization policy may pre-authorize a bounded action, but the resulting audit context remains attached to the operation.

## 7. Parity tests

For each public Engine use case exposed through multiple adapters, contract tests verify equivalent input semantics, errors, operation IDs, and result objects across CLI and MCP.
