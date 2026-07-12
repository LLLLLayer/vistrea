import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

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
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import { ScreenGraphEngine, deterministicGraphId } from "../../engine/exploration/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

async function loadSnapshot(name: string): Promise<Record<string, unknown>> {
  const source = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, `protocol/fixtures/v1/runtime-snapshot/valid/${name}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete source["screenshot"];
  return source;
}

function withSnapshotId(
  snapshot: Record<string, unknown>,
  snapshotId: string,
): Record<string, unknown> {
  return { ...structuredClone(snapshot), snapshot_id: snapshotId };
}

function withExtraNode(snapshot: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(snapshot);
  const trees = copy["trees"] as JsonObject[];
  const tree = trees[0] as { payload: { inline_nodes: JsonObject[] }; root_node_ids: string[] };
  const root = tree.payload.inline_nodes[0] as {
    node_id: string;
    child_ids: string[];
  };
  const addedId = "node_019f0000-0000-7000-8000-00000000ffff";
  root.child_ids = [...root.child_ids, addedId];
  tree.payload.inline_nodes.push({
    node_id: addedId,
    parent_id: root.node_id,
    stable_id: "demo.home.extra_banner",
    child_ids: [],
    native_type: "UILabel",
    role: "text",
    content: {},
    state: { visible: true, enabled: true },
    actions: [],
    capture_limitations: [],
    related_nodes: [],
    extensions: {},
  });
  return copy;
}

interface EngineContext {
  readonly workspace: MemoryDataStore;
  readonly engine: ScreenGraphEngine;
  readonly base: Record<string, unknown>;
}

async function engineContext(): Promise<EngineContext> {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T12:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(900),
  });
  const engine = new ScreenGraphEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(300),
  });
  const base = await loadSnapshot("ios-uikit");
  return { workspace, engine, base };
}

function persistSnapshots(
  workspace: MemoryDataStore,
  snapshots: readonly Record<string, unknown>[],
): void {
  const unit = workspace.beginUnitOfWork("write");
  for (const snapshot of snapshots) {
    unit.snapshots.put(snapshot as unknown as RuntimeSnapshot);
  }
  unit.commit();
}

test("structural identity dedups repeated observations and separates changed structure", async () => {
  const { workspace, engine, base } = await engineContext();
  const first = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000a1");
  const second = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000a2");
  const changed = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000a3",
  );
  persistSnapshots(workspace, [first, second, changed]);

  const initial = engine.recordStateObservation({
    snapshot_id: first["snapshot_id"] as string,
    title: "Home",
    entry: true,
  });
  assert.equal(initial.created, true);
  assert.equal(initial.graph_revision, 1);
  assert.equal(initial.screen_state.revision, 1);
  assert.equal(initial.screen_state["title"], "Home");
  const identity = initial.screen_state["identity"] as JsonObject;
  assert.equal(identity["strategy"], "structural");
  assert.match(identity["layout_digest"] as string, /^sha256:[0-9a-f]{64}$/);
  assert.ok((identity["stable_node_ids"] as readonly string[]).includes("demo.home.root"));

  const repeated = engine.recordStateObservation({
    snapshot_id: second["snapshot_id"] as string,
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.screen_state.screen_state_id, initial.screen_state.screen_state_id);
  assert.equal(repeated.screen_state.revision, 2);
  assert.equal((repeated.screen_state["observation_ids"] as readonly string[]).length, 2);
  assert.equal(repeated.screen_state["title"], "Home");

  const distinct = engine.recordStateObservation({
    snapshot_id: changed["snapshot_id"] as string,
  });
  assert.equal(distinct.created, true);
  assert.notEqual(distinct.screen_state.screen_state_id, initial.screen_state.screen_state_id);

  const graph = engine.getGraph({
    project_id: (first["runtime_context"] as JsonObject)["project_id"] as string,
    application_id: (first["runtime_context"] as JsonObject)["application_id"] as string,
  });
  assert.equal(graph.screen_graph_id, deterministicGraphId(
    (first["runtime_context"] as JsonObject)["project_id"] as string,
    (first["runtime_context"] as JsonObject)["application_id"] as string,
  ));
  assert.equal(graph.states.length, 2);
  assert.equal(graph.observations.length, 3);
  assert.deepEqual(graph["entry_state_ids"], [initial.screen_state.screen_state_id]);
});

test("transition observations dedup by action signature and count occurrences", async () => {
  const { workspace, engine, base } = await engineContext();
  const home = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000b1");
  const detail = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000b2",
  );
  const homeAgain = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000b3");
  persistSnapshots(workspace, [home, detail, homeAgain]);

  const action = {
    kind: "tap" as const,
    requested_effect: "Open the catalog detail",
    target: { stable_id: "demo.home.open_catalog" },
  };
  const first = engine.recordTransitionObservation({
    before_snapshot_id: home["snapshot_id"] as string,
    after_snapshot_id: detail["snapshot_id"] as string,
    action,
  });
  assert.equal(first.created, true);
  assert.equal(first.transition["occurrence_count"], 1);
  assert.equal(first.transition["status"], "observed");
  assert.notEqual(first.source_state_id, first.target_state_id);

  const repeat = engine.recordTransitionObservation({
    before_snapshot_id: homeAgain["snapshot_id"] as string,
    after_snapshot_id: detail["snapshot_id"] as string,
    action,
  });
  assert.equal(repeat.created, false);
  assert.equal(repeat.transition.transition_id, first.transition.transition_id);
  assert.equal(repeat.transition["occurrence_count"], 2);
  assert.equal(repeat.transition.revision, 2);
  assert.equal(repeat.action_id, first.action_id);

  const back = engine.recordTransitionObservation({
    before_snapshot_id: detail["snapshot_id"] as string,
    after_snapshot_id: homeAgain["snapshot_id"] as string,
    action: { kind: "back", requested_effect: "Return to Home" },
  });
  assert.equal(back.created, true);
  assert.notEqual(back.transition.transition_id, first.transition.transition_id);

  const graph = engine.getGraph({
    project_id: (home["runtime_context"] as JsonObject)["project_id"] as string,
    application_id: (home["runtime_context"] as JsonObject)["application_id"] as string,
  });
  assert.equal(graph.states.length, 2);
  assert.equal(graph.transitions.length, 2);
  assert.equal((graph["actions"] as readonly JsonObject[]).length, 2);

  const paths = engine.findPath({
    source_state_id: first.source_state_id,
    target_state_id: first.target_state_id,
  });
  assert.ok(paths.length >= 1);
  assert.deepEqual(paths[0]?.state_ids, [first.source_state_id, first.target_state_id]);

  const state = engine.getState(first.source_state_id);
  assert.equal(state.screen_state_id, first.source_state_id);

  await assert.rejects(
    Promise.resolve().then(() =>
      engine.recordStateObservation({
        snapshot_id: "snapshot_019f0000-0000-7000-8000-00000000dead",
      }),
    ),
    (error: unknown) => isDataError(error) && error.code === "invalid_argument",
  );
});

test("the persisted Screen Graph survives production Workspace reopen", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-graph-workspace-"));
  t.after(async () => fs.rm(workspaceRoot, { recursive: true, force: true }));

  const base = await loadSnapshot("ios-uikit");
  const first = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000c1");

  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  let stateId: string;
  let graphId: string;
  try {
    const unit = workspace.data.beginUnitOfWork("write");
    unit.snapshots.put(first as unknown as RuntimeSnapshot);
    unit.commit();
    const engine = new ScreenGraphEngine({ workspace: workspace.data, validator });
    const recorded = engine.recordStateObservation({
      snapshot_id: first["snapshot_id"] as string,
      title: "Home",
      entry: true,
    });
    stateId = recorded.screen_state.screen_state_id;
    graphId = recorded.screen_graph_id;
  } finally {
    await workspace.close();
  }

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  try {
    const engine = new ScreenGraphEngine({ workspace: workspace.data, validator });
    const reopened = engine.getState(stateId);
    assert.equal(reopened.screen_state_id, stateId);
    const unit = workspace.data.beginUnitOfWork("read");
    try {
      const graph = unit.screenGraph.getGraph(graphId);
      assert.equal(graph.revision, 1);
      assert.equal(graph.states.length, 1);
      validator.assert(PROTOCOL_SCHEMA_IDS.screenGraph, graph);
    } finally {
      unit.rollback();
    }
  } finally {
    await workspace.close();
  }
});
