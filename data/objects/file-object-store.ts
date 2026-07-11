import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { DataError } from "../api/errors.js";
import type {
  ByteRange,
  Clock,
  JsonObject,
  JsonValue,
  ObjectInventoryQuery,
  ObjectPutMetadata,
  ObjectRef,
  RetentionPolicy,
} from "../api/models.js";
import type { ByteStream, ObjectStore } from "../api/ports.js";

const HASH_PATTERN = /^sha256:([0-9a-f]{64})$/;
const HASH_PREFIX_PATTERN = /^sha256:[0-9a-f]{0,64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const TIMESTAMP_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/;
const DELETE_TOMBSTONE_PATTERN =
  /^delete-([0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const MAX_SAFE_BYTE_SIZE = Number.MAX_SAFE_INTEGER;
const READ_CHUNK_SIZE = 64 * 1024;

type Compression = "none" | "gzip" | "zstd";

interface StoredEncryptionReference {
  readonly algorithm: string;
  readonly key_id: string;
}

interface StoredObjectRef {
  readonly hash: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly decoded_byte_size?: number;
  readonly compression: Compression;
  readonly encryption?: StoredEncryptionReference;
  readonly redaction_profile?: string;
  readonly logical_name?: string;
  readonly extensions: JsonObject;
}

interface StoredRetentionPolicy {
  readonly policy_id: string;
  readonly retain_until?: string;
  readonly reason: string;
}

interface ObjectSidecar {
  readonly format_version: 1;
  readonly object_ref: StoredObjectRef;
  readonly retention_policies: readonly StoredRetentionPolicy[];
}

export interface FileObjectStoreOptions {
  /** Workspace root containing the canonical `objects/` directory. */
  readonly workspaceRoot: string;
  /** Injectable only for deterministic retention enforcement. */
  readonly clock?: Clock;
}

class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * File-backed content-addressed storage for one local Workspace.
 *
 * One Host process owns a writable Workspace. Per-hash serialization prevents
 * races inside that process; exclusive hard-link publication prevents a put
 * from overwriting an object or immutable sidecar already on disk.
 */
export class FileObjectStore implements ObjectStore {
  readonly #objectsRoot: string;
  readonly #payloadRoot: string;
  readonly #metadataRoot: string;
  readonly #temporaryRoot: string;
  readonly #clock: Clock;
  readonly #hashLocks = new Map<string, Promise<void>>();

  private constructor(workspaceRoot: string, clock: Clock) {
    this.#objectsRoot = path.join(workspaceRoot, "objects");
    this.#payloadRoot = path.join(this.#objectsRoot, "sha256");
    this.#metadataRoot = path.join(this.#objectsRoot, ".metadata", "sha256");
    this.#temporaryRoot = path.join(this.#objectsRoot, ".tmp");
    this.#clock = clock;
  }

  static async open(options: FileObjectStoreOptions): Promise<FileObjectStore> {
    if (typeof options.workspaceRoot !== "string" || options.workspaceRoot.length === 0) {
      throw new DataError("invalid_argument", "workspaceRoot must be a non-empty path.");
    }

    const requestedRoot = path.resolve(options.workspaceRoot);
    await ensureDirectory(requestedRoot);
    const workspaceRoot = await fs.realpath(requestedRoot);
    const store = new FileObjectStore(workspaceRoot, options.clock ?? new SystemClock());
    await store.#initialize();
    return store;
  }

  async put(stream: ByteStream, metadata: ObjectPutMetadata): Promise<ObjectRef> {
    const normalized = normalizePutMetadata(metadata);
    const temporaryPath = this.#temporaryPath("put", ".part");
    let encodedByteSize = 0;
    const digest = createHash("sha256");

    try {
      const handle = await openExclusiveFile(temporaryPath);
      try {
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) {
            throw new DataError(
              "invalid_argument",
              "Object streams must yield Uint8Array chunks.",
            );
          }
          if (chunk.byteLength > MAX_SAFE_BYTE_SIZE - encodedByteSize) {
            throw new DataError(
              "resource_exhausted",
              "The encoded object exceeds the JSON-safe byte-size limit.",
            );
          }
          if (chunk.byteLength === 0) {
            continue;
          }

          // Copy caller-owned memory so concurrent mutation cannot make the
          // bytes written to disk differ from the bytes fed into SHA-256.
          const bytes = Buffer.from(chunk);
          await writeAll(handle, bytes, encodedByteSize);
          digest.update(bytes);
          encodedByteSize += bytes.byteLength;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }

      const hash = `sha256:${digest.digest("hex")}`;
      if (normalized.expectedHash !== undefined && normalized.expectedHash !== hash) {
        throw new DataError("integrity_error", "The object stream does not match expected_hash.", {
          details: {
            expected_hash: normalized.expectedHash,
            actual_hash: hash,
            actual_byte_size: encodedByteSize,
          },
        });
      }

      const objectRef: StoredObjectRef = {
        hash,
        media_type: normalized.mediaType,
        byte_size: encodedByteSize,
        ...(normalized.decodedByteSize === undefined
          ? {}
          : { decoded_byte_size: normalized.decodedByteSize }),
        compression: normalized.compression,
        ...(normalized.encryption === undefined ? {} : { encryption: normalized.encryption }),
        ...(normalized.redactionProfile === undefined
          ? {}
          : { redaction_profile: normalized.redactionProfile }),
        ...(normalized.logicalName === undefined
          ? {}
          : { logical_name: normalized.logicalName }),
        extensions: normalized.extensions,
      };

      return await this.#withHashLock(hash, async () => {
        await this.#publishPayload(temporaryPath, objectRef);
        const existing = await this.#tryReadCompleteSidecar(hash);
        if (existing !== undefined) {
          assertSameImmutableMetadata(existing.object_ref, objectRef);
          return toObjectRef(existing.object_ref);
        }

        const sidecar: ObjectSidecar = {
          format_version: 1,
          object_ref: objectRef,
          retention_policies: [],
        };
        const published = await this.#publishNewSidecar(sidecar);
        assertSameImmutableMetadata(published.object_ref, objectRef);
        return toObjectRef(published.object_ref);
      });
    } catch (error) {
      throw mapFilesystemError(error, "store the object");
    } finally {
      await removeIfPresent(temporaryPath);
    }
  }

  async stat(hash: string): Promise<ObjectRef> {
    assertHash(hash);
    try {
      const sidecar = await this.#readCompleteSidecar(hash);
      return toObjectRef(sidecar.object_ref);
    } catch (error) {
      throw mapFilesystemError(error, "stat the object");
    }
  }

  async open(hash: string, range?: ByteRange): Promise<ByteStream> {
    assertHash(hash);
    try {
      const sidecar = await this.#readCompleteSidecar(hash);
      const { offset, endExclusive } = normalizeRange(range, sidecar.object_ref.byte_size);
      const payloadPath = this.#payloadPath(hash);
      return readFileRange(
        payloadPath,
        path.dirname(payloadPath),
        hash,
        offset,
        endExclusive,
      );
    } catch (error) {
      throw mapFilesystemError(error, "open the object");
    }
  }

  async has(hashes: readonly string[]): Promise<ReadonlySet<string>> {
    if (!Array.isArray(hashes)) {
      throw new DataError("invalid_argument", "hashes must be an array.");
    }
    const unique = [...new Set(hashes)].sort();
    for (const hash of unique) {
      assertHash(hash);
    }

    const present = new Set<string>();
    for (const hash of unique) {
      try {
        await this.#readCompleteSidecar(hash);
        present.add(hash);
      } catch (error) {
        if (error instanceof DataError && error.code === "not_found") {
          continue;
        }
        throw mapFilesystemError(error, "check object presence");
      }
    }
    return present;
  }

  async pin(hash: string, policy: RetentionPolicy): Promise<void> {
    assertHash(hash);
    const normalizedPolicy = normalizeRetentionPolicy(policy);

    try {
      await this.#withHashLock(hash, async () => {
        const sidecar = await this.#readCompleteSidecar(hash);
        const current = sidecar.retention_policies.find(
          (candidate) => candidate.policy_id === normalizedPolicy.policy_id,
        );
        if (current !== undefined) {
          if (canonicalJson(current) !== canonicalJson(normalizedPolicy)) {
            throw new DataError(
              "conflict",
              "A different retention policy already uses this policy_id.",
              { details: { hash, policy_id: normalizedPolicy.policy_id } },
            );
          }
          return;
        }

        const updated: ObjectSidecar = {
          ...sidecar,
          retention_policies: [...sidecar.retention_policies, normalizedPolicy].sort(
            (left, right) => compareAscii(left.policy_id, right.policy_id),
          ),
        };
        await this.#replaceSidecar(updated);
      });
    } catch (error) {
      throw mapFilesystemError(error, "pin the object");
    }
  }

  async *inventory(query?: ObjectInventoryQuery): AsyncIterable<ObjectRef> {
    const normalized = normalizeInventoryQuery(query);
    const hashes = await this.#listSidecarHashes();

    for (const hash of hashes) {
      if (normalized.hashPrefix !== undefined && !hash.startsWith(normalized.hashPrefix)) {
        continue;
      }
      let sidecar: ObjectSidecar;
      try {
        sidecar = await this.#readCompleteSidecar(hash);
      } catch (error) {
        if (error instanceof DataError && error.code === "not_found") {
          // An interrupted two-file publication is not visible and remains repairable by put.
          continue;
        }
        throw mapFilesystemError(error, "enumerate object inventory");
      }
      if (
        normalized.mediaTypes !== undefined &&
        !normalized.mediaTypes.has(sidecar.object_ref.media_type)
      ) {
        continue;
      }
      yield toObjectRef(sidecar.object_ref);
    }
  }

  async deletePhysical(hash: string): Promise<void> {
    assertHash(hash);
    try {
      await this.#withHashLock(hash, async () => {
        const sidecar = await this.#readCompleteSidecar(hash);
        const now = parseTimestamp(this.#clock.now(), "clock.now()");
        const activePolicies = sidecar.retention_policies.filter(
          (policy) =>
            policy.retain_until === undefined ||
            parseTimestamp(policy.retain_until, "retain_until") > now,
        );
        if (activePolicies.length > 0) {
          throw new DataError("conflict", "The object is protected by retention policy.", {
            details: {
              hash,
              policy_ids: activePolicies.map((policy) => policy.policy_id),
            },
          });
        }

        const metadataPath = this.#metadataPath(hash);
        const payloadPath = this.#payloadPath(hash);
        const tombstonePath = this.#temporaryPath(`delete-${hexForHash(hash)}`, ".json");
        await this.#assertExistingShard(path.dirname(metadataPath), hash);
        await this.#assertExistingShard(path.dirname(payloadPath), hash);
        await fs.rename(metadataPath, tombstonePath);
        await syncDirectory(path.dirname(metadataPath));
        await syncDirectory(this.#temporaryRoot);

        let payloadDeleted = false;
        try {
          await this.#assertExistingShard(path.dirname(payloadPath), hash);
          await fs.unlink(payloadPath);
          payloadDeleted = true;
          await syncDirectory(path.dirname(payloadPath));
          await fs.unlink(tombstonePath);
          await syncDirectory(this.#temporaryRoot);
        } catch (error) {
          if (!payloadDeleted) {
            try {
              await this.#assertExistingShard(path.dirname(metadataPath), hash);
              await fs.rename(tombstonePath, metadataPath);
              await syncDirectory(path.dirname(metadataPath));
            } catch {
              // The tombstone is intentionally retained for initialization recovery.
            }
          }
          throw error;
        }
      });
    } catch (error) {
      throw mapFilesystemError(error, "delete the physical object");
    }
  }

  async #initialize(): Promise<void> {
    await ensureControlledDirectory(this.#objectsRoot);
    await ensureControlledDirectory(this.#payloadRoot);
    await ensureControlledDirectory(path.dirname(this.#metadataRoot));
    await ensureControlledDirectory(this.#metadataRoot);
    await ensureControlledDirectory(this.#temporaryRoot);
    await this.#recoverTemporaryFiles();
  }

  async #recoverTemporaryFiles(): Promise<void> {
    const entries = (await fs.readdir(this.#temporaryRoot, { withFileTypes: true })).sort(
      (left, right) => compareAscii(left.name, right.name),
    );

    for (const entry of entries) {
      const temporaryPath = path.join(this.#temporaryRoot, entry.name);
      const tombstoneMatch = DELETE_TOMBSTONE_PATTERN.exec(entry.name);
      if (tombstoneMatch !== null && entry.isFile()) {
        const hex = tombstoneMatch[1] as string;
        const hash = `sha256:${hex}`;
        const sidecar = await readAndValidateSidecar(temporaryPath, hash);
        if (sidecar.object_ref.hash !== hash) {
          throw new DataError("integrity_error", "A delete tombstone has the wrong hash.", {
            details: { temporary_file: entry.name },
          });
        }
        const payloadPath = this.#payloadPath(hash);
        await this.#assertRecoveryShard(path.dirname(payloadPath));
        await removeIfPresent(payloadPath);
        await syncDirectory(path.dirname(payloadPath));
        await fs.unlink(temporaryPath);
        continue;
      }
      await fs.rm(temporaryPath, { recursive: true, force: true });
    }
    await syncDirectory(this.#temporaryRoot);
  }

  async #publishPayload(temporaryPath: string, objectRef: StoredObjectRef): Promise<void> {
    const payloadPath = this.#payloadPath(objectRef.hash);
    await ensureControlledDirectory(path.dirname(payloadPath));
    try {
      await fs.link(temporaryPath, payloadPath);
      await syncDirectory(path.dirname(payloadPath));
    } catch (error) {
      if (!hasFilesystemCode(error, "EEXIST")) {
        throw error;
      }
      await verifyFileIdentity(payloadPath, objectRef.hash, objectRef.byte_size);
    }
  }

  async #publishNewSidecar(sidecar: ObjectSidecar): Promise<ObjectSidecar> {
    const hash = sidecar.object_ref.hash;
    const metadataPath = this.#metadataPath(hash);
    await ensureControlledDirectory(path.dirname(metadataPath));
    const temporaryPath = this.#temporaryPath("metadata", ".json");
    await writeSyncedFile(temporaryPath, `${canonicalJson(sidecar)}\n`);
    try {
      await fs.link(temporaryPath, metadataPath);
      await syncDirectory(path.dirname(metadataPath));
      return sidecar;
    } catch (error) {
      if (!hasFilesystemCode(error, "EEXIST")) {
        throw error;
      }
      return await this.#readCompleteSidecar(hash);
    } finally {
      await removeIfPresent(temporaryPath);
    }
  }

  async #replaceSidecar(sidecar: ObjectSidecar): Promise<void> {
    const metadataPath = this.#metadataPath(sidecar.object_ref.hash);
    const temporaryPath = this.#temporaryPath("pin", ".json");
    await writeSyncedFile(temporaryPath, `${canonicalJson(sidecar)}\n`);
    try {
      await fs.rename(temporaryPath, metadataPath);
      await syncDirectory(path.dirname(metadataPath));
    } finally {
      await removeIfPresent(temporaryPath);
    }
  }

  async #tryReadCompleteSidecar(hash: string): Promise<ObjectSidecar | undefined> {
    try {
      return await this.#readCompleteSidecar(hash);
    } catch (error) {
      if (error instanceof DataError && error.code === "not_found") {
        return undefined;
      }
      throw error;
    }
  }

  async #readCompleteSidecar(hash: string): Promise<ObjectSidecar> {
    const metadataPath = this.#metadataPath(hash);
    const payloadPath = this.#payloadPath(hash);
    let sidecar: ObjectSidecar;
    try {
      await this.#assertExistingShard(path.dirname(metadataPath), hash);
      sidecar = await readAndValidateSidecar(metadataPath, hash);
    } catch (error) {
      if (hasFilesystemCode(error, "ENOENT")) {
        throw notFound(hash);
      }
      throw error;
    }

    let payloadStat;
    try {
      await this.#assertExistingShard(path.dirname(payloadPath), hash);
      payloadStat = await fs.lstat(payloadPath);
    } catch (error) {
      if (hasFilesystemCode(error, "ENOENT")) {
        throw notFound(hash);
      }
      throw error;
    }
    if (!payloadStat.isFile() || payloadStat.isSymbolicLink()) {
      throw new DataError("integrity_error", "The object payload is not a regular file.", {
        details: { hash },
      });
    }
    if (!Number.isSafeInteger(payloadStat.size) || payloadStat.size !== sidecar.object_ref.byte_size) {
      throw new DataError("integrity_error", "The object payload size does not match metadata.", {
        details: {
          hash,
          expected_byte_size: sidecar.object_ref.byte_size,
          actual_byte_size: payloadStat.size,
        },
      });
    }
    await verifyFileIdentity(payloadPath, hash, sidecar.object_ref.byte_size);
    return sidecar;
  }

  async #assertExistingShard(directory: string, hash: string): Promise<void> {
    try {
      await assertControlledDirectory(directory);
    } catch (error) {
      if (hasFilesystemCode(error, "ENOENT")) {
        throw notFound(hash);
      }
      throw error;
    }
  }

  async #assertRecoveryShard(directory: string): Promise<void> {
    try {
      await assertControlledDirectory(directory);
    } catch (error) {
      if (!hasFilesystemCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  async #listSidecarHashes(): Promise<readonly string[]> {
    const hashes: string[] = [];
    await assertControlledDirectory(this.#metadataRoot);
    const shards = (await fs.readdir(this.#metadataRoot, { withFileTypes: true })).sort(
      (left, right) => compareAscii(left.name, right.name),
    );
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard.name) || !shard.isDirectory() || shard.isSymbolicLink()) {
        throw new DataError("integrity_error", "The object metadata tree is non-canonical.", {
          details: { entry: shard.name },
        });
      }
      const directory = path.join(this.#metadataRoot, shard.name);
      await assertControlledDirectory(directory);
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
        (left, right) => compareAscii(left.name, right.name),
      );
      for (const entry of entries) {
        const match = /^([0-9a-f]{62})\.json$/.exec(entry.name);
        if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
          throw new DataError("integrity_error", "The object metadata tree is non-canonical.", {
            details: { entry: `${shard.name}/${entry.name}` },
          });
        }
        hashes.push(`sha256:${shard.name}${match[1] as string}`);
      }
    }
    return hashes.sort();
  }

  #payloadPath(hash: string): string {
    const hex = hexForHash(hash);
    return path.join(this.#payloadRoot, hex.slice(0, 2), hex.slice(2));
  }

  #metadataPath(hash: string): string {
    const hex = hexForHash(hash);
    return path.join(this.#metadataRoot, hex.slice(0, 2), `${hex.slice(2)}.json`);
  }

  #temporaryPath(prefix: string, suffix: string): string {
    return path.join(this.#temporaryRoot, `${prefix}-${randomUUID()}${suffix}`);
  }

  async #withHashLock<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#hashLocks.get(hash) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => current);
    this.#hashLocks.set(hash, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.#hashLocks.get(hash) === tail) {
        this.#hashLocks.delete(hash);
      }
    }
  }
}

