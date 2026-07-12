import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  HostClientError,
  HostLocalApiClient,
  createCorrelationId,
  isHostClientError,
  type ImplementedHostOperation,
  type JsonObject,
} from "../shared/index.js";

export const VISTREA_MCP_TOOLS = [
  {
    name: "vistrea_get_workspace_status",
    title: "Get Vistrea Workspace Status",
    description: "Read the current local Workspace and Runtime adapter status.",
    inputSchema: emptyInputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_capture_snapshot",
    title: "Capture Runtime Snapshot",
    description: "Capture and persist one canonical Runtime Snapshot through the Host Engine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        include: {
          type: "object",
          additionalProperties: false,
          required: ["paths"],
          properties: {
            paths: {
              type: "array",
              maxItems: 64,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
        },
        screenshot: { type: "string", enum: ["none", "reference"] },
        reason: {
          type: "string",
          enum: ["manual", "before_action", "after_action", "review", "validation"],
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_list_snapshots",
    title: "List Runtime Snapshots",
    description: "List persisted Runtime Snapshot summaries from the active Workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_get_snapshot",
    title: "Get Runtime Snapshot",
    description: "Load one canonical Runtime Snapshot by opaque Snapshot ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_id"],
      properties: {
        snapshot_id: {
          type: "string",
          minLength: 45,
          maxLength: 45,
          pattern:
            "^snapshot_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_get_event_timeline",
    title: "Get Runtime Event Timeline",
    description:
      "Read the persisted Runtime event timeline, including reported gap evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        event_epoch_id: {
          type: "string",
          maxLength: 128,
          pattern:
            "^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        },
        kinds: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        },
        first_sequence: { type: "integer", minimum: 0 },
        last_sequence: { type: "integer", minimum: 0 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_upload_design_asset",
    title: "Upload Design Asset",
    description: "Store one design artifact payload in the content-addressed Object Store.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["asset_base64", "media_type"],
      properties: {
        asset_base64: { type: "string", minLength: 4, maxLength: 8_388_608 },
        media_type: { type: "string", pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$" },
        logical_name: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_add_design_reference",
    title: "Add Design Reference",
    description: "Register a design baseline over a stored asset for runtime comparison.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind", "canvas_size", "pixel_size", "asset_hash", "created_by"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 256 },
        kind: { type: "string", enum: ["design_artifact", "approved_build"] },
        canvas_size: { type: "object" },
        pixel_size: { type: "object" },
        asset_hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        created_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_design_reference",
    title: "Get Design Reference",
    description: "Load one design reference by ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["design_reference_id"],
      properties: { design_reference_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_map_design_region",
    title: "Map Design Region",
    description: "Bind one design-region rectangle to a runtime UI node target.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["design_reference_id", "design_region", "runtime_target", "created_by"],
      properties: {
        design_reference_id: { type: "string", maxLength: 128 },
        design_region: { type: "object" },
        runtime_target: { type: "object" },
        created_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_run_design_comparison",
    title: "Run Design Comparison",
    description: "Compare confirmed design mappings against one captured Snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["design_reference_id", "target_snapshot_id", "completed_by"],
      properties: {
        design_reference_id: { type: "string", maxLength: 128 },
        target_snapshot_id: { type: "string", maxLength: 128 },
        completed_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_design_comparison",
    title: "Get Design Comparison",
    description: "Load one immutable design comparison by ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["comparison_id"],
      properties: { comparison_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_create_review_issue",
    title: "Create Review Issue",
    description: "Open one Review Issue with expected and actual design values.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "design_reference_id",
        "runtime_target",
        "title",
        "category",
        "severity",
        "expected",
        "actual",
        "created_by",
      ],
      properties: {
        design_reference_id: { type: "string", maxLength: 128 },
        mapping_id: { type: "string", maxLength: 128 },
        comparison_id: { type: "string", maxLength: 128 },
        runtime_target: { type: "object" },
        title: { type: "string", minLength: 1, maxLength: 512 },
        description: { type: "string", maxLength: 8192 },
        category: { type: "string", maxLength: 32 },
        severity: { type: "string", enum: ["info", "minor", "major", "critical"] },
        expected: { type: "object" },
        actual: { type: "object" },
        created_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_list_review_issues",
    title: "List Review Issues",
    description: "List Review Issues filtered by state or design reference.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        states: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z_]{1,32}$" },
        },
        design_reference_id: { type: "string", maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_get_review_issue",
    title: "Get Review Issue",
    description: "Load one Review Issue with its full state history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue_id"],
      properties: { issue_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_transition_review_issue",
    title: "Transition Review Issue",
    description: "Move one Review Issue through its legal lifecycle states.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue_id", "expected_revision", "to_state", "changed_by"],
      properties: {
        issue_id: { type: "string", maxLength: 128 },
        expected_revision: { type: "integer", minimum: 1 },
        to_state: {
          type: "string",
          enum: ["open", "in_progress", "ready_for_verification", "resolved", "wont_fix"],
        },
        reason: { type: "string", minLength: 1, maxLength: 4096 },
        changed_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_verify_review_issue",
    title: "Verify Review Issue",
    description:
      "Record immutable verification evidence and resolve or reopen the issue atomically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "issue_id",
        "expected_revision",
        "basis",
        "result",
        "verified_snapshot_id",
        "verified_build_id",
        "verified_by",
      ],
      properties: {
        issue_id: { type: "string", maxLength: 128 },
        expected_revision: { type: "integer", minimum: 1 },
        basis: { type: "string", enum: ["real_build", "runtime_preview"] },
        result: { type: "string", enum: ["passed", "failed", "inconclusive"] },
        verified_snapshot_id: { type: "string", maxLength: 128 },
        verified_build_id: { type: "string", maxLength: 128 },
        rationale: { type: "string", minLength: 1, maxLength: 4096 },
        verified_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_create_tuning_patch",
    title: "Create Tuning Patch",
    description: "Persist one reversible allowlisted visual-property patch description.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "target_snapshot_id", "changes", "created_by"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 512 },
        description: { type: "string", maxLength: 8192 },
        target_snapshot_id: { type: "string", maxLength: 128 },
        issue_ids: { type: "array", maxItems: 32, items: { type: "string", maxLength: 128 } },
        changes: { type: "array", minItems: 1, maxItems: 32, items: { type: "object" } },
        status: { type: "string", enum: ["draft", "approved"] },
        created_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_tuning_patch",
    title: "Get Tuning Patch",
    description: "Load one Tuning Patch description by ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["patch_id"],
      properties: { patch_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_apply_tuning_patch",
    title: "Apply Tuning Patch",
    description:
      "Apply one patch as a reversible preview over the live authenticated Runtime connection.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["patch_id"],
      properties: {
        patch_id: { type: "string", maxLength: 128 },
        preview_ttl_ms: { type: "integer", minimum: 100, maximum: 3_600_000 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_revert_tuning_application",
    title: "Revert Tuning Application",
    description: "Precisely revert one active runtime tuning preview.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tuning_application_id"],
      properties: { tuning_application_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_tuning_application",
    title: "Get Tuning Application",
    description: "Load one Tuning Application lifecycle record by ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tuning_application_id"],
      properties: { tuning_application_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_list_active_tuning",
    title: "List Active Tuning",
    description: "List active tuning previews on the current Runtime connection.",
    inputSchema: emptyInputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
] as const satisfies readonly Tool[];

const TOOL_OPERATIONS = new Map<string, ImplementedHostOperation>([
  ["vistrea_get_workspace_status", "GetWorkspaceStatus"],
  ["vistrea_capture_snapshot", "CaptureSnapshot"],
  ["vistrea_list_snapshots", "ListSnapshots"],
  ["vistrea_get_snapshot", "GetSnapshot"],
  ["vistrea_get_event_timeline", "GetEventTimeline"],
  ["vistrea_upload_design_asset", "AddDesignAsset"],
  ["vistrea_add_design_reference", "AddDesignReference"],
  ["vistrea_get_design_reference", "GetDesignReference"],
  ["vistrea_map_design_region", "MapDesignRegion"],
  ["vistrea_run_design_comparison", "RunDesignComparison"],
  ["vistrea_get_design_comparison", "GetDesignComparison"],
  ["vistrea_create_review_issue", "CreateReviewIssue"],
  ["vistrea_list_review_issues", "ListReviewIssues"],
  ["vistrea_get_review_issue", "GetReviewIssue"],
  ["vistrea_transition_review_issue", "TransitionReviewIssue"],
  ["vistrea_verify_review_issue", "VerifyReviewIssue"],
  ["vistrea_create_tuning_patch", "CreateTuningPatch"],
  ["vistrea_get_tuning_patch", "GetTuningPatch"],
  ["vistrea_apply_tuning_patch", "ApplyTuningPatch"],
  ["vistrea_revert_tuning_application", "RevertTuningApplication"],
  ["vistrea_get_tuning_application", "GetTuningApplication"],
  ["vistrea_list_active_tuning", "ListActiveTuning"],
]);

export function createVistreaMcpServer(client: HostLocalApiClient): Server {
  const server = new Server(
    { name: "vistrea", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use Vistrea tools to query or capture the active authenticated local Runtime Workspace.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...VISTREA_MCP_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const requestId = createCorrelationId("request");
    const traceId = createCorrelationId("trace");
    try {
      const operation = TOOL_OPERATIONS.get(request.params.name);
      if (operation === undefined) {
        throw new HostClientError("unsupported", "The requested MCP tool is not implemented.");
      }
      const input = request.params.arguments ?? {};
      const result = await client.execute(operation, input, {
        requestId,
        traceId,
        signal: extra.signal,
      });
      return successResult(result);
    } catch (error) {
      const safeError = isHostClientError(error)
        ? error
        : new HostClientError("internal", "The MCP tool could not complete the request.");
      return errorResult(requestId, traceId, safeError);
    }
  });
  return server;
}

function emptyInputSchema(): Tool["inputSchema"] {
  return { type: "object", additionalProperties: false, properties: {} };
}

function successResult(value: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(
  requestId: string,
  traceId: string,
  error: HostClientError,
): CallToolResult {
  const value: JsonObject = {
    request_id: requestId,
    trace_id: traceId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
