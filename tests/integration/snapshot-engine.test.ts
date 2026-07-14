import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DataError,
  isDataError,
  PROTOCOL_SCHEMA_IDS,
  type ByteRange,
  type ByteStream,
  type Clock,
  type DataErrorCode,
  type DataUnitOfWork,
  type ObjectInventoryQuery,
  type ObjectPutMetadata,
  type ObjectRef,
  type ObjectStore,
  type PageRequest,
  type ProtocolValidator,
  type RetentionPolicy,
  type RuntimeSnapshot,
  type SnapshotQuery,
  type SnapshotRepository,
  type UnitOfWorkBound,
  type UnitOfWorkMode,
  type WorkspaceDataSource,
  type WorkspaceHealth,
} from "../../data/api/index.js";
import {
  createRepositoryProtocolValidator,
  MemoryDataStore,
} from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import {
  CaptureSnapshotUseCase,
  FixtureRuntimeCapturePort,
  GetSnapshotQuery,
  ListSnapshotsQuery,
  type CaptureSnapshotCommand,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const captureCommand: CaptureSnapshotCommand = {
  include: { paths: ["trees", "screenshot"] },
  screenshot: "reference",
  reason: "manual",
};

interface CanonicalCaptureFixture {
  readonly snapshot: RuntimeSnapshot;
  readonly object: ObjectRef;
  readonly payload: Uint8Array;
}

async function loadCanonicalCaptureFixture(
  validator: ProtocolValidator,
): Promise<CanonicalCaptureFixture> {
  const [snapshotValue, artifactValue, objectValue] = await Promise.all([
    readJson("protocol/fixtures/v1/runtime-snapshot/valid/android-view.json"),
    readJson("protocol/fixtures/v1/artifact/valid/screenshot.json"),
    readJson("protocol/fixtures/v1/object/valid/plain-text.json"),
  ]);
  const snapshot = requireMutableRecord(structuredClone(snapshotValue), "snapshot");
  const screenshot = requireMutableRecord(snapshot["screenshot"], "screenshot");
  const artifact = requireMutableRecord(artifactValue, "artifact");
  const objectFixture = requireMutableRecord(objectValue, "object fixture");
  const objectCandidate = structuredClone(artifact["object"]);
  screenshot["object"] = objectCandidate;

  validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshot);
  validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, objectCandidate);

  const payloadBase64 = objectFixture["payload_base64"];
  if (typeof payloadBase64 !== "string") {
    throw new Error("The canonical object fixture has no payload_base64.");
  }
  const payload = Buffer.from(payloadBase64, "base64");
  const object = objectCandidate as ObjectRef;
  assert.equal(hashOf(payload), object.hash);
  assert.equal(payload.byteLength, object.byte_size);
  return {
    snapshot: snapshot as RuntimeSnapshot,
    object,
    payload,
  };
}

function fixtureRuntime(fixture: CanonicalCaptureFixture): FixtureRuntimeCapturePort {
  return new FixtureRuntimeCapturePort({
    snapshot: fixture.snapshot,
    objects: [
      {
        ref: fixture.object,
        chunks: [fixture.payload.subarray(0, 3), fixture.payload.subarray(3)],
      },
    ],
  });
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(path.join(repositoryRoot, relativePath), "utf8"),
  ) as unknown;
}

function requireMutableRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(name + " must be an object.");
  }
  return value as Record<string, unknown>;
}

