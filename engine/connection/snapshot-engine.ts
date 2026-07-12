import {
  DataError,
  PROTOCOL_SCHEMA_IDS,
  type ByteStream,
  type FieldMask,
  type JsonObject,
  type JsonValue,
  type ObjectPutMetadata,
  type ObjectRef,
  type ObjectStore,
  type Page,
  type PageRequest,
  type ProtocolValidator,
  type RuntimeSnapshot,
  type SnapshotQuery,
  type SnapshotSummary,
  type WorkspaceDataSource,
} from "../../data/api/index.js";

export type SnapshotCaptureReason =
  | "manual"
  | "before_action"
  | "after_action"
  | "review"
  | "validation";

export interface CaptureSnapshotCommand {
  readonly include: FieldMask;
  readonly screenshot: "none" | "reference";
  readonly reason: SnapshotCaptureReason;
}

export interface RuntimeCapturedObject {
  /** Untrusted canonical ObjectRef candidate declared by the Runtime SDK. */
  readonly ref: unknown;
  /** Exact encoded bytes described by ref. */
  readonly stream: ByteStream;
}

export interface RuntimeCaptureResult {
  /** Untrusted canonical RuntimeSnapshot candidate returned by the Runtime SDK. */
  readonly snapshot: unknown;
  readonly objects: readonly RuntimeCapturedObject[];
}

export interface RuntimeCaptureOptions {
  readonly signal?: AbortSignal;
}

/** Observation-only Runtime boundary. Real device actions remain outside this port. */
export interface RuntimeCapturePort {
  captureSnapshot(
    command: CaptureSnapshotCommand,
    options?: RuntimeCaptureOptions,
  ): Promise<RuntimeCaptureResult>;
}

export interface SnapshotEngineDependencies {
  readonly runtime: RuntimeCapturePort;
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly validator: ProtocolValidator;
}

interface ValidatedCapturedObject {
  readonly ref: ObjectRef;
  readonly stream: ByteStream;
}

interface ValidatedCaptureResult {
  readonly snapshot: RuntimeSnapshot;
  readonly objects: readonly ValidatedCapturedObject[];
}

/**
 * Captures one immutable Snapshot, materializes every referenced Object first,
 * and makes Snapshot metadata visible through one write Unit of Work.
 */
export class CaptureSnapshotUseCase {
  readonly #runtime: RuntimeCapturePort;
  readonly #workspace: WorkspaceDataSource;
  readonly #objects: ObjectStore;
  readonly #validator: ProtocolValidator;

  constructor(dependencies: SnapshotEngineDependencies) {
    this.#runtime = dependencies.runtime;
    this.#workspace = dependencies.workspace;
    this.#objects = dependencies.objects;
    this.#validator = dependencies.validator;
  }

  async execute(
    command: CaptureSnapshotCommand,
    options?: RuntimeCaptureOptions,
  ): Promise<RuntimeSnapshot> {
    const captured = validateCaptureResult(
      await this.#runtime.captureSnapshot(command, options),
      this.#validator,
    );
    assertCaptureObjectAssociations(captured.snapshot, captured.objects, this.#validator);

    const verifiedObjects: ObjectRef[] = [];
    for (const object of captured.objects) {
      const written = await this.#objects.put(object.stream, putMetadataFor(object.ref));
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, written);
      if (canonicalJson(written) !== canonicalJson(object.ref)) {
        throw new DataError(
          "integrity_error",
          "The Object Store result does not match the Runtime SDK ObjectRef.",
          {
            details: {
              expected_hash: object.ref.hash,
              actual_hash: written.hash,
            },
          },
        );
      }
      verifiedObjects.push(cloneFrozen(written));
    }

    this.#workspace.registerVerifiedObjects(verifiedObjects);

    const unit = this.#workspace.beginUnitOfWork("write");
    let unitClosed = false;
    try {
      unit.snapshots.put(captured.snapshot, verifiedObjects);
      try {
        unit.commit();
        unitClosed = true;
      } catch (commitError) {
        try {
          unit.rollback();
        } catch {
          // A failed commit may already have closed or rolled back the Unit of Work.
        }
        unitClosed = true;
        throw commitError;
      }
    } catch (error) {
      if (!unitClosed) {
        try {
          unit.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Snapshot persistence failed and its Unit of Work could not roll back.",
          );
        }
      }
      throw error;
    }

    return new GetSnapshotQuery(this.#workspace).execute(captured.snapshot.snapshot_id);
  }
}

export class GetSnapshotQuery {
  constructor(private readonly workspace: WorkspaceDataSource) {}

  execute(snapshotId: string, fields?: FieldMask): RuntimeSnapshot {
    if (typeof snapshotId !== "string" || snapshotId.length === 0) {
      throw new DataError("invalid_argument", "snapshotId must be a non-empty string.");
    }
    return withReadUnit(this.workspace, (unit) => unit.snapshots.get(snapshotId, fields));
  }
}

export class ListSnapshotsQuery {
  constructor(private readonly workspace: WorkspaceDataSource) {}

  execute(query?: SnapshotQuery, page?: PageRequest): Page<SnapshotSummary> {
    return withReadUnit(this.workspace, (unit) => unit.snapshots.list(query, page));
  }
}

