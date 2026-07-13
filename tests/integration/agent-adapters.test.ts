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

test("the CLI preserves Host operation results, errors, and toolset focus", async (t) => {
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
    ...process.env,
    VISTREA_HOST_URL: host.baseUrl,
    VISTREA_HOST_TOKEN: host.bearerToken,
    VISTREA_CLI_TOOLSETS: "",
  };

  const cliStatus = await runCli(["workspace", "status", "--format", "json"], environment);
  assert.equal(cliStatus.exitCode, 0);
  assert.equal(cliStatus.stderr, "");
  assertTokenAbsent(cliStatus, host.bearerToken);
  const cliStatusEnvelope = parseCliEnvelope(cliStatus.stdout);

  assert.equal((cliStatusEnvelope.data as JsonObject)["status"], "ready");

  // A composition focused on exploration and asset recording masks the
  // verification surface on both sides: the commands vanish from help and a
  // masked invocation fails closed instead of quietly executing.
  const focusedEnvironment = { ...environment, VISTREA_CLI_TOOLSETS: "assets,exploration" };
  const maskedValidate = await runCli(
    ["validate", "snapshot", "--snapshot", "snapshot_019f0000-0000-7000-8000-000000000001"],
    focusedEnvironment,
  );
  assert.equal(maskedValidate.exitCode, 6);
  const maskedEnvelope = parseCliEnvelope(maskedValidate.stdout);
  assert.equal(maskedEnvelope.error?.["code"], "unsupported");
  assert.match(
    maskedEnvelope.error?.["message"] as string,
    /validate commands are not exposed by this toolset configuration/,
  );
  const maskedDesign = await runCli(["design", "list-references"], focusedEnvironment);
  assert.equal(maskedDesign.exitCode, 6);
  const focusedStatus = await runCli(["workspace", "status"], focusedEnvironment);
  assert.equal(focusedStatus.exitCode, 0);
  const focusedHelp = await runCli(["help"], focusedEnvironment);
  assert.equal(focusedHelp.exitCode, 0);
  const focusedCommands = (parseCliEnvelope(focusedHelp.stdout).data as JsonObject)[
    "commands"
  ] as readonly string[];
  assert.equal(
    focusedCommands.some((line) =>
      ["design", "issue", "tuning", "validate", "wiki"].includes(line.split(" ")[0] as string),
    ),
    false,
  );
  assert.equal(
    focusedCommands.some((line) => line.startsWith("explore run")),
    true,
  );
  const unknownToolset = await runCli(["workspace", "status"], {
    ...environment,
    VISTREA_CLI_TOOLSETS: "bogus,assets",
  });
  assert.equal(unknownToolset.exitCode, 2);
  assert.match(
    parseCliEnvelope(unknownToolset.stdout).error?.["message"] as string,
    /Unknown VISTREA_CLI_TOOLSETS entries: bogus/,
  );

  const cliCapture = await runCli(["snapshot", "capture"], environment);
  assert.equal(cliCapture.exitCode, 0);
  assert.equal(cliCapture.stderr, "");
  assertTokenAbsent(cliCapture, host.bearerToken);
  const cliCaptureEnvelope = parseCliEnvelope(cliCapture.stdout);
  assert.equal(
    (cliCaptureEnvelope.data as JsonObject)["snapshot_id"],
    fixtures[0]?.snapshot.snapshot_id,
  );

  const secondCapture = await runCli(["snapshot", "capture"], environment);
  assert.equal(secondCapture.exitCode, 0);
  assert.equal(
    (parseCliEnvelope(secondCapture.stdout).data as JsonObject)["snapshot_id"],
    fixtures[1]?.snapshot.snapshot_id,
  );

  const cliList = await runCli(["snapshot", "list", "--limit", "10"], environment);
  assert.equal(cliList.exitCode, 0);
  const cliListEnvelope = parseCliEnvelope(cliList.stdout);
  assert.notEqual(cliListEnvelope.data, null);

  const snapshotId = fixtures[0]?.snapshot.snapshot_id as string;
  const cliGet = await runCli(["snapshot", "get", snapshotId], environment);
  assert.equal(cliGet.exitCode, 0);
  const cliGetEnvelope = parseCliEnvelope(cliGet.stdout);
  assert.equal((cliGetEnvelope.data as JsonObject)["snapshot_id"], snapshotId);

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
  // Design review round trip through the CLI.
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

  const issueRead = await runCli(["issue", "get", issueId], environment);
  assert.equal(issueRead.exitCode, 0, issueRead.stdout);
  assert.deepEqual(parseCliEnvelope(issueRead.stdout).data, verifiedEnvelope["issue"]);
  const issueList = await runCli(["issue", "list", "--states", "resolved"], environment);
  assert.equal(issueList.exitCode, 0, issueList.stdout);
  assert.deepEqual(
    ((parseCliEnvelope(issueList.stdout).data as JsonObject)["items"] as readonly JsonObject[]).map(
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
  const patchRead = await runCli(
    ["tuning", "get-patch", patchEnvelope["patch_id"] as string],
    environment,
  );
  assert.equal(patchRead.exitCode, 0, patchRead.stdout);
  assert.deepEqual(parseCliEnvelope(patchRead.stdout).data, patchEnvelope);
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

  const observeAgain = await runCli(
    ["graph", "observe-state", "--snapshot", capturedSnapshot["snapshot_id"] as string],
    environment,
  );
  assert.equal(observeAgain.exitCode, 0, observeAgain.stdout);
  const observedAgain = parseCliEnvelope(observeAgain.stdout).data as JsonObject;
  assert.equal(observedAgain["created"], false);
  assert.equal(
    (observedAgain["screen_state"] as JsonObject)["screen_state_id"],
    observedScreenState["screen_state_id"],
  );

  const runtimeContext = capturedSnapshot["runtime_context"] as JsonObject;
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
  const graphDocument = parseCliEnvelope(cliGraph.stdout).data as JsonObject;
  assert.equal((graphDocument["states"] as readonly JsonObject[]).length, 1);

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

  const wikiPublish = await runCli(
    [
      "wiki",
      "update",
      wikiNode["wiki_node_id"] as string,
      "--json",
      JSON.stringify({
        expected_revision: 1,
        to_status: "published",
        updated_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(wikiPublish.exitCode, 0, wikiPublish.stdout);
  assert.equal((parseCliEnvelope(wikiPublish.stdout).data as JsonObject)["status"], "published");

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

  const noteCreate = await runCli(
    [
      "wiki",
      "create",
      "--json",
      JSON.stringify({
        kind: "note",
        title: "Follow-up",
        markdown: "Check the banner timing.",
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(noteCreate.exitCode, 0, noteCreate.stdout);
  const note = parseCliEnvelope(noteCreate.stdout).data as JsonObject;

  // Long-form documents (well past the 64 KiB adapter envelope) persist.
  const longMarkdown = `# Long document\n\n${"vistrea knowledge line\n".repeat(6000)}`;
  const longCreate = await runCli(
    [
      "wiki",
      "create",
      "--json",
      JSON.stringify({
        kind: "concept",
        title: "Long-form knowledge",
        markdown: longMarkdown,
        created_by: JSON.parse(actorJson),
      }),
    ],
    environment,
  );
  assert.equal(longCreate.exitCode, 0, longCreate.stdout);
  const longNode = parseCliEnvelope(longCreate.stdout).data as JsonObject;
  const longRead = await runCli(
    ["wiki", "get", longNode["wiki_node_id"] as string],
    environment,
  );
  assert.equal(longRead.exitCode, 0, longRead.stdout);
  const longContent = (parseCliEnvelope(longRead.stdout).data as JsonObject)[
    "content"
  ] as JsonObject;
  assert.equal((longContent["text"] as string).length, longMarkdown.length);
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
  const backlinks = await runCli(
    ["wiki", "backlinks", wikiNode["wiki_node_id"] as string],
    environment,
  );
  assert.equal(backlinks.exitCode, 0, backlinks.stdout);
  assert.equal(
    ((parseCliEnvelope(backlinks.stdout).data as JsonObject)["items"] as readonly JsonObject[])
      .length,
    1,
  );
  const relatedNodes = await runCli(
    ["wiki", "related", "--kind", "snapshot", "--id", capturedSnapshot["snapshot_id"] as string],
    environment,
  );
  assert.equal(relatedNodes.exitCode, 0, relatedNodes.stdout);
  assert.deepEqual(
    ((parseCliEnvelope(relatedNodes.stdout).data as JsonObject)["items"] as readonly JsonObject[])
      .map((item) => item["wiki_node_id"]),
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
  const runRead = await runCli(
    ["validate", "get-run", validationRun["validation_run_id"] as string],
    environment,
  );
  assert.equal(runRead.exitCode, 0, runRead.stdout);
  assert.deepEqual(parseCliEnvelope(runRead.stdout).data, validationRun);
  const findingsRead = await runCli(
    ["validate", "findings", "--run", validationRun["validation_run_id"] as string],
    environment,
  );
  assert.equal(findingsRead.exitCode, 0, findingsRead.stdout);
  assert.deepEqual(
    (parseCliEnvelope(findingsRead.stdout).data as JsonObject)["items"],
    validateEnvelope["findings"],
  );

  // Object bytes round-trip through the sanctioned adapters, never raw curl.
  const objectOutput = path.join(workspaceRoot, "downloaded-design-asset.bin");
  const cliObjectGet = await runCli(
    ["object", "get", "--hash", assetHash, "--output", objectOutput],
    environment,
  );
  assert.equal(cliObjectGet.exitCode, 0, cliObjectGet.stdout);
  const objectEnvelope = parseCliEnvelope(cliObjectGet.stdout).data as JsonObject;
  assert.equal(objectEnvelope["hash"], assetHash);
  assert.equal(objectEnvelope["output"], objectOutput);
  assert.equal(objectEnvelope["bytes_base64"], undefined);
  assert.deepEqual(
    await fs.readFile(objectOutput),
    Buffer.from("vistrea-adapter-design-asset", "utf8"),
  );

  // Refusing to overwrite an existing file keeps the download side effect safe.
  const objectClobber = await runCli(
    ["object", "get", "--hash", assetHash, "--output", objectOutput],
    environment,
  );
  assert.notEqual(objectClobber.exitCode, 0);
  assert.deepEqual(
    await fs.readFile(objectOutput),
    Buffer.from("vistrea-adapter-design-asset", "utf8"),
  );

  const missingSnapshotId = "snapshot_019f0000-0000-7000-8000-000000000099";
  const cliMissing = await runCli(["snapshot", "get", missingSnapshotId], environment);
  assert.equal(cliMissing.exitCode, 3);
  const cliMissingEnvelope = parseCliEnvelope(cliMissing.stdout);
  assert.equal(cliMissingEnvelope.error?.["code"], "not_found");

  const cliInvalidCapture = await runCli(
    ["snapshot", "capture", "--reason", "not-a-reason"],
    environment,
  );
  assert.equal(cliInvalidCapture.exitCode, 2);
  const cliInvalidCaptureEnvelope = parseCliEnvelope(cliInvalidCapture.stdout);
  assert.equal(cliInvalidCaptureEnvelope.error?.["code"], "invalid_argument");

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
