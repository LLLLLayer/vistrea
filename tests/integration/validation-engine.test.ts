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
import { ValidationEngine } from "../../engine/validation/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const ACTOR = { kind: "human", id: "reviewer-1", extensions: {} };

interface Context {
  readonly workspace: MemoryDataStore;
  readonly engine: ValidationEngine;
  readonly base: Record<string, unknown>;
}

async function validationContext(): Promise<Context> {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T17:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(800),
  });
  const engine = new ValidationEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(300),
  });
  const base = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete base["screenshot"];
  return { workspace, engine, base };
}

function persist(workspace: MemoryDataStore, snapshot: Record<string, unknown>): void {
  const unit = workspace.beginUnitOfWork("write");
  unit.snapshots.put(snapshot as unknown as RuntimeSnapshot);
  unit.commit();
}

function nodeTemplate(nodeId: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    node_id: nodeId,
    child_ids: [],
    native_type: "UIView",
    role: "button",
    content: {},
    state: { visible: true, enabled: true },
    actions: [],
    capture_limitations: [],
    related_nodes: [],
    extensions: {},
    ...overrides,
  };
}

function withProblemNodes(base: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(base);
  copy["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-00000000e001";
  const tree = (copy["trees"] as Record<string, unknown>[])[0] as {
    payload: { inline_nodes: Record<string, unknown>[] };
  };
  const root = tree.payload.inline_nodes[0] as { node_id: string; child_ids: string[] };
  const added = [
    // Duplicates the fixture button's stable identifier.
    nodeTemplate("node_019f0000-0000-7000-8000-00000000e101", {
      stable_id: "demo.home.open_catalog",
      parent_id: root.node_id,
      frame: { x: 24, y: 240, width: 342, height: 52 },
      actions: ["tap"],
      accessibility: { label: "Duplicate", role: "button", hidden: false },
      content: { text: "Duplicate" },
    }),
    // Interactive, tiny, unlabeled, and without a stable identifier.
    nodeTemplate("node_019f0000-0000-7000-8000-00000000e102", {
      parent_id: root.node_id,
      frame: { x: 24, y: 320, width: 32, height: 32 },
      actions: ["tap"],
    }),
    // Interactive but entirely off the display.
    nodeTemplate("node_019f0000-0000-7000-8000-00000000e103", {
      stable_id: "demo.home.offscreen",
      parent_id: root.node_id,
      frame: { x: 500, y: 900, width: 100, height: 40 },
      actions: ["tap"],
      accessibility: { label: "Offscreen", role: "button", hidden: false },
      content: { text: "Offscreen" },
    }),
    // Visible but with no drawable area.
    nodeTemplate("node_019f0000-0000-7000-8000-00000000e104", {
      stable_id: "demo.home.ghost",
      parent_id: root.node_id,
      frame: { x: 10, y: 10, width: 0, height: 20 },
      role: "text",
      native_type: "UILabel",
      content: { text: "Ghost" },
    }),
  ];
  root.child_ids = [...root.child_ids, ...added.map((node) => node["node_id"] as string)];
  tree.payload.inline_nodes.push(...added);
  return copy;
}

test("core validators find structural, accessibility, and visual product issues", async () => {
  const { workspace, engine, base } = await validationContext();
  const problem = withProblemNodes(base);
  persist(workspace, problem);

  const outcome = engine.validateSnapshot({ snapshot_id: problem["snapshot_id"] as string });
  assert.equal(outcome.run["state"], "succeeded");
  assert.equal(outcome.run.revision, 2);
  const rules = outcome.findings.map((finding) => finding["rule_id"]).sort();
  // The offscreen control is also below the minimum touch target, so the
  // rule fires twice.
  assert.deepEqual(rules, [
    "accessibility.minimum-touch-target",
    "accessibility.minimum-touch-target",
    "accessibility.missing-label",
    "structural.duplicate-stable-id",
    "structural.interactive-without-stable-id",
    "visual.offscreen-interactive",
    "visual.zero-size-visible",
  ]);
  const counts = outcome.run["finding_counts"] as JsonObject;
  assert.equal(counts["total"], 7);
  assert.equal(counts["open"], 7);
  assert.deepEqual(counts["by_severity"], { info: 0, warning: 5, error: 2, critical: 0 });
  const validator = await validatorPromise;
  validator.assert(PROTOCOL_SCHEMA_IDS.validationRun, outcome.run);
  for (const finding of outcome.findings) {
    validator.assert(PROTOCOL_SCHEMA_IDS.validationFinding, finding);
  }

  // A clean Snapshot succeeds with zero findings.
  const clean = structuredClone(base);
  clean["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-00000000e002";
  persist(workspace, clean);
  const cleanOutcome = engine.validateSnapshot({
    snapshot_id: clean["snapshot_id"] as string,
  });
  assert.equal(cleanOutcome.findings.length, 0);
  assert.equal(cleanOutcome.run["state"], "succeeded");
  assert.equal((cleanOutcome.run["finding_counts"] as JsonObject)["total"], 0);

  // Category selection narrows the executed rules.
  const structuralOnly = engine.validateSnapshot({
    snapshot_id: problem["snapshot_id"] as string,
    categories: ["structural"],
  });
  assert.deepEqual(
    structuralOnly.findings.map((finding) => finding["category"]),
    ["structural", "structural"],
  );

  await assert.rejects(
    Promise.resolve().then(() =>
      engine.validateSnapshot({
        snapshot_id: "snapshot_019f0000-0000-7000-8000-00000000dead",
      }),
    ),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );

  // Caller configuration disables named rules with exact count bookkeeping
  // and persists into the run for auditability.
  const configured = engine.validateSnapshot({
    snapshot_id: problem["snapshot_id"] as string,
    configuration: { disabled_rules: ["accessibility.minimum-touch-target"] },
  });
  assert.deepEqual(
    configured.findings.map((finding) => finding["rule_id"]).sort(),
    [
      "accessibility.missing-label",
      "structural.duplicate-stable-id",
      "structural.interactive-without-stable-id",
      "visual.offscreen-interactive",
      "visual.zero-size-visible",
    ],
  );
  assert.equal((configured.run["finding_counts"] as JsonObject)["total"], 5);
  assert.deepEqual((configured.run["extensions"] as JsonObject)["vistrea.configuration"], {
    disabled_rules: ["accessibility.minimum-touch-target"],
  });
  validator.assert(PROTOCOL_SCHEMA_IDS.validationRun, configured.run);

  // A raised touch-target threshold judges the clean Snapshot's real controls.
  const strict = engine.validateSnapshot({
    snapshot_id: clean["snapshot_id"] as string,
    configuration: { minimum_touch_target_points: 200 },
  });
  assert.equal(
    strict.findings.every((finding) => finding["rule_id"] === "accessibility.minimum-touch-target"),
    true,
  );
  assert.ok(strict.findings.length >= 1);
  assert.deepEqual(
    ((strict.findings[0] as JsonObject)["expected"] as JsonObject)["minimum_width"],
    200,
  );

  // Unknown rule identifiers fail closed instead of silently validating less.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.validateSnapshot({
        snapshot_id: problem["snapshot_id"] as string,
        configuration: { disabled_rules: ["accessibility.not-a-rule"] },
      }),
    ),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
});

