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
import { ScreenGraphEngine } from "../../engine/exploration/index.js";
import { BuildDiffEngine } from "../../engine/validation/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const LEFT_BUILD = "build_019f0000-0000-7000-8000-000000000001";
const RIGHT_BUILD = "build_019f0000-0000-7000-8000-000000000002";

test("build diffs report per-build Screen State and Transition coverage", async () => {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T18:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(900),
  });
  const graphEngine = new ScreenGraphEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(500),
  });
  const engine = new BuildDiffEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(100),
  });

  const base = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete base["screenshot"];

  const snapshot = (
    id: string,
    buildId: string,
    mutate?: (copy: Record<string, unknown>) => void,
  ): Record<string, unknown> => {
    const copy = structuredClone(base);
    copy["snapshot_id"] = id;
    (copy["runtime_context"] as Record<string, unknown>)["build_id"] = buildId;
    mutate?.(copy);
    const unit = workspace.beginUnitOfWork("write");
    unit.snapshots.put(copy as unknown as RuntimeSnapshot);
    unit.commit();
    return copy;
  };
  const addNode = (copy: Record<string, unknown>, stableId: string): void => {
    const tree = (copy["trees"] as Record<string, unknown>[])[0] as {
      payload: { inline_nodes: Record<string, unknown>[] };
    };
    const root = tree.payload.inline_nodes[0] as { node_id: string; child_ids: string[] };
    const nodeId = `node_019f0000-0000-7000-8000-0000000${stableId.length}fff`;
    root.child_ids = [...root.child_ids, nodeId];
    tree.payload.inline_nodes.push({
      node_id: nodeId,
      parent_id: root.node_id,
      stable_id: stableId,
      child_ids: [],
      native_type: "UILabel",
      role: "text",
      frame: { x: 0, y: 700, width: 390, height: 44 },
      content: { text: stableId },
      state: { visible: true, enabled: true },
      actions: [],
      capture_limitations: [],
      related_nodes: [],
      extensions: {},
    });
  };

  // Left build observes Home -> Catalog.
  const homeLeft = snapshot("snapshot_019f0000-0000-7000-8000-00000000f001", LEFT_BUILD);
  const catalogLeft = snapshot(
    "snapshot_019f0000-0000-7000-8000-00000000f002",
    LEFT_BUILD,
    (copy) => addNode(copy, "demo.catalog.marker"),
  );
  graphEngine.recordStateObservation({
    snapshot_id: homeLeft["snapshot_id"] as string,
    title: "Home",
    entry: true,
  });
  graphEngine.recordTransitionObservation({
    before_snapshot_id: homeLeft["snapshot_id"] as string,
    after_snapshot_id: catalogLeft["snapshot_id"] as string,
    action: {
      kind: "tap",
      requested_effect: "Open the catalog",
      target: { stable_id: "demo.home.open_catalog" },
    },
  });

  // Right build observes Home -> Detail: Catalog disappears, Detail appears.
  const homeRight = snapshot("snapshot_019f0000-0000-7000-8000-00000000f003", RIGHT_BUILD);
  const detailRight = snapshot(
    "snapshot_019f0000-0000-7000-8000-00000000f004",
    RIGHT_BUILD,
    (copy) => addNode(copy, "demo.detail.marker.x"),
  );
  graphEngine.recordStateObservation({
    snapshot_id: homeRight["snapshot_id"] as string,
  });
  graphEngine.recordTransitionObservation({
    before_snapshot_id: homeRight["snapshot_id"] as string,
    after_snapshot_id: detailRight["snapshot_id"] as string,
    action: {
      kind: "tap",
      requested_effect: "Open the detail screen",
      target: { stable_id: "demo.home.open_detail" },
    },
  });

  const runtimeContext = base["runtime_context"] as JsonObject;
  const diff = engine.compareBuilds({
    project_id: runtimeContext["project_id"] as string,
    application_id: runtimeContext["application_id"] as string,
    left_build_id: LEFT_BUILD,
    right_build_id: RIGHT_BUILD,
  });
  validator.assert(PROTOCOL_SCHEMA_IDS.buildDiff, diff);
  assert.deepEqual(diff["summary"], {
    total: 4,
    added: 2,
    removed: 2,
    changed: 0,
    regressed: 0,
    improved: 0,
  });
  const entries = diff["entries"] as readonly JsonObject[];
  const removedState = entries.find(
    (entry) =>
      entry["kind"] === "removed" &&
      (entry["left_subject"] as JsonObject | undefined)?.["kind"] === "screen_state",
  );
  assert.ok(removedState !== undefined);
  assert.equal(
    (removedState["left_subject"] as JsonObject)["version"],
    LEFT_BUILD,
  );
  assert.equal(removedState["right_subject"], undefined);
  const addedTransition = entries.find(
    (entry) =>
      entry["kind"] === "added" &&
      (entry["right_subject"] as JsonObject | undefined)?.["kind"] === "transition",
  );
  assert.ok(addedTransition !== undefined);
  assert.equal(addedTransition["left_subject"], undefined);

  const reloaded = engine.getBuildDiff(diff.build_diff_id);
  assert.deepEqual(reloaded, diff);

  await assert.rejects(
    Promise.resolve().then(() =>
      engine.compareBuilds({
        project_id: runtimeContext["project_id"] as string,
        application_id: runtimeContext["application_id"] as string,
        left_build_id: LEFT_BUILD,
        right_build_id: LEFT_BUILD,
      }),
    ),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.compareBuilds({
        project_id: runtimeContext["project_id"] as string,
        application_id: runtimeContext["application_id"] as string,
        left_build_id: LEFT_BUILD,
        right_build_id: "build_019f0000-0000-7000-8000-00000000dead",
      }),
    ),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
});
