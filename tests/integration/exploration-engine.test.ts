import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { type JsonObject, type RuntimeSnapshot } from "../../data/api/index.js";
import {
  MemoryDataStore,
  SequenceClock,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import {
  AutomationEngine,
  type AutomationProviderPort,
  type ProviderActionCommand,
  type ProviderActionResult,
} from "../../engine/automation/index.js";
import {
  ExplorationEngine,
  ScreenGraphEngine,
  type ExplorationCapturePort,
} from "../../engine/exploration/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

type FakeScreen = "home" | "catalog" | "detail";

class FakeRuntimeUnavailable extends Error {
  readonly code = "unavailable";
}

const FAKE_SCREEN_NODES: Readonly<Record<FakeScreen, readonly { id: string; tap: boolean }[]>> = {
  home: [
    { id: "demo.home.root", tap: false },
    { id: "demo.home.open_catalog", tap: true },
  ],
  catalog: [
    { id: "demo.catalog.root", tap: false },
    { id: "demo.catalog.item_primary", tap: true },
  ],
  detail: [
    { id: "demo.detail.root", tap: false },
    { id: "demo.detail.open_form", tap: false },
  ],
};

/** A deterministic three-screen application the provider genuinely drives. */
class FakeApp {
  readonly stack: FakeScreen[] = ["home"];
  running = true;
  crashOnNextCatalogItem = false;

  get current(): FakeScreen {
    return this.stack[this.stack.length - 1] as FakeScreen;
  }

  tap(stableId: string): void {
    if (this.current === "home" && stableId === "demo.home.open_catalog") {
      this.stack.push("catalog");
    } else if (this.current === "catalog" && stableId === "demo.catalog.item_primary") {
      if (this.crashOnNextCatalogItem) {
        this.crashOnNextCatalogItem = false;
        this.running = false;
        return;
      }
      this.stack.push("detail");
    }
  }

  back(): void {
    if (this.stack.length > 1) {
      this.stack.pop();
    }
  }

  launch(): void {
    this.stack.splice(0, this.stack.length, "home");
    this.running = true;
  }
}

class FakeAppProvider implements AutomationProviderPort {
  readonly descriptor = {
    provider_id: "fake-app",
    platform: "android",
    device_kind: "virtual",
    action_kinds: ["tap", "back", "launch"],
    supports_system_alerts: false,
  } as const;

  constructor(private readonly app: FakeApp) {}

  async execute(command: ProviderActionCommand): Promise<ProviderActionResult> {
    if (command.kind === "tap") {
      const stableId = command.target?.provider_locator?.value;
      assert.ok(stableId !== undefined);
      this.app.tap(stableId);
      return { outcome: "uncertain" };
    }
    if (command.kind === "back") {
      this.app.back();
      return { outcome: "uncertain" };
    }
    if (command.kind === "launch") {
      assert.equal(command.payload?.["package_id"], "dev.vistrea.demo");
      this.app.launch();
      return { outcome: "succeeded" };
    }
    return { outcome: "failed" };
  }
}

class FakeAppCapture implements ExplorationCapturePort {
  #sequence = 0;

  constructor(
    private readonly app: FakeApp,
    private readonly workspace: MemoryDataStore,
    private readonly template: Record<string, unknown>,
  ) {}

  async captureSnapshot(): Promise<RuntimeSnapshot> {
    if (!this.app.running) {
      throw new FakeRuntimeUnavailable("The simulated Runtime connection was lost.");
    }
    this.#sequence += 1;
    const suffix = this.#sequence.toString(16).padStart(4, "0");
    const screen = this.app.current;
    const nodes = FAKE_SCREEN_NODES[screen];
    const snapshot = structuredClone(this.template);
    snapshot["snapshot_id"] = `snapshot_019f0000-0000-7000-8000-00000000${suffix}`;
    const rootChildren = nodes.slice(1).map((_, index) =>
      `node_019f0000-0000-7000-8000-0000000000${(index + 2).toString(16).padStart(2, "0")}`,
    );
    (snapshot["trees"] as unknown[])[0] = {
      tree_id: "tree_019f0000-0000-7000-8000-000000000001",
      kind: "semantic",
      root_node_ids: ["node_019f0000-0000-7000-8000-000000000001"],
      payload: {
        inline_nodes: [
          {
            node_id: "node_019f0000-0000-7000-8000-000000000001",
            stable_id: nodes[0]?.id,
            child_ids: rootChildren,
            native_type: "ViewGroup",
            role: "container",
            frame: { x: 0, y: 0, width: 390, height: 844 },
            content: {},
            state: { visible: true, enabled: true },
            actions: [],
            capture_limitations: [],
            related_nodes: [],
            extensions: {},
          },
          ...nodes.slice(1).map((node, index) => ({
            node_id: rootChildren[index],
            parent_id: "node_019f0000-0000-7000-8000-000000000001",
            stable_id: node.id,
            child_ids: [],
            native_type: node.tap ? "Button" : "TextView",
            role: node.tap ? "button" : "text",
            frame: { x: 24, y: 120 + index * 80, width: 342, height: 52 },
            content: {},
            state: { visible: true, enabled: true },
            actions: node.tap ? ["tap"] : [],
            capture_limitations: [],
            related_nodes: [],
            extensions: {},
          })),
        ],
      },
      capture_limitations: [],
      extensions: {},
    };
    const unit = this.workspace.beginUnitOfWork("write");
    unit.snapshots.put(snapshot as unknown as RuntimeSnapshot);
    unit.commit();
    return snapshot as unknown as RuntimeSnapshot;
  }
}

async function explorationContext(): Promise<{
  workspace: MemoryDataStore;
  exploration: ExplorationEngine;
  graphEngine: ScreenGraphEngine;
  app: FakeApp;
  sessionId: string;
  projectId: string;
  applicationId: string;
}> {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T15:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(400),
  });
  const template = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/minimal.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete template["screenshot"];

  const app = new FakeApp();
  const graphEngine = new ScreenGraphEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(600),
  });
  const automation = new AutomationEngine({
    workspace,
    validator,
    providers: [new FakeAppProvider(app)],
    ids: new SequenceIdGenerator(800),
  });
  const session = automation.openSession({
    provider_id: "fake-app",
    actor_id: "vistrea-exploration-tests",
  });
  const exploration = new ExplorationEngine({
    workspace,
    capture: new FakeAppCapture(app, workspace, template),
    automation,
    graph: graphEngine,
    sleep: async () => undefined,
  });
  const runtimeContext = template["runtime_context"] as JsonObject;
  return {
    workspace,
    exploration,
    graphEngine,
    app,
    sessionId: session.automation_session_id,
    projectId: runtimeContext["project_id"] as string,
    applicationId: runtimeContext["application_id"] as string,
  };
}

