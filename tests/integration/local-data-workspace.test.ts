import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  isDataError,
  PROTOCOL_SCHEMA_IDS,
  type ObjectRef,
  type ProtocolValidator,
  type RuntimeSnapshot,
} from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import {
  CaptureSnapshotUseCase,
  FixtureRuntimeCapturePort,
  GetSnapshotQuery,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

test("one Host owns a local Workspace until clean close", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const first = await LocalDataWorkspace.open({ workspaceRoot, validator });

  await assert.rejects(
    LocalDataWorkspace.open({ workspaceRoot, validator }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  assert.equal(first.data.checkHealth().ok, true);
  assert.equal(
    (await fs.stat(path.join(workspaceRoot, "metadata.sqlite"))).isFile(),
    true,
  );
  const read = first.data.beginUnitOfWork("read");
  await assert.rejects(first.close(), (error: unknown) => isDataError(error, "conflict"));
  await assert.rejects(
    LocalDataWorkspace.open({ workspaceRoot, validator }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  read.rollback();
  await first.close();

  const reopened = await LocalDataWorkspace.open({ workspaceRoot, validator });
  assert.equal(reopened.data.checkHealth().ok, true);
  await reopened.close();
  await assert.rejects(fs.stat(path.join(workspaceRoot, ".host.lock")), { code: "ENOENT" });
});

test("production local storage reopens one captured Snapshot and its exact object", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const fixture = await captureFixture(validator);
  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });

  const captured = await new CaptureSnapshotUseCase({
    runtime: new FixtureRuntimeCapturePort({
      snapshot: fixture.snapshot,
      objects: [{ ref: fixture.object, chunks: [fixture.bytes] }],
    }),
    workspace: workspace.data,
    objects: workspace.objects,
    validator,
  }).execute({
    include: { paths: ["trees", "screenshot"] },
    screenshot: "reference",
    reason: "manual",
  });
  assert.equal(captured.snapshot_id, fixture.snapshot.snapshot_id);
  await workspace.close();

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  assert.deepEqual(
    new GetSnapshotQuery(workspace.data).execute(fixture.snapshot.snapshot_id),
    fixture.snapshot,
  );
  assert.deepEqual(await collect(await workspace.objects.open(fixture.object.hash)), fixture.bytes);
  await workspace.close();
});

async function temporaryWorkspace(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-local-workspace-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function captureFixture(
  validator: ProtocolValidator,
): Promise<{ snapshot: RuntimeSnapshot; object: ObjectRef; bytes: Uint8Array }> {
  const [snapshotSource, artifact, objectFixture] = await Promise.all([
    readJson("protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
    readJson("protocol/fixtures/v1/artifact/valid/screenshot.json"),
    readJson("protocol/fixtures/v1/object/valid/plain-text.json"),
  ]);
  const snapshot = structuredClone(snapshotSource) as Record<string, unknown>;
  const screenshot = snapshot["screenshot"] as Record<string, unknown>;
  const object = structuredClone(
    (artifact as Record<string, unknown>)["object"],
  ) as ObjectRef;
  screenshot["object"] = object;
  const payloadBase64 = (objectFixture as Record<string, unknown>)["payload_base64"];
  assert.equal(typeof payloadBase64, "string");
  const bytes = Buffer.from(payloadBase64 as string, "base64");
  assert.equal(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    object.hash,
  );
  validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshot);
  validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
  return { snapshot: snapshot as RuntimeSnapshot, object, bytes };
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(path.join(repositoryRoot, relativePath), "utf8"),
  ) as unknown;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
