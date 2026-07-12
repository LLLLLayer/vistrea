import {
  DataError,
  PROTOCOL_SCHEMA_IDS,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type ProtocolValidator,
  type TuningApplication,
  type TuningPatch,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import type { ApplyTuningWireCommand } from "../connection/loopback-runtime-transport.js";
import { SecureUuidV7IdGenerator } from "./uuid-v7.js";

/** The project tuning allowlist for this verified slice. */
export const TUNING_PROPERTY_ALLOWLIST = ["alpha"] as const;

const ACTIVE_APPLICATION_STATUSES = new Set(["active", "partially_active"]);
const TERMINAL_REVERTED_STATUSES = new Set(["reverted", "expired", "connection_lost"]);
const REVERSION_TRIGGERS = [
  "explicit_revert",
  "ttl_expiry",
  "prepare_disconnect",
  "transport_loss",
  "connection_close",
  "application_termination",
] as const;
const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

/** The observation-side tuning boundary implemented by the loopback session. */
export interface RuntimeTuningPort {
  readonly connectionId: string;
  applyTuning(command: ApplyTuningWireCommand): Promise<unknown>;
  revertTuning(tuningApplicationId: string): Promise<unknown>;
}

export interface TuningEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly validator: ProtocolValidator;
  readonly ids?: IdGenerator;
}

export interface CreateTuningPatchCommand {
  readonly title: string;
  readonly description?: string;
  readonly target_snapshot_id: string;
  readonly issue_ids?: readonly string[];
  readonly changes: readonly {
    readonly runtime_target: {
      readonly snapshot_id: string;
      readonly tree_id: string;
      readonly node_id: string;
      readonly stable_id?: string;
    };
    readonly property: string;
    readonly original_value: JsonObject;
    readonly preview_value: JsonObject;
  }[];
  readonly status?: "draft" | "approved";
  readonly created_by: JsonObject;
}

export interface ApplyTuningPatchCommand {
  readonly patch_id: string;
  readonly preview_ttl_ms?: number;
}

export interface RevertTuningApplicationCommand {
  readonly tuning_application_id: string;
}

/**
 * Protected reversible tuning over the authenticated Runtime connection.
 *
 * The engine enforces the project property allowlist, relays canonical
 * TuningPatch values, validates the canonical TuningApplication the Runtime
 * returns against the originating patch, and persists every lifecycle state
 * so previews stay auditable and reversible.
 */
