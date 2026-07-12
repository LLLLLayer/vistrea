import assert from "node:assert/strict";
import { test } from "node:test";

import { isDataError, type JsonObject } from "../../data/api/index.js";
import { createRepositoryProtocolValidator, MemoryDataStore } from "../../data/memory/index.js";
import {
  GetEventTimelineQuery,
  RuntimeEventPump,
  type RuntimeEventEpochDescriptor,
  type RuntimeEventStreamPort,
  type RuntimeEventSubscription,
  type SubscribeRuntimeEventsCommand,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

const EPOCH_ID = "epoch_019f0000-0000-7000-8000-00000000e001";

function runtimeEvent(sequence: number, suffix: string): JsonObject {
  return {
    event_id: `event_019f0000-0000-7000-8000-0000000000${suffix}`,
    protocol_version: { major: 1, minor: 0 },
    event_epoch_id: EPOCH_ID,
    sequence,
    time: { wall_time: `2026-07-12T08:00:0${sequence % 10}.000Z` },
    kind: "transient_presented",
    stable_id: "demo.toast.success",
    payload: { text: "Saved successfully" },
    extensions: {},
  };
}

function wireBatch(
  firstSequence: number,
  lastSequence: number,
  events: readonly JsonObject[],
  epochId = EPOCH_ID,
): JsonObject {
  return {
    protocol_version: { major: 1, minor: 0 },
    event_epoch_id: epochId,
    first_sequence: firstSequence,
    last_sequence: lastSequence,
    events,
    dropped_event_count: 0,
    extensions: {},
  };
}

class ScriptedSubscription implements RuntimeEventSubscription {
  readonly subscriptionId = "scripted-events";
  readonly eventEpochId: string;
  readonly acknowledged: number[] = [];
  closedLocally = false;
  readonly #batches: unknown[];
  #waiter: ((batch: unknown | undefined) => void) | undefined;
  #ended = false;

  constructor(eventEpochId: string, batches: readonly unknown[]) {
    this.eventEpochId = eventEpochId;
    this.#batches = [...batches];
  }

  nextBatch(): Promise<unknown | undefined> {
    if (this.#batches.length > 0) {
      return Promise.resolve(this.#batches.shift());
    }
    if (this.#ended || this.closedLocally) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  acknowledge(durableThroughSequence: number): void {
    this.acknowledged.push(durableThroughSequence);
  }

  close(): void {
    this.closedLocally = true;
    this.end();
  }

  end(): void {
    this.#ended = true;
    this.#waiter?.(undefined);
    this.#waiter = undefined;
  }
}

class ScriptedEventPort implements RuntimeEventStreamPort {
  readonly eventEpoch: RuntimeEventEpochDescriptor | undefined;
  readonly subscription: ScriptedSubscription;
  lastCommand: SubscribeRuntimeEventsCommand | undefined;

  constructor(
    epoch: RuntimeEventEpochDescriptor | undefined,
    batches: readonly unknown[],
  ) {
    this.eventEpoch = epoch;
    this.subscription = new ScriptedSubscription(epoch?.eventEpochId ?? EPOCH_ID, batches);
  }

  subscribeEvents(command: SubscribeRuntimeEventsCommand): Promise<RuntimeEventSubscription> {
    this.lastCommand = command;
    return Promise.resolve(this.subscription);
  }
}

const epochDescriptor: RuntimeEventEpochDescriptor = {
  eventEpochId: EPOCH_ID,
  oldestRetainedSequence: 1,
  nextSequence: 5,
};

test("the event pump persists ordered batches, acknowledges durably, and resumes", async () => {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({ validator });

  const firstRun = new ScriptedEventPort(epochDescriptor, [
    wireBatch(1, 2, [runtimeEvent(1, "01"), runtimeEvent(2, "02")]),
    wireBatch(3, 3, [runtimeEvent(3, "03")]),
  ]);
  const pump = new RuntimeEventPump({ runtime: firstRun, workspace, validator });
  assert.equal(pump.status().state, "idle");
  await pump.start();
  assert.deepEqual(firstRun.lastCommand?.start, { mode: "oldest_retained" });
  firstRun.subscription.end();
  await pump.whenSettled();
  assert.equal(pump.status().state, "stopped");
  assert.equal(pump.status().persisted_through_sequence, 3);
  assert.deepEqual(firstRun.subscription.acknowledged, [2, 3]);

  const timeline = new GetEventTimelineQuery(workspace).execute({ event_epoch_id: EPOCH_ID });
  assert.deepEqual(
    timeline.events.map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(timeline.reported_gaps, []);

  // A second connection resumes exactly after the durably persisted history.
  const secondRun = new ScriptedEventPort(epochDescriptor, [
    wireBatch(4, 4, [runtimeEvent(4, "04")]),
  ]);
  const resumed = new RuntimeEventPump({ runtime: secondRun, workspace, validator });
  await resumed.start();
  assert.deepEqual(secondRun.lastCommand?.start, { mode: "after_sequence", sequence: 3 });
  secondRun.subscription.end();
  await resumed.whenSettled();
  assert.equal(resumed.status().persisted_through_sequence, 4);
  assert.deepEqual(secondRun.subscription.acknowledged, [4]);
});

test("the event pump resumes correctly past one repository page of history", async () => {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({ validator });
  // More persisted events than the 500-item repository page, so a resume
  // computed from one page would replay history and permanently conflict.
  const total = 620;
  const batches: JsonObject[] = [];
  for (let start = 0; start < total; start += 100) {
    const slice = Array.from({ length: Math.min(100, total - start) }, (_, index) => {
      const sequence = start + index + 1;
      return {
        ...runtimeEvent(sequence, "00"),
        event_id: `event_019f0000-0000-7000-8000-00000000${sequence
          .toString(16)
          .padStart(4, "0")}`,
        sequence,
      };
    });
    batches.push(wireBatch(start + 1, start + slice.length, slice));
  }
  const longEpoch = { ...epochDescriptor, nextSequence: total + 1 };
  const firstRun = new ScriptedEventPort(longEpoch, batches);
  const pump = new RuntimeEventPump({ runtime: firstRun, workspace, validator });
  await pump.start();
  firstRun.subscription.end();
  await pump.whenSettled();
  assert.equal(pump.status().persisted_through_sequence, total);

  const secondRun = new ScriptedEventPort(longEpoch, []);
  const resumed = new RuntimeEventPump({ runtime: secondRun, workspace, validator });
  await resumed.start();
  assert.deepEqual(secondRun.lastCommand?.start, { mode: "after_sequence", sequence: total });
  secondRun.subscription.end();
  await resumed.whenSettled();
});

test("the event pump fails closed on epoch mismatch and overlap without acknowledging", async () => {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({ validator });

  const wrongEpoch = new ScriptedEventPort(epochDescriptor, [
    wireBatch(1, 1, [runtimeEvent(1, "11")], "epoch_019f0000-0000-7000-8000-00000000e002"),
  ]);
  const pump = new RuntimeEventPump({ runtime: wrongEpoch, workspace, validator });
  await pump.start();
  await assert.rejects(pump.whenSettled(), (error: unknown) => {
    assert.ok(isDataError(error));
    return true;
  });
  assert.equal(pump.status().state, "failed");
  assert.deepEqual(wrongEpoch.subscription.acknowledged, []);
  assert.equal(wrongEpoch.subscription.closedLocally, true);
  const timeline = new GetEventTimelineQuery(workspace).execute();
  assert.deepEqual(timeline.events, []);

  const overlapping = new ScriptedEventPort(epochDescriptor, [
    wireBatch(1, 1, [runtimeEvent(1, "21")]),
    wireBatch(1, 1, [runtimeEvent(1, "22")]),
  ]);
  const overlapPump = new RuntimeEventPump({
    runtime: overlapping,
    workspace: new MemoryDataStore({ validator }),
    validator,
  });
  await overlapPump.start();
  await assert.rejects(overlapPump.whenSettled(), (error: unknown) => {
    assert.ok(isDataError(error, "integrity_error"));
    return true;
  });
  assert.deepEqual(overlapping.subscription.acknowledged, [1]);
});

test("snapshot-only sessions leave the pump in an explicit unsupported state", async () => {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({ validator });
  const port = new ScriptedEventPort(undefined, []);
  const pump = new RuntimeEventPump({ runtime: port, workspace, validator });
  await pump.start();
  assert.equal(pump.status().state, "unsupported");
  assert.equal(port.lastCommand, undefined);
  await pump.stop();
});