interface NormalizedPutMetadata {
  readonly expectedHash?: string;
  readonly mediaType: string;
  readonly compression: Compression;
  readonly decodedByteSize?: number;
  readonly encryption?: StoredEncryptionReference;
  readonly redactionProfile?: string;
  readonly logicalName?: string;
  readonly extensions: JsonObject;
}

function normalizePutMetadata(metadata: ObjectPutMetadata): NormalizedPutMetadata {
  if (metadata === null || typeof metadata !== "object") {
    throw new DataError("invalid_argument", "Object metadata must be an object.");
  }
  if (metadata.expected_hash !== undefined) {
    assertHash(metadata.expected_hash, "expected_hash");
  }
  assertMediaType(metadata.media_type);
  if (!(["none", "gzip", "zstd"] as const).includes(metadata.compression)) {
    throw new DataError("invalid_argument", "compression is unsupported.", {
      details: { compression: metadata.compression },
    });
  }
  if (metadata.decoded_byte_size !== undefined) {
    assertSafeUnsigned(metadata.decoded_byte_size, "decoded_byte_size");
  }
  const encryption =
    metadata.encryption === undefined
      ? undefined
      : normalizeEncryptionReference(metadata.encryption, "invalid_argument");
  assertOptionalString(metadata.redaction_profile, "redaction_profile", 128);
  assertOptionalString(metadata.logical_name, "logical_name", 512);

  const extensions = cloneExtensions(metadata.extensions ?? {});
  return {
    ...(metadata.expected_hash === undefined ? {} : { expectedHash: metadata.expected_hash }),
    mediaType: metadata.media_type,
    compression: metadata.compression,
    ...(metadata.decoded_byte_size === undefined
      ? {}
      : { decodedByteSize: metadata.decoded_byte_size }),
    ...(encryption === undefined ? {} : { encryption }),
    ...(metadata.redaction_profile === undefined
      ? {}
      : { redactionProfile: metadata.redaction_profile }),
    ...(metadata.logical_name === undefined ? {} : { logicalName: metadata.logical_name }),
    extensions,
  };
}