function hashOf(value: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function expectDataError(code: DataErrorCode): (error: unknown) => boolean {
  return (error: unknown): boolean => isDataError(error, code);
}

class DelegatingObjectStore implements ObjectStore {
  constructor(protected readonly delegate: ObjectStore) {}

  put(stream: ByteStream, metadata: ObjectPutMetadata): Promise<ObjectRef> {
    return this.delegate.put(stream, metadata);
  }

  stat(hash: string): Promise<ObjectRef> {
    return this.delegate.stat(hash);
  }

  open(hash: string, range?: ByteRange): Promise<ByteStream> {
    return this.delegate.open(hash, range);
  }

  has(hashes: readonly string[]): Promise<ReadonlySet<string>> {
    return this.delegate.has(hashes);
  }

  pin(hash: string, policy: RetentionPolicy): Promise<void> {
    return this.delegate.pin(hash, policy);
  }

  unpin(hash: string, policyId: string): Promise<void> {
    return this.delegate.unpin(hash, policyId);
  }

  inventory(query?: ObjectInventoryQuery): AsyncIterable<ObjectRef> {
    return this.delegate.inventory(query);
  }

  deletePhysical(hash: string): Promise<void> {
    return this.delegate.deletePhysical(hash);
  }
}

class RecordingObjectStore extends DelegatingObjectStore {
  constructor(
    delegate: ObjectStore,
    private readonly events: string[],
  ) {
    super(delegate);
  }

  override async put(stream: ByteStream, metadata: ObjectPutMetadata): Promise<ObjectRef> {
    this.events.push("object.put:start");
    const object = await super.put(stream, metadata);
    this.events.push("object.put:complete");
    return object;
  }
}

class RewritingObjectStore extends DelegatingObjectStore {
  override async put(stream: ByteStream, metadata: ObjectPutMetadata): Promise<ObjectRef> {
    const object = await super.put(stream, metadata);
    return {
      ...object,
      logical_name: "rewritten-by-broken-adapter.png",
    } as ObjectRef;
  }
}

interface RecordingWorkspaceOptions {
  readonly failAfterSnapshotPut?: boolean;
}

class RecordingWorkspaceDataSource implements WorkspaceDataSource {
  readonly clock: Clock;

  constructor(
    private readonly delegate: WorkspaceDataSource,
    private readonly events: string[],
    private readonly options: RecordingWorkspaceOptions = {},
  ) {
    this.clock = delegate.clock;
  }

  registerVerifiedObjects(objects: readonly ObjectRef[]): void {
    this.events.push("workspace.register");
    this.delegate.registerVerifiedObjects(objects);
  }

  beginUnitOfWork(mode: UnitOfWorkMode): DataUnitOfWork {
    this.events.push("workspace.begin:" + mode);
    return wrapUnitOfWork(
      this.delegate.beginUnitOfWork(mode),
      this.events,
      this.options.failAfterSnapshotPut === true,
    );
  }

  checkHealth(): WorkspaceHealth {
    return this.delegate.checkHealth();
  }
}

function wrapUnitOfWork(
  unit: DataUnitOfWork,
  events: string[],
  failAfterSnapshotPut: boolean,
): DataUnitOfWork {
  const snapshots: SnapshotRepository = {
    unitOfWorkId: unit.snapshots.unitOfWorkId,
    put(snapshot: RuntimeSnapshot, objects?: readonly ObjectRef[]): void {
      events.push("snapshot.put");
      unit.snapshots.put(snapshot, objects);
      if (failAfterSnapshotPut) {
        throw new DataError("internal", "Injected metadata failure after Snapshot staging.");
      }
    },
    get(snapshotId, fields) {
      return unit.snapshots.get(snapshotId, fields);
    },
    list(query?: SnapshotQuery, page?: PageRequest) {
      return unit.snapshots.list(query, page);
    },
    pin(snapshotId, reason) {
      unit.snapshots.pin(snapshotId, reason);
    },
  };

  return {
    id: unit.id,
    mode: unit.mode,
    snapshots,
    observations: unit.observations,
    runtimeEvents: unit.runtimeEvents,
    screenGraph: unit.screenGraph,
    wiki: unit.wiki,
    designReviews: unit.designReviews,
    validation: unit.validation,
    operations: unit.operations,
    versions: unit.versions,
    assertOwns(...repositories: readonly UnitOfWorkBound[]): void {
      unit.assertOwns(...repositories);
    },
    commit(): void {
      events.push("uow.commit");
      unit.commit();
    },
    rollback(): void {
      events.push("uow.rollback");
      unit.rollback();
    },
  };
}

test("fixture capture writes objects before metadata and supports immutable Get and List queries", async (t) => {
  const validator = await validatorPromise;
  const fixture = await loadCanonicalCaptureFixture(validator);
  const runtime = fixtureRuntime(fixture);
  const memory = new MemoryDataStore({ validator });
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-snapshot-engine-"));
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const fileObjects = await FileObjectStore.open({ workspaceRoot });
  const events: string[] = [];
  const objects = new RecordingObjectStore(fileObjects, events);
  const workspace = new RecordingWorkspaceDataSource(memory, events);

  const captured = await new CaptureSnapshotUseCase({
    runtime,
    workspace,
    objects,
    validator,
  }).execute(captureCommand);

  assert.deepEqual(captured, fixture.snapshot);
  assert.equal(runtime.captureCount, 1);
  assert.ok(events.indexOf("object.put:complete") < events.indexOf("workspace.register"));
  assert.ok(events.indexOf("workspace.register") < events.indexOf("workspace.begin:write"));
  assert.ok(events.indexOf("workspace.begin:write") < events.indexOf("snapshot.put"));
  assert.ok(events.indexOf("snapshot.put") < events.indexOf("uow.commit"));
  assert.deepEqual(await collect(await fileObjects.open(fixture.object.hash)), fixture.payload);

  const returned = new GetSnapshotQuery(workspace).execute(fixture.snapshot.snapshot_id);
  const page = new ListSnapshotsQuery(workspace).execute();
  assert.deepEqual(returned, fixture.snapshot);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.snapshot_id, fixture.snapshot.snapshot_id);
  assert.equal(Object.isFrozen(returned), true);
  assert.equal(Object.isFrozen(returned.runtime_context), true);
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.items), true);
  assert.throws(() => {
    (returned as unknown as { snapshot_id: string }).snapshot_id = "mutated";
  }, TypeError);
  assert.equal(
    new GetSnapshotQuery(workspace).execute(fixture.snapshot.snapshot_id).snapshot_id,
    fixture.snapshot.snapshot_id,
  );
});

