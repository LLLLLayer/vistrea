import {
  DataError,
  isDataError,
  type IdGenerator,
  type JsonObject,
  type OperationEvent,
  type OperationRecord,
  type OperationRef,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { AutomationError, type AutomationEngine } from "../automation/index.js";
import { SecureUuidV7IdGenerator } from "../design/uuid-v7.js";
import type { ExecutedExplorationStep, ExplorationEngine } from "./exploration-engine.js";

const OPERATION_KIND = "RunExploration";
const RESULT_TYPE = "ExplorationReport";
const DEFAULT_ACTOR_ID = "vistrea-exploration";

/** The error vocabulary the Operation schema accepts for failed runs. */
const OPERATION_ERROR_CODES = new Set([
  "invalid_argument",
  "not_found",
  "already_exists",
  "conflict",
  "unauthenticated",
  "forbidden",
  "unsupported",
  "policy_blocked",
  "unavailable",
  "timeout",
  "cancelled",
  "integrity_error",
  "resource_exhausted",
  "internal",
]);

export interface ExplorationOperationDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly automation: AutomationEngine;
  readonly exploration: ExplorationEngine;
  /** The configured automation provider the run opens its session on. */
  readonly providerId: string;
  readonly ids?: IdGenerator;
}

export interface RunExplorationCommand {
  readonly maximum_actions: number;
  readonly maximum_depth?: number;
  readonly settle_milliseconds?: number;
  readonly excluded_stable_ids?: readonly string[];
  readonly actor_id?: string;
}

/**
 * Runs bounded deterministic exploration as one canonical Operation: the run
 * executes in the background against the live Runtime, every executed step
 * appends a progress event, and the final report lands as the inline
 * Operation result. One Host drives at most one exploration at a time, since
 * a device has exactly one foreground application to walk.
 */