function normalizeEncryptionReference(
  value: unknown,
  errorCode: "invalid_argument" | "integrity_error",
): StoredEncryptionReference {
  if (!isRecord(value)) {
    throw new DataError(errorCode, "encryption must be an object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "algorithm" || keys[1] !== "key_id") {
    throw new DataError(
      errorCode,
      "encryption must contain only algorithm and key_id.",
    );
  }
  const algorithm = value["algorithm"];
  const keyId = value["key_id"];
  if (typeof algorithm !== "string" || typeof keyId !== "string") {
    throw new DataError(errorCode, "encryption algorithm and key_id must be strings.");
  }
  assertRequiredString(algorithm, "encryption.algorithm", 64, errorCode);
  assertRequiredString(keyId, "encryption.key_id", 256, errorCode);
  return { algorithm, key_id: keyId };
}

interface NormalizedInventoryQuery {
  readonly hashPrefix?: string;
  readonly mediaTypes?: ReadonlySet<string>;
}

function normalizeInventoryQuery(query: ObjectInventoryQuery | undefined): NormalizedInventoryQuery {
  if (query === undefined) {
    return {};
  }
  if (query.hash_prefix !== undefined && !HASH_PREFIX_PATTERN.test(query.hash_prefix)) {
    throw new DataError("invalid_argument", "hash_prefix must be a canonical SHA-256 prefix.", {
      details: { hash_prefix: query.hash_prefix },
    });
  }
  let mediaTypes: ReadonlySet<string> | undefined;
  if (query.media_types !== undefined) {
    const values = new Set<string>();
    for (const mediaType of query.media_types) {
      assertMediaType(mediaType);
      values.add(mediaType);
    }
    mediaTypes = values;
  }
  return {
    ...(query.hash_prefix === undefined ? {} : { hashPrefix: query.hash_prefix }),
    ...(mediaTypes === undefined ? {} : { mediaTypes }),
  };
}

function normalizeRetentionPolicy(policy: RetentionPolicy): StoredRetentionPolicy {
  if (policy === null || typeof policy !== "object") {
    throw new DataError("invalid_argument", "Retention policy must be an object.");
  }
  assertRequiredString(policy.policy_id, "policy_id", 256);
  assertRequiredString(policy.reason, "reason", 1024);
  if (policy.retain_until !== undefined) {
    parseTimestamp(policy.retain_until, "retain_until");
  }
  return {
    policy_id: policy.policy_id,
    ...(policy.retain_until === undefined ? {} : { retain_until: policy.retain_until }),
    reason: policy.reason,
  };
}

function normalizeRange(
  range: ByteRange | undefined,
  byteSize: number,
): { readonly offset: number; readonly endExclusive: number } {
  if (range === undefined) {
    return { offset: 0, endExclusive: byteSize };
  }
  assertSafeUnsigned(range.offset, "range.offset");
  if (range.length !== undefined) {
    assertSafeUnsigned(range.length, "range.length");
  }
  if (range.offset > byteSize) {
    throw new DataError("invalid_argument", "The range offset is beyond the encoded object.", {
      details: { offset: range.offset, byte_size: byteSize },
    });
  }
  const length = range.length ?? byteSize - range.offset;
  if (length > byteSize - range.offset) {
    throw new DataError("invalid_argument", "The range end is beyond the encoded object.", {
      details: { offset: range.offset, length, byte_size: byteSize },
    });
  }
  return { offset: range.offset, endExclusive: range.offset + length };
}

async function* readFileRange(
  filePath: string,
  shardDirectory: string,
  hash: string,
  offset: number,
  endExclusive: number,
): AsyncIterable<Uint8Array> {
  if (offset === endExclusive) {
    return;
  }
  let handle;
  try {
    try {
      await assertControlledDirectory(shardDirectory);
    } catch (error) {
      if (hasFilesystemCode(error, "ENOENT")) {
        throw notFound(hash);
      }
      throw error;
    }
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new DataError("integrity_error", "The object payload is not a regular file.");
    }
    let position = offset;
    while (position < endExclusive) {
      const requested = Math.min(READ_CHUNK_SIZE, endExclusive - position);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        throw new DataError("integrity_error", "The object payload ended before its metadata size.");
      }
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } catch (error) {
    throw mapFilesystemError(error, "read the object");
  } finally {
    await handle?.close();
  }
}

