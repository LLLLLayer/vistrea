import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  isDataError,
  PROTOCOL_SCHEMA_IDS,
  type CommitManifest,
  type ObjectRef,
  type ProtocolValidator,
  type RefUpdatePrecondition,
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

test("a full pack moves committed history between two local Workspaces", async (t) => {
  const validator = await validatorPromise;
  const source = await LocalDataWorkspace.open({
    workspaceRoot: await temporaryWorkspace(t),
    validator,
  });
  const target = await LocalDataWorkspace.open({
    workspaceRoot: await temporaryWorkspace(t),
    validator,
  });
  t.after(async () => {
    for (const workspace of [source, target]) {
      try {
        await workspace.close();
      } catch {
        // The workspace may already be closed by the test body.
      }
    }
  });

  const payload = Buffer.from('{"screens":["demo.home"]}', "utf8");
  const graphObject = await source.objects.put(
    (async function* () {
      yield payload;
    })(),
    {
      media_type: "application/vnd.vistrea.graph+json",
      compression: "none",
      logical_name: "graph-root.json",
    },
  );
  source.data.registerVerifiedObjects([graphObject]);
  const write = source.data.beginUnitOfWork("write");
  const commit = write.versions.createCommit({
    protocol_version: { major: 1, minor: 0 },
    parents: [],
    created_at: "2026-07-12T07:00:00.000Z",
    author: { kind: "human", id: "exchange-test@vistrea.dev", extensions: {} },
    message: "Record the exchanged runtime graph.",
    roots: { runtime_graph: graphObject },
    object_hashes: [graphObject.hash],
    extensions: {},
  } as unknown as CommitManifest);
  write.versions.updateRef("teams/im/main", commit.commit_id, {
    mode: "must_not_exist",
  } as unknown as RefUpdatePrecondition);
  write.commit();

  const pack = await source.exchange.exportPack({
    ref_names: ["teams/im/main"],
    created_by: { kind: "human", id: "exchange-test@vistrea.dev", extensions: {} },
  });
  const transferred = await target.objects.put(await source.objects.open(pack.hash), {
    expected_hash: pack.hash,
    media_type: pack.media_type,
    compression: pack.compression,
    extensions: pack.extensions,
  });
  const result = await target.exchange.importPack({ pack: transferred });
  assert.deepEqual(result.imported_commit_ids, [commit.commit_id]);
  assert.deepEqual(result.imported_object_hashes, [graphObject.hash]);

  const read = target.data.beginUnitOfWork("read");
  assert.deepEqual(read.versions.getCommit(commit.commit_id), commit);
  assert.equal(read.versions.resolveRef("teams/im/main").commit_id, commit.commit_id);
  read.rollback();
  assert.deepEqual(await collect(await target.objects.open(graphObject.hash)), payload);
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