test("suppressions move findings and run counts with optimistic concurrency", async () => {
  const { workspace, engine, base } = await validationContext();
  const problem = withProblemNodes(base);
  persist(workspace, problem);
  const outcome = engine.validateSnapshot({ snapshot_id: problem["snapshot_id"] as string });
  const target = outcome.findings.find(
    (finding) => finding["rule_id"] === "accessibility.minimum-touch-target",
  );
  // Seven findings exist; one is suppressed below.
  assert.ok(target !== undefined);

  const suppressed = engine.suppressFinding({
    finding_id: target.finding_id,
    expected_finding_revision: 1,
    reason_code: "accepted_risk",
    justification: "The compact control is a documented design exception.",
    created_by: ACTOR,
  });
  assert.equal(suppressed["status"], "suppressed");
  assert.equal(suppressed.revision, 2);
  assert.match(suppressed["active_suppression_id"] as string, /^suppression_/);

  const run = engine.getRun(outcome.run.validation_run_id);
  const counts = run["finding_counts"] as JsonObject;
  assert.equal(counts["open"], 6);
  assert.equal(counts["suppressed"], 1);
  assert.equal(run.revision, 3);

  // Suppressing again conflicts: the finding is no longer open.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.suppressFinding({
        finding_id: target.finding_id,
        expected_finding_revision: 2,
        reason_code: "other",
        justification: "Duplicate suppression attempt.",
        created_by: ACTOR,
      }),
    ),
    (error: unknown) => isDataError(error, "conflict"),
  );

  const open = engine.listFindings({ statuses: ["open"] });
  assert.equal(open.items.length, 6);
  const reloaded = engine.getFinding(target.finding_id);
  assert.equal(reloaded["status"], "suppressed");
});