async function verifyFileIdentity(
  filePath: string,
  expectedHash: string,
  expectedByteSize: number,
): Promise<void> {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedByteSize) {
      throw new DataError("integrity_error", "An existing object has conflicting bytes.", {
        details: {
          hash: expectedHash,
          expected_byte_size: expectedByteSize,
          actual_byte_size: stat.size,
        },
      });
    }
    const digest = createHash("sha256");
    let position = 0;
    while (position < stat.size) {
      const requested = Math.min(READ_CHUNK_SIZE, stat.size - position);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        throw new DataError("integrity_error", "An existing object ended unexpectedly.", {
          details: { hash: expectedHash },
        });
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const actualHash = `sha256:${digest.digest("hex")}`;
    if (actualHash !== expectedHash) {
      throw new DataError("integrity_error", "An existing object fails SHA-256 verification.", {
        details: { expected_hash: expectedHash, actual_hash: actualHash },
      });
    }
  } finally {
    await handle?.close();
  }
}

async function readAndValidateSidecar(
  metadataPath: string,
  expectedHash: string,
): Promise<ObjectSidecar> {
  let handle;
  let source: string;
  try {
    handle = await fs.open(metadataPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw corruptMetadata(expectedHash, "Object metadata is not a regular file.");
    }
    source = await handle.readFile("utf8");
  } catch (error) {
    if (hasFilesystemCode(error, "ELOOP")) {
      throw corruptMetadata(expectedHash, "Object metadata must not be a symbolic link.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new DataError("integrity_error", "Object metadata is not valid JSON.", {
      details: { hash: expectedHash },
    });
  }
  return validateSidecar(value, expectedHash);
}