test("capture rejects missing streams, payload hash mismatch, and returned ObjectRef mismatch", async (t) => {
  const validator = await validatorPromise;
  const fixture = await loadCanonicalCaptureFixture(validator);
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-snapshot-mismatch-"));
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const objects = await FileObjectStore.open({ workspaceRoot });

  const missingWorkspace = new MemoryDataStore({ validator });
  await assert.rejects(
    new CaptureSnapshotUseCase({
      runtime: new FixtureRuntimeCapturePort({ snapshot: fixture.snapshot }),
      workspace: missingWorkspace,
      objects,
      validator,
    }).execute(captureCommand),
    expectDataError("integrity_error"),
  );

  const wrongBytes = Buffer.from("not Vistrea", "utf8");
  const hashWorkspace = new MemoryDataStore({ validator });
  await assert.rejects(
    new CaptureSnapshotUseCase({
      runtime: new FixtureRuntimeCapturePort({
        snapshot: fixture.snapshot,
        objects: [{ ref: fixture.object, chunks: [wrongBytes] }],
      }),
      workspace: hashWorkspace,
      objects,
      validator,
    }).execute(captureCommand),
    expectDataError("integrity_error"),
  );
  assert.deepEqual([...(await objects.has([fixture.object.hash]))], []);

  const refWorkspace = new MemoryDataStore({ validator });
  await assert.rejects(
    new CaptureSnapshotUseCase({
      runtime: fixtureRuntime(fixture),
      workspace: refWorkspace,
      objects: new RewritingObjectStore(objects),
      validator,
    }).execute(captureCommand),
    expectDataError("integrity_error"),
  );
  const read = refWorkspace.beginUnitOfWork("read");
  assert.throws(
    () => read.snapshots.get(fixture.snapshot.snapshot_id),
    expectDataError("not_found"),
  );
  read.rollback();
});

test("metadata failure rolls back Snapshot visibility and leaves written objects unreachable", async (t) => {
  const validator = await validatorPromise;
  const fixture = await loadCanonicalCaptureFixture(validator);
  const memory = new MemoryDataStore({ validator });
  const events: string[] = [];
  const workspace = new RecordingWorkspaceDataSource(memory, events, {
    failAfterSnapshotPut: true,
  });
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-snapshot-rollback-"));
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const fileObjects = await FileObjectStore.open({ workspaceRoot });
  const objects = new RecordingObjectStore(fileObjects, events);

  await assert.rejects(
    new CaptureSnapshotUseCase({
      runtime: fixtureRuntime(fixture),
      workspace,
      objects,
      validator,
    }).execute(captureCommand),
    expectDataError("internal"),
  );

  assert.ok(events.indexOf("object.put:complete") < events.indexOf("workspace.register"));
  assert.ok(events.indexOf("workspace.register") < events.indexOf("snapshot.put"));
  assert.ok(events.indexOf("snapshot.put") < events.indexOf("uow.rollback"));
  assert.deepEqual([...(await fileObjects.has([fixture.object.hash]))], [fixture.object.hash]);
  const read = memory.beginUnitOfWork("read");
  assert.throws(
    () => read.snapshots.get(fixture.snapshot.snapshot_id),
    expectDataError("not_found"),
  );
  read.rollback();
});

test("semantic-invalid Runtime Snapshot is rejected before object or metadata side effects", async (t) => {
  const validator = await validatorPromise;
  const invalid = await readJson(
    "protocol/fixtures/v1/runtime-snapshot/invalid/duplicate-node-id.json",
  );
  const memory = new MemoryDataStore({ validator });
  const workspaceEvents: string[] = [];
  const workspace = new RecordingWorkspaceDataSource(memory, workspaceEvents);
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-snapshot-invalid-"));
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const fileObjects = await FileObjectStore.open({ workspaceRoot });
  const objectEvents: string[] = [];
  const objects = new RecordingObjectStore(fileObjects, objectEvents);

  await assert.rejects(
    new CaptureSnapshotUseCase({
      runtime: new FixtureRuntimeCapturePort({ snapshot: invalid }),
      workspace,
      objects,
      validator,
    }).execute(captureCommand),
    expectDataError("invalid_argument"),
  );

  assert.deepEqual(objectEvents, []);
  assert.deepEqual(workspaceEvents, []);
  assert.deepEqual(await collectInventory(fileObjects), []);
});

async function collect(stream: ByteStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function collectInventory(store: ObjectStore): Promise<readonly ObjectRef[]> {
  const values: ObjectRef[] = [];
  for await (const value of store.inventory()) {
    values.push(value);
  }
  return values;
}
