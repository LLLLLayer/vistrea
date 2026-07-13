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

function withSecondExtraNode(snapshot: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(snapshot);
  const trees = copy["trees"] as JsonObject[];
  const tree = trees[0] as { payload: { inline_nodes: JsonObject[] } };
  const root = tree.payload.inline_nodes[0] as { node_id: string; child_ids: string[] };
  const addedId = "node_019f0000-0000-7000-8000-00000000eeee";
  root.child_ids = [...root.child_ids, addedId];
  tree.payload.inline_nodes.push({
    node_id: addedId,
    parent_id: root.node_id,
    stable_id: "demo.home.other_banner",
    child_ids: [],
    native_type: "UIImageView",
    role: "image",
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

  // The path search is bounded: shortest paths first, never more than asked.
  const bounded = engine.findPath({
    source_state_id: first.source_state_id,
    target_state_id: first.target_state_id,
    maximum_paths: 1,
  });
  assert.equal(bounded.length, 1);
  assert.deepEqual(bounded[0]?.state_ids, [first.source_state_id, first.target_state_id]);
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.findPath({
        source_state_id: first.source_state_id,
        target_state_id: first.target_state_id,
        maximum_paths: 101,
      }),
    ),
    (error: unknown) => isDataError(error) && error.code === "invalid_argument",
  );

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

const CURATOR = { kind: "human", id: "curator-1", extensions: {} };

test("manual merge collapses states, re-points transitions, and aliases dedup", async () => {
  const { workspace, engine, base } = await engineContext();
  const home = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000c1");
  const variant = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000c2",
  );
  const homeAgain = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000c3");
  const variantAgain = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000c4",
  );
  persistSnapshots(workspace, [home, variant, homeAgain, variantAgain]);
  const runtimeContext = home["runtime_context"] as JsonObject;
  const graphQuery = {
    project_id: runtimeContext["project_id"] as string,
    application_id: runtimeContext["application_id"] as string,
  };

  const homeState = engine.recordStateObservation({
    snapshot_id: home["snapshot_id"] as string,
    title: "Home",
    entry: true,
  });
  const variantState = engine.recordStateObservation({
    snapshot_id: variant["snapshot_id"] as string,
    title: "Home with banner",
  });
  assert.notEqual(
    homeState.screen_state.screen_state_id,
    variantState.screen_state.screen_state_id,
  );
  const transition = engine.recordTransitionObservation({
    before_snapshot_id: home["snapshot_id"] as string,
    after_snapshot_id: variant["snapshot_id"] as string,
    action: {
      kind: "tap",
      requested_effect: "Show the banner",
      target: { stable_id: "demo.home.open_catalog" },
    },
  });
  const graphBefore = engine.getGraph(graphQuery);

  // Wrong revision conflicts before anything mutates.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.mergeScreenStates({
        ...graphQuery,
        state_ids: [
          homeState.screen_state.screen_state_id,
          variantState.screen_state.screen_state_id,
        ],
        expected_graph_revision: graphBefore.revision + 5,
        merged_by: CURATOR,
      }),
    ),
    (error: unknown) => isDataError(error, "conflict"),
  );

  const merged = engine.mergeScreenStates({
    ...graphQuery,
    state_ids: [
      homeState.screen_state.screen_state_id,
      variantState.screen_state.screen_state_id,
    ],
    expected_graph_revision: graphBefore.revision,
    merged_by: CURATOR,
    justification: "The banner is a rotating decoration of one Home screen.",
  });
  assert.equal(merged.state.screen_state_id, homeState.screen_state.screen_state_id);
  assert.equal(merged.decision["kind"], "merge");

  const graph = engine.getGraph(graphQuery);
  const survivor = graph.states.find(
    (state) => state.screen_state_id === homeState.screen_state.screen_state_id,
  ) as unknown as JsonObject;
  const tombstone = graph.states.find(
    (state) => state.screen_state_id === variantState.screen_state.screen_state_id,
  ) as unknown as JsonObject;
  assert.equal(tombstone["status"], "merged");
  assert.deepEqual(tombstone["superseded_by_state_ids"], [
    homeState.screen_state.screen_state_id,
  ]);
  // Each endpoint also records a state observation during the transition,
  // so the survivor absorbs two moved observations on top of its own two.
  assert.equal((survivor["observation_ids"] as readonly string[]).length, 4);
  const mergedTransition = graph.transitions.find(
    (candidate) => candidate.transition_id === transition.transition.transition_id,
  ) as unknown as JsonObject;
  assert.equal(mergedTransition["source_state_id"], homeState.screen_state.screen_state_id);
  assert.equal(mergedTransition["target_state_id"], homeState.screen_state.screen_state_id);
  assert.equal(graph.identity_decisions.length >= 1, true);

  // Future captures of BOTH structures deduplicate into the survivor.
  const homeRepeat = engine.recordStateObservation({
    snapshot_id: homeAgain["snapshot_id"] as string,
  });
  assert.equal(homeRepeat.created, false);
  assert.equal(
    homeRepeat.screen_state.screen_state_id,
    homeState.screen_state.screen_state_id,
  );
  const variantRepeat = engine.recordStateObservation({
    snapshot_id: variantAgain["snapshot_id"] as string,
  });
  assert.equal(variantRepeat.created, false);
  assert.equal(
    variantRepeat.screen_state.screen_state_id,
    homeState.screen_state.screen_state_id,
  );
});