function validateSidecar(value: unknown, expectedHash: string): ObjectSidecar {
  const sidecar = requireRecord(value, "object sidecar");
  assertExactKeys(sidecar, ["format_version", "object_ref", "retention_policies"], "sidecar");
  if (sidecar["format_version"] !== 1) {
    throw corruptMetadata(expectedHash, "Unsupported object metadata format version.");
  }

  const objectValue = requireRecord(sidecar["object_ref"], "object_ref");
  const allowedObjectKeys = [
    "hash",
    "media_type",
    "byte_size",
    "decoded_byte_size",
    "compression",
    "encryption",
    "redaction_profile",
    "logical_name",
    "extensions",
  ];
  assertAllowedKeys(objectValue, allowedObjectKeys, "object_ref");
  const hash = objectValue["hash"];
  if (typeof hash !== "string") {
    throw corruptMetadata(expectedHash, "Object metadata hash is missing.");
  }
  assertHash(hash, "hash", "integrity_error");
  if (hash !== expectedHash) {
    throw corruptMetadata(expectedHash, "Object metadata hash does not match its path.");
  }
  const mediaType = objectValue["media_type"];
  if (typeof mediaType !== "string") {
    throw corruptMetadata(expectedHash, "Object metadata media_type is missing.");
  }
  assertMediaType(mediaType, "integrity_error");
  const byteSize = objectValue["byte_size"];
  if (typeof byteSize !== "number") {
    throw corruptMetadata(expectedHash, "Object metadata byte_size is missing.");
  }
  assertSafeUnsigned(byteSize, "byte_size", "integrity_error");
  const compression = objectValue["compression"];
  if (compression !== "none" && compression !== "gzip" && compression !== "zstd") {
    throw corruptMetadata(expectedHash, "Object metadata compression is invalid.");
  }
  const extensionsValue = objectValue["extensions"];
  if (!isRecord(extensionsValue)) {
    throw corruptMetadata(expectedHash, "Object metadata extensions are invalid.");
  }
  const extensions = cloneExtensions(extensionsValue, "integrity_error");

  const decodedByteSize = objectValue["decoded_byte_size"];
  if (decodedByteSize !== undefined) {
    if (typeof decodedByteSize !== "number") {
      throw corruptMetadata(expectedHash, "Object metadata decoded_byte_size is invalid.");
    }
    assertSafeUnsigned(decodedByteSize, "decoded_byte_size", "integrity_error");
  }
  const encryptionValue = objectValue["encryption"];
  const encryption =
    encryptionValue === undefined
      ? undefined
      : normalizeEncryptionReference(encryptionValue, "integrity_error");
  const redactionProfile = optionalStoredString(
    objectValue["redaction_profile"],
    "redaction_profile",
    128,
    expectedHash,
  );
  const logicalName = optionalStoredString(
    objectValue["logical_name"],
    "logical_name",
    512,
    expectedHash,
  );

  const policiesValue = sidecar["retention_policies"];
  if (!Array.isArray(policiesValue)) {
    throw corruptMetadata(expectedHash, "Object retention policies are invalid.");
  }
  const policies = policiesValue.map((policy) => validateStoredRetentionPolicy(policy, expectedHash));
  const policyIds = new Set<string>();
  let previousPolicyId: string | undefined;
  for (const policy of policies) {
    if (policyIds.has(policy.policy_id)) {
      throw corruptMetadata(expectedHash, "Object retention policy IDs are not unique.");
    }
    if (previousPolicyId !== undefined && compareAscii(previousPolicyId, policy.policy_id) > 0) {
      throw corruptMetadata(expectedHash, "Object retention policies are not canonical.");
    }
    policyIds.add(policy.policy_id);
    previousPolicyId = policy.policy_id;
  }

  const objectRef: StoredObjectRef = {
    hash,
    media_type: mediaType,
    byte_size: byteSize,
    ...(decodedByteSize === undefined ? {} : { decoded_byte_size: decodedByteSize }),
    compression,
    ...(encryption === undefined ? {} : { encryption }),
    ...(redactionProfile === undefined ? {} : { redaction_profile: redactionProfile }),
    ...(logicalName === undefined ? {} : { logical_name: logicalName }),
    extensions,
  };
  return {
    format_version: 1,
    object_ref: objectRef,
    retention_policies: policies,
  };
}

