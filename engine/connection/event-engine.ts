import {
  DataError,
  PROTOCOL_SCHEMA_IDS,
  type EventTimeline,
  type EventTimelineQuery,
  type ProtocolValidator,
  type RuntimeEventBatch,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import {
  LoopbackTransportError,
  type RuntimeEventEpochDescriptor,
  type RuntimeEventSubscription,
  type SubscribeRuntimeEventsCommand,
} from "./loopback-runtime-transport.js";

export const RUNTIME_EVENT_KINDS = [
  "node_appeared",
  "node_disappeared",
  "layout_changed",
  "state_changed",
  "transient_presented",
  "transient_dismissed",
  "screen_changed",
] as const;

/** Observation-only Runtime event boundary implemented by the loopback session. */
export interface RuntimeEventStreamPort {
  readonly eventEpoch: RuntimeEventEpochDescriptor | undefined;
  subscribeEvents(command: SubscribeRuntimeEventsCommand): Promise<RuntimeEventSubscription>;
}

export interface RuntimeEventPumpDependencies {
  readonly runtime: RuntimeEventStreamPort;
  readonly workspace: WorkspaceDataSource;
  readonly validator: ProtocolValidator;
  readonly eventKinds?: readonly string[];
  readonly maxBatchSize?: number;
}

export type RuntimeEventPumpState =
  | "idle"
  | "unsupported"
  | "running"
  | "stopped"
  | "failed";

export interface RuntimeEventPumpStatus {
  readonly state: RuntimeEventPumpState;
  readonly event_epoch_id?: string;
  readonly persisted_through_sequence?: number;
  readonly error_code?: string;
}

/**
 * Subscribes to one Runtime event stream, persists every validated batch
 * through the RuntimeEventRepository, and acknowledges only after the batch is
 * durable, so reconnects resume exactly after persisted history.
 */
export class RuntimeEventPump {
  readonly #runtime: RuntimeEventStreamPort;
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #eventKinds: readonly string[];
  readonly #maxBatchSize: number | undefined;
  #state: RuntimeEventPumpState = "idle";
  #subscription: RuntimeEventSubscription | undefined;
  #persistedThroughSequence: number | undefined;
  #errorCode: string | undefined;
  #completion: Promise<void> = Promise.resolve();

  constructor(dependencies: RuntimeEventPumpDependencies) {
    this.#runtime = dependencies.runtime;
    this.#workspace = dependencies.workspace;
    this.#validator = dependencies.validator;
    this.#eventKinds = dependencies.eventKinds ?? RUNTIME_EVENT_KINDS;
    this.#maxBatchSize = dependencies.maxBatchSize;
  }

  status(): RuntimeEventPumpStatus {
    const epoch = this.#runtime.eventEpoch;
    return {
      state: this.#state,
      ...(epoch === undefined ? {} : { event_epoch_id: epoch.eventEpochId }),
      ...(this.#persistedThroughSequence === undefined
        ? {}
        : { persisted_through_sequence: this.#persistedThroughSequence }),
      ...(this.#errorCode === undefined ? {} : { error_code: this.#errorCode }),
    };
  }

  /** Resolves once the subscription is active; the pump then drains in the background. */
  async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new DataError("conflict", "The Runtime event pump was already started.");
    }
    const epoch = this.#runtime.eventEpoch;
    if (epoch === undefined) {
      this.#state = "unsupported";
      return;
    }
    const resumeAfter = this.#durablyPersistedSequence(epoch.eventEpochId);
    const subscription = await this.#runtime.subscribeEvents({
      eventEpochId: epoch.eventEpochId,
      eventKinds: this.#eventKinds,
      start:
        resumeAfter === undefined
          ? { mode: "oldest_retained" }
          : { mode: "after_sequence", sequence: resumeAfter },
      ...(this.#maxBatchSize === undefined ? {} : { maxBatchSize: this.#maxBatchSize }),
    });
    this.#subscription = subscription;
    if (resumeAfter !== undefined) {
      this.#persistedThroughSequence = resumeAfter;
    }
    this.#state = "running";
    this.#completion = this.#drain(subscription, epoch.eventEpochId);
  }

  /** Ends the subscription and waits for the drain loop to settle. */
  async stop(): Promise<void> {
    this.#subscription?.close();
    await this.#completion;
    if (this.#state === "running") {
      this.#state = "stopped";
    }
  }

  /** Resolves when the stream ends; rejects when the pump failed. */
  whenSettled(): Promise<void> {
    return this.#completion;
  }

  async #drain(subscription: RuntimeEventSubscription, eventEpochId: string): Promise<void> {
    try {
      for (;;) {
        const candidate = await subscription.nextBatch();
        if (candidate === undefined) {
          if (this.#state === "running") {
            this.#state = "stopped";
          }
          return;
        }
        const batch = this.#validateBatch(candidate, eventEpochId);
        this.#persistBatch(batch);
        this.#persistedThroughSequence = batch.last_sequence;
        subscription.acknowledge(batch.last_sequence);
      }
    } catch (error) {
      this.#state = "failed";
      this.#errorCode =
        error instanceof LoopbackTransportError || error instanceof DataError
          ? error.code
          : "internal";
      subscription.close();
      throw error;
    }
  }

  #validateBatch(candidate: unknown, eventEpochId: string): RuntimeEventBatch {
    let cloned: unknown;
    try {
      cloned = structuredClone(candidate);
    } catch {
      throw new DataError("invalid_argument", "A Runtime event batch is not cloneable JSON.");
    }
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.runtimeEventBatch, cloned);
    const batch = cloned as RuntimeEventBatch;
    if (batch.event_epoch_id !== eventEpochId) {
      throw new DataError(
        "integrity_error",
        "A Runtime event batch does not belong to the subscribed epoch.",
        {
          details: {
            expected_event_epoch_id: eventEpochId,
            actual_event_epoch_id: batch.event_epoch_id,
          },
        },
      );
    }
    if (
      this.#persistedThroughSequence !== undefined &&
      batch.first_sequence <= this.#persistedThroughSequence
    ) {
      throw new DataError(
        "integrity_error",
        "A Runtime event batch overlaps already-durable sequences.",
        {
          details: {
            persisted_through_sequence: this.#persistedThroughSequence,
            first_sequence: batch.first_sequence,
          },
        },
      );
    }
    return batch;
  }

  #persistBatch(batch: RuntimeEventBatch): void {
    const unit = this.#workspace.beginUnitOfWork("write");
    let unitClosed = false;
    try {
      unit.runtimeEvents.appendBatch(batch);
      unit.commit();
      unitClosed = true;
    } catch (error) {
      if (!unitClosed) {
        try {
          unit.rollback();
        } catch {
          // Preserve the original persistence failure.
        }
      }
      throw error;
    }
  }

  /** The highest sequence this Workspace already holds for one epoch. */
  #durablyPersistedSequence(eventEpochId: string): number | undefined {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      const timeline = unit.runtimeEvents.getTimeline({ event_epoch_id: eventEpochId });
      let highest: number | undefined;
      for (const event of timeline.events) {
        if (highest === undefined || event.sequence > highest) {
          highest = event.sequence;
        }
      }
      for (const gap of timeline.reported_gaps) {
        if (highest === undefined || gap.last_sequence > highest) {
          highest = gap.last_sequence;
        }
      }
      return highest;
    } finally {
      unit.rollback();
    }
  }
}

export class GetEventTimelineQuery {
  constructor(private readonly workspace: WorkspaceDataSource) {}

  execute(query?: EventTimelineQuery): EventTimeline {
    const unit = this.workspace.beginUnitOfWork("read");
    try {
      return unit.runtimeEvents.getTimeline(query);
    } finally {
      unit.rollback();
    }
  }
}
