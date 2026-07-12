import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { startHostLocalApi, type HostLocalApiHandle } from "../../apps/host/index.js";
import {
  DataError,
  isDataError,
  PROTOCOL_SCHEMA_IDS,
  type ObjectRef,
  type ProtocolValidator,
  type RuntimeSnapshot,
} from "../../data/api/index.js";
import { createRepositoryProtocolValidator, MemoryDataStore } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import {
  FixtureRuntimeCapturePort,
  type CaptureSnapshotCommand,
  type RuntimeCaptureOptions,
  type RuntimeCapturePort,
  type RuntimeCaptureResult,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

interface CaptureFixture {
  readonly snapshot: RuntimeSnapshot;
  readonly object: ObjectRef;
  readonly bytes: Buffer;
}

class RecordingRuntimeCapturePort implements RuntimeCapturePort {
  command: CaptureSnapshotCommand | undefined;
  captureCount = 0;

  constructor(private readonly delegate: RuntimeCapturePort) {}

  async captureSnapshot(
    command: CaptureSnapshotCommand,
    options?: RuntimeCaptureOptions,
  ): Promise<RuntimeCaptureResult> {
    this.captureCount += 1;
    this.command = structuredClone(command);
    return await this.delegate.captureSnapshot(command, options);
  }
}

test("Host Local API exposes canonical fixture capture, list, object, and error contracts", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t, "vistrea-host-api-memory-");
  const fixture = await captureFixture(validator);
  const workspace = new MemoryDataStore({ validator });
  const objects = await FileObjectStore.open({ workspaceRoot });
  const runtime = new RecordingRuntimeCapturePort(
    new FixtureRuntimeCapturePort({
      snapshot: fixture.snapshot,
      objects: [{ ref: fixture.object, chunks: [fixture.bytes.subarray(0, 2), fixture.bytes.subarray(2)] }],
    }),
  );

  await assert.rejects(
    startHostLocalApi({
      host: "0.0.0.0" as "127.0.0.1",
      runtime,
      workspace,
      objects,
      validator,
    }),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );

  const api = await startHostLocalApi({
    host: "127.0.0.1",
    maximumJsonBodyBytes: 128,
    runtime,
    workspace,
    objects,
    validator,
  });
  t.after(() => api.close());
  assert.equal(api.host, "127.0.0.1");
  assert.match(api.baseUrl, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.match(api.bearerToken, /^[A-Za-z0-9_-]{43}$/);

  const missingAuthentication = await fetch(`${api.baseUrl}/v1/status`);
  assert.equal(missingAuthentication.status, 401);
  assert.equal(
    missingAuthentication.headers.get("www-authenticate"),
    'Bearer realm="vistrea-local", charset="UTF-8"',
  );
  await assertErrorBody(missingAuthentication, {
    code: "unauthenticated",
    message: "A valid Host Local API bearer token is required.",
    retryable: false,
  });

  const wrongAuthentication = await fetch(`${api.baseUrl}/v1/status`, {
    headers: { authorization: `Bearer ${"x".repeat(43)}` },
  });
  assert.equal(wrongAuthentication.status, 401);
  const wrongAuthenticationSource = JSON.stringify(await wrongAuthentication.json());
  assert.equal(wrongAuthenticationSource.includes(api.bearerToken), false);

  const statusResponse = await authorizedFetch(api, "/v1/status");
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    status: "ready",
    runtime_connected: true,
  });

  const captureResponse = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(captureResponse.status, 201);
  assert.deepEqual(await captureResponse.json(), fixture.snapshot);
  assert.deepEqual(runtime.command, {
    include: { paths: ["trees", "screenshot"] },
    screenshot: "reference",
    reason: "manual",
  });

  const listResponse = await authorizedFetch(api, "/v1/snapshots?limit=1");
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), {
    items: [
      {
        snapshot_id: fixture.snapshot.snapshot_id,
        captured_at: fixture.snapshot.captured_at,
        runtime_context: fixture.snapshot.runtime_context,
      },
    ],
    snapshot_version: "memory:1",
  });

  const emptyTimeline = await authorizedFetch(api, "/v1/events");
  assert.equal(emptyTimeline.status, 200);
  assert.deepEqual(await emptyTimeline.json(), { events: [], reported_gaps: [] });

  const eventBatch = JSON.parse(
    await fs.readFile(
      path.join(
        repositoryRoot,
        "protocol/fixtures/v1/runtime-event-batch/valid/ordered-with-filtered-gap.json",
      ),
      "utf8",
    ),
  ) as { event_epoch_id: string; events: readonly { kind: string }[] };
  const eventUnit = workspace.beginUnitOfWork("write");
  eventUnit.runtimeEvents.appendBatch(eventBatch as never);
  eventUnit.commit();
  const timelineResponse = await authorizedFetch(
    api,
    `/v1/events?event_epoch_id=${encodeURIComponent(eventBatch.event_epoch_id)}`,
  );
  assert.equal(timelineResponse.status, 200);
  const timelineBody = (await timelineResponse.json()) as {
    events: readonly Record<string, unknown>[];
  };
  assert.equal(timelineBody.events.length, eventBatch.events.length);

  const filteredTimeline = await authorizedFetch(
    api,
    "/v1/events?kinds=screen_changed&first_sequence=0&last_sequence=99",
  );
  assert.equal(filteredTimeline.status, 200);
  const filteredBody = (await filteredTimeline.json()) as {
    events: readonly Record<string, unknown>[];
  };
  assert.equal(
    filteredBody.events.every((event) => event["kind"] === "screen_changed"),
    true,
  );

  const invalidTimeline = await authorizedFetch(api, "/v1/events?event_epoch_id=not-an-epoch");
  assert.equal(invalidTimeline.status, 400);
  const unknownTimelineParameter = await authorizedFetch(api, "/v1/events?foo=1");
  assert.equal(unknownTimelineParameter.status, 400);

  const getResponse = await authorizedFetch(
    api,
    `/v1/snapshots/${encodeURIComponent(fixture.snapshot.snapshot_id)}`,
  );
  assert.equal(getResponse.status, 200);
  const getBody = await getResponse.json();
  assert.deepEqual(getBody, fixture.snapshot);
  assert.equal(Object.hasOwn(getBody as object, "data"), false);
  assert.equal(Object.hasOwn(getBody as object, "snapshot"), false);

  const objectResponse = await authorizedFetch(
    api,
    `/v1/objects/${encodeURIComponent(fixture.object.hash)}`,
  );
  assert.equal(objectResponse.status, 200);
  assert.equal(objectResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(objectResponse.headers.get("content-type"), fixture.object.media_type);
  assert.equal(objectResponse.headers.get("etag"), `"${fixture.object.hash}"`);
  assert.deepEqual(Buffer.from(await objectResponse.arrayBuffer()), fixture.bytes);

  const rangeResponse = await authorizedFetch(
    api,
    `/v1/objects/${encodeURIComponent(fixture.object.hash)}`,
    { headers: { range: "bytes=1-3" } },
  );
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), `bytes 1-3/${fixture.bytes.byteLength}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), fixture.bytes.subarray(1, 4));

  const suffixResponse = await authorizedFetch(
    api,
    `/v1/objects/${encodeURIComponent(fixture.object.hash)}`,
    { headers: { range: "bytes=-2" } },
  );
  assert.equal(suffixResponse.status, 206);
  assert.deepEqual(Buffer.from(await suffixResponse.arrayBuffer()), fixture.bytes.subarray(-2));

  const invalidRange = await authorizedFetch(
    api,
    `/v1/objects/${encodeURIComponent(fixture.object.hash)}`,
    { headers: { range: "bytes=0-1,3-4" } },
  );
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-range"), `bytes */${fixture.bytes.byteLength}`);
  await assertErrorBody(invalidRange, {
    code: "invalid_argument",
    message: "The requested byte range is invalid or unsatisfiable.",
    retryable: false,
  });

  const invalidRoute = await authorizedFetch(api, "/v1/unknown");
  assert.equal(invalidRoute.status, 404);
  await assertErrorBody(invalidRoute, {
    code: "not_found",
    message: "The requested Host Local API route does not exist.",
    retryable: false,
  });

  const invalidMethod = await authorizedFetch(api, "/v1/status", { method: "POST" });
  assert.equal(invalidMethod.status, 405);
  assert.equal(invalidMethod.headers.get("allow"), "GET");
  await assertErrorBody(invalidMethod, {
    code: "unsupported",
    message: "This route requires GET.",
    retryable: false,
  });

  const invalidJson = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  await assertErrorBody(invalidJson, {
    code: "invalid_argument",
    message: "The request body is not valid UTF-8 JSON.",
    retryable: false,
  });

  const invalidUtf8 = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  });
  assert.equal(invalidUtf8.status, 400);
  await assertErrorBody(invalidUtf8, {
    code: "invalid_argument",
    message: "The request body is not valid UTF-8 JSON.",
    retryable: false,
  });

  for (const duplicateBody of [
    '{"reason":"manual","\\u0072eason":"review"}',
    '{"include":{"paths":["trees"],"paths":["screenshot"]}}',
  ]) {
    const duplicateKey = await authorizedFetch(api, "/v1/captures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: duplicateBody,
    });
    assert.equal(duplicateKey.status, 400);
    await assertErrorBody(duplicateKey, {
      code: "invalid_argument",
      message: "JSON object keys must be unique.",
      retryable: false,
    });
  }
  assert.equal(runtime.captureCount, 1);

  const unknownCaptureField = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unknown: true }),
  });
  assert.equal(unknownCaptureField.status, 400);
  await assertErrorBody(unknownCaptureField, {
    code: "invalid_argument",
    message: "Capture request contains unsupported fields: unknown.",
    retryable: false,
  });

  const invalidCapture = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ private_snapshot: fixture.snapshot }),
  });
  assert.equal(invalidCapture.status, 413);
  await assertErrorBody(invalidCapture, {
    code: "resource_exhausted",
    message: "The JSON request body exceeds the 128-byte limit.",
    retryable: false,
  });

  const unsupportedContentType = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(unsupportedContentType.status, 415);
  await assertErrorBody(unsupportedContentType, {
    code: "unsupported",
    message: "The request Content-Type must be application/json.",
    retryable: false,
  });

  const privateFailure = `private failure at ${workspaceRoot}`;
  const failingApi = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: {
      async captureSnapshot(): Promise<never> {
        throw new Error(privateFailure);
      },
    },
    workspace,
    objects,
    validator,
  });
  t.after(() => failingApi.close());
  const internalFailure = await authorizedFetch(failingApi, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(internalFailure.status, 500);
  const internalFailureSource = await internalFailure.text();
  assert.equal(internalFailureSource.includes(privateFailure), false);
  const internalFailureBody = JSON.parse(internalFailureSource) as {
    readonly request_id: string;
    readonly error: unknown;
  };
  assert.match(internalFailureBody.request_id, /^request_/);
  assert.deepEqual(internalFailureBody.error, {
    code: "internal",
    message: "The Host could not complete the request.",
    retryable: false,
  });

  const privateInvalidArgument = `invalid path=${workspaceRoot} token=private-local-token`;
  const invalidArgumentApi = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: {
      async captureSnapshot(): Promise<never> {
        throw new DataError("invalid_argument", privateInvalidArgument);
      },
    },
    workspace,
    objects,
    validator,
  });
  t.after(() => invalidArgumentApi.close());
  const invalidArgumentFailure = await authorizedFetch(invalidArgumentApi, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(invalidArgumentFailure.status, 400);
  const invalidArgumentSource = await invalidArgumentFailure.text();
  assert.equal(invalidArgumentSource.includes(privateInvalidArgument), false);
  assert.equal(invalidArgumentSource.includes(workspaceRoot), false);
  const invalidArgumentBody = JSON.parse(invalidArgumentSource) as {
    readonly request_id: string;
    readonly error: unknown;
  };
  assert.match(invalidArgumentBody.request_id, /^request_/);
  assert.deepEqual(invalidArgumentBody.error, {
    code: "invalid_argument",
    message: "The request was rejected as invalid.",
    retryable: false,
  });
});

test("Host Local API drives the design review flow from asset to verified issue", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t, "vistrea-host-api-design-");
  const fixture = await captureFixture(validator);
  const workspace = new MemoryDataStore({ validator });
  const objects = await FileObjectStore.open({ workspaceRoot });
  const runtime = new RecordingRuntimeCapturePort(
    new FixtureRuntimeCapturePort({
      snapshot: fixture.snapshot,
      objects: [{ ref: fixture.object, chunks: [fixture.bytes] }],
    }),
  );
  const api = await startHostLocalApi({
    host: "127.0.0.1",
    runtime,
    workspace,
    objects,
    validator,
  });
  t.after(() => api.close());
  const actor = { kind: "agent", id: "vistrea-api-test", extensions: {} };

  // Capture one Snapshot so design targets resolve.
  const capture = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(capture.status, 201);
  const snapshot = (await capture.json()) as {
    snapshot_id: string;
    trees: readonly {
      tree_id: string;
      payload: { inline_nodes: readonly { node_id: string; stable_id?: string }[] };
    }[];
  };
  const tree = snapshot.trees[0];
  assert.ok(tree !== undefined);
  const node = tree.payload.inline_nodes.find((candidate) => candidate.stable_id !== undefined);
  assert.ok(node !== undefined);

  const assetUpload = await authorizedFetch(api, "/v1/design-assets", {
    method: "POST",
    headers: { "content-type": "image/png", "x-vistrea-logical-name": "home-baseline.png" },
    body: Buffer.from("vistrea-design-asset", "utf8"),
  });
  assert.equal(assetUpload.status, 201);
  const asset = (await assetUpload.json()) as { hash: string; media_type: string };
  assert.equal(asset.media_type, "image/png");

  const referenceResponse = await authorizedFetch(api, "/v1/design-references", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Home baseline",
      kind: "design_artifact",
      canvas_size: { width: 390, height: 844 },
      pixel_size: { width: 1170, height: 2532 },
      asset_hash: asset.hash,
      created_by: actor,
    }),
  });
  assert.equal(referenceResponse.status, 201);
  const reference = (await referenceResponse.json()) as { design_reference_id: string };

  const mappingResponse = await authorizedFetch(api, "/v1/design-mappings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      design_reference_id: reference.design_reference_id,
      design_region: { x: 0, y: 10, width: 390, height: 844 },
      runtime_target: {
        snapshot_id: snapshot.snapshot_id,
        tree_id: tree.tree_id,
        node_id: node.node_id,
        ...(node.stable_id === undefined ? {} : { stable_id: node.stable_id }),
      },
      created_by: actor,
    }),
  });
  assert.equal(mappingResponse.status, 201);

  const comparisonResponse = await authorizedFetch(api, "/v1/design-comparisons", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      design_reference_id: reference.design_reference_id,
      target_snapshot_id: snapshot.snapshot_id,
      completed_by: actor,
    }),
  });
  assert.equal(comparisonResponse.status, 201);
  const comparison = (await comparisonResponse.json()) as {
    comparison_id: string;
    differences: readonly { category: string; delta?: number }[];
  };
  assert.equal(comparison.differences.length, 1);
  assert.equal(comparison.differences[0]?.category, "frame");
  const comparisonReload = await authorizedFetch(
    api,
    `/v1/design-comparisons/${encodeURIComponent(comparison.comparison_id)}`,
  );
  assert.equal(comparisonReload.status, 200);

  const issueResponse = await authorizedFetch(api, "/v1/review-issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      design_reference_id: reference.design_reference_id,
      comparison_id: comparison.comparison_id,
      runtime_target: {
        snapshot_id: snapshot.snapshot_id,
        tree_id: tree.tree_id,
        node_id: node.node_id,
      },
      title: "Root container offset from baseline",
      category: "frame",
      severity: "minor",
      expected: { kind: "number", value: 10, unit: "logical_point", extensions: {} },
      actual: { kind: "number", value: 0, unit: "logical_point", extensions: {} },
      created_by: actor,
    }),
  });
  assert.equal(issueResponse.status, 201);
  const issue = (await issueResponse.json()) as { issue_id: string; revision: number };

  const transition = await authorizedFetch(
    api,
    `/v1/review-issues/${encodeURIComponent(issue.issue_id)}/transitions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: issue.revision,
        to_state: "ready_for_verification",
        changed_by: actor,
      }),
    },
  );
  assert.equal(transition.status, 200);
  const ready = (await transition.json()) as { revision: number; state: string };
  assert.equal(ready.state, "ready_for_verification");

  const verification = await authorizedFetch(
    api,
    `/v1/review-issues/${encodeURIComponent(issue.issue_id)}/verifications`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: ready.revision,
        basis: "real_build",
        result: "passed",
        verified_snapshot_id: snapshot.snapshot_id,
        verified_build_id: "build_019f0000-0000-7000-8000-000000000002",
        verified_by: actor,
      }),
    },
  );
  assert.equal(verification.status, 201);
  const verified = (await verification.json()) as {
    issue: { state: string };
    record: { result: string };
  };
  assert.equal(verified.issue.state, "resolved");
  assert.equal(verified.record.result, "passed");

  const listed = await authorizedFetch(api, "/v1/review-issues?states=resolved");
  assert.equal(listed.status, 200);
  const page = (await listed.json()) as { items: readonly { issue_id: string }[] };
  assert.deepEqual(
    page.items.map((item) => item.issue_id),
    [issue.issue_id],
  );
  const reloaded = await authorizedFetch(
    api,
    `/v1/review-issues/${encodeURIComponent(issue.issue_id)}`,
  );
  assert.equal(reloaded.status, 200);

  const illegalTransition = await authorizedFetch(
    api,
    `/v1/review-issues/${encodeURIComponent(issue.issue_id)}/transitions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: 999,
        to_state: "wont_fix",
        changed_by: actor,
      }),
    },
  );
  assert.equal(illegalTransition.status, 409);
  const emptyAsset = await authorizedFetch(api, "/v1/design-assets", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.alloc(0),
  });
  assert.equal(emptyAsset.status, 400);
});

test("Host Local API records deduplicated Screen States, Transitions, and paths", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t, "vistrea-host-api-graph-");
  const fixture = await captureFixture(validator);
  const workspace = new MemoryDataStore({ validator });
  const objects = await FileObjectStore.open({ workspaceRoot });
  const runtime = new FixtureRuntimeCapturePort({
    snapshot: fixture.snapshot,
    objects: [{ ref: fixture.object, chunks: [fixture.bytes] }],
  });
  const api = await startHostLocalApi({
    host: "127.0.0.1",
    runtime,
    workspace,
    objects,
    validator,
  });
  t.after(() => api.close());

  // Capture the Home structure, then persist a structurally different target.
  const capture = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(capture.status, 201);
  const homeSnapshot = (await capture.json()) as Record<string, unknown> & {
    snapshot_id: string;
    runtime_context: { project_id: string; application_id: string };
  };
  const detailSnapshot = structuredClone(homeSnapshot) as unknown as Record<string, unknown> & {
    snapshot_id: string;
    trees: readonly {
      payload: {
        inline_nodes: {
          node_id: string;
          child_ids: string[];
          parent_id?: string;
        }[];
      };
    }[];
  };
  detailSnapshot["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-00000000d0d0";
  delete detailSnapshot["screenshot"];
  const detailTree = detailSnapshot.trees[0];
  assert.ok(detailTree !== undefined);
  const detailRoot = detailTree.payload.inline_nodes[0];
  assert.ok(detailRoot !== undefined);
  const addedNodeId = "node_019f0000-0000-7000-8000-00000000fff0";
  detailRoot.child_ids = [...detailRoot.child_ids, addedNodeId];
  detailTree.payload.inline_nodes.push({
    node_id: addedNodeId,
    parent_id: detailRoot.node_id,
    child_ids: [],
    stable_id: "demo.detail.banner",
    native_type: "UILabel",
    role: "text",
    content: {},
    state: { visible: true, enabled: true },
    actions: [],
    capture_limitations: [],
    related_nodes: [],
    extensions: {},
  } as never);
  {
    const unit = workspace.beginUnitOfWork("write");
    unit.snapshots.put(detailSnapshot as never);
    unit.commit();
  }

  const observed = await authorizedFetch(api, "/v1/screen-graph/state-observations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      snapshot_id: homeSnapshot.snapshot_id,
      title: "Home",
      entry: true,
    }),
  });
  assert.equal(observed.status, 201);
  const observedBody = (await observed.json()) as {
    created: boolean;
    graph_revision: number;
    screen_graph_id: string;
    screen_state: { screen_state_id: string; revision: number };
  };
  assert.equal(observedBody.created, true);
  assert.equal(observedBody.graph_revision, 1);

  const repeated = await authorizedFetch(api, "/v1/screen-graph/state-observations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot_id: homeSnapshot.snapshot_id }),
  });
  assert.equal(repeated.status, 201);
  const repeatedBody = (await repeated.json()) as {
    created: boolean;
    screen_state: { screen_state_id: string; revision: number };
  };
  assert.equal(repeatedBody.created, false);
  assert.equal(
    repeatedBody.screen_state.screen_state_id,
    observedBody.screen_state.screen_state_id,
  );
  assert.equal(repeatedBody.screen_state.revision, 2);

  const transition = await authorizedFetch(api, "/v1/screen-graph/transition-observations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      before_snapshot_id: homeSnapshot.snapshot_id,
      after_snapshot_id: detailSnapshot.snapshot_id,
      action: {
        kind: "tap",
        requested_effect: "Open the detail screen",
        target: { stable_id: "demo.home.open_catalog" },
      },
    }),
  });
  assert.equal(transition.status, 201);
  const transitionBody = (await transition.json()) as {
    created: boolean;
    source_state_id: string;
    target_state_id: string;
    transition: { transition_id: string; occurrence_count: number };
  };
  assert.equal(transitionBody.created, true);
  assert.equal(transitionBody.source_state_id, observedBody.screen_state.screen_state_id);
  assert.equal(transitionBody.transition.occurrence_count, 1);

  const graphResponse = await authorizedFetch(
    api,
    `/v1/screen-graph?project_id=${encodeURIComponent(homeSnapshot.runtime_context.project_id)}` +
      `&application_id=${encodeURIComponent(homeSnapshot.runtime_context.application_id)}`,
  );
  assert.equal(graphResponse.status, 200);
  const graph = (await graphResponse.json()) as {
    screen_graph_id: string;
    states: readonly unknown[];
    transitions: readonly unknown[];
    observations: readonly unknown[];
  };
  assert.equal(graph.screen_graph_id, observedBody.screen_graph_id);
  assert.equal(graph.states.length, 2);
  assert.equal(graph.transitions.length, 1);
  // Two direct state observations, plus the transition resolving both
  // endpoint states (two more state observations) and its own evidence.
  assert.equal(graph.observations.length, 5);

  const stateResponse = await authorizedFetch(
    api,
    `/v1/screen-states/${encodeURIComponent(transitionBody.target_state_id)}`,
  );
  assert.equal(stateResponse.status, 200);

  const pathResponse = await authorizedFetch(
    api,
    `/v1/screen-graph/paths?source_state_id=${encodeURIComponent(transitionBody.source_state_id)}` +
      `&target_state_id=${encodeURIComponent(transitionBody.target_state_id)}`,
  );
  assert.equal(pathResponse.status, 200);
  const paths = (await pathResponse.json()) as {
    paths: readonly { state_ids: readonly string[] }[];
  };
  assert.equal(paths.paths.length, 1);
  assert.deepEqual(paths.paths[0]?.state_ids, [
    transitionBody.source_state_id,
    transitionBody.target_state_id,
  ]);

  const missingSnapshot = await authorizedFetch(api, "/v1/screen-graph/state-observations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot_id: "snapshot_019f0000-0000-7000-8000-00000000dead" }),
  });
  assert.equal(missingSnapshot.status, 400);
});

test("Host Local API reopens production LocalDataWorkspace without persisting its token", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t, "vistrea-host-api-production-");
  const fixture = await captureFixture(validator);
  const runtime = new FixtureRuntimeCapturePort({
    snapshot: fixture.snapshot,
    objects: [{ ref: fixture.object, chunks: [fixture.bytes] }],
  });

  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  let api = await startHostLocalApi({
    host: "127.0.0.1",
    runtime,
    workspace: workspace.data,
    objects: workspace.objects,
    validator,
  });
  const firstToken = api.bearerToken;
  const captureResponse = await authorizedFetch(api, "/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: "{}",
  });
  assert.equal(captureResponse.status, 201);
  assert.deepEqual(await captureResponse.json(), fixture.snapshot);
  await api.close();
  await workspace.close();
  await assertDirectoryDoesNotContain(workspaceRoot, firstToken);

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  api = await startHostLocalApi({
    host: "127.0.0.1",
    runtime,
    workspace: workspace.data,
    objects: workspace.objects,
    validator,
  });
  t.after(async () => {
    await api.close();
    try {
      await workspace.close();
    } catch {
      // The test may already have closed the Workspace.
    }
  });
  assert.notEqual(api.bearerToken, firstToken);

  const oldTokenResponse = await fetch(`${api.baseUrl}/v1/status`, {
    headers: { authorization: `Bearer ${firstToken}` },
  });
  assert.equal(oldTokenResponse.status, 401);

  const getResponse = await authorizedFetch(
    api,
    `/v1/snapshots/${encodeURIComponent(fixture.snapshot.snapshot_id)}`,
  );
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), fixture.snapshot);

  const listResponse = await authorizedFetch(api, "/v1/snapshots");
  assert.equal(listResponse.status, 200);
  const listBody = (await listResponse.json()) as { readonly items?: readonly unknown[] };
  assert.deepEqual(listBody.items, [
    {
      snapshot_id: fixture.snapshot.snapshot_id,
      captured_at: fixture.snapshot.captured_at,
      runtime_context: fixture.snapshot.runtime_context,
    },
  ]);

  const objectResponse = await authorizedFetch(
    api,
    `/v1/objects/${encodeURIComponent(fixture.object.hash)}`,
  );
  assert.equal(objectResponse.status, 200);
  assert.deepEqual(Buffer.from(await objectResponse.arrayBuffer()), fixture.bytes);

  await api.close();
  await workspace.close();
});

async function authorizedFetch(
  api: HostLocalApiHandle,
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${api.bearerToken}`);
  return await fetch(`${api.baseUrl}${route}`, { ...init, headers });
}