function validateCaptureResult(
  input: RuntimeCaptureResult,
  validator: ProtocolValidator,
): ValidatedCaptureResult {
  const result = requireRecord(input, "Runtime capture result");
  const objectCandidates = result["objects"];
  if (!Array.isArray(objectCandidates)) {
    throw new DataError("invalid_argument", "Runtime capture result objects must be an array.");
  }

  const snapshotCandidate = cloneUntrustedJson(result["snapshot"], "RuntimeSnapshot");
  validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshotCandidate);
  const snapshot = cloneFrozen(snapshotCandidate as RuntimeSnapshot);

  const objects = objectCandidates.map((candidate, index): ValidatedCapturedObject => {
    const object = requireRecord(candidate, "Runtime captured object");
    if (!isByteStream(object["stream"])) {
      throw new DataError(
        "invalid_argument",
        "A Runtime captured object must provide an asynchronous byte stream.",
        { details: { object_index: index } },
      );
    }
    const refCandidate = cloneUntrustedJson(object["ref"], "ObjectRef");
    validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, refCandidate);
    return {
      ref: cloneFrozen(refCandidate as ObjectRef),
      stream: object["stream"],
    };
  });

  return { snapshot, objects };
}

function assertCaptureObjectAssociations(
  snapshot: RuntimeSnapshot,
  captured: readonly ValidatedCapturedObject[],
  validator: ProtocolValidator,
): void {
  const expectedByHash = new Map<string, ObjectRef>();
  for (const object of snapshotObjectRefs(snapshot)) {
    validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
    const current = expectedByHash.get(object.hash);
    if (current !== undefined && canonicalJson(current) !== canonicalJson(object)) {
      throw new DataError(
        "integrity_error",
        "One Snapshot hash is associated with conflicting ObjectRefs.",
        { details: { snapshot_id: snapshot.snapshot_id, hash: object.hash } },
      );
    }
    expectedByHash.set(object.hash, object);
  }

  const capturedByHash = new Map<string, ObjectRef>();
  for (const object of captured) {
    if (capturedByHash.has(object.ref.hash)) {
      throw new DataError("integrity_error", "The Runtime SDK returned a duplicate object stream.", {
        details: { snapshot_id: snapshot.snapshot_id, hash: object.ref.hash },
      });
    }
    capturedByHash.set(object.ref.hash, object.ref);
  }

  for (const [hash, expected] of expectedByHash) {
    const actual = capturedByHash.get(hash);
    if (actual === undefined) {
      throw new DataError("integrity_error", "A Snapshot ObjectRef has no captured byte stream.", {
        details: { snapshot_id: snapshot.snapshot_id, hash },
      });
    }
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new DataError(
        "integrity_error",
        "A captured ObjectRef does not match the ObjectRef embedded in the Snapshot.",
        { details: { snapshot_id: snapshot.snapshot_id, hash } },
      );
    }
  }

  for (const hash of capturedByHash.keys()) {
    if (!expectedByHash.has(hash)) {
      throw new DataError(
        "integrity_error",
        "The Runtime SDK returned an object that the Snapshot does not reference.",
        { details: { snapshot_id: snapshot.snapshot_id, hash } },
      );
    }
  }
}

function snapshotObjectRefs(snapshot: RuntimeSnapshot): readonly ObjectRef[] {
  const result: ObjectRef[] = [];
  const screenshot = optionalRecord(snapshot["screenshot"]);
  if (screenshot !== undefined) {
    result.push(requireRecord(screenshot["object"], "Snapshot screenshot ObjectRef") as ObjectRef);
  }

  const trees = snapshot["trees"];
  if (!Array.isArray(trees)) {
    throw new DataError("integrity_error", "A validated RuntimeSnapshot has no tree array.");
  }
  for (const treeCandidate of trees) {
    const tree = requireRecord(treeCandidate, "Snapshot UI tree");
    const payload = requireRecord(tree["payload"], "Snapshot UI tree payload");
    const nodesObject = optionalRecord(payload["nodes_object"]);
    if (nodesObject !== undefined) {
      result.push(nodesObject as ObjectRef);
    }
  }
  return result;
}

function putMetadataFor(ref: ObjectRef): ObjectPutMetadata {
  const decodedByteSize = ref["decoded_byte_size"];
  const encryption = ref["encryption"];
  const redactionProfile = ref["redaction_profile"];
  const logicalName = ref["logical_name"];
  return {
    expected_hash: ref.hash,
    media_type: ref.media_type,
    compression: ref.compression,
    ...(typeof decodedByteSize === "number" ? { decoded_byte_size: decodedByteSize } : {}),
    ...(encryption === undefined ? {} : { encryption: structuredClone(encryption) }),
    ...(typeof redactionProfile === "string" ? { redaction_profile: redactionProfile } : {}),
    ...(typeof logicalName === "string" ? { logical_name: logicalName } : {}),
    extensions: structuredClone(ref.extensions),
  };
}

function withReadUnit<T>(
  workspace: WorkspaceDataSource,
  operation: (unit: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>) => T,
): T {
  const unit = workspace.beginUnitOfWork("read");
  try {
    return cloneFrozen(operation(unit));
  } finally {
    unit.rollback();
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataError("invalid_argument", name + " must be an object.");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataError("integrity_error", "A validated protocol object has an invalid shape.");
  }
  return value as JsonObject;
}

function isByteStream(value: unknown): value is ByteStream {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}

function cloneUntrustedJson(value: unknown, name: string): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new DataError("invalid_argument", name + " must contain cloneable JSON values.");
  }
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
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

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DataError("integrity_error", "A canonical value contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const object = value as JsonObject;
  return (
    "{" +
    Object.keys(object)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key] as JsonValue))
      .join(",") +
    "}"
  );
}