export class ExplorationOperationEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #automation: AutomationEngine;
  readonly #exploration: ExplorationEngine;
  readonly #providerId: string;
  readonly #ids: IdGenerator;
  #activeOperationId: string | undefined;
  #cancelRequested = false;
  #completion: Promise<void> = Promise.resolve();

  constructor(dependencies: ExplorationOperationDependencies) {
    this.#workspace = dependencies.workspace;
    this.#automation = dependencies.automation;
    this.#exploration = dependencies.exploration;
    this.#providerId = dependencies.providerId;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  /** Starts one exploration run and returns its running OperationRef. */
  run(command: RunExplorationCommand): OperationRef {
    if (this.#activeOperationId !== undefined) {
      throw new DataError("conflict", "An exploration operation is already running.", {
        details: { operation_id: this.#activeOperationId },
      });
    }
    if (
      command.actor_id !== undefined &&
      (typeof command.actor_id !== "string" ||
        command.actor_id.length === 0 ||
        command.actor_id.length > 256)
    ) {
      throw new DataError("invalid_argument", "actor_id is invalid.");
    }
    // Bounds are the walk's contract: reject them before an Operation exists
    // and before a real device session is opened, never after.
    this.#exploration.assertExploreBounds({
      maximum_actions: command.maximum_actions,
      ...(command.maximum_depth === undefined ? {} : { maximum_depth: command.maximum_depth }),
      ...(command.settle_milliseconds === undefined
        ? {}
        : { settle_milliseconds: command.settle_milliseconds }),
      ...(command.excluded_stable_ids === undefined
        ? {}
        : { excluded_stable_ids: command.excluded_stable_ids }),
      automation_session_id: "",
    });
    const operationId = this.#ids.next("operation");
    const createdAt = this.#workspace.clock.now();
    const created: OperationRef = {
      operation_id: operationId,
      kind: OPERATION_KIND,
      state: "queued",
      created_at: createdAt,
      updated_at: createdAt,
    } as unknown as OperationRef;
    this.#write((unit) =>
      unit.operations.create(created, this.#event(operationId, 1, "created", "queued", createdAt)),
    );

    const startedAt = this.#workspace.clock.now();
    const running: OperationRef = {
      ...created,
      state: "running",
      updated_at: startedAt,
    } as OperationRef;
    this.#write((unit) =>
      unit.operations.appendEvents(
        running,
        [this.#event(operationId, 2, "started", "running", startedAt)],
        2,
        { expected_revision: 1 },
      ),
    );

    this.#activeOperationId = operationId;
    this.#cancelRequested = false;
    this.#completion = this.#drive(running, command).finally(() => {
      this.#activeOperationId = undefined;
    });
    return running;
  }

  get(operationId: string): OperationRecord {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      return unit.operations.get(operationId);
    } finally {
      unit.rollback();
    }
  }

  /**
   * Requests cancellation of the active run. The walk observes the request
   * before its next action and terminates the Operation as `cancelled`;
   * observations already recorded stay in the Screen Graph.
   */
  cancel(operationId: string): OperationRef {
    const record = this.get(operationId);
    if (this.#activeOperationId !== operationId) {
      throw new DataError("conflict", "The exploration operation is not running.", {
        details: { operation_id: operationId, state: record.operation.state },
      });
    }
    this.#cancelRequested = true;
    return record.operation;
  }

  /** Resolves when the active run settles; for tests and orderly shutdown. */
  whenSettled(): Promise<void> {
    return this.#completion;
  }

  async #drive(started: OperationRef, command: RunExplorationCommand): Promise<void> {
    const operationId = started.operation_id;
    let sequence = 2;
    let revision = 2;
    let sessionId: string | undefined;
    try {
      const session = this.#automation.openSession({
        provider_id: this.#providerId,
        actor_id: command.actor_id ?? DEFAULT_ACTOR_ID,
      });
      sessionId = session.automation_session_id;
      const report = await this.#exploration.explore(
        {
          automation_session_id: session.automation_session_id,
          maximum_actions: command.maximum_actions,
          ...(command.maximum_depth === undefined
            ? {}
            : { maximum_depth: command.maximum_depth }),
          ...(command.settle_milliseconds === undefined
            ? {}
            : { settle_milliseconds: command.settle_milliseconds }),
          ...(command.excluded_stable_ids === undefined
            ? {}
            : { excluded_stable_ids: command.excluded_stable_ids }),
        },
        {
          shouldContinue: () => !this.#cancelRequested,
          onStep: (step) => {
            const time = this.#workspace.clock.now();
            this.#write((unit) =>
              unit.operations.appendEvents(
                { ...started, updated_at: time } as OperationRef,
                [
                  this.#progressEvent(
                    operationId,
                    sequence + 1,
                    time,
                    command.maximum_actions,
                    step,
                  ),
                ],
                sequence + 1,
                { expected_revision: revision },
              ),
            );
            sequence += 1;
            revision += 1;
          },
        },
      );
      const time = this.#workspace.clock.now();
      if (report.stopped_reason === "cancelled") {
        const cancellationError = {
          code: "cancelled",
          message: "The exploration run was cancelled by the caller.",
          retryable: false,
        };
        const cancelled: OperationRef = {
          ...started,
          state: "cancelled",
          updated_at: time,
          error: cancellationError,
        } as OperationRef;
        this.#write((unit) =>
          unit.operations.appendEvents(
            cancelled,
            [
              {
                ...this.#event(operationId, sequence + 1, "cancelled", "cancelled", time),
                error: cancellationError,
              } as unknown as OperationEvent,
            ],
            sequence + 1,
            { expected_revision: revision },
          ),
        );
        return;
      }
      const succeeded: OperationRef = {
        ...started,
        state: "succeeded",
        updated_at: time,
      } as OperationRef;
      this.#write((unit) =>
        unit.operations.complete(
          succeeded,
          {
            operation_id: operationId,
            result_type: RESULT_TYPE,
            storage: "inline",
            value: report as unknown as JsonObject,
          } as never,
          this.#event(operationId, sequence + 1, "succeeded", "succeeded", time),
          sequence + 1,
          { expected_revision: revision },
        ),
      );
    } catch (error) {
      const time = this.#workspace.clock.now();
      const failed: OperationRef = {
        ...started,
        state: "failed",
        updated_at: time,
        error: this.#operationError(error),
      } as OperationRef;
      try {
        this.#write((unit) =>
          unit.operations.appendEvents(
            failed,
            [
              {
                ...this.#event(operationId, sequence + 1, "failed", "failed", time),
                error: this.#operationError(error),
              } as OperationEvent,
            ],
            sequence + 1,
            { expected_revision: revision },
          ),
        );
      } catch {
        // The original run failure stays the meaningful outcome.
      }
    } finally {
      if (sessionId !== undefined) {
        try {
          this.#automation.closeSession(sessionId);
        } catch {
          // Session cleanup must not mask the run outcome.
        }
      }
    }
  }

  #event(
    operationId: string,
    sequence: number,
    kind: OperationEvent["kind"],
    state: OperationRef["state"],
    time: string,
  ): OperationEvent {
    return {
      event_id: this.#ids.next("operationevent"),
      operation_id: operationId,
      sequence,
      time,
      kind,
      state,
      extensions: {},
    } as unknown as OperationEvent;
  }

  #progressEvent(
    operationId: string,
    sequence: number,
    time: string,
    totalActions: number,
    step: ExecutedExplorationStep,
  ): OperationEvent {
    return {
      ...this.#event(operationId, sequence, "progressed", "running", time),
      progress: {
        phase: "exploration.walk",
        completed_units: Math.min(sequence - 2, totalActions),
        total_units: totalActions,
        unit: "action",
        message:
          step.kind === "tap"
            ? `Tapped ${step.target_stable_id ?? "a target"}${step.discovered_new_state ? " and discovered a new state" : ""}`
            : "Returned with physical back",
      },
    } as OperationEvent;
  }

  #operationError(error: unknown): JsonObject {
    if (isDataError(error)) {
      return {
        code: OPERATION_ERROR_CODES.has(error.code) ? error.code : "internal",
        message: error.message,
        retryable: error.retryable,
      };
    }
    if (error instanceof AutomationError) {
      return {
        code: OPERATION_ERROR_CODES.has(error.code) ? error.code : "internal",
        message: error.message,
        retryable: false,
      };
    }
    return { code: "internal", message: "The exploration run failed.", retryable: false };
  }

  #write<T>(action: (unit: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>) => T): T {
    const unit = this.#workspace.beginUnitOfWork("write");
    try {
      const value = action(unit);
      unit.commit();
      return value;
    } catch (error) {
      try {
        unit.rollback();
      } catch {
        // The original failure is the meaningful error.
      }
      throw error;
    }
  }
}
