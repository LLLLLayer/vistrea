import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  PROTOCOL_SCHEMA_IDS,
  isDataError,
  type Commit,
  type CommitManifest,
  type DataError,
  type JsonObject,
  type ObjectRef,
  type RefUpdatePrecondition,
} from "../../data/api/index.js";
import {
  PACK_MEDIA_TYPE,
  PackExchangeService,
} from "../../data/exchange/index.js";
import {
  MemoryDataStore,
  SequenceClock,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import { SQLiteDataStore } from "../../data/metadata/index.js";
import { FileObjectStore } from "../../data/objects/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

const ACTOR = { kind: "human", id: "exchange-test@vistrea.dev", extensions: {} };
const REF_NAME = "teams/im/main";

function expectDataError(code?: DataError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(isDataError(error, code), `Expected DataError${code === undefined ? "" : `(${code})`}`);
    return true;
  };
}

async function temporaryDirectory(t: TestContext, name: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

interface ExchangeContext {
  readonly store: MemoryDataStore | SQLiteDataStore;
  readonly objects: FileObjectStore;
  readonly exchange: PackExchangeService;
}

async function memoryContext(t: TestContext, name: string): Promise<ExchangeContext> {
  const validator = await validatorPromise;
  const directory = await temporaryDirectory(t, name);
  const store = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T05:00:00.000Z", 1),
    ids: new SequenceIdGenerator(500),
  });
  const objects = await FileObjectStore.open({ workspaceRoot: directory });
  return { store, objects, exchange: new PackExchangeService({ data: store, objects, validator }) };
}

async function sqliteContext(t: TestContext, name: string): Promise<ExchangeContext> {
  const validator = await validatorPromise;
  const directory = await temporaryDirectory(t, name);
  const store = new SQLiteDataStore({
    databasePath: path.join(directory, "metadata.sqlite"),
    validator,
    clock: new SequenceClock("2026-07-12T05:00:00.000Z", 1),
    ids: new SequenceIdGenerator(500),
  });
  t.after(() => {
    try {
      store.close();
    } catch {
      // The store may already be closed by the test body.
    }
  });
  const objects = await FileObjectStore.open({ workspaceRoot: directory });
  return { store, objects, exchange: new PackExchangeService({ data: store, objects, validator }) };
}

async function* bytesOf(...buffers: readonly Buffer[]): AsyncIterable<Uint8Array> {
  for (const buffer of buffers) {
    yield buffer;
  }
}