test("behavioral validators judge Screen Graph reachability", async () => {
  const { workspace, engine, base } = await validationContext();
  const validator = await validatorPromise;
  const graphEngine = new ScreenGraphEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(600),
  });
  const home = structuredClone(base);
  home["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-00000000e011";
  const catalog = withProblemNodes(base);
  catalog["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-00000000e012";
  const orphan = structuredClone(base);
  orphan["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-00000000e013";
  const orphanTree = (orphan["trees"] as Record<string, unknown>[])[0] as {
    payload: { inline_nodes: Record<string, unknown>[] };
  };
  const orphanRoot = orphanTree.payload.inline_nodes[0] as {
    node_id: string;
    child_ids: string[];
  };
  const marker = nodeTemplate("node_019f0000-0000-7000-8000-00000000e201", {
    stable_id: "demo.orphan.marker",
    parent_id: orphanRoot.node_id,
    frame: { x: 0, y: 700, width: 390, height: 44 },
    role: "text",
    native_type: "UILabel",
    content: { text: "Orphan" },
  });
  orphanRoot.child_ids = [...orphanRoot.child_ids, marker["node_id"] as string];
  orphanTree.payload.inline_nodes.push(marker);
  persist(workspace, home);
  persist(workspace, catalog);
  persist(workspace, orphan);

  graphEngine.recordStateObservation({
    snapshot_id: home["snapshot_id"] as string,
    title: "Home",
    entry: true,
  });
  graphEngine.recordTransitionObservation({
    before_snapshot_id: home["snapshot_id"] as string,
    after_snapshot_id: catalog["snapshot_id"] as string,
    action: {
      kind: "tap",
      requested_effect: "Open the catalog",
      target: { stable_id: "demo.home.open_catalog" },
    },
  });
  graphEngine.recordStateObservation({
    snapshot_id: orphan["snapshot_id"] as string,
    title: "Orphan",
  });

  const runtimeContext = home["runtime_context"] as JsonObject;
  const outcome = engine.validateScreenGraph({
    project_id: runtimeContext["project_id"] as string,
    application_id: runtimeContext["application_id"] as string,
  });
  const byRule = new Map<string, JsonObject[]>();
  for (const finding of outcome.findings) {
    const rule = finding["rule_id"] as string;
    byRule.set(rule, [...(byRule.get(rule) ?? []), finding as unknown as JsonObject]);
  }
  // The orphan state is unreachable; both non-entry states dead-end.
  assert.equal(byRule.get("behavioral.unreachable-state")?.length, 1);
  assert.equal(byRule.get("behavioral.dead-end-state")?.length, 2);
  assert.equal(outcome.run["state"], "succeeded");
  validator.assert(PROTOCOL_SCHEMA_IDS.validationRun, outcome.run);
});
