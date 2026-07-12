import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  PROTOCOL_SCHEMA_IDS,
  isDataError,
  type JsonObject,
  type RuntimeSnapshot,
} from "../../data/api/index.js";
import {
  MemoryDataStore,
  SequenceClock,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import {
  TuningEngine,
  type RuntimeTuningPort,
} from "../../engine/design/index.js";
import type { ApplyTuningWireCommand } from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

const DESIGNER = { kind: "human", id: "designer-1", extensions: {} };
const CONNECTION_ID = "connection_019f0000-0000-7000-8000-0000000000c1";

/** Builds canonical TuningApplications from received wire commands, like a real SDK. */
class ScriptedTuningPort implements RuntimeTuningPort {
  readonly connectionId = CONNECTION_ID;
  lastApply: ApplyTuningWireCommand | undefined;
  lastRevertId: string | undefined;
  applications = new Map<string, JsonObject>();
  #counter = 1;

  applyTuning(command: ApplyTuningWireCommand): Promise<unknown> {
    this.lastApply = command;
    const patch = command.patch as JsonObject;
    const changes = patch["changes"] as readonly JsonObject[];
    const application: JsonObject = {
      tuning_application_id: `tuningapp_019f0000-0000-7000-8000-0000000000${String(this.#counter++).padStart(2, "0")}`,
      protocol_version: { major: 1, minor: 0 },
      revision: 1,
      patch_id: patch["patch_id"] as string,
      patch_revision: patch["revision"] as number,
      connection_id: this.connectionId,
      expected_snapshot_id: command.expectedSnapshotId,
      status: "active",
      applied_changes: changes.map(
        (change) =>
          ({
            tuning_change_id: change["tuning_change_id"],
            runtime_target: change["runtime_target"],
            original_value: change["original_value"],
            applied_value: change["preview_value"],
            extensions: {},
          }) as JsonObject,
      ) as unknown as JsonObject[],
      rejected_changes: [],
      ...(command.previewTtlMs === undefined
        ? {}
        : { preview_expires_at: "2026-07-12T11:00:30.000Z" }),
      started_at: "2026-07-12T11:00:00.000Z",
      applied_at: "2026-07-12T11:00:01.000Z",
      actor: DESIGNER,
      extensions: {},
    };
    this.applications.set(String(application["tuning_application_id"]), application);
    return Promise.resolve(structuredClone(application));
  }

  revertTuning(tuningApplicationId: string): Promise<unknown> {
    this.lastRevertId = tuningApplicationId;
    const current = this.applications.get(tuningApplicationId);
    if (current === undefined) {
      return Promise.reject(new Error("Unknown application."));
    }
    const reverted: JsonObject = {
      ...current,
      revision: (current["revision"] as number) + 1,
      status: "reverted",
      reverted_at: "2026-07-12T11:00:05.000Z",
      reversion_reason: "explicit_revert",
    };
    this.applications.set(tuningApplicationId, reverted);
    return Promise.resolve(structuredClone(reverted));
  }

  expireLocally(tuningApplicationId: string): JsonObject {
    const current = this.applications.get(tuningApplicationId);
    assert.ok(current !== undefined);
    const expired: JsonObject = {
      ...current,
      revision: (current["revision"] as number) + 1,
      status: "expired",
      reverted_at: "2026-07-12T11:00:31.000Z",
      reversion_reason: "ttl_expiry",
    };
    this.applications.set(tuningApplicationId, expired);
    return expired;
  }
}

async function tuningContext(): Promise<{
  engine: TuningEngine;
  workspace: MemoryDataStore;
  port: ScriptedTuningPort;
  snapshot: RuntimeSnapshot;
  target: {
    snapshot_id: string;
    tree_id: string;
    node_id: string;
    stable_id?: string;
  };
}> {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T11:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(800),
  });
  const engine = new TuningEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(300),
  });
  const source = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete source["screenshot"];
  validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, source);
  const snapshot = source as unknown as RuntimeSnapshot;
  const unit = workspace.beginUnitOfWork("write");
  unit.snapshots.put(snapshot);
  unit.commit();
  const target = {
    snapshot_id: snapshot.snapshot_id,
    tree_id: "tree_019f0000-0000-7000-8000-000000000002",
    node_id: "node_019f0000-0000-7000-8000-000000000011",
    stable_id: "demo.home.open_catalog",
  };
  return { engine, workspace, port: new ScriptedTuningPort(), snapshot, target };
}