function validateStoredRetentionPolicy(value: unknown, hash: string): StoredRetentionPolicy {
  const policy = requireRecord(value, "retention policy");
  assertAllowedKeys(policy, ["policy_id", "retain_until", "reason"], "retention policy");
  const policyId = policy["policy_id"];
  const reason = policy["reason"];
  if (typeof policyId !== "string" || typeof reason !== "string") {
    throw corruptMetadata(hash, "A stored retention policy is incomplete.");
  }
  assertRequiredString(policyId, "policy_id", 256, "integrity_error");
  assertRequiredString(reason, "reason", 1024, "integrity_error");
  const retainUntil = policy["retain_until"];
  if (retainUntil !== undefined) {
    if (typeof retainUntil !== "string") {
      throw corruptMetadata(hash, "A stored retain_until value is invalid.");
    }
    parseTimestamp(retainUntil, "retain_until", "integrity_error");
  }
  return {
    policy_id: policyId,
    ...(retainUntil === undefined ? {} : { retain_until: retainUntil }),
    reason,
  };
}

function optionalStoredString(
  value: unknown,
  field: string,
  maximumLength: number,
  hash: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw corruptMetadata(hash, `Object metadata ${field} is invalid.`);
  }
  assertRequiredString(value, field, maximumLength, "integrity_error");
  return value;
}

