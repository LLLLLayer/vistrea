import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { isDataError } from "../../data/api/index.js";
import type {
  ByteStream,
  Clock,
  DataErrorCode,
  ObjectPutMetadata,
  ObjectRef,
} from "../../data/api/index.js";
import { FileObjectStore } from "../../data/objects/index.js";

class FixedClock implements Clock {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  now(): string {
    return this.#value;
  }
}

async function createWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-object-store-"));
}

async function* bytes(...chunks: readonly Uint8Array[]): ByteStream {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collect(stream: ByteStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function collectInventory(
  store: FileObjectStore,
  query?: Parameters<FileObjectStore["inventory"]>[0],
): Promise<readonly ObjectRef[]> {
  const values: ObjectRef[] = [];
  for await (const value of store.inventory(query)) {
    values.push(value);
  }
  return values;
}

function hashOf(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalPayloadPath(workspaceRoot: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return path.join(workspaceRoot, "objects", "sha256", hex.slice(0, 2), hex.slice(2));
}

function canonicalMetadataPath(workspaceRoot: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return path.join(
    workspaceRoot,
    "objects",
    ".metadata",
    "sha256",
    hex.slice(0, 2),
    `${hex.slice(2)}.json`,
  );
}

function metadata(overrides: Partial<ObjectPutMetadata> = {}): ObjectPutMetadata {
  return {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "fixture.bin",
    extensions: { "vistrea.test": true },
    ...overrides,
  };
}

function expectDataError(code: DataErrorCode): (error: unknown) => boolean {
  return (error: unknown): boolean => isDataError(error, code);
}

test("put hashes encoded bytes, publishes the canonical path, and survives reopen", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const decoded = Buffer.from("runtime snapshot payload", "utf8");
  const encoded = gzipSync(decoded);
  const expectedHash = hashOf(encoded);
  assert.notEqual(expectedHash, hashOf(decoded));

  const ref = await store.put(bytes(encoded.subarray(0, 7), encoded.subarray(7)),
    metadata({
      expected_hash: expectedHash,
      media_type: "application/json",
      compression: "gzip",
      decoded_byte_size: decoded.byteLength,
      logical_name: "snapshot.json.gz",
    }),
  );

  assert.equal(ref.hash, expectedHash);
  assert.equal(ref.byte_size, encoded.byteLength);
  assert.equal(ref["decoded_byte_size"], decoded.byteLength);
  assert.equal(Object.isFrozen(ref), true);
  assert.deepEqual(await fs.readFile(canonicalPayloadPath(workspaceRoot, ref.hash)), encoded);

  const reopened = await FileObjectStore.open({ workspaceRoot });
  assert.deepEqual(await reopened.stat(ref.hash), ref);
  assert.equal((await reopened.stat(ref.hash)).byte_size, encoded.byteLength);
  assert.deepEqual(await collect(await reopened.open(ref.hash)), encoded);
});

test("encryption references survive put, dedupe, inventory, and reopen without changing identity", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const content = Buffer.from("encoded bytes before provider encryption", "utf8");
  const encryption = {
    algorithm: "aes-256-gcm",
    key_id: "workspace-key-2026",
  };
  const putMetadata = metadata({ encryption });

  const ref = await store.put(bytes(content), putMetadata);
  assert.equal(ref.hash, hashOf(content));
  assert.deepEqual(ref.encryption, encryption);
  assert.equal(Object.isFrozen(ref.encryption), true);
  assert.deepEqual(await store.put(bytes(content), putMetadata), ref);
  assert.deepEqual(await collectInventory(store), [ref]);

  const reopened = await FileObjectStore.open({ workspaceRoot });
  assert.deepEqual(await reopened.stat(ref.hash), ref);
  await assert.rejects(
    reopened.put(
      bytes(content),
      metadata({ encryption: { ...encryption, key_id: "different-key" } }),
    ),
    expectDataError("conflict"),
  );
  await assert.rejects(
    reopened.put(bytes(Buffer.from("invalid encryption", "utf8")),
      metadata({ encryption: { algorithm: "", key_id: "workspace-key-2026" } }),
    ),
    expectDataError("invalid_argument"),
  );
});

test("expected_hash mismatch rejects before publication and cleans temporary bytes", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const content = Buffer.from("wrong expectation", "utf8");
  const actualHash = hashOf(content);

  await assert.rejects(
    store.put(bytes(content), metadata({ expected_hash: `sha256:${"0".repeat(64)}` })),
    expectDataError("integrity_error"),
  );
  assert.deepEqual(await fs.readdir(path.join(workspaceRoot, "objects", ".tmp")), []);
  assert.deepEqual([...(await store.has([actualHash]))], []);
  await assert.rejects(fs.stat(canonicalPayloadPath(workspaceRoot, actualHash)), {
    code: "ENOENT",
  });
});

