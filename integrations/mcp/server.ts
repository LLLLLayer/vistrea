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
] as const satisfies readonly Tool[];

const TOOL_OPERATIONS = new Map<string, ImplementedHostOperation>([
  ["vistrea_get_workspace_status", "GetWorkspaceStatus"],
  ["vistrea_capture_snapshot", "CaptureSnapshot"],
  ["vistrea_list_snapshots", "ListSnapshots"],
  ["vistrea_get_snapshot", "GetSnapshot"],
  ["vistrea_get_event_timeline", "GetEventTimeline"],
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