function assertSameImmutableMetadata(existing: StoredObjectRef, submitted: StoredObjectRef): void {
  if (canonicalJson(existing) !== canonicalJson(submitted)) {
    throw new DataError(
      "conflict",
      "The object already exists with different immutable metadata.",
      { details: { hash: submitted.hash } },
    );
  }
}

function toObjectRef(value: StoredObjectRef): ObjectRef {
  return deepFreeze(structuredClone(value)) as ObjectRef;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function assertHash(
  hash: string,
  field = "hash",
  errorCode: "invalid_argument" | "integrity_error" = "invalid_argument",
): void {
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
    throw new DataError(errorCode, `${field} must be a canonical SHA-256 object hash.`, {
      details: { field, value: typeof hash === "string" ? hash : String(hash) },
    });
  }
}

function hexForHash(hash: string): string {
  const match = HASH_PATTERN.exec(hash);
  if (match === null) {
    throw new DataError("invalid_argument", "hash must be a canonical SHA-256 object hash.");
  }
  return match[1] as string;
}

function assertMediaType(
  mediaType: string,
  errorCode: "invalid_argument" | "integrity_error" = "invalid_argument",
): void {
  if (
    typeof mediaType !== "string" ||
    mediaType.length < 3 ||
    mediaType.length > 128 ||
    !MEDIA_TYPE_PATTERN.test(mediaType)
  ) {
    throw new DataError(errorCode, "media_type is not canonical.", {
      details: { media_type: typeof mediaType === "string" ? mediaType : String(mediaType) },
    });
  }
}

function assertSafeUnsigned(
  value: number,
  field: string,
  errorCode: "invalid_argument" | "integrity_error" = "invalid_argument",
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DataError(errorCode, `${field} must be a JSON-safe unsigned integer.`, {
      details: { field, value },
    });
  }
}

function assertOptionalString(value: string | undefined, field: string, maximumLength: number): void {
  if (value !== undefined) {
    assertRequiredString(value, field, maximumLength);
  }
}

function assertRequiredString(
  value: string,
  field: string,
  maximumLength: number,
  errorCode: "invalid_argument" | "integrity_error" = "invalid_argument",
): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new DataError(errorCode, `${field} must be between 1 and ${maximumLength} characters.`, {
      details: { field },
    });
  }
}

function cloneExtensions(
  extensions: unknown,
  errorCode: "invalid_argument" | "integrity_error" = "invalid_argument",
): JsonObject {
  if (!isRecord(extensions)) {
    throw new DataError(errorCode, "extensions must be a JSON object.");
  }
  for (const key of Object.keys(extensions)) {
    if (!EXTENSION_KEY_PATTERN.test(key)) {
      throw new DataError(errorCode, "An extension key is not namespaced.", {
        details: { extension_key: key },
      });
    }
  }
  assertJsonValue(extensions, new Set<object>(), errorCode);
  return structuredClone(extensions);
}

