import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { startHostLocalApi } from "../../apps/host/index.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type ByteStream,
  type ObjectRef,
  type ProtocolValidator,
  type RuntimeSnapshot,
} from "../../data/api/index.js";
import { createRepositoryProtocolValidator, MemoryDataStore } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import {
  HostLocalApiClient,
  isHostClientError,
  type JsonObject,
} from "../../integrations/shared/index.js";
import { exitCodeFor } from "../../integrations/cli/index.js";
import {
  LoopbackTransportError,
  type CaptureSnapshotCommand,
  type RuntimeCaptureOptions,
  type RuntimeCapturePort,
  type RuntimeCaptureResult,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const emittedCliPath = path.join(
  repositoryRoot,
  ".build/typescript/integrations/cli/main.js",
);
const emittedMcpPath = path.join(
  repositoryRoot,
  ".build/typescript/integrations/mcp/main.js",
);

interface CaptureFixture {
  readonly snapshot: RuntimeSnapshot;
  readonly object: ObjectRef;
  readonly bytes: Buffer;
}

class QueuedRuntimeCapturePort implements RuntimeCapturePort {
  readonly #captures: CaptureFixture[];

  constructor(captures: readonly CaptureFixture[]) {
    this.#captures = [...captures];
  }

  async captureSnapshot(
    _command: CaptureSnapshotCommand,
    _options?: RuntimeCaptureOptions,
  ): Promise<RuntimeCaptureResult> {
    const capture = this.#captures.shift();
    if (capture === undefined) {
      throw new Error("No fixture capture remains.");
    }
    return {
      snapshot: structuredClone(capture.snapshot),
      objects: [
        {
          ref: structuredClone(capture.object),
          stream: streamBytes(capture.bytes),
        },
      ],
    };
  }
}

test("CLI and real stdio MCP preserve Host operation results and errors", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryDirectory(t, "vistrea-agent-adapters-");
  const fixtures = await loadCaptureFixtures(validator);
  const workspace = new MemoryDataStore({ validator });
  const objects = await FileObjectStore.open({ workspaceRoot });
  const host = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: new QueuedRuntimeCapturePort(fixtures),
    workspace,
    objects,
    validator,
  });
  t.after(() => host.close());
  const environment = {
    ...getDefaultEnvironment(),
    VISTREA_HOST_URL: host.baseUrl,
    VISTREA_HOST_TOKEN: host.bearerToken,
  };

  const cliStatus = await runCli(["workspace", "status", "--format", "json"], environment);
  assert.equal(cliStatus.exitCode, 0);
  assert.equal(cliStatus.stderr, "");
  assertTokenAbsent(cliStatus, host.bearerToken);
  const cliStatusEnvelope = parseCliEnvelope(cliStatus.stdout);

  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [emittedMcpPath],
    cwd: repositoryRoot,
    env: environment,
    stderr: "pipe",
  });
  const mcpStderr: Buffer[] = [];
  mcpTransport.stderr?.on("data", (chunk: Buffer) => mcpStderr.push(Buffer.from(chunk)));
  const mcp = new Client({ name: "vistrea-agent-adapter-test", version: "1.0.0" });
  t.after(() => mcp.close().catch(() => undefined));
  await mcp.connect(mcpTransport);

  const tools = await mcp.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "vistrea_add_design_reference",
      "vistrea_apply_tuning_patch",
      "vistrea_capture_snapshot",
      "vistrea_create_review_issue",
      "vistrea_create_tuning_patch",
      "vistrea_create_wiki_node",
      "vistrea_find_screen_path",
      "vistrea_get_design_comparison",
      "vistrea_get_design_reference",
      "vistrea_get_event_timeline",
      "vistrea_get_review_issue",
      "vistrea_get_screen_graph",
      "vistrea_get_snapshot",
      "vistrea_get_tuning_application",
      "vistrea_get_tuning_patch",
      "vistrea_get_validation_finding",
      "vistrea_get_validation_run",
      "vistrea_get_wiki_backlinks",
      "vistrea_get_wiki_node",
      "vistrea_get_workspace_status",
      "vistrea_link_wiki_node",
      "vistrea_list_active_tuning",
      "vistrea_list_review_issues",
      "vistrea_list_snapshots",
      "vistrea_list_validation_findings",
      "vistrea_map_design_region",
      "vistrea_observe_screen_state",
      "vistrea_observe_transition",
      "vistrea_related_wiki_nodes",
      "vistrea_revert_tuning_application",
      "vistrea_run_design_comparison",
      "vistrea_search_wiki",
      "vistrea_suppress_validation_finding",
      "vistrea_transition_review_issue",
      "vistrea_unlink_wiki_node",
      "vistrea_update_wiki_node",
      "vistrea_upload_design_asset",
      "vistrea_validate_screen_graph",
      "vistrea_validate_snapshot",
      "vistrea_verify_review_issue",
    ],
  );
  const inheritedToolName = await mcp.callTool({ name: "__proto__", arguments: {} });
  assert.equal(inheritedToolName.isError, true);
  assert.equal(
    ((inheritedToolName.structuredContent as JsonObject)["error"] as JsonObject)["code"],
    "unsupported",
  );

  const mcpStatus = await mcp.callTool({ name: "vistrea_get_workspace_status", arguments: {} });
  assert.equal(mcpStatus.isError, undefined);
  assert.deepEqual(mcpStatus.structuredContent, cliStatusEnvelope.data);

  const cliCapture = await runCli(["snapshot", "capture"], environment);
  assert.equal(cliCapture.exitCode, 0);
  assert.equal(cliCapture.stderr, "");
  assertTokenAbsent(cliCapture, host.bearerToken);
  const cliCaptureEnvelope = parseCliEnvelope(cliCapture.stdout);
  assert.equal(
    (cliCaptureEnvelope.data as JsonObject)["snapshot_id"],
    fixtures[0]?.snapshot.snapshot_id,
  );

  const mcpCapture = await mcp.callTool({ name: "vistrea_capture_snapshot", arguments: {} });
  assert.equal(mcpCapture.isError, undefined);
  assert.equal(
    (mcpCapture.structuredContent as JsonObject)["snapshot_id"],
    fixtures[1]?.snapshot.snapshot_id,
  );

  const cliList = await runCli(["snapshot", "list", "--limit", "10"], environment);
  assert.equal(cliList.exitCode, 0);
  const cliListEnvelope = parseCliEnvelope(cliList.stdout);
  const mcpList = await mcp.callTool({
    name: "vistrea_list_snapshots",
    arguments: { limit: 10 },
  });
  assert.equal(mcpList.isError, undefined);
  assert.deepEqual(mcpList.structuredContent, cliListEnvelope.data);

  const snapshotId = fixtures[0]?.snapshot.snapshot_id as string;
  const cliGet = await runCli(["snapshot", "get", snapshotId], environment);
  assert.equal(cliGet.exitCode, 0);
  const cliGetEnvelope = parseCliEnvelope(cliGet.stdout);
  const mcpGet = await mcp.callTool({
    name: "vistrea_get_snapshot",
    arguments: { snapshot_id: snapshotId },
  });
  assert.equal(mcpGet.isError, undefined);
  assert.deepEqual(mcpGet.structuredContent, cliGetEnvelope.data);

  const eventBatch = JSON.parse(
    await fs.readFile(
      path.join(
        repositoryRoot,
        "protocol/fixtures/v1/runtime-event-batch/valid/ordered-with-filtered-gap.json",
      ),
      "utf8",
    ),
  ) as { event_epoch_id: string; events: readonly { event_id: string }[] };
  const eventUnit = workspace.beginUnitOfWork("write");
  eventUnit.runtimeEvents.appendBatch(eventBatch as never);
  eventUnit.commit();
  const cliEvents = await runCli(
    ["events", "list", "--epoch", eventBatch.event_epoch_id],
    environment,
  );
  assert.equal(cliEvents.exitCode, 0);
  const cliEventsEnvelope = parseCliEnvelope(cliEvents.stdout);
  assert.equal(
    ((cliEventsEnvelope.data as JsonObject)["events"] as readonly JsonObject[]).length,
    eventBatch.events.length,
  );
  const mcpEvents = await mcp.callTool({
    name: "vistrea_get_event_timeline",
    arguments: { event_epoch_id: eventBatch.event_epoch_id },
  });
  assert.equal(mcpEvents.isError, undefined);
  assert.deepEqual(mcpEvents.structuredContent, cliEventsEnvelope.data);

  // Design review round trip: CLI drives the flow; MCP reads identical state.
  const assetPath = path.join(workspaceRoot, "design-baseline.png");
  await fs.writeFile(assetPath, Buffer.from("vistrea-adapter-design-asset", "utf8"));
  const uploadedAsset = await runCli(
    [
      "design",
      "upload-asset",
      "--file",
      assetPath,
      "--media-type",
      "image/png",
      "--name",
      "design-baseline.png",
    ],
    environment,
  );
  assert.equal(uploadedAsset.exitCode, 0, uploadedAsset.stdout);
  const assetHash = (parseCliEnvelope(uploadedAsset.stdout).data as JsonObject)["hash"] as string;

  const actorJson = JSON.stringify({ kind: "agent", id: "vistrea-cli", extensions: {} });
  const referenceCreate = await runCli(
    [
      "design",
      "add-reference",
      "--json",
      JSON.stringify({
        name: "Adapter baseline",
        kind: "design_artifact",
        canvas_size: { width: 390, height: 844 },
        pixel_size: { width: 1170, height: 2532 },
        asset_hash: assetHash,
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(referenceCreate.exitCode, 0, referenceCreate.stdout);
  const referenceEnvelope = parseCliEnvelope(referenceCreate.stdout).data as JsonObject;
  const referenceId = referenceEnvelope["design_reference_id"] as string;

  const capturedSnapshot = cliCaptureEnvelope.data as JsonObject;
  const capturedTree = (capturedSnapshot["trees"] as readonly JsonObject[])[0] as JsonObject;
  const capturedNode = ((capturedTree["payload"] as JsonObject)[
    "inline_nodes"
  ] as readonly JsonObject[])[0] as JsonObject;
  const runtimeTarget = {
    snapshot_id: capturedSnapshot["snapshot_id"],
    tree_id: capturedTree["tree_id"],
    node_id: capturedNode["node_id"],
  };
  const mapCreate = await runCli(
    [
      "design",
      "map",
      "--json",
      JSON.stringify({
        design_reference_id: referenceId,
        design_region: { x: 0, y: 12, width: 390, height: 844 },
        runtime_target: runtimeTarget,
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(mapCreate.exitCode, 0, mapCreate.stdout);

  const comparisonRun = await runCli(
    [
      "design",
      "compare",
      "--reference",
      referenceId,
      "--snapshot",
      capturedSnapshot["snapshot_id"] as string,
    ],
    environment,
  );
  assert.equal(comparisonRun.exitCode, 0, comparisonRun.stdout);
  const comparisonEnvelope = parseCliEnvelope(comparisonRun.stdout).data as JsonObject;
  assert.equal((comparisonEnvelope["differences"] as readonly JsonObject[]).length, 1);

  const issueCreate = await runCli(
    [
      "issue",
      "create",
      "--json",
      JSON.stringify({
        design_reference_id: referenceId,
        comparison_id: comparisonEnvelope["comparison_id"],
        runtime_target: runtimeTarget,
        title: "Adapter-detected frame drift",
        category: "frame",
        severity: "minor",
        expected: { kind: "number", value: 12, unit: "logical_point", extensions: {} },
        actual: { kind: "number", value: 0, unit: "logical_point", extensions: {} },
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(issueCreate.exitCode, 0, issueCreate.stdout);
  const issueEnvelope = parseCliEnvelope(issueCreate.stdout).data as JsonObject;
  const issueId = issueEnvelope["issue_id"] as string;

  const issueTransition = await runCli(
    ["issue", "transition", issueId, "--revision", "1", "--to", "ready_for_verification"],
    environment,
  );
  assert.equal(issueTransition.exitCode, 0, issueTransition.stdout);
  const readyIssue = parseCliEnvelope(issueTransition.stdout).data as JsonObject;

  const issueVerify = await runCli(
    [
      "issue",
      "verify",
      issueId,
      "--revision",
      String(readyIssue["revision"]),
      "--basis",
      "real_build",
      "--result",
      "passed",
      "--snapshot",
      capturedSnapshot["snapshot_id"] as string,
      "--build",
      "build_019f0000-0000-7000-8000-000000000002",
    ],
    environment,
  );
  assert.equal(issueVerify.exitCode, 0, issueVerify.stdout);
  const verifiedEnvelope = parseCliEnvelope(issueVerify.stdout).data as JsonObject;
  assert.equal((verifiedEnvelope["issue"] as JsonObject)["state"], "resolved");

  const mcpIssue = await mcp.callTool({
    name: "vistrea_get_review_issue",
    arguments: { issue_id: issueId },
  });
  assert.equal(mcpIssue.isError, undefined);
  assert.deepEqual(mcpIssue.structuredContent, verifiedEnvelope["issue"]);
  const mcpIssueList = await mcp.callTool({
    name: "vistrea_list_review_issues",
    arguments: { states: ["resolved"] },
  });
  assert.equal(mcpIssueList.isError, undefined);
  assert.deepEqual(
    ((mcpIssueList.structuredContent as JsonObject)["items"] as readonly JsonObject[]).map(
      (item) => item["issue_id"],
    ),
    [issueId],
  );

  // Tuning: patch descriptions persist; applying without a Runtime is unavailable.
  const patchCreate = await runCli(
    [
      "tuning",
      "create-patch",
      "--json",
      JSON.stringify({
        title: "Preview node opacity",
        target_snapshot_id: capturedSnapshot["snapshot_id"],
        status: "approved",
        changes: [
          {
            runtime_target: runtimeTarget,
            property: "alpha",
            original_value: { kind: "number", value: 1, unit: "ratio", extensions: {} },
            preview_value: { kind: "number", value: 0.7, unit: "ratio", extensions: {} },
          },
        ],
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(patchCreate.exitCode, 0, patchCreate.stdout);
  const patchEnvelope = parseCliEnvelope(patchCreate.stdout).data as JsonObject;
  const mcpPatch = await mcp.callTool({
    name: "vistrea_get_tuning_patch",
    arguments: { patch_id: patchEnvelope["patch_id"] },
  });
  assert.equal(mcpPatch.isError, undefined);
  assert.deepEqual(mcpPatch.structuredContent, patchEnvelope);
  const applyWithoutRuntime = await runCli(
    ["tuning", "apply", "--patch", patchEnvelope["patch_id"] as string],
    environment,
  );
  assert.equal(applyWithoutRuntime.exitCode, 7);
  assert.equal(parseCliEnvelope(applyWithoutRuntime.stdout).error?.["code"], "unavailable");

  // Screen Graph: state observation dedup and graph reads round trip.
  const observeState = await runCli(
    [
      "graph",
      "observe-state",
      "--snapshot",
      capturedSnapshot["snapshot_id"] as string,
      "--title",
      "Home",
      "--entry",
      "true",
    ],
    environment,
  );
  assert.equal(observeState.exitCode, 0, observeState.stdout);
  const observedState = parseCliEnvelope(observeState.stdout).data as JsonObject;
  assert.equal(observedState["created"], true);
  const observedScreenState = observedState["screen_state"] as JsonObject;

  const mcpObserveAgain = await mcp.callTool({
    name: "vistrea_observe_screen_state",
    arguments: { snapshot_id: capturedSnapshot["snapshot_id"] },
  });
  assert.equal(mcpObserveAgain.isError, undefined);
  const mcpObserved = mcpObserveAgain.structuredContent as JsonObject;
  assert.equal(mcpObserved["created"], false);
  assert.equal(
    (mcpObserved["screen_state"] as JsonObject)["screen_state_id"],
    observedScreenState["screen_state_id"],
  );

  const runtimeContext = capturedSnapshot["runtime_context"] as JsonObject;
  const mcpGraph = await mcp.callTool({
    name: "vistrea_get_screen_graph",
    arguments: {
      project_id: runtimeContext["project_id"],
      application_id: runtimeContext["application_id"],
    },
  });
  assert.equal(mcpGraph.isError, undefined);
  const graphDocument = mcpGraph.structuredContent as JsonObject;
  assert.equal((graphDocument["states"] as readonly JsonObject[]).length, 1);

  const cliGraph = await runCli(
    [
      "graph",
      "show",
      "--project",
      runtimeContext["project_id"] as string,
      "--application",
      runtimeContext["application_id"] as string,
    ],
    environment,
  );
  assert.equal(cliGraph.exitCode, 0, cliGraph.stdout);
  assert.deepEqual(parseCliEnvelope(cliGraph.stdout).data, graphDocument);

  const cliGraphState = await runCli(
    ["graph", "get-state", observedScreenState["screen_state_id"] as string],
    environment,
  );
  assert.equal(cliGraphState.exitCode, 0, cliGraphState.stdout);
  assert.equal(
    (parseCliEnvelope(cliGraphState.stdout).data as JsonObject)["revision"],
    2,
  );

  // Deep Wiki: create, revise, search, link, and backlinks round trip.
  const wikiCreate = await runCli(
    [
      "wiki",
      "create",
      "--json",
      JSON.stringify({
        kind: "screen",
        title: "Home knowledge",
        markdown: "# Home\n\nEntry screen for the demo scenario.",
        labels: ["demo"],
        related_resources: [
          { kind: "snapshot", id: capturedSnapshot["snapshot_id"] },
        ],
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(wikiCreate.exitCode, 0, wikiCreate.stdout);
  const wikiNode = parseCliEnvelope(wikiCreate.stdout).data as JsonObject;
  assert.equal(wikiNode["status"], "draft");

  const wikiPublish = await mcp.callTool({
    name: "vistrea_update_wiki_node",
    arguments: {
      wiki_node_id: wikiNode["wiki_node_id"],
      expected_revision: 1,
      to_status: "published",
      updated_by: JSON.parse(actorJson),
    },
  });
  assert.equal(wikiPublish.isError, undefined);
  assert.equal((wikiPublish.structuredContent as JsonObject)["status"], "published");

  const wikiSearch = await runCli(
    ["wiki", "search", "--text", "entry screen", "--statuses", "published"],
    environment,
  );
  assert.equal(wikiSearch.exitCode, 0, wikiSearch.stdout);
  const wikiHits = (parseCliEnvelope(wikiSearch.stdout).data as JsonObject)[
    "items"
  ] as readonly JsonObject[];
  assert.deepEqual(
    wikiHits.map((hit) => hit["wiki_node_id"]),
    [wikiNode["wiki_node_id"]],
  );

  const noteCreate = await mcp.callTool({
    name: "vistrea_create_wiki_node",
    arguments: {
      kind: "note",
      title: "Follow-up",
      markdown: "Check the banner timing.",
      created_by: JSON.parse(actorJson),
    },
  });
  assert.equal(noteCreate.isError, undefined);
  const note = noteCreate.structuredContent as JsonObject;
  const wikiLink = await runCli(
    [
      "wiki",
      "link",
      "--json",
      JSON.stringify({
        source_node_id: note["wiki_node_id"],
        target: { kind: "wiki_node", id: wikiNode["wiki_node_id"] },
        relation: "relates_to",
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(wikiLink.exitCode, 0, wikiLink.stdout);
  const backlinks = await mcp.callTool({
    name: "vistrea_get_wiki_backlinks",
    arguments: { wiki_node_id: wikiNode["wiki_node_id"] },
  });
  assert.equal(backlinks.isError, undefined);
  assert.equal(
    ((backlinks.structuredContent as JsonObject)["items"] as readonly JsonObject[]).length,
    1,
  );
  const relatedNodes = await mcp.callTool({
    name: "vistrea_related_wiki_nodes",
    arguments: { kind: "snapshot", id: capturedSnapshot["snapshot_id"] },
  });
  assert.equal(relatedNodes.isError, undefined);
  assert.deepEqual(
    ((relatedNodes.structuredContent as JsonObject)["items"] as readonly JsonObject[]).map(
      (item) => item["wiki_node_id"],
    ),
    [wikiNode["wiki_node_id"]],
  );

  // Validation: the captured fixture Snapshot passes the core rule set.
  const cliValidate = await runCli(
    ["validate", "snapshot", "--snapshot", capturedSnapshot["snapshot_id"] as string],
    environment,
  );
  assert.equal(cliValidate.exitCode, 0, cliValidate.stdout);
  const validateEnvelope = parseCliEnvelope(cliValidate.stdout).data as JsonObject;
  const validationRun = validateEnvelope["run"] as JsonObject;
  assert.equal(validationRun["state"], "succeeded");
  const mcpValidationRun = await mcp.callTool({
    name: "vistrea_get_validation_run",
    arguments: { validation_run_id: validationRun["validation_run_id"] },
  });
  assert.equal(mcpValidationRun.isError, undefined);
  assert.deepEqual(mcpValidationRun.structuredContent, validationRun);
  const mcpFindings = await mcp.callTool({
    name: "vistrea_list_validation_findings",
    arguments: { validation_run_id: validationRun["validation_run_id"] },
  });
  assert.equal(mcpFindings.isError, undefined);
  assert.deepEqual(
    (mcpFindings.structuredContent as JsonObject)["items"],
    validateEnvelope["findings"],
  );

  const missingSnapshotId = "snapshot_019f0000-0000-7000-8000-000000000099";
  const cliMissing = await runCli(["snapshot", "get", missingSnapshotId], environment);
  assert.equal(cliMissing.exitCode, 3);
  const cliMissingEnvelope = parseCliEnvelope(cliMissing.stdout);
  const mcpMissing = await mcp.callTool({
    name: "vistrea_get_snapshot",
    arguments: { snapshot_id: missingSnapshotId },
  });
  assert.equal(mcpMissing.isError, true);
  assert.deepEqual(
    (mcpMissing.structuredContent as JsonObject)["error"],
    cliMissingEnvelope.error,
  );

  const cliInvalidCapture = await runCli(
    ["snapshot", "capture", "--reason", "not-a-reason"],
    environment,
  );
  assert.equal(cliInvalidCapture.exitCode, 2);
  const cliInvalidCaptureEnvelope = parseCliEnvelope(cliInvalidCapture.stdout);
  const mcpInvalidCapture = await mcp.callTool({
    name: "vistrea_capture_snapshot",
    arguments: { reason: "not-a-reason" },
  });
  assert.equal(mcpInvalidCapture.isError, true);
  assert.deepEqual(
    (mcpInvalidCapture.structuredContent as JsonObject)["error"],
    cliInvalidCaptureEnvelope.error,
  );

  const invalidCli = await runCli(
    ["snapshot", "get", "--token", "token-looking-value"],
    environment,
  );
  assert.equal(invalidCli.exitCode, 2);
  assertTokenAbsent(invalidCli, host.bearerToken);

  const wrongEnvironmentToken = "w".repeat(43);
  const unauthenticatedCli = await runCli(["workspace", "status"], {
    ...environment,
    VISTREA_HOST_TOKEN: wrongEnvironmentToken,
  });
  assert.equal(unauthenticatedCli.exitCode, 5);
  assert.equal(unauthenticatedCli.stdout.includes(wrongEnvironmentToken), false);
  assert.equal(unauthenticatedCli.stderr.includes(wrongEnvironmentToken), false);

  await mcp.close();
  const stderr = Buffer.concat(mcpStderr).toString("utf8");
  assert.equal(stderr.includes(host.bearerToken), false);
  assert.equal(stderr, "");
});

test("shared Host client enforces loopback, response, deadline, and secret boundaries", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryDirectory(t, "vistrea-agent-client-");
  const [fixture] = await loadCaptureFixtures(validator);
  const workspace = new MemoryDataStore({ validator });
  const objects = await FileObjectStore.open({ workspaceRoot });
  const host = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: new QueuedRuntimeCapturePort(fixture === undefined ? [] : [fixture]),
    workspace,
    objects,
    validator,
  });
  t.after(() => host.close());

  assert.throws(
    () =>
      new HostLocalApiClient({
        baseUrl: "https://example.com:443",
        bearerToken: host.bearerToken,
      }),
    (error: unknown) => isHostClientError(error) && error.code === "invalid_argument",
  );
  for (const nonCanonicalUrl of [
    "http://127.0.0.1:0",
    "http://2130706433:43123",
    "http://0177.0.0.1:43123",
    "http://127.1:43123",
    "http://0x7f000001:43123",
    "http://127.0.0.1:43123/",
  ]) {
    assert.throws(
      () =>
        new HostLocalApiClient({
          baseUrl: nonCanonicalUrl,
          bearerToken: host.bearerToken,
        }),
      (error: unknown) => isHostClientError(error) && error.code === "invalid_argument",
    );
  }
  assert.doesNotThrow(
    () =>
      new HostLocalApiClient({
        baseUrl: "http://127.0.0.1:80",
        bearerToken: host.bearerToken,
      }),
  );

  const limited = new HostLocalApiClient({
    baseUrl: host.baseUrl,
    bearerToken: host.bearerToken,
    maximumResponseBytes: 8,
  });
  await assert.rejects(
    limited.execute("GetWorkspaceStatus"),
    (error: unknown) => isHostClientError(error) && error.code === "resource_exhausted",
  );

  const token = "t".repeat(43);
  const slowServer = await startFakeServer(t, (_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) {
        writeJson(response, 200, { status: "ready", runtime_connected: true });
      }
    }, 100).unref();
  });
  const timed = new HostLocalApiClient({
    baseUrl: slowServer,
    bearerToken: token,
    timeoutMilliseconds: 10,
  });
  await assert.rejects(
    timed.execute("GetWorkspaceStatus"),
    (error: unknown) => isHostClientError(error) && error.code === "timeout",
  );

  const echoServer = await startFakeServer(t, (request, response) => {
    const authorization = request.headers.authorization ?? "missing";
    writeJson(response, 400, {
      request_id: "request_019f0000-0000-7000-8000-000000000001",
      error: {
        code: "invalid_argument",
        message: `private authorization ${authorization}`,
        retryable: false,
      },
    });
  });
  const redacting = new HostLocalApiClient({ baseUrl: echoServer, bearerToken: token });
  await assert.rejects(redacting.execute("GetWorkspaceStatus"), (error: unknown) => {
    assert.equal(isHostClientError(error), true);
    const clientError = error as Error & { readonly code: string };
    assert.equal(clientError.code, "invalid_argument");
    assert.equal(clientError.message.includes(token), false);
    assert.match(clientError.message, /\[redacted\]/);
    return true;
  });

  const encodedServer = await startFakeServer(t, (_request, response) => {
    const body = Buffer.from(JSON.stringify({ status: "ready", runtime_connected: true }), "utf8");
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": String(body.byteLength),
    });
    response.end(body);
  });
  const encodedClient = new HostLocalApiClient({ baseUrl: encodedServer, bearerToken: token });
  await assert.rejects(
    encodedClient.execute("GetWorkspaceStatus"),
    (error: unknown) => isHostClientError(error) && error.code === "integrity_error",
  );

  const mismatchedLengthServer = await startFakeServer(t, (_request, response) => {
    const body = Buffer.from(JSON.stringify({ status: "ready", runtime_connected: true }), "utf8");
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.byteLength + 1),
      connection: "close",
    });
    response.end(body);
  });
  const mismatchedLengthClient = new HostLocalApiClient({
    baseUrl: mismatchedLengthServer,
    bearerToken: token,
  });
  await assert.rejects(
    mismatchedLengthClient.execute("GetWorkspaceStatus"),
    (error: unknown) => isHostClientError(error) && error.code === "integrity_error",
  );

  const wrongSnapshotId = "snapshot_019f0000-0000-7000-8000-000000000098";
  const mismatchedSnapshotServer = await startFakeServer(t, (_request, response) => {
    writeJson(response, 200, { snapshot_id: wrongSnapshotId });
  });
  const mismatchedSnapshotClient = new HostLocalApiClient({
    baseUrl: mismatchedSnapshotServer,
    bearerToken: token,
  });
  await assert.rejects(
    mismatchedSnapshotClient.execute("GetSnapshot", {
      snapshot_id: "snapshot_019f0000-0000-7000-8000-000000000097",
    }),
    (error: unknown) => isHostClientError(error) && error.code === "integrity_error",
  );

  const oversizedProjectionServer = await startFakeServer(t, (request, response) => {
    if (request.url === "/v1/status") {
      writeJson(response, 200, {
        status: "degraded",
        runtime_connected: false,
        message: "x".repeat(1025),
      });
      return;
    }
    writeJson(response, 200, { items: Array.from({ length: 501 }, () => ({})) });
  });
  const oversizedProjectionClient = new HostLocalApiClient({
    baseUrl: oversizedProjectionServer,
    bearerToken: token,
  });
  await assert.rejects(
    oversizedProjectionClient.execute("GetWorkspaceStatus"),
    (error: unknown) => isHostClientError(error) && error.code === "integrity_error",
  );
  await assert.rejects(
    oversizedProjectionClient.execute("ListSnapshots"),
    (error: unknown) => isHostClientError(error) && error.code === "integrity_error",
  );

  const transportFailures: Array<"protocol_error" | "remote_error"> = [
    "protocol_error",
    "remote_error",
  ];
  const failureHost = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: {
      async captureSnapshot(): Promise<never> {
        const code = transportFailures.shift();
        if (code === undefined) {
          throw new Error("No transport failure remains.");
        }
        throw new LoopbackTransportError(code, "private Runtime transport detail");
      },
    },
    workspace,
    objects,
    validator,
  });
  t.after(() => failureHost.close());
  const failureClient = new HostLocalApiClient({
    baseUrl: failureHost.baseUrl,
    bearerToken: failureHost.bearerToken,
  });
  for (const [expectedCode, expectedExit] of [
    ["integrity_error", 9],
    ["internal", 10],
  ] as const) {
    await assert.rejects(failureClient.execute("CaptureSnapshot"), (error: unknown) => {
      assert.equal(isHostClientError(error), true);
      assert.equal((error as { readonly code: string }).code, expectedCode);
      assert.equal((error as Error).message.includes("private Runtime transport detail"), false);
      return true;
    });
    assert.equal(exitCodeFor(expectedCode), expectedExit);
  }
});

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  return await runProcess(process.execPath, [emittedCliPath, ...arguments_], environment);
}

async function runProcess(
  command: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  timeout.unref();
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code === null) {
        reject(new Error("Agent adapter process terminated unexpectedly."));
      } else {
        resolve(code);
      }
    });
  });
  clearTimeout(timeout);
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function parseCliEnvelope(source: string): {
  readonly request_id: string;
  readonly trace_id: string;
  readonly data: JsonObject | null;
  readonly warnings: readonly JsonObject[];
  readonly error: JsonObject | null;
} {
  assert.equal(source.endsWith("\n"), true);
  assert.equal(source.trim().split("\n").length, 1);
  const value = JSON.parse(source) as {
    readonly request_id: string;
    readonly trace_id: string;
    readonly data: JsonObject | null;
    readonly warnings: readonly JsonObject[];
    readonly error: JsonObject | null;
  };
  assert.deepEqual(Object.keys(value), ["request_id", "trace_id", "data", "warnings", "error"]);
  assert.match(value.request_id, /^request_/);
  assert.match(value.trace_id, /^trace_/);
  assert.deepEqual(value.warnings, []);
  return value;
}

function assertTokenAbsent(result: ProcessResult, token: string): void {
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
}

async function loadCaptureFixtures(validator: ProtocolValidator): Promise<readonly CaptureFixture[]> {
  const [artifactSource, objectFixtureSource, iosSource, androidSource] = await Promise.all([
    readJson("protocol/fixtures/v1/artifact/valid/screenshot.json"),
    readJson("protocol/fixtures/v1/object/valid/plain-text.json"),
    readJson("protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
    readJson("protocol/fixtures/v1/runtime-snapshot/valid/android-view.json"),
  ]);
  const artifact = artifactSource as Record<string, unknown>;
  const objectFixture = objectFixtureSource as Record<string, unknown>;
  const object = structuredClone(artifact["object"]) as ObjectRef;
  const payloadBase64 = objectFixture["payload_base64"];
  assert.equal(typeof payloadBase64, "string");
  const bytes = Buffer.from(payloadBase64 as string, "base64");
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, object.hash);
  validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
  return [iosSource, androidSource].map((source) => {
    const snapshot = structuredClone(source) as Record<string, unknown>;
    const screenshot = snapshot["screenshot"] as Record<string, unknown>;
    screenshot["object"] = structuredClone(object);
    validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshot);
    return { snapshot: snapshot as RuntimeSnapshot, object, bytes };
  });
}

async function* streamBytes(bytes: Uint8Array): ByteStream {
  yield new Uint8Array(bytes);
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")) as unknown;
}

async function startFakeServer(
  t: TestContext,
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${(address as { readonly port: number }).port}`;
}

function writeJson(response: http.ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
  });
  response.end(body);
}
