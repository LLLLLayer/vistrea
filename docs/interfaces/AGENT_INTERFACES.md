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

The implemented command surface — Workspace status, Snapshot capture and inspection, Runtime events, design review, tuning, the Screen Graph, the Deep Wiki, validation, build diffs, and portable packs — is maintained command-for-command in `integrations/cli/README.md`. Reserved future command families follow the same `<resource> <verb>` shape:

```text
vistrea workspace create|open|health|gc
vistrea device list|connect|disconnect|launch|terminate
vistrea node get|query
vistrea explore run|status|pause|resume|cancel
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

## 3. MCP tools

Tool names use the `vistrea_` prefix and map one-to-one to implemented Host operations. The stdio server in `integrations/mcp/server.ts` exposes 53 tools covering Workspace status, Snapshot capture and inspection, the Runtime event timeline, design review, reversible tuning, Screen Graph observations, states, and paths, Deep Wiki nodes and links, validation runs and findings, build diffs, portable pack exchange, object downloads, and exploration Operations. The authoritative name-for-name tool table lives in `integrations/mcp/README.md` and matches the server code exactly.

Future tools for reserved operations (device connection, exploration sessions, generic operations, and sync) keep the same `vistrea_` naming convention and are reserved in `docs/interfaces/OPERATION_CATALOG.md`.

MCP resources may expose read-heavy stable content such as Workspace status, selected Screen State, protocol documentation, or operation logs. Mutations remain tools.

Synchronous tool responses return structured domain objects and common errors rather than CLI text. Asynchronous tools immediately return `OperationRef`; progress and the typed completion result use the generic operation APIs.

## 4. Skills

Five Skills ship as real packages under `integrations/skills/`, each composing only implemented CLI and MCP operations:

- `vistrea-inspect-runtime`: check Runtime readiness, capture canonical UI evidence, and inspect or retrieve the same persisted Snapshot;
- `vistrea-review-design`: register a design baseline, map regions, run comparisons, and manage the Review Issue lifecycle;
- `vistrea-tune-ui`: apply and revert allowlisted visual previews on the live Runtime;
- `vistrea-verify-change`: run the core validators and CI gate, triage findings, and diff observed coverage between builds;
- `vistrea-explore-ui`: drive bounded deterministic exploration through the Host's exploration Operations and read the resulting Screen Graph.

### Exploration workflow (reference)

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

Do not create additional real `SKILL.md` packages until the referenced CLI/MCP operations exist.

## 5. CI gate

`integrations/ci/` provides a headless gate over the same authenticated Host Local API client:

```text
node .build/typescript/integrations/ci/main.js \
  [--snapshot <snapshot_id>] \
  [--project <project_id> --application <application_id>] \
  [--left-build <build_id> --right-build <build_id>] \
  [--fail-on info|warning|error|critical]
```

The gate validates the newest (or one named) Snapshot with the core rule set, optionally validates the Screen Graph and diffs two builds, and emits exactly one machine-readable JSON report on stdout.

| Exit | Meaning |
|---|---|
| `0` | Gate passed |
| `1` | Open findings at or above `--fail-on` (default `error`) |
| `2` | Usage error |
| `3` | The Host was unavailable or an operation failed |

## 6. Deep links

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

## 7. Confirmation and policy

Agent adapters must request confirmation before:

- dangerous device actions;
- applying tuning outside an approved internal environment;
- updating a shared ref;
- publishing sensitive artifacts;
- deleting retained objects;
- suppressing validation findings.

An organization policy may pre-authorize a bounded action, but the resulting audit context remains attached to the operation.

## 8. Parity tests

For each public Engine use case exposed through multiple adapters, contract tests verify equivalent input semantics, errors, operation IDs, and result objects across CLI and MCP.