test("stat, open, has, and inventory reject same-size payload corruption", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const content = Buffer.from("integrity", "utf8");
  const ref = await store.put(bytes(content), metadata());
  const corrupted = Buffer.from("xntegrity", "utf8");
  assert.equal(corrupted.byteLength, content.byteLength);
  await fs.writeFile(canonicalPayloadPath(workspaceRoot, ref.hash), corrupted);

  await assert.rejects(store.stat(ref.hash), expectDataError("integrity_error"));
  await assert.rejects(store.open(ref.hash), expectDataError("integrity_error"));
  await assert.rejects(store.has([ref.hash]), expectDataError("integrity_error"));
  await assert.rejects(
    async () => {
      for await (const _value of store.inventory()) {
        // Iteration forces integrity verification for each inventory entry.
      }
    },
    expectDataError("integrity_error"),
  );
});

test("symlinked payload and metadata shards fail closed without touching external files", async (t) => {
  for (const shardKind of ["payload", "metadata"] as const) {
    const workspaceRoot = await createWorkspace();
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-object-external-"));
    t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
    t.after(async () => await fs.rm(externalRoot, { recursive: true, force: true }));
    const store = await FileObjectStore.open({ workspaceRoot });
    const content = Buffer.from(`external safety ${shardKind}`, "utf8");
    const ref = await store.put(bytes(content), metadata());
    const protectedPath =
      shardKind === "payload"
        ? canonicalPayloadPath(workspaceRoot, ref.hash)
        : canonicalMetadataPath(workspaceRoot, ref.hash);
    const originalShard = path.dirname(protectedPath);
    const externalShard = path.join(externalRoot, `${shardKind}-shard`);
    await fs.rename(originalShard, externalShard);
    await fs.symlink(externalShard, originalShard, "dir");
    const externalFile = path.join(externalShard, path.basename(protectedPath));
    const externalBytesBefore = await fs.readFile(externalFile);

    await assert.rejects(store.stat(ref.hash), expectDataError("integrity_error"));
    await assert.rejects(store.open(ref.hash), expectDataError("integrity_error"));
    await assert.rejects(store.deletePhysical(ref.hash), expectDataError("integrity_error"));
    await assert.rejects(store.put(bytes(content), metadata()), expectDataError("integrity_error"));

    assert.deepEqual(await fs.readFile(externalFile), externalBytesBefore);
    if (shardKind === "payload") {
      assert.deepEqual(externalBytesBefore, content);
      await fs.stat(canonicalMetadataPath(workspaceRoot, ref.hash));
    } else {
      assert.deepEqual(await fs.readFile(canonicalPayloadPath(workspaceRoot, ref.hash)), content);
    }
  }
});

test("deduplication preserves immutable metadata and rejects conflicting metadata", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const content = Buffer.from("deduplicated", "utf8");
  const firstMetadata = metadata({
    extensions: { "z.test": 1, "a.test": 2 },
  });
  const first = await store.put(bytes(content), firstMetadata);
  const second = await store.put(
    bytes(content.subarray(0, 3), content.subarray(3)),
    metadata({ extensions: { "a.test": 2, "z.test": 1 } }),
  );

  assert.deepEqual(second, first);
  await assert.rejects(
    store.put(bytes(content), metadata({ logical_name: "different.bin" })),
    expectDataError("conflict"),
  );
  assert.equal((await store.stat(first.hash))["logical_name"], "fixture.bin");
  assert.deepEqual(await collectInventory(store), [first]);
});

test("open uses an inclusive offset and exclusive end over encoded bytes", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const content = Buffer.from("0123456789", "utf8");
  const ref = await store.put(bytes(content), metadata());

  assert.equal((await collect(await store.open(ref.hash, { offset: 2, length: 4 }))).toString(), "2345");
  assert.equal((await collect(await store.open(ref.hash, { offset: 3 }))).toString(), "3456789");
  assert.equal((await collect(await store.open(ref.hash, { offset: 10 }))).byteLength, 0);
  assert.equal((await collect(await store.open(ref.hash, { offset: 5, length: 0 }))).byteLength, 0);
  await assert.rejects(store.open(ref.hash, { offset: 11 }), expectDataError("invalid_argument"));
  await assert.rejects(
    store.open(ref.hash, { offset: 8, length: 3 }),
    expectDataError("invalid_argument"),
  );
});

test("batched has and filtered inventory are deterministic", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const text = await store.put(bytes(Buffer.from("text", "utf8")),
    metadata({ media_type: "text/plain", logical_name: "text.txt" }),
  );
  const image = await store.put(bytes(Buffer.from("image", "utf8")),
    metadata({ media_type: "image/png", logical_name: "image.png" }),
  );
  const json = await store.put(bytes(Buffer.from("json", "utf8")),
    metadata({ media_type: "application/json", logical_name: "data.json" }),
  );
  const missing = `sha256:${"f".repeat(64)}`;

  assert.deepEqual(
    [...(await store.has([missing, image.hash, text.hash, image.hash]))],
    [image.hash, text.hash].sort(),
  );
  const all = await collectInventory(store);
  assert.deepEqual(
    all.map((value) => value.hash),
    [text.hash, image.hash, json.hash].sort(),
  );
  assert.deepEqual(
    (await collectInventory(store, { media_types: ["image/png"] })).map((value) => value.hash),
    [image.hash],
  );
  assert.deepEqual(
    (await collectInventory(store, { hash_prefix: json.hash.slice(0, 20) })).map(
      (value) => value.hash,
    ),
    [json.hash],
  );
});