test("tuning patches enforce the allowlist and applications persist their lifecycle", async () => {
  const { engine, port, snapshot, target } = await tuningContext();

  assert.throws(
    () =>
      engine.createTuningPatch({
        title: "Disallowed frame preview",
        target_snapshot_id: snapshot.snapshot_id,
        changes: [
          {
            runtime_target: target,
            property: "frame",
            original_value: {
              kind: "rect",
              value: { x: 24, y: 120, width: 342, height: 52 },
              extensions: {},
            },
            preview_value: {
              kind: "rect",
              value: { x: 24, y: 100, width: 342, height: 52 },
              extensions: {},
            },
          },
        ],
        created_by: DESIGNER,
      }),
    (error: unknown) => isDataError(error, "unsupported"),
  );

  const patch = engine.createTuningPatch({
    title: "Preview catalog button opacity",
    description: "A reversible preview before the source fix.",
    target_snapshot_id: snapshot.snapshot_id,
    status: "approved",
    changes: [
      {
        runtime_target: target,
        property: "alpha",
        original_value: { kind: "number", value: 1, unit: "ratio", extensions: {} },
        preview_value: { kind: "number", value: 0.8, unit: "ratio", extensions: {} },
      },
    ],
    created_by: DESIGNER,
  });
  assert.equal(patch.revision, 1);
  assert.deepEqual(engine.getTuningPatch(patch.patch_id), patch);

  const application = await engine.applyTuningPatch(port, {
    patch_id: patch.patch_id,
    preview_ttl_ms: 30_000,
  });
  assert.equal(application.status, "active");
  assert.equal(application.connection_id, CONNECTION_ID);
  assert.equal(port.lastApply?.previewTtlMs, 30_000);
  assert.deepEqual(
    engine.listActiveTuning(CONNECTION_ID).map((item) => item.tuning_application_id),
    [application.tuning_application_id],
  );

  const reverted = await engine.revertTuningApplication(port, {
    tuning_application_id: application.tuning_application_id,
  });
  assert.equal(reverted.status, "reverted");
  assert.equal(reverted.revision, 2);
  assert.equal((reverted as JsonObject)["reversion_reason"], "explicit_revert");
  assert.deepEqual(engine.listActiveTuning(CONNECTION_ID), []);
  assert.deepEqual(
    engine.getTuningApplication(application.tuning_application_id),
    reverted,
  );

  await assert.rejects(
    engine.revertTuningApplication(port, {
      tuning_application_id: application.tuning_application_id,
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
});

test("self-reverted previews persist and mismatched runtime results fail closed", async () => {
  const { engine, port, snapshot, target } = await tuningContext();
  const patch = engine.createTuningPatch({
    title: "Preview catalog button opacity",
    target_snapshot_id: snapshot.snapshot_id,
    status: "approved",
    changes: [
      {
        runtime_target: target,
        property: "alpha",
        original_value: { kind: "number", value: 1, unit: "ratio", extensions: {} },
        preview_value: { kind: "number", value: 0.6, unit: "ratio", extensions: {} },
      },
    ],
    created_by: DESIGNER,
  });
  const application = await engine.applyTuningPatch(port, { patch_id: patch.patch_id });

  const expired = port.expireLocally(application.tuning_application_id);
  const recorded = engine.recordRuntimeReversion(expired, CONNECTION_ID);
  assert.equal(recorded.status, "expired");
  assert.equal((recorded as JsonObject)["reversion_reason"], "ttl_expiry");
  assert.deepEqual(engine.listActiveTuning(CONNECTION_ID), []);

  // A stale replay of the same terminal report cannot fork the record.
  assert.throws(
    () => engine.recordRuntimeReversion(expired, CONNECTION_ID),
    (error: unknown) => isDataError(error),
  );

  // An application bound to a different connection is rejected before persistence.
  const foreignPatch = engine.createTuningPatch({
    title: "Second preview",
    target_snapshot_id: snapshot.snapshot_id,
    changes: [
      {
        runtime_target: target,
        property: "alpha",
        original_value: { kind: "number", value: 1, unit: "ratio", extensions: {} },
        preview_value: { kind: "number", value: 0.4, unit: "ratio", extensions: {} },
      },
    ],
    created_by: DESIGNER,
  });
  const hijackedPort: RuntimeTuningPort = {
    connectionId: CONNECTION_ID,
    applyTuning: async (command) => {
      const value = (await port.applyTuning(command)) as JsonObject;
      return { ...value, connection_id: "connection_019f0000-0000-7000-8000-0000000000ff" };
    },
    revertTuning: (id) => port.revertTuning(id),
  };
  await assert.rejects(
    engine.applyTuningPatch(hijackedPort, { patch_id: foreignPatch.patch_id }),
    (error: unknown) => isDataError(error, "integrity_error"),
  );
  assert.deepEqual(engine.listActiveTuning(CONNECTION_ID), []);
});
