import fs from "node:fs/promises";
import path from "node:path";

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
    name: "vistrea_list_design_references",
    title: "List Design References",
    description: "List registered design baselines.",
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
    name: "vistrea_list_design_comparisons",
    title: "List Design Comparisons",
    description: "List persisted design comparisons, optionally narrowed by reference or Snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        design_reference_id: { type: "string", maxLength: 128 },
        target_snapshot_id: { type: "string", maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
      },
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
        include_pixel: { type: "boolean" },
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
  {
    name: "vistrea_observe_screen_state",
    title: "Observe Screen State",
    description:
      "Record one persisted Snapshot as a Screen State observation with deterministic structural identity and deduplication.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_id"],
      properties: {
        snapshot_id: { type: "string", maxLength: 128 },
        title: { type: "string", minLength: 1, maxLength: 512 },
        state_kind: { type: "string", enum: ["screen", "modal", "overlay", "transient"] },
        entry: { type: "boolean" },
        capture_source: {
          type: "string",
          enum: ["sdk", "automation", "manual", "import", "validation"],
        },
        session_id: { type: "string", maxLength: 128 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_observe_transition",
    title: "Observe Transition",
    description:
      "Record one executed action between two persisted Snapshots as a deduplicated Screen Graph Transition.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["before_snapshot_id", "after_snapshot_id", "action"],
      properties: {
        before_snapshot_id: { type: "string", maxLength: 128 },
        after_snapshot_id: { type: "string", maxLength: 128 },
        action: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "requested_effect"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "tap",
                "long_press",
                "type_text",
                "clear_text",
                "swipe",
                "scroll",
                "back",
                "launch",
                "dismiss",
              ],
            },
            requested_effect: { type: "string", minLength: 1, maxLength: 1024 },
            risk: { type: "string", enum: ["safe", "sensitive", "dangerous", "forbidden"] },
            target: {
              type: "object",
              additionalProperties: false,
              properties: {
                stable_id: { type: "string", maxLength: 256 },
                node_id: { type: "string", maxLength: 128 },
                tree_id: { type: "string", maxLength: 128 },
              },
            },
            parameters: { type: "object" },
          },
        },
        capture_source: {
          type: "string",
          enum: ["sdk", "automation", "manual", "import", "validation"],
        },
        session_id: { type: "string", maxLength: 128 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_screen_graph",
    title: "Get Screen Graph",
    description: "Read the materialized Screen Graph for one project and application.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id", "application_id"],
      properties: {
        project_id: { type: "string", maxLength: 128 },
        application_id: { type: "string", maxLength: 256 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_get_screen_state",
    title: "Get Screen State",
    description: "Read one Screen State, including its representative Snapshot reference.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["screen_state_id"],
      properties: {
        screen_state_id: { type: "string", maxLength: 128 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_merge_screen_states",
    title: "Merge Screen States",
    description:
      "Manually collapse structurally distinct Screen States that are one product screen; future captures deduplicate into the survivor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id", "application_id", "state_ids", "expected_graph_revision", "merged_by"],
      properties: {
        project_id: { type: "string", maxLength: 128 },
        application_id: { type: "string", maxLength: 256 },
        state_ids: {
          type: "array",
          minItems: 2,
          maxItems: 64,
          items: { type: "string", maxLength: 128 },
        },
        into_state_id: { type: "string", maxLength: 128 },
        expected_graph_revision: { type: "integer", minimum: 1 },
        merged_by: { type: "object" },
        justification: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_split_screen_state",
    title: "Split Screen State",
    description:
      "Manually separate wrongly deduplicated observations into a new Screen State with a manual identity.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id", "application_id", "state_id", "observation_ids", "expected_graph_revision", "split_by"],
      properties: {
        project_id: { type: "string", maxLength: 128 },
        application_id: { type: "string", maxLength: 256 },
        state_id: { type: "string", maxLength: 128 },
        observation_ids: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: { type: "string", maxLength: 128 },
        },
        title: { type: "string", minLength: 1, maxLength: 512 },
        expected_graph_revision: { type: "integer", minimum: 1 },
        split_by: { type: "object" },
        justification: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_find_screen_path",
    title: "Find Screen Path",
    description: "Find acyclic transition paths between two known Screen States.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source_state_id", "target_state_id"],
      properties: {
        source_state_id: { type: "string", maxLength: 128 },
        target_state_id: { type: "string", maxLength: 128 },
        graph_id: { type: "string", maxLength: 128 },
        maximum_depth: { type: "integer", minimum: 0, maximum: 10000 },
        maximum_paths: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_create_wiki_node",
    title: "Create Wiki Node",
    description: "Create one Deep Wiki knowledge node with inline Markdown content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "title", "markdown", "created_by"],
      properties: {
        kind: {
          type: "string",
          enum: ["screen", "component", "path", "requirement", "test", "design", "concept", "note"],
        },
        title: { type: "string", minLength: 1, maxLength: 512 },
        slug: { type: "string", minLength: 1, maxLength: 256 },
        summary: { type: "string", minLength: 1, maxLength: 2048 },
        markdown: { type: "string", minLength: 1, maxLength: 262144 },
        labels: {
          type: "array",
          maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
        related_resources: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: {
              kind: { type: "string", maxLength: 64 },
              id: { type: "string", maxLength: 320 },
            },
          },
        },
        created_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_update_wiki_node",
    title: "Update Wiki Node",
    description:
      "Revise one Deep Wiki node with optimistic concurrency; published knowledge archives instead of reverting to draft.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wiki_node_id", "expected_revision", "updated_by"],
      properties: {
        wiki_node_id: { type: "string", maxLength: 128 },
        expected_revision: { type: "integer", minimum: 1 },
        title: { type: "string", minLength: 1, maxLength: 512 },
        summary: { type: "string", minLength: 1, maxLength: 2048 },
        markdown: { type: "string", minLength: 1, maxLength: 262144 },
        labels: {
          type: "array",
          maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
        related_resources: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: {
              kind: { type: "string", maxLength: 64 },
              id: { type: "string", maxLength: 320 },
            },
          },
        },
        to_status: { type: "string", enum: ["draft", "published", "archived"] },
        updated_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_wiki_node",
    title: "Get Wiki Node",
    description: "Load one Deep Wiki node.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wiki_node_id"],
      properties: { wiki_node_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_search_wiki",
    title: "Search Wiki",
    description: "Search Deep Wiki nodes by text, kind, label, and status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1, maxLength: 512 },
        kinds: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
        labels: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
        statuses: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_link_wiki_node",
    title: "Link Wiki Node",
    description: "Link one Deep Wiki node to another node or any workspace resource.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source_node_id", "target", "relation", "created_by"],
      properties: {
        source_node_id: { type: "string", maxLength: 128 },
        target: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "id"],
          properties: {
            kind: { type: "string", maxLength: 64 },
            id: { type: "string", maxLength: 320 },
          },
        },
        relation: {
          type: "string",
          enum: [
            "relates_to",
            "documents",
            "evidence_for",
            "implements",
            "tests",
            "depends_on",
            "supersedes",
          ],
        },
        label: { type: "string", minLength: 1, maxLength: 256 },
        annotation: { type: "string", minLength: 1, maxLength: 2048 },
        created_by: { type: "object" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_unlink_wiki_node",
    title: "Unlink Wiki Node",
    description: "Remove one Deep Wiki link with optimistic concurrency.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wiki_link_id", "expected_revision"],
      properties: {
        wiki_link_id: { type: "string", maxLength: 128 },
        expected_revision: { type: "integer", minimum: 1 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "vistrea_get_wiki_backlinks",
    title: "Get Wiki Backlinks",
    description: "List links pointing at one Deep Wiki node.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wiki_node_id"],
      properties: {
        wiki_node_id: { type: "string", maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_related_wiki_nodes",
    title: "Related Wiki Nodes",
    description: "List Deep Wiki nodes related to one workspace resource.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: {
        kind: { type: "string", maxLength: 64 },
        id: { type: "string", maxLength: 320 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_validate_snapshot",
    title: "Validate Snapshot",
    description:
      "Run the built-in structural, accessibility, and visual validators over one persisted Snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_id"],
      properties: {
        snapshot_id: { type: "string", maxLength: 128 },
        categories: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "string", enum: ["structural", "accessibility", "visual"] },
        },
        configuration: {
          type: "object",
          additionalProperties: false,
          properties: {
            disabled_rules: {
              type: "array",
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
            minimum_touch_target_points: { type: "number", minimum: 1, maximum: 200 },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_validate_screen_graph",
    title: "Validate Screen Graph",
    description:
      "Run the behavioral reachability validators over the materialized Screen Graph.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id", "application_id"],
      properties: {
        project_id: { type: "string", maxLength: 128 },
        application_id: { type: "string", maxLength: 256 },
        configuration: {
          type: "object",
          additionalProperties: false,
          properties: {
            disabled_rules: {
              type: "array",
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
            minimum_touch_target_points: { type: "number", minimum: 1, maximum: 200 },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_validation_run",
    title: "Get Validation Run",
    description: "Load one Validation Run with its finding counts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["validation_run_id"],
      properties: { validation_run_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_list_validation_findings",
    title: "List Validation Findings",
    description: "Page Validation Findings by run, status, and severity.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        validation_run_id: { type: "string", maxLength: 128 },
        statuses: { type: "array", maxItems: 8, items: { type: "string", maxLength: 32 } },
        severities: { type: "array", maxItems: 8, items: { type: "string", maxLength: 32 } },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_get_validation_finding",
    title: "Get Validation Finding",
    description: "Load one Validation Finding with its evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["finding_id"],
      properties: { finding_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_suppress_validation_finding",
    title: "Suppress Validation Finding",
    description:
      "Suppress one open Finding with a justified reason and optimistic concurrency.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["finding_id", "expected_finding_revision", "reason_code", "justification", "created_by"],
      properties: {
        finding_id: { type: "string", maxLength: 128 },
        expected_finding_revision: { type: "integer", minimum: 1 },
        reason_code: {
          type: "string",
          enum: ["false_positive", "accepted_risk", "known_issue", "environment_variance", "other"],
        },
        justification: { type: "string", minLength: 1, maxLength: 2048 },
        created_by: { type: "object" },
        expires_at: { type: "string", maxLength: 64 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_compare_builds",
    title: "Compare Builds",
    description:
      "Diff observed Screen State and Transition coverage between two builds of one application.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id", "application_id", "left_build_id", "right_build_id"],
      properties: {
        project_id: { type: "string", maxLength: 128 },
        application_id: { type: "string", maxLength: 256 },
        left_build_id: { type: "string", maxLength: 128 },
        right_build_id: { type: "string", maxLength: 128 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_build_diff",
    title: "Get Build Diff",
    description: "Load one persisted Build Diff.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["build_diff_id"],
      properties: { build_diff_id: { type: "string", maxLength: 128 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_export_pack",
    title: "Export Pack",
    description:
      "Export refs and commits as a portable content-addressed .vistrea-pack Object; download its bytes with vistrea_get_object.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["created_by"],
      properties: {
        ref_names: { type: "array", maxItems: 64, items: { type: "string", maxLength: 256 } },
        commit_ids: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 } },
        prerequisite_commit_ids: {
          type: "array",
          maxItems: 64,
          items: { type: "string", maxLength: 128 },
        },
        created_by: { type: "object" },
        message: { type: "string", minLength: 1, maxLength: 2048 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_import_pack",
    title: "Import Pack",
    description: "Import a base64-encoded .vistrea-pack into the local Workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pack_base64"],
      properties: { pack_base64: { type: "string", minLength: 1, maxLength: 8388608 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_run_exploration",
    title: "Run Exploration",
    description:
      "Start bounded deterministic exploration of the connected application as a background Operation; poll it with vistrea_get_exploration_operation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["maximum_actions"],
      properties: {
        maximum_actions: { type: "integer", minimum: 1, maximum: 500 },
        maximum_depth: { type: "integer", minimum: 1, maximum: 32 },
        settle_milliseconds: { type: "integer", minimum: 0, maximum: 60000 },
        excluded_stable_ids: {
          type: "array",
          maxItems: 128,
          items: { type: "string", minLength: 1, maxLength: 256 },
        },
        actor_id: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "vistrea_get_exploration_operation",
    title: "Get Exploration Operation",
    description:
      "Read one exploration Operation with its progress events and, once succeeded, the inline ExplorationReport result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation_id"],
      properties: {
        operation_id: { type: "string", maxLength: 128 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_cancel_exploration",
    title: "Cancel Exploration",
    description:
      "Request cancellation of the running exploration Operation; recorded observations stay in the Screen Graph.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation_id"],
      properties: {
        operation_id: { type: "string", maxLength: 128 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "vistrea_get_object",
    title: "Get Object",
    description:
      "Download one content-addressed Object (screenshot, exported pack) into a new local file at output_path.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["hash", "output_path"],
      properties: {
        hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        output_path: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
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
  ["vistrea_list_design_references", "ListDesignReferences"],
  ["vistrea_list_design_comparisons", "ListDesignComparisons"],
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
  ["vistrea_observe_screen_state", "RecordStateObservation"],
  ["vistrea_observe_transition", "RecordTransitionObservation"],
  ["vistrea_get_screen_graph", "GetScreenGraph"],
  ["vistrea_get_screen_state", "GetScreenState"],
  ["vistrea_merge_screen_states", "MergeScreenStates"],
  ["vistrea_split_screen_state", "SplitScreenState"],
  ["vistrea_find_screen_path", "FindScreenPath"],
  ["vistrea_create_wiki_node", "CreateWikiNode"],
  ["vistrea_update_wiki_node", "UpdateWikiNode"],
  ["vistrea_get_wiki_node", "GetWikiNode"],
  ["vistrea_search_wiki", "ListWikiNodes"],
  ["vistrea_link_wiki_node", "LinkWikiNode"],
  ["vistrea_unlink_wiki_node", "UnlinkWikiNode"],
  ["vistrea_get_wiki_backlinks", "GetWikiBacklinks"],
  ["vistrea_related_wiki_nodes", "GetRelatedWikiNodes"],
  ["vistrea_validate_snapshot", "ValidateSnapshot"],
  ["vistrea_validate_screen_graph", "ValidateScreenGraph"],
  ["vistrea_get_validation_run", "GetValidationRun"],
  ["vistrea_list_validation_findings", "ListValidationFindings"],
  ["vistrea_get_validation_finding", "GetValidationFinding"],
  ["vistrea_suppress_validation_finding", "SuppressValidationFinding"],
  ["vistrea_compare_builds", "CompareBuilds"],
  ["vistrea_get_build_diff", "GetBuildDiff"],
  ["vistrea_export_pack", "ExportPack"],
  ["vistrea_import_pack", "ImportPack"],
  ["vistrea_get_object", "GetObject"],
  ["vistrea_run_exploration", "RunExploration"],
  ["vistrea_get_exploration_operation", "GetExplorationOperation"],
  ["vistrea_cancel_exploration", "CancelExploration"],
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
      if (request.params.name === "vistrea_get_object") {
        // Object bytes go to a fresh local file, never into the tool result.
        const command = input as JsonObject;
        const outputPath = command["output_path"];
        if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
          throw new HostClientError("invalid_argument", "output_path must be an absolute path.");
        }
        const result = (await client.execute(
          operation,
          { hash: command["hash"] ?? null },
          { requestId, traceId, signal: extra.signal },
        )) as JsonObject;
        const encoded = result["bytes_base64"];
        if (typeof encoded !== "string") {
          throw new HostClientError("integrity_error", "The Host returned an invalid object body.");
        }
        try {
          await fs.writeFile(outputPath, Buffer.from(encoded, "base64"), { flag: "wx" });
        } catch {
          throw new HostClientError(
            "invalid_argument",
            "output_path could not be created; it must name a new writable file.",
          );
        }
        const { bytes_base64: _encoded, ...summary } = result;
        return successResult({ ...summary, output_path: outputPath });
      }
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