test("deterministic exploration discovers, deduplicates, and versions the Screen Graph", async () => {
  const context = await explorationContext();

  const report = await context.exploration.explore({
    automation_session_id: context.sessionId,
    maximum_actions: 20,
    settle_milliseconds: 0,
  });

  // Three real screens, walked depth-first with physical back navigation.
  assert.equal(report.discovered_state_ids.length, 3);
  assert.equal(report.stopped_reason, "frontier_exhausted");
  const tapSteps = report.steps.filter((step) => step.kind === "tap");
  const backSteps = report.steps.filter((step) => step.kind === "back");
  assert.deepEqual(
    tapSteps.map((step) => step.target_stable_id),
    ["demo.home.open_catalog", "demo.catalog.item_primary"],
  );
  assert.equal(backSteps.length, 2);
  assert.equal(
    report.steps.every((step) => step.created_transition),
    true,
  );

  const graph = context.graphEngine.getGraph({
    project_id: context.projectId,
    application_id: context.applicationId,
  });
  assert.equal(graph.states.length, 3);
  assert.equal(graph.transitions.length, 4);
  assert.equal((graph["entry_state_ids"] as readonly string[])[0], report.initial_state_id);

  const partialTag = context.exploration.tagGraphVersion({
    project_id: context.projectId,
    application_id: context.applicationId,
    tag_name: "exploration/v1",
  });
  assert.equal(partialTag.state_count, 3);
  assert.equal(partialTag.transition_count, 4);

  // A second run over the same application discovers nothing new: every
  // state deduplicates and every transition only accumulates occurrences.
  const repeat = await context.exploration.explore({
    automation_session_id: context.sessionId,
    maximum_actions: 20,
    settle_milliseconds: 0,
  });
  assert.equal(repeat.discovered_state_ids.length, 3);
  assert.deepEqual([...repeat.discovered_state_ids].sort(), [...report.discovered_state_ids].sort());
  // Discovery is per-run bookkeeping; persistence-level dedup shows as zero
  // created transitions and identical state identifiers.
  assert.equal(
    repeat.steps.every((step) => !step.created_transition),
    true,
  );
  const settled = context.graphEngine.getGraph({
    project_id: context.projectId,
    application_id: context.applicationId,
  });
  assert.equal(settled.states.length, 3);
  assert.equal(settled.transitions.length, 4);
  assert.equal(
    (settled.transitions as readonly JsonObject[]).every(
      (transition) => transition["occurrence_count"] === 2,
    ),
    true,
  );

  const fullTag = context.exploration.tagGraphVersion({
    project_id: context.projectId,
    application_id: context.applicationId,
    tag_name: "exploration/v2",
  });
  assert.notEqual(fullTag.screen_graph_id, partialTag.screen_graph_id);

  // Version comparison: identical structure diffs empty; the partial run
  // below diffs as added coverage.
  const unchanged = context.exploration.compareGraphVersions(
    "exploration/v1",
    "exploration/v2",
  );
  assert.deepEqual(unchanged, {
    added_state_ids: [],
    removed_state_ids: [],
    added_transition_ids: [],
    removed_transition_ids: [],
  });

  const paths = context.graphEngine.findPath({
    graph_id: report.screen_graph_id,
    source_state_id: report.initial_state_id,
    target_state_id: (tapSteps[1] as { target_state_id: string }).target_state_id,
  });
  assert.ok(paths.length >= 1);
  assert.equal(paths[0]?.transition_ids.length, 2);

  // Excluded stable IDs (for example Vistrea's own Inspector launcher) never
  // enter the frontier, so an excluded entry point ends the walk immediately.
  const fenced = await explorationContext();
  const fencedReport = await fenced.exploration.explore({
    automation_session_id: fenced.sessionId,
    maximum_actions: 20,
    settle_milliseconds: 0,
    excluded_stable_ids: ["demo.home.open_catalog"],
  });
  assert.equal(fencedReport.discovered_state_ids.length, 1);
  assert.equal(fencedReport.stopped_reason, "frontier_exhausted");
  assert.deepEqual(fencedReport.steps, []);
});