function assertJsonValue(
  value: unknown,
  ancestors: Set<object>,
  errorCode: "invalid_argument" | "integrity_error",
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new DataError(errorCode, "extensions contain a non-portable JSON number.");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new DataError(errorCode, "extensions contain a non-JSON value.");
  }
  if (ancestors.has(value)) {
    throw new DataError(errorCode, "extensions contain a cycle.");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      assertJsonValue(child, ancestors, errorCode);
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DataError(errorCode, "extensions contain a non-plain object.");
    }
    for (const child of Object.values(value)) {
      assertJsonValue(child, ancestors, errorCode);
    }
  }
  ancestors.delete(value);
}

function parseTimestamp(
  value: string,
  field: string,
  errorCode: "invalid_argument" | "integrity_error" = "invalid_argument",
): bigint {
  const match = TIMESTAMP_PATTERN.exec(value);
  const parsed = Date.parse(value);
  if (match === null || !Number.isFinite(parsed)) {
    throw new DataError(errorCode, `${field} must be a canonical UTC timestamp.`, {
      details: { field, value },
    });
  }
  const date = new Date(parsed);
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6])
  ) {
    throw new DataError(errorCode, `${field} must be a valid UTC timestamp.`, {
      details: { field, value },
    });
  }
  const wholeSecond = value.replace(/(?:\.[0-9]{1,9})?Z$/, "Z");
  const wholeSecondMilliseconds = Date.parse(wholeSecond);
  const fraction = (match[7] ?? "").padEnd(9, "0");
  return BigInt(wholeSecondMilliseconds) * 1_000_000n + BigInt(fraction || "0");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DataError("integrity_error", "Stored metadata contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!isRecord(value)) {
    throw new DataError("integrity_error", "Stored metadata contains a non-JSON value.");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DataError("integrity_error", `${name} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(canonicalExpected)) {
    throw new DataError("integrity_error", `${name} has unexpected or missing fields.`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new DataError("integrity_error", `${name} has unexpected fields.`, {
      details: { fields: unexpected.sort() },
    });
  }
}

function corruptMetadata(hash: string, message: string): DataError {
  return new DataError("integrity_error", message, { details: { hash } });
}

function notFound(hash: string): DataError {
  return new DataError("not_found", "The object does not exist.", { details: { hash } });
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw mapFilesystemError(error, "create the Workspace directory");
  }
}

async function ensureControlledDirectory(directory: string): Promise<void> {
  try {
    await assertControlledDirectory(directory);
    return;
  } catch (error) {
    if (!hasFilesystemCode(error, "ENOENT")) {
      throw error;
    }
  }

  const parentDirectory = path.dirname(directory);
  await assertControlledDirectory(parentDirectory);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasFilesystemCode(error, "EEXIST")) {
      throw mapFilesystemError(error, "create an Object Store directory");
    }
  }
  await assertControlledDirectory(directory);
}

async function assertControlledDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DataError("integrity_error", "An Object Store directory is not a real directory.", {
      details: { directory },
    });
  }
  const canonicalDirectory = path.resolve(directory);
  const realDirectory = await fs.realpath(directory);
  if (realDirectory !== canonicalDirectory) {
    throw new DataError(
      "integrity_error",
      "An Object Store directory resolves outside its canonical Workspace path.",
      { details: { directory } },
    );
  }
}

async function openExclusiveFile(filePath: string) {
  try {
    return await fs.open(filePath, "wx", 0o600);
  } catch (error) {
    throw mapFilesystemError(error, "create a temporary object file");
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer,
  fileOffset: number,
): Promise<void> {
  let bufferOffset = 0;
  while (bufferOffset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      bufferOffset,
      buffer.byteLength - bufferOffset,
      fileOffset + bufferOffset,
    );
    if (bytesWritten === 0) {
      throw new DataError("internal", "The filesystem made no progress writing an object.");
    }
    bufferOffset += bytesWritten;
  }
}

async function writeSyncedFile(filePath: string, contents: string): Promise<void> {
  const handle = await openExclusiveFile(filePath);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!hasFilesystemCode(error, "ENOENT")) {
      throw mapFilesystemError(error, "remove a temporary Object Store file");
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      hasFilesystemCode(error, "EINVAL") ||
      hasFilesystemCode(error, "ENOTSUP") ||
      hasFilesystemCode(error, "EISDIR")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function hasFilesystemCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function filesystemCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function mapFilesystemError(error: unknown, operation: string): Error {
  if (error instanceof DataError) {
    return error;
  }
  const code = filesystemCode(error);
  if (code === "ENOENT") {
    return new DataError("not_found", `Unable to ${operation}: a required file is missing.`, {
      details: { filesystem_code: code },
    });
  }
  if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG") {
    return new DataError("resource_exhausted", `Unable to ${operation}: storage is exhausted.`, {
      details: { filesystem_code: code },
    });
  }
  return new DataError("internal", `Unable to ${operation}.`, {
    details: { filesystem_code: code ?? "unknown" },
  });
}