test("merging states that share an action coalesces the duplicate transition", async () => {
  const { workspace, engine, base } = await engineContext();
  const home = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000e1");
  const variantA = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000e2",
  );
  const homeAgain = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000e3");
  const variantB = withSnapshotId(
    withSecondExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000e4",
  );
  const homeThird = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000e5");
  const variantAAgain = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000e6",
  );
  persistSnapshots(workspace, [home, variantA, homeAgain, variantB, homeThird, variantAAgain]);
  const runtimeContext = home["runtime_context"] as JsonObject;
  const graphQuery = {
    project_id: runtimeContext["project_id"] as string,
    application_id: runtimeContext["application_id"] as string,
  };
  const action = {
    kind: "tap" as const,
    requested_effect: "Open the variant",
    target: { stable_id: "demo.home.open_catalog" },
  };

  engine.recordStateObservation({
    snapshot_id: home["snapshot_id"] as string,
    title: "Home",
    entry: true,
  });
  // The same action reaches two structurally distinct variants, so the graph
  // holds two transitions that a merge collapses onto one endpoint pair.
  const toA = engine.recordTransitionObservation({
    before_snapshot_id: home["snapshot_id"] as string,
    after_snapshot_id: variantA["snapshot_id"] as string,
    action,
  });
  const toB = engine.recordTransitionObservation({
    before_snapshot_id: homeAgain["snapshot_id"] as string,
    after_snapshot_id: variantB["snapshot_id"] as string,
    action,
  });
  assert.notEqual(toA.transition.transition_id, toB.transition.transition_id);
  assert.notEqual(toA.target_state_id, toB.target_state_id);

  const before = engine.getGraph(graphQuery);
  engine.mergeScreenStates({
    ...graphQuery,
    state_ids: [toA.target_state_id, toB.target_state_id],
    expected_graph_revision: before.revision,
    merged_by: CURATOR,
  });

  // One transition survives with both observations; a duplicate dedup key
  // would strand occurrences no future observation can ever reach.
  const graph = engine.getGraph(graphQuery);
  assert.equal(graph.transitions.length, 1);
  const survivor = graph.transitions[0] as unknown as JsonObject;
  assert.equal((survivor["observation_ids"] as readonly string[]).length, 2);
  assert.equal(survivor["occurrence_count"], 2);
  const keys = graph.transitions.map(
    (transition) => (transition["extensions"] as JsonObject)["vistrea.transition_key"],
  );
  assert.equal(new Set(keys).size, keys.length);
  // Evidence is immutable: the observations still name the transition they
  // were captured for, and the decision records where the coalesced one went.
  const transitionObservations = (graph.observations as readonly JsonObject[]).filter(
    (observation) => observation["kind"] === "transition",
  );
  assert.equal(
    transitionObservations.some(
      (observation) => observation["transition_id"] !== survivor["transition_id"],
    ),
    true,
  );
  const mergeDecision = (graph.identity_decisions as readonly JsonObject[]).find(
    (decision) => decision["kind"] === "merge",
  ) as JsonObject;
  assert.deepEqual((mergeDecision["extensions"] as JsonObject)["vistrea.coalesced_transitions"], [
    {
      from_transition_id: toB.transition.transition_id,
      to_transition_id: survivor["transition_id"],
    },
  ]);

  // A later observation of the same action accumulates on the survivor.
  const repeat = engine.recordTransitionObservation({
    before_snapshot_id: homeThird["snapshot_id"] as string,
    after_snapshot_id: variantAAgain["snapshot_id"] as string,
    action,
  });
  assert.equal(repeat.created, false);
  assert.equal(repeat.transition["occurrence_count"], 3);
  assert.equal(engine.getGraph(graphQuery).transitions.length, 1);
});

