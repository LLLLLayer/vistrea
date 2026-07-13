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
import { ExplorationEngine, ScreenGraphEngine } from "../../engine/exploration/index.js";
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

test("a tagged baseline classifies removals as regressions or expected", async () => {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T19:00:00.000Z", 1_000),
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
  // tagGraphVersion needs no capture or automation collaborators.
  const tagging = new ExplorationEngine({
    workspace,
    validator,
    capture: {
      captureSnapshot: () => Promise.reject(new Error("not used")),
    },
    automation: {} as never,
    graph: graphEngine,
  } as never);

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
    marker?: string,
  ): Record<string, unknown> => {
    const copy = structuredClone(base);
    copy["snapshot_id"] = id;
    (copy["runtime_context"] as Record<string, unknown>)["build_id"] = buildId;
    if (marker !== undefined) {
      const tree = (copy["trees"] as Record<string, unknown>[])[0] as {
        payload: { inline_nodes: Record<string, unknown>[] };
      };
      const root = tree.payload.inline_nodes[0] as { node_id: string; child_ids: string[] };
      const nodeId = `node_019f0000-0000-7000-8000-0000000${marker.length}fff`;
      root.child_ids = [...root.child_ids, nodeId];
      tree.payload.inline_nodes.push({
        node_id: nodeId,
        parent_id: root.node_id,
        stable_id: marker,
        child_ids: [],
        native_type: "UILabel",
        role: "text",
        frame: { x: 0, y: 700, width: 390, height: 44 },
        content: { text: marker },
        state: { visible: true, enabled: true },
        actions: [],
        capture_limitations: [],
        related_nodes: [],
        extensions: {},
      });
    }
    const unit = workspace.beginUnitOfWork("write");
    unit.snapshots.put(copy as unknown as RuntimeSnapshot);
    unit.commit();
    return copy;
  };
  const runtimeContext = base["runtime_context"] as JsonObject;
  const graphQuery = {
    project_id: runtimeContext["project_id"] as string,
    application_id: runtimeContext["application_id"] as string,
  };

  // The baseline knows Home -> Catalog.
  const homeLeft = snapshot("snapshot_019f0000-0000-7000-8000-00000000f101", LEFT_BUILD);
  const catalogLeft = snapshot(
    "snapshot_019f0000-0000-7000-8000-00000000f102",
    LEFT_BUILD,
    "demo.catalog.marker",
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
  tagging.tagGraphVersion({ ...graphQuery, tag_name: "release/1.0" });

  // A post-baseline experiment appears only in the left build.
  const extraLeft = snapshot(
    "snapshot_019f0000-0000-7000-8000-00000000f103",
    LEFT_BUILD,
    "demo.experiment.banner.x",
  );
  graphEngine.recordStateObservation({
    snapshot_id: extraLeft["snapshot_id"] as string,
    title: "Experiment",
  });

  // The right build keeps Home and adds Detail; Catalog and Experiment vanish.
  const homeRight = snapshot("snapshot_019f0000-0000-7000-8000-00000000f104", RIGHT_BUILD);
  const detailRight = snapshot(
    "snapshot_019f0000-0000-7000-8000-00000000f105",
    RIGHT_BUILD,
    "demo.detail.marker.xy",
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

  const diff = engine.compareBuilds({
    ...graphQuery,
    left_build_id: LEFT_BUILD,
    right_build_id: RIGHT_BUILD,
    baseline_tag: "release/1.0",
  });
  validator.assert(PROTOCOL_SCHEMA_IDS.buildDiff, diff);
  // A vanished screen has no right-build subject, so every entry stays an
  // honest `removed`; the baseline verdict rides in the extension.
  assert.deepEqual(diff["summary"], {
    total: 5,
    added: 2,
    removed: 3,
    changed: 0,
    regressed: 0,
    improved: 0,
  });
  assert.deepEqual((diff["extensions"] as JsonObject)["vistrea.baseline"], {
    tag: "release/1.0",
  });
  const entries = diff["entries"] as readonly JsonObject[];
  const classification = (entry: JsonObject): unknown =>
    ((entry["extensions"] as JsonObject)["vistrea.baseline"] as JsonObject | undefined)?.[
      "classification"
    ];
  const regressions = entries.filter((entry) => classification(entry) === "regression");
  assert.equal(regressions.length, 2);
  const regressedState = regressions.find(
    (entry) => (entry["left_subject"] as JsonObject | undefined)?.["kind"] === "screen_state",
  ) as JsonObject;
  assert.equal(regressedState["kind"], "removed");
  assert.equal(regressedState["severity"], "error");
  assert.equal(regressedState["right_subject"], undefined);
  assert.match(regressedState["summary"] as string, /baseline/);
  const expected = entries.filter((entry) => classification(entry) === "expected");
  assert.equal(expected.length, 1);
  assert.match(expected[0]?.["summary"] as string, /Experiment/);
  assert.equal((expected[0] as JsonObject)["severity"], "warning");

  // Curation must not manufacture or hide regressions. Merging the vanished
  // experiment into the surviving Home leaves a tombstone: it is history, not
  // coverage, so it must stop being reported at all.
  const graphNow = graphEngine.getGraph(graphQuery);
  const experiment = graphNow.states.find(
    (state) => (state as unknown as JsonObject)["title"] === "Experiment",
  ) as unknown as JsonObject;
  const homeState = graphNow.states.find(
    (state) => (state as unknown as JsonObject)["title"] === "Home",
  ) as unknown as JsonObject;
  graphEngine.mergeScreenStates({
    ...graphQuery,
    state_ids: [
      homeState["screen_state_id"] as string,
      experiment["screen_state_id"] as string,
    ],
    into_state_id: homeState["screen_state_id"] as string,
    expected_graph_revision: graphNow.revision,
    merged_by: { kind: "human", id: "curator-1", extensions: {} },
  });
  const afterMerge = engine.compareBuilds({
    ...graphQuery,
    left_build_id: LEFT_BUILD,
    right_build_id: RIGHT_BUILD,
    baseline_tag: "release/1.0",
  });
  const merged = (afterMerge["entries"] as readonly JsonObject[]).filter(
    (entry) =>
      (entry["left_subject"] as JsonObject | undefined)?.["id"] ===
      experiment["screen_state_id"],
  );
  assert.deepEqual(merged, []);

  // An unknown baseline tag fails closed instead of classifying nothing.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.compareBuilds({
        ...graphQuery,
        left_build_id: LEFT_BUILD,
        right_build_id: RIGHT_BUILD,
        baseline_tag: "release/none",
      }),
    ),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
});