async function assertErrorBody(
  response: Response,
  expected: { readonly code: string; readonly message: string; readonly retryable: boolean },
): Promise<void> {
  const body = (await response.json()) as {
    readonly request_id?: unknown;
    readonly error?: unknown;
  };
  assert.deepEqual(Object.keys(body).sort(), ["error", "request_id"]);
  assert.equal(typeof body.request_id, "string");
  assert.match(
    body.request_id as string,
    /^request_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(response.headers.get("x-vistrea-request-id"), body.request_id);
  assert.deepEqual(body.error, expected);
}

async function captureFixture(validator: ProtocolValidator): Promise<CaptureFixture> {
  const [snapshotSource, artifactSource, objectFixtureSource] = await Promise.all([
    readJson("protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
    readJson("protocol/fixtures/v1/artifact/valid/screenshot.json"),
    readJson("protocol/fixtures/v1/object/valid/plain-text.json"),
  ]);
  const snapshot = structuredClone(snapshotSource) as Record<string, unknown>;
  const screenshot = snapshot["screenshot"] as Record<string, unknown>;
  const artifact = artifactSource as Record<string, unknown>;
  const objectFixture = objectFixtureSource as Record<string, unknown>;
  const object = structuredClone(artifact["object"]) as ObjectRef;
  screenshot["object"] = object;
  const payloadBase64 = objectFixture["payload_base64"];
  assert.equal(typeof payloadBase64, "string");
  const bytes = Buffer.from(payloadBase64 as string, "base64");
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, object.hash);
  validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshot);
  validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
  return { snapshot: snapshot as RuntimeSnapshot, object, bytes };
}

async function temporaryWorkspace(t: TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")) as unknown;
}

async function assertDirectoryDoesNotContain(directory: string, value: string): Promise<void> {
  const needle = Buffer.from(value, "utf8");
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(entryPath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        assert.equal((await fs.readFile(entryPath)).includes(needle), false, entryPath);
      }
    }
  }
}