test("retention pins survive reopen and safe deletion never uses caller paths", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const clock = new FixedClock("2026-07-12T12:00:00.000Z");
  const store = await FileObjectStore.open({ workspaceRoot, clock });
  const pinned = await store.put(bytes(Buffer.from("pinned", "utf8")), metadata());
  const expiring = await store.put(bytes(Buffer.from("expired", "utf8")), metadata());
  const nanosecondPinned = await store.put(bytes(Buffer.from("nanosecond", "utf8")), metadata());
  const unpinned = await store.put(bytes(Buffer.from("unprotected", "utf8")), metadata());

  await store.pin(pinned.hash, { policy_id: "baseline", reason: "Approved baseline" });
  await store.pin(pinned.hash, { policy_id: "baseline", reason: "Approved baseline" });
  await assert.rejects(
    store.pin(pinned.hash, { policy_id: "baseline", reason: "Conflicting reason" }),
    expectDataError("conflict"),
  );
  await store.pin(expiring.hash, {
    policy_id: "temporary",
    retain_until: "2026-07-12T11:59:59.999Z",
    reason: "Expired fixture",
  });
  await store.pin(nanosecondPinned.hash, {
    policy_id: "nanosecond-boundary",
    retain_until: "2026-07-12T12:00:00.000000001Z",
    reason: "Proves nanosecond retention ordering",
  });

  const reopened = await FileObjectStore.open({
    workspaceRoot,
    clock: new FixedClock("2026-07-12T12:00:00.000000000Z"),
  });
  await assert.rejects(reopened.deletePhysical(pinned.hash), expectDataError("conflict"));
  await assert.rejects(
    reopened.deletePhysical(nanosecondPinned.hash),
    expectDataError("conflict"),
  );
  await reopened.deletePhysical(expiring.hash);
  await reopened.deletePhysical(unpinned.hash);
  assert.deepEqual(
    [...(await reopened.has([pinned.hash, expiring.hash, nanosecondPinned.hash, unpinned.hash]))],
    [nanosecondPinned.hash, pinned.hash].sort(),
  );
  await assert.rejects(reopened.deletePhysical(unpinned.hash), expectDataError("not_found"));
  await assert.rejects(
    reopened.deletePhysical("../../outside-workspace"),
    expectDataError("invalid_argument"),
  );
  assert.equal((await reopened.stat(pinned.hash)).hash, pinned.hash);

  const afterNanosecond = await FileObjectStore.open({
    workspaceRoot,
    clock: new FixedClock("2026-07-12T12:00:00.000000002Z"),
  });
  await afterNanosecond.deletePhysical(nanosecondPinned.hash);
});

test("startup cleans abandoned temps, completes delete tombstones, and repairs orphan payloads", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  const doomed = await store.put(bytes(Buffer.from("doomed", "utf8")), metadata());
  const temporaryRoot = path.join(workspaceRoot, "objects", ".tmp");
  await fs.writeFile(path.join(temporaryRoot, "abandoned.part"), "partial");
  const tombstone = path.join(
    temporaryRoot,
    `delete-${doomed.hash.slice("sha256:".length)}-${randomUUID()}.json`,
  );
  await fs.rename(canonicalMetadataPath(workspaceRoot, doomed.hash), tombstone);

  const orphanContent = Buffer.from("orphan payload", "utf8");
  const orphanHash = hashOf(orphanContent);
  const orphanPath = canonicalPayloadPath(workspaceRoot, orphanHash);
  await fs.mkdir(path.dirname(orphanPath), { recursive: true });
  await fs.writeFile(orphanPath, orphanContent);

  const reopened = await FileObjectStore.open({ workspaceRoot });
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
  assert.deepEqual([...(await reopened.has([doomed.hash, orphanHash]))], []);
  await assert.rejects(fs.stat(canonicalPayloadPath(workspaceRoot, doomed.hash)), {
    code: "ENOENT",
  });

  const repaired = await reopened.put(bytes(orphanContent), metadata());
  assert.equal(repaired.hash, orphanHash);
  assert.deepEqual(await collect(await reopened.open(orphanHash)), orphanContent);
});

test("a failed input stream leaves no published object or temporary file", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => await fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = await FileObjectStore.open({ workspaceRoot });
  async function* failingStream(): ByteStream {
    yield Buffer.from("partial", "utf8");
    throw new Error("fixture stream failure");
  }

  await assert.rejects(store.put(failingStream(), metadata()), expectDataError("internal"));
  assert.deepEqual(await fs.readdir(path.join(workspaceRoot, "objects", ".tmp")), []);
  assert.deepEqual(await collectInventory(store), []);
});