export class TuningEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #ids: IdGenerator;

  constructor(dependencies: TuningEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#validator = dependencies.validator;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  createTuningPatch(command: CreateTuningPatchCommand): TuningPatch {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    for (const change of command.changes) {
      if (!TUNING_PROPERTY_ALLOWLIST.includes(change.property as "alpha")) {
        throw new DataError(
          "unsupported",
          "The tuning property is outside the project allowlist.",
          { details: { property: change.property } },
        );
      }
    }
    const now = this.#workspace.clock.now();
    const patch = {
      patch_id: this.#ids.next("patch"),
      protocol_version: PROTOCOL_VERSION,
      revision: 1,
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      target_snapshot_id: command.target_snapshot_id,
      status: command.status ?? "draft",
      issue_ids: command.issue_ids ?? [],
      changes: command.changes.map((change) => ({
        tuning_change_id: this.#ids.next("tuningchange"),
        runtime_target: { ...change.runtime_target, extensions: {} },
        property: change.property,
        original_value: change.original_value,
        preview_value: change.preview_value,
        extensions: {},
      })),
      reversion_policy: {
        strategy: "restore_captured_original",
        triggers: [...REVERSION_TRIGGERS],
        restore_on_partial_failure: true,
        extensions: {},
      },
      created_at: now,
      created_by: command.created_by,
      updated_at: now,
      updated_by: command.created_by,
      extensions: {},
    } as unknown as TuningPatch;
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.tuningPatch, patch);
    return this.#write((unit) => {
      unit.snapshots.get(command.target_snapshot_id);
      return unit.designReviews.createPatch(patch);
    });
  }

  /**
   * Applies one persisted patch over the live connection and persists the
   * canonical TuningApplication the Runtime returns.
   */
  async applyTuningPatch(
    runtime: RuntimeTuningPort,
    command: ApplyTuningPatchCommand,
  ): Promise<TuningApplication> {
    if (
      command.preview_ttl_ms !== undefined &&
      (!Number.isSafeInteger(command.preview_ttl_ms) ||
        command.preview_ttl_ms < 100 ||
        command.preview_ttl_ms > 3_600_000)
    ) {
      throw new DataError(
        "invalid_argument",
        "preview_ttl_ms must be between 100 and 3600000 milliseconds.",
      );
    }
    const patch = this.#read((unit) => unit.designReviews.getPatch(command.patch_id));
    if (patch["status"] === "archived") {
      throw new DataError("conflict", "An archived Tuning Patch cannot be applied.", {
        details: { patch_id: command.patch_id },
      });
    }
    const candidate = await runtime.applyTuning({
      patch: patch as unknown as Readonly<Record<string, unknown>>,
      expectedSnapshotId: String(patch["target_snapshot_id"]),
      ...(command.preview_ttl_ms === undefined
        ? {}
        : { previewTtlMs: command.preview_ttl_ms }),
    });
    const application = this.#validateApplication(candidate, patch, runtime.connectionId);
    if (application.revision !== 1) {
      throw new DataError(
        "integrity_error",
        "A new Tuning Application must start at revision one.",
      );
    }
    return this.#write((unit) => unit.designReviews.createApplication(application));
  }

  /** Reverts one active application and persists its terminal state. */
  async revertTuningApplication(
    runtime: RuntimeTuningPort,
    command: RevertTuningApplicationCommand,
  ): Promise<TuningApplication> {
    const current = this.#read((unit) =>
      unit.designReviews.getApplication(command.tuning_application_id),
    );
    if (!ACTIVE_APPLICATION_STATUSES.has(String(current["status"]))) {
      throw new DataError("conflict", "Only an active Tuning Application can be reverted.", {
        details: {
          tuning_application_id: command.tuning_application_id,
          status: current["status"],
        },
      });
    }
    const patch = this.#read((unit) =>
      unit.designReviews.getPatch(String(current["patch_id"])),
    );
    const candidate = await runtime.revertTuning(command.tuning_application_id);
    const application = this.#validateApplication(candidate, patch, runtime.connectionId);
    if (
      application.tuning_application_id !== command.tuning_application_id ||
      application.revision !== current.revision + 1 ||
      application.status !== "reverted" ||
      (application as JsonObject)["reverted_at"] === undefined ||
      (application as JsonObject)["reversion_reason"] !== "explicit_revert"
    ) {
      throw new DataError(
        "integrity_error",
        "The Runtime reversion result does not match the requested application.",
        { details: { tuning_application_id: command.tuning_application_id } },
      );
    }
    return this.#write((unit) =>
      unit.designReviews.updateApplication(application, {
        expected_revision: current.revision,
      }),
    );
  }

  /**
   * Persists a reversion the Runtime performed on its own, for example on TTL
   * expiry; stale or unknown reports fail closed.
   */
  recordRuntimeReversion(candidate: unknown, connectionId: string): TuningApplication {
    return this.#write((unit) => {
      const cloned = cloneUntrusted(candidate);
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.tuningApplication, cloned);
      const application = cloned as unknown as TuningApplication;
      const current = unit.designReviews.getApplication(application.tuning_application_id);
      if (
        application.connection_id !== connectionId ||
        !TERMINAL_REVERTED_STATUSES.has(application.status) ||
        application.revision !== current.revision + 1 ||
        (application as JsonObject)["reverted_at"] === undefined
      ) {
        throw new DataError(
          "integrity_error",
          "The Runtime self-reversion report is not a valid terminal transition.",
          { details: { tuning_application_id: application.tuning_application_id } },
        );
      }
      return unit.designReviews.updateApplication(application, {
        expected_revision: current.revision,
      });
    });
  }

  getTuningPatch(id: string): TuningPatch {
    return this.#read((unit) => unit.designReviews.getPatch(id));
  }

  getTuningApplication(id: string): TuningApplication {
    return this.#read((unit) => unit.designReviews.getApplication(id));
  }

  listActiveTuning(connectionId: string): readonly TuningApplication[] {
    return this.#read((unit) => unit.designReviews.listActiveApplications(connectionId));
  }

  #validateApplication(
    candidate: unknown,
    patch: TuningPatch,
    connectionId: string,
  ): TuningApplication {
    const cloned = cloneUntrusted(candidate);
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.tuningApplication, cloned);
    const application = cloned as unknown as TuningApplication;
    const patchValue = patch as JsonObject;
    const applicationValue = application as JsonObject;
    const patchChanges = new Map(
      (patchValue["changes"] as readonly JsonObject[]).map((change) => [
        String(change["tuning_change_id"]),
        change,
      ]),
    );
    const applied = applicationValue["applied_changes"] as readonly JsonObject[];
    const rejected = applicationValue["rejected_changes"] as readonly JsonObject[];
    const resultIds = [
      ...applied.map((change) => String(change["tuning_change_id"])),
      ...rejected.map((change) => String(change["tuning_change_id"])),
    ];
    const partitionComplete =
      new Set(resultIds).size === resultIds.length &&
      resultIds.every((id) => patchChanges.has(id)) &&
      (application.status === "applying" || resultIds.length === patchChanges.size);
    const valuesMatch = applied.every((change) => {
      const source = patchChanges.get(String(change["tuning_change_id"]));
      return (
        source !== undefined &&
        canonicalJson(change["original_value"] as JsonValue) ===
          canonicalJson(source["original_value"] as JsonValue) &&
        canonicalJson(change["applied_value"] as JsonValue) ===
          canonicalJson(source["preview_value"] as JsonValue)
      );
    });
    if (
      applicationValue["patch_id"] !== patchValue["patch_id"] ||
      applicationValue["patch_revision"] !== patchValue["revision"] ||
      applicationValue["expected_snapshot_id"] !== patchValue["target_snapshot_id"] ||
      application.connection_id !== connectionId ||
      !partitionComplete ||
      !valuesMatch
    ) {
      throw new DataError(
        "integrity_error",
        "The Runtime Tuning Application does not match the originating patch.",
        { details: { patch_id: String(patchValue["patch_id"]) } },
      );
    }
    return application;
  }

  #read<T>(operation: (unit: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>) => T): T {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      return operation(unit);
    } finally {
      unit.rollback();
    }
  }

  #write<T>(operation: (unit: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>) => T): T {
    const unit = this.#workspace.beginUnitOfWork("write");
    try {
      const result = operation(unit);
      unit.commit();
      return result;
    } catch (error) {
      try {
        unit.rollback();
      } catch {
        // Preserve the original command failure.
      }
      throw error;
    }
  }
}

function cloneUntrusted(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new DataError("invalid_argument", "The Runtime returned a non-JSON tuning value.");
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(",")}}`;
}
