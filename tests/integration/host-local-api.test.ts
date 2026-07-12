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