async function readAll(objects: FileObjectStore, hash: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await objects.open(hash)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function putGraphObject(
  context: ExchangeContext,
  text: string,
  logicalName: string,
): Promise<ObjectRef> {
  const object = await context.objects.put(bytesOf(Buffer.from(text, "utf8")), {
    media_type: "application/vnd.vistrea.graph+json",
    compression: "none",
    logical_name: logicalName,
  });
  context.store.registerVerifiedObjects([object]);
  return object;
}

interface SeededHistory {
  readonly firstCommit: Commit;
  readonly secondCommit: Commit;
  readonly firstObject: ObjectRef;
  readonly secondObject: ObjectRef;
}

function manifestFor(
  parents: readonly string[],
  createdAt: string,
  message: string,
  roots: JsonObject,
  objectHashes: readonly string[],
): CommitManifest {
  return {
    protocol_version: { major: 1, minor: 0 },
    parents,
    created_at: createdAt,
    author: ACTOR,
    message,
    roots,
    object_hashes: objectHashes,
    extensions: {},
  } as unknown as CommitManifest;
}

/** Two commits: the second keeps the first root object alive and adds one more. */
async function seedHistory(context: ExchangeContext): Promise<SeededHistory> {
  const firstObject = await putGraphObject(context, '{"screens":["demo.home"]}', "graph-v1.json");
  const secondObject = await putGraphObject(
    context,
    '{"screens":["demo.home","demo.detail"]}',
    "graph-v2.json",
  );

  const unit = context.store.beginUnitOfWork("write");
  const firstCommit = unit.versions.createCommit(
    manifestFor(
      [],
      "2026-07-12T05:00:00.000Z",
      "Record the first exchange graph.",
      { runtime_graph: firstObject },
      [firstObject.hash],
    ),
  );
  const secondCommit = unit.versions.createCommit(
    manifestFor(
      [firstCommit.commit_id],
      "2026-07-12T05:01:00.000Z",
      "Record the second exchange graph.",
      { runtime_graph: secondObject, wiki: firstObject },
      [firstObject.hash, secondObject.hash].sort(),
    ),
  );
  unit.versions.updateRef(REF_NAME, secondCommit.commit_id, {
    mode: "must_not_exist",
  } as unknown as RefUpdatePrecondition);
  unit.commit();
  return { firstCommit, secondCommit, firstObject, secondObject };
}

async function transferPack(
  source: ExchangeContext,
  target: ExchangeContext,
  pack: ObjectRef,
): Promise<ObjectRef> {
  return target.objects.put(await source.objects.open(pack.hash), {
    expected_hash: pack.hash,
    media_type: pack.media_type,
    compression: pack.compression,
    ...(pack.logical_name === undefined ? {} : { logical_name: pack.logical_name }),
    extensions: pack.extensions,
  });
}

function parsePackText(bytes: Buffer): { header: JsonObject; manifest: JsonObject } {
  const headerEnd = bytes.indexOf(0x0a);
  const header = JSON.parse(bytes.subarray(0, headerEnd).toString("utf8")) as JsonObject;
  const manifestSize = header["manifest_byte_size"] as number;
  const manifest = JSON.parse(
    bytes.subarray(headerEnd + 1, headerEnd + 1 + manifestSize).toString("utf8"),
  ) as JsonObject;
  return { header, manifest };
}

function commitIdsOf(context: ExchangeContext, refName: string): string {
  const unit = context.store.beginUnitOfWork("read");
  try {
    return unit.versions.resolveRef(refName).commit_id;
  } finally {
    unit.rollback();
  }
}

test("a full pack round trips a Workspace history into an empty Workspace", async (t) => {
  const source = await sqliteContext(t, "vistrea-pack-source");
  const target = await sqliteContext(t, "vistrea-pack-target");
  const history = await seedHistory(source);

  const pack = await source.exchange.exportPack({
    ref_names: [REF_NAME],
    created_by: ACTOR,
    message: "Full Demo history export.",
  });
  assert.equal(pack.media_type, PACK_MEDIA_TYPE);
  assert.equal(pack.compression, "none");

  const packBytes = await readAll(source.objects, pack.hash);
  assert.equal(packBytes.byteLength, pack.byte_size);
  const { manifest } = parsePackText(packBytes);
  assert.equal(manifest["mode"], "full");
  assert.deepEqual(
    (manifest["commits"] as readonly JsonObject[]).map((commit) => commit["commit_id"]),
    [history.firstCommit.commit_id, history.secondCommit.commit_id],
  );
  assert.deepEqual(
    (manifest["objects"] as readonly JsonObject[]).map((object) => object["hash"]),
    [history.firstObject.hash, history.secondObject.hash].sort(),
  );
  assert.deepEqual(manifest["prerequisite_commit_ids"], []);
  assert.deepEqual(manifest["refs"], [
    { name: REF_NAME, commit_id: history.secondCommit.commit_id },
  ]);

  const transferred = await transferPack(source, target, pack);
  const result = await target.exchange.importPack({ pack: transferred });
  assert.equal(result.mode, "full");
  assert.deepEqual(result.imported_commit_ids, [
    history.firstCommit.commit_id,
    history.secondCommit.commit_id,
  ]);
  assert.deepEqual(result.existing_commit_ids, []);
  assert.deepEqual(
    [...result.imported_object_hashes].sort(),
    [history.firstObject.hash, history.secondObject.hash].sort(),
  );
  assert.deepEqual(result.existing_object_hashes, []);
  assert.deepEqual(result.created_refs.map((ref) => ({ name: ref.name, commit_id: ref.commit_id })), [
    { name: REF_NAME, commit_id: history.secondCommit.commit_id },
  ]);
  assert.deepEqual(result.conflicting_refs, []);

  const unit = target.store.beginUnitOfWork("read");
  assert.deepEqual(unit.versions.getCommit(history.firstCommit.commit_id), history.firstCommit);
  assert.deepEqual(unit.versions.getCommit(history.secondCommit.commit_id), history.secondCommit);
  assert.equal(unit.versions.resolveRef(REF_NAME).commit_id, history.secondCommit.commit_id);
  const reachable = [...unit.versions.reachableObjects([history.secondCommit.commit_id])]
    .map((object) => object.hash)
    .sort();
  assert.deepEqual(reachable, [history.firstObject.hash, history.secondObject.hash].sort());
  unit.rollback();
  for (const object of [history.firstObject, history.secondObject]) {
    assert.deepEqual(await target.objects.stat(object.hash), object);
    assert.deepEqual(await readAll(target.objects, object.hash), await readAll(source.objects, object.hash));
  }

  const again = await target.exchange.importPack({ pack: transferred });
  assert.deepEqual(again.imported_commit_ids, []);
  assert.deepEqual(
    [...again.existing_commit_ids].sort(),
    [history.firstCommit.commit_id, history.secondCommit.commit_id].sort(),
  );
  assert.deepEqual(again.imported_object_hashes, []);
  assert.deepEqual(again.created_refs, []);
  assert.deepEqual(again.unchanged_ref_names, [REF_NAME]);
});

test("pack export bytes are deterministic for identical logical content", async (t) => {
  const first = await memoryContext(t, "vistrea-pack-deterministic-a");
  const second = await memoryContext(t, "vistrea-pack-deterministic-b");
  await seedHistory(first);
  await seedHistory(second);

  const command = {
    ref_names: [REF_NAME],
    created_by: ACTOR,
    message: "Deterministic export.",
  };
  const firstPack = await first.exchange.exportPack(command);
  const secondPack = await second.exchange.exportPack(command);
  assert.equal(firstPack.hash, secondPack.hash);
  assert.equal(firstPack.byte_size, secondPack.byte_size);
  assert.deepEqual(firstPack, secondPack);
});

test("a thin pack omits prerequisite objects and requires them on import", async (t) => {
  const source = await memoryContext(t, "vistrea-pack-thin-source");
  const prepared = await memoryContext(t, "vistrea-pack-thin-prepared");
  const empty = await memoryContext(t, "vistrea-pack-thin-empty");
  const history = await seedHistory(source);

  const pack = await source.exchange.exportPack({
    ref_names: [REF_NAME],
    prerequisite_commit_ids: [history.firstCommit.commit_id],
    created_by: ACTOR,
  });
  const packBytes = await readAll(source.objects, pack.hash);
  const { manifest } = parsePackText(packBytes);
  assert.equal(manifest["mode"], "thin");
  assert.deepEqual(
    (manifest["commits"] as readonly JsonObject[]).map((commit) => commit["commit_id"]),
    [history.secondCommit.commit_id],
  );
  assert.deepEqual(
    (manifest["objects"] as readonly JsonObject[]).map((object) => object["hash"]),
    [history.secondObject.hash],
  );
  assert.deepEqual(
    (manifest["omitted_objects"] as readonly JsonObject[]).map((object) => object["hash"]),
    [history.firstObject.hash],
  );
  assert.deepEqual(manifest["prerequisite_commit_ids"], [history.firstCommit.commit_id]);

  // The prepared target already holds the prerequisite commit and object.
  const firstObject = await putGraphObject(prepared, '{"screens":["demo.home"]}', "graph-v1.json");
  assert.equal(firstObject.hash, history.firstObject.hash);
  const preparedUnit = prepared.store.beginUnitOfWork("write");
  preparedUnit.versions.createCommit(history.firstCommit.manifest);
  preparedUnit.commit();

  const transferred = await transferPack(source, prepared, pack);
  const result = await prepared.exchange.importPack({ pack: transferred });
  assert.equal(result.mode, "thin");
  assert.deepEqual(result.imported_commit_ids, [history.secondCommit.commit_id]);
  assert.deepEqual(result.imported_object_hashes, [history.secondObject.hash]);
  const unit = prepared.store.beginUnitOfWork("read");
  assert.deepEqual(unit.versions.getCommit(history.secondCommit.commit_id), history.secondCommit);
  assert.equal(unit.versions.resolveRef(REF_NAME).commit_id, history.secondCommit.commit_id);
  unit.rollback();

  // An empty target is missing the prerequisites and must reject the thin pack.
  const orphaned = await transferPack(source, empty, pack);
  await assert.rejects(
    () => empty.exchange.importPack({ pack: orphaned }),
    (error: unknown) => {
      assert.ok(isDataError(error, "conflict"));
      assert.deepEqual(error.details["missing_commit_ids"], [history.firstCommit.commit_id]);
      return true;
    },
  );
  const emptyUnit = empty.store.beginUnitOfWork("read");
  assert.throws(
    () => emptyUnit.versions.getCommit(history.secondCommit.commit_id),
    expectDataError("not_found"),
  );
  assert.throws(() => emptyUnit.versions.resolveRef(REF_NAME), expectDataError("not_found"));
  emptyUnit.rollback();
});

test("tampered or truncated packs fail integrity with no visible metadata", async (t) => {
  const source = await memoryContext(t, "vistrea-pack-tamper-source");
  const target = await memoryContext(t, "vistrea-pack-tamper-target");
  const history = await seedHistory(source);
  const pack = await source.exchange.exportPack({ ref_names: [REF_NAME], created_by: ACTOR });
  const packBytes = await readAll(source.objects, pack.hash);

  const headerEnd = packBytes.indexOf(0x0a);
  const header = JSON.parse(packBytes.subarray(0, headerEnd).toString("utf8")) as JsonObject;
  const payloadStart = headerEnd + 1 + (header["manifest_byte_size"] as number) + 1;

  const tamperedBytes = Buffer.from(packBytes);
  const tamperedByte = tamperedBytes[payloadStart] as number;
  tamperedBytes[payloadStart] = tamperedByte ^ 0xff;
  const tampered = await target.objects.put(bytesOf(tamperedBytes), {
    media_type: PACK_MEDIA_TYPE,
    compression: "none",
    extensions: {},
  });
  await assert.rejects(
    () => target.exchange.importPack({ pack: tampered }),
    expectDataError("integrity_error"),
  );

  const truncated = await target.objects.put(
    bytesOf(packBytes.subarray(0, packBytes.byteLength - 40)),
    { media_type: PACK_MEDIA_TYPE, compression: "none", extensions: {} },
  );
  await assert.rejects(
    () => target.exchange.importPack({ pack: truncated }),
    expectDataError("integrity_error"),
  );

  const unit = target.store.beginUnitOfWork("read");
  assert.throws(
    () => unit.versions.getCommit(history.firstCommit.commit_id),
    expectDataError("not_found"),
  );
  assert.throws(() => unit.versions.resolveRef(REF_NAME), expectDataError("not_found"));
  unit.rollback();
});

test("import reports ref conflicts without forcing local refs", async (t) => {
  const source = await memoryContext(t, "vistrea-pack-conflict-source");
  const target = await memoryContext(t, "vistrea-pack-conflict-target");
  const history = await seedHistory(source);
  const pack = await source.exchange.exportPack({ ref_names: [REF_NAME], created_by: ACTOR });
  const transferred = await transferPack(source, target, pack);
  await target.exchange.importPack({ pack: transferred });

  // The target advances its ref to a local-only commit.
  const localObject = await putGraphObject(target, '{"screens":["demo.local"]}', "graph-local.json");
  const unit = target.store.beginUnitOfWork("write");
  const localCommit = unit.versions.createCommit(
    manifestFor(
      [history.secondCommit.commit_id],
      "2026-07-12T06:00:00.000Z",
      "Advance the local line.",
      { runtime_graph: localObject },
      [localObject.hash],
    ),
  );
  unit.versions.updateRef(REF_NAME, localCommit.commit_id, {
    mode: "must_match",
    expected_commit_id: history.secondCommit.commit_id,
  } as unknown as RefUpdatePrecondition);
  unit.commit();

  const result = await target.exchange.importPack({ pack: transferred });
  assert.deepEqual(result.created_refs, []);
  assert.deepEqual(result.unchanged_ref_names, []);
  assert.deepEqual(result.conflicting_refs, [
    {
      name: REF_NAME,
      pack_commit_id: history.secondCommit.commit_id,
      local_commit_id: localCommit.commit_id,
    },
  ]);
  assert.equal(commitIdsOf(target, REF_NAME), localCommit.commit_id);
});

test("import rejects payloads that are not version 1 packs", async (t) => {
  const context = await memoryContext(t, "vistrea-pack-reject");

  const wrongMediaType = await context.objects.put(bytesOf(Buffer.from("plain", "utf8")), {
    media_type: "text/plain",
    compression: "none",
    extensions: {},
  });
  await assert.rejects(
    () => context.exchange.importPack({ pack: wrongMediaType }),
    expectDataError("invalid_argument"),
  );

  const garbage = await context.objects.put(bytesOf(Buffer.from("not json\n", "utf8")), {
    media_type: PACK_MEDIA_TYPE,
    compression: "none",
    extensions: {},
  });
  await assert.rejects(
    () => context.exchange.importPack({ pack: garbage }),
    expectDataError("integrity_error"),
  );
});

test("pack export validates its command and readable export stays unsupported", async (t) => {
  const context = await memoryContext(t, "vistrea-pack-command");
  await seedHistory(context);

  await assert.rejects(
    () => context.exchange.exportPack({ created_by: ACTOR }),
    expectDataError("invalid_argument"),
  );
  await assert.rejects(
    () => context.exchange.exportPack({ ref_names: ["teams/im/missing"], created_by: ACTOR }),
    expectDataError("not_found"),
  );
  await assert.rejects(
    () =>
      context.exchange.exportPack({
        ref_names: [REF_NAME],
        created_by: { kind: "human", id: "" },
      }),
    expectDataError("invalid_argument"),
  );
  await assert.rejects(() => context.exchange.exportReadable({}), expectDataError("unsupported"));
});