test("exploration relaunches a crashed app, restores its path, and resumes honestly", async () => {
  const context = await explorationContext();
  context.app.crashOnNextCatalogItem = true;

  const report = await context.exploration.explore({
    automation_session_id: context.sessionId,
    maximum_actions: 20,
    maximum_recovery_attempts: 2,
    settle_milliseconds: 0,
  });

  assert.equal(report.stopped_reason, "frontier_exhausted");
  assert.equal(report.discovered_state_ids.length, 3);
  assert.equal(report.recovery_attempt_count, 1);
  assert.equal(report.recovery_count, 1);
  assert.equal(report.restoration_action_count, 1);
  assert.equal(report.action_count, 7);
  assert.equal(report.recoveries[0]?.replayed_action_count, 1);
  assert.equal(
    report.recoveries[0]?.restored_state_id,
    report.steps.find((step) => step.target_stable_id === "demo.home.open_catalog")
      ?.target_state_id,
  );
  assert.deepEqual(
    report.steps.filter((step) => step.kind === "tap").map((step) => step.target_stable_id),
    ["demo.home.open_catalog", "demo.catalog.item_primary"],
  );

  const graph = context.graphEngine.getGraph({
    project_id: context.projectId,
    application_id: context.applicationId,
  });
  assert.equal(graph.states.length, 3);
  assert.equal(graph.transitions.length, 4);
  const restoredEntry = (graph.transitions as readonly JsonObject[]).find(
    (transition) => transition["occurrence_count"] === 2,
  );
  assert.ok(restoredEntry !== undefined);
});

test("a bounded budget stops exploration early and later runs extend the same versioned graph", async () => {
  const context = await explorationContext();

  const partial = await context.exploration.explore({
    automation_session_id: context.sessionId,
    maximum_actions: 1,
    settle_milliseconds: 0,
  });
  assert.equal(partial.stopped_reason, "action_budget");
  assert.equal(partial.action_count, 1);
  assert.equal(partial.discovered_state_ids.length, 2);
  context.exploration.tagGraphVersion({
    project_id: context.projectId,
    application_id: context.applicationId,
    tag_name: "coverage/partial",
  });

  const complete = await context.exploration.explore({
    automation_session_id: context.sessionId,
    maximum_actions: 20,
    settle_milliseconds: 0,
  });
  assert.equal(complete.stopped_reason, "frontier_exhausted");
  context.exploration.tagGraphVersion({
    project_id: context.projectId,
    application_id: context.applicationId,
    tag_name: "coverage/complete",
  });

  const diff = context.exploration.compareGraphVersions(
    "coverage/partial",
    "coverage/complete",
  );
  assert.equal(diff.removed_state_ids.length, 0);
  assert.equal(diff.removed_transition_ids.length, 0);
  assert.equal(diff.added_state_ids.length, 1);
  assert.ok(diff.added_transition_ids.length >= 2);
});