test("splitting a wrongly merged structure gives its identity back", async () => {
  const { workspace, engine, base } = await engineContext();
  const home = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000f1");
  const variant = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000f2",
  );
  const variantAgain = withSnapshotId(
    withExtraNode(base),
    "snapshot_019f0000-0000-7000-8000-0000000000f3",
  );
  persistSnapshots(workspace, [home, variant, variantAgain]);
  const runtimeContext = home["runtime_context"] as JsonObject;
  const graphQuery = {
    project_id: runtimeContext["project_id"] as string,
    application_id: runtimeContext["application_id"] as string,
  };

  const homeState = engine.recordStateObservation({
    snapshot_id: home["snapshot_id"] as string,
    title: "Home",
    entry: true,
  });
  const variantState = engine.recordStateObservation({
    snapshot_id: variant["snapshot_id"] as string,
    title: "Home with banner",
  });

  // A curator merges them, then realizes they are genuinely different screens.
  const beforeMerge = engine.getGraph(graphQuery);
  engine.mergeScreenStates({
    ...graphQuery,
    state_ids: [
      homeState.screen_state.screen_state_id,
      variantState.screen_state.screen_state_id,
    ],
    into_state_id: homeState.screen_state.screen_state_id,
    expected_graph_revision: beforeMerge.revision,
    merged_by: CURATOR,
  });
  const merged = engine.getGraph(graphQuery);
  const survivor = merged.states.find(
    (state) => state.screen_state_id === homeState.screen_state.screen_state_id,
  ) as unknown as JsonObject;
  assert.equal(
    (
      ((survivor["identity"] as JsonObject)["extensions"] as JsonObject)[
        "vistrea.alias_layout_digests"
      ] as readonly string[]
    ).length,
    1,
  );

  // Splitting the merged observations back out reclaims the aliased digest,
  // so the merge is reversible and future captures of that structure land on
  // the restored state instead of the survivor.
  const split = engine.splitScreenState({
    ...graphQuery,
    state_id: homeState.screen_state.screen_state_id,
    observation_ids: [variantState.observation_id],
    title: "Home with banner",
    expected_graph_revision: merged.revision,
    split_by: CURATOR,
  });
  const restoredIdentity = split.state["identity"] as JsonObject;
  assert.equal(restoredIdentity["strategy"], "structural");
  assert.match(restoredIdentity["layout_digest"] as string, /^sha256:[0-9a-f]{64}$/);

  const afterSplit = engine.getGraph(graphQuery);
  const restoredSource = afterSplit.states.find(
    (state) => state.screen_state_id === homeState.screen_state.screen_state_id,
  ) as unknown as JsonObject;
  assert.equal(
    ((restoredSource["identity"] as JsonObject)["extensions"] as JsonObject)[
      "vistrea.alias_layout_digests"
    ],
    undefined,
  );

  const reobserved = engine.recordStateObservation({
    snapshot_id: variantAgain["snapshot_id"] as string,
  });
  assert.equal(reobserved.created, false);
  assert.equal(reobserved.screen_state.screen_state_id, split.state.screen_state_id);
});

test("manual split separates observations into a manual-identity state", async () => {
  const { workspace, engine, base } = await engineContext();
  const first = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000d1");
  const second = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000d2");
  const third = withSnapshotId(base, "snapshot_019f0000-0000-7000-8000-0000000000d3");
  persistSnapshots(workspace, [first, second, third]);
  const runtimeContext = first["runtime_context"] as JsonObject;
  const graphQuery = {
    project_id: runtimeContext["project_id"] as string,
    application_id: runtimeContext["application_id"] as string,
  };

  const observedFirst = engine.recordStateObservation({
    snapshot_id: first["snapshot_id"] as string,
    title: "Home",
    entry: true,
  });
  const observedSecond = engine.recordStateObservation({
    snapshot_id: second["snapshot_id"] as string,
  });
  assert.equal(observedSecond.created, false);
  const sourceStateId = observedFirst.screen_state.screen_state_id;
  const graphBefore = engine.getGraph(graphQuery);

  // The whole membership cannot move; a strict subset must remain.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.splitScreenState({
        ...graphQuery,
        state_id: sourceStateId,
        observation_ids: [observedFirst.observation_id, observedSecond.observation_id],
        expected_graph_revision: graphBefore.revision,
        split_by: CURATOR,
      }),
    ),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );

  const split = engine.splitScreenState({
    ...graphQuery,
    state_id: sourceStateId,
    observation_ids: [observedSecond.observation_id],
    title: "Home (empty account)",
    expected_graph_revision: graphBefore.revision,
    split_by: CURATOR,
  });
  assert.equal(split.decision["kind"], "split");
  assert.equal(split.state["title"], "Home (empty account)");
  assert.equal((split.state["identity"] as JsonObject)["strategy"], "manual");

  const graph = engine.getGraph(graphQuery);
  assert.equal(graph.states.length, 2);
  const source = graph.states.find(
    (state) => state.screen_state_id === sourceStateId,
  ) as unknown as JsonObject;
  assert.deepEqual(source["observation_ids"], [observedFirst.observation_id]);

  // Structurally identical future captures still deduplicate into the
  // digest-bearing source, never the manual split.
  const repeat = engine.recordStateObservation({
    snapshot_id: third["snapshot_id"] as string,
  });
  assert.equal(repeat.created, false);
  assert.equal(repeat.screen_state.screen_state_id, sourceStateId);
});
