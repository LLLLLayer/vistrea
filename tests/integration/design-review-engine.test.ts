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
import { FileObjectStore } from "../../data/objects/index.js";
import { DesignReviewEngine, SecureUuidV7IdGenerator } from "../../engine/design/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

const DESIGNER = { kind: "human", id: "designer-1", extensions: {} };
const DEVELOPER = { kind: "human", id: "developer-1", extensions: {} };
const COMPARATOR = { kind: "agent", id: "vistrea-design-comparison", extensions: {} };

interface EngineContext {
  readonly workspace: MemoryDataStore;
  readonly objects: FileObjectStore;
  readonly engine: DesignReviewEngine;
  readonly snapshot: RuntimeSnapshot;
}

async function engineContext(t: TestContext): Promise<EngineContext> {
  const validator = await validatorPromise;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-design-engine-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T10:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(700),
  });
  const objects = await FileObjectStore.open({ workspaceRoot: directory });
  const engine = new DesignReviewEngine({
    workspace,
    objects,
    validator,
    ids: new SequenceIdGenerator(100),
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
  return { workspace, objects, engine, snapshot };
}

async function addReference(context: EngineContext): Promise<string> {
  const asset = await context.objects.put(
    (async function* () {
      yield Buffer.from("vistrea-design-asset", "utf8");
    })(),
    { media_type: "image/png", compression: "none", logical_name: "home-baseline.png" },
  );
  const reference = await context.engine.addDesignReference({
    name: "Home baseline",
    kind: "design_artifact",
    canvas_size: { width: 390, height: 844 },
    pixel_size: { width: 1170, height: 2532 },
    asset_hash: asset.hash,
    created_by: DESIGNER,
  });
  assert.equal(reference.revision, 1);
  assert.equal((reference["artifact"] as JsonObject)["kind"], "design");
  assert.equal(
    ((reference["artifact"] as JsonObject)["object"] as JsonObject)["hash"],
    asset.hash,
  );
  return reference.design_reference_id;
}

test("design comparison locates nodes by stable ID and reports frame deviations", async (t) => {
  const context = await engineContext(t);
  const referenceId = await addReference(context);
  const snapshotId = context.snapshot.snapshot_id;
  const treeId = "tree_019f0000-0000-7000-8000-000000000002";
  const rootNodeId = "node_019f0000-0000-7000-8000-000000000010";
  const buttonNodeId = "node_019f0000-0000-7000-8000-000000000011";

  const aligned = context.engine.mapDesignRegion({
    design_reference_id: referenceId,
    design_region: { x: 0, y: 0, width: 390, height: 844 },
    runtime_target: {
      snapshot_id: snapshotId,
      tree_id: treeId,
      node_id: rootNodeId,
      stable_id: "demo.home.root",
    },
    created_by: DESIGNER,
  });
  const misaligned = context.engine.mapDesignRegion({
    design_reference_id: referenceId,
    design_region: { x: 24, y: 100, width: 342, height: 52 },
    runtime_target: {
      snapshot_id: snapshotId,
      tree_id: treeId,
      node_id: buttonNodeId,
      stable_id: "demo.home.open_catalog",
    },
    created_by: DESIGNER,
  });

  const comparison = context.engine.runDesignComparison({
    design_reference_id: referenceId,
    target_snapshot_id: snapshotId,
    completed_by: COMPARATOR,
  });
  assert.equal(comparison["quality"], "complete");
  assert.deepEqual(comparison["mapping_ids"], [
    aligned.mapping_id,
    misaligned.mapping_id,
  ]);
  const differences = comparison["differences"] as readonly JsonObject[];
  assert.equal(differences.length, 1);
  const difference = differences[0] as JsonObject;
  assert.equal(difference["category"], "frame");
  assert.equal(difference["severity"], "major");
  assert.equal(difference["delta"], 20);
  assert.equal(difference["mapping_id"], misaligned.mapping_id);
  assert.equal(
    (difference["runtime_target"] as JsonObject)["stable_id"],
    "demo.home.open_catalog",
  );
  assert.deepEqual((difference["expected"] as JsonObject)["value"], {
    x: 24,
    y: 100,
    width: 342,
    height: 52,
  });
  assert.deepEqual((difference["actual"] as JsonObject)["value"], {
    x: 24,
    y: 120,
    width: 342,
    height: 52,
  });
  assert.deepEqual(
    context.engine.getDesignComparison(String(comparison["comparison_id"])),
    comparison,
  );

  await assert.rejects(
    Promise.resolve().then(() =>
      context.engine.runDesignComparison({
        design_reference_id: referenceId,
        target_snapshot_id: "snapshot_019f0000-0000-7000-8000-000000000099",
        completed_by: COMPARATOR,
      }),
    ),
    (error: unknown) => isDataError(error, "not_found"),
  );
});

test("the Review Issue lifecycle enforces legal transitions and atomic verification", async (t) => {
  const context = await engineContext(t);
  const referenceId = await addReference(context);
  const validator = await validatorPromise;
  const snapshotId = context.snapshot.snapshot_id;
  const target = {
    snapshot_id: snapshotId,
    tree_id: "tree_019f0000-0000-7000-8000-000000000002",
    node_id: "node_019f0000-0000-7000-8000-000000000011",
    stable_id: "demo.home.open_catalog",
  };

  const issue = context.engine.createReviewIssue({
    design_reference_id: referenceId,
    runtime_target: target,
    title: "Catalog button sits 20 points too low",
    description: "The primary call to action drifted below the design baseline.",
    category: "frame",
    severity: "major",
    expected: { kind: "rect", value: { x: 24, y: 100, width: 342, height: 52 }, extensions: {} },
    actual: { kind: "rect", value: { x: 24, y: 120, width: 342, height: 52 }, extensions: {} },
    created_by: DESIGNER,
  });
  assert.equal(issue.state, "open");
  assert.equal(issue.revision, 1);

  // Illegal transitions and premature verification fail closed.
  assert.throws(
    () =>
      context.engine.updateReviewIssue({
        issue_id: issue.issue_id,
        expected_revision: 1,
        to_state: "resolved",
        changed_by: DEVELOPER,
      }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await assert.rejects(
    context.engine.verifyReviewIssue({
      issue_id: issue.issue_id,
      expected_revision: 1,
      basis: "real_build",
      result: "passed",
      verified_snapshot_id: snapshotId,
      verified_build_id: "build_019f0000-0000-7000-8000-000000000001",
      verified_by: DESIGNER,
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );

  const inProgress = context.engine.updateReviewIssue({
    issue_id: issue.issue_id,
    expected_revision: 1,
    to_state: "in_progress",
    changed_by: DEVELOPER,
  });
  const ready = context.engine.updateReviewIssue({
    issue_id: issue.issue_id,
    expected_revision: inProgress.revision,
    to_state: "ready_for_verification",
    reason: "Constraint fix landed on main.",
    changed_by: DEVELOPER,
  });

  const failed = await context.engine.verifyReviewIssue({
    issue_id: issue.issue_id,
    expected_revision: ready.revision,
    basis: "real_build",
    result: "failed",
    verified_snapshot_id: snapshotId,
    verified_build_id: "build_019f0000-0000-7000-8000-000000000001",
    rationale: "The next build still renders 20 points low.",
    verified_by: DESIGNER,
  });
  assert.equal(failed.issue.state, "in_progress");
  assert.equal(failed.record["result"], "failed");
  assert.deepEqual(failed.issue["verification_record_ids"], [
    failed.record["verification_record_id"],
  ]);

  const readyAgain = context.engine.updateReviewIssue({
    issue_id: issue.issue_id,
    expected_revision: failed.issue.revision,
    to_state: "ready_for_verification",
    changed_by: DEVELOPER,
  });
  const passed = await context.engine.verifyReviewIssue({
    issue_id: issue.issue_id,
    expected_revision: readyAgain.revision,
    basis: "real_build",
    result: "passed",
    verified_snapshot_id: snapshotId,
    verified_build_id: "build_019f0000-0000-7000-8000-000000000002",
    verified_by: DESIGNER,
  });
  assert.equal(passed.issue.state, "resolved");
  assert.equal((passed.issue["resolution"] as JsonObject)["kind"], "verified");
  assert.equal(
    (passed.issue["resolution"] as JsonObject)["verification_record_id"],
    passed.record["verification_record_id"],
  );
  assert.equal(
    (passed.issue["state_history"] as readonly JsonObject[]).length,
    passed.issue.revision,
  );

  const listed = context.engine.listReviewIssues({ states: ["resolved"] });
  assert.deepEqual(
    listed.items.map((item) => item.issue_id),
    [issue.issue_id],
  );
  assert.deepEqual(context.engine.getReviewIssue(issue.issue_id), passed.issue);

  // The engine-built values must satisfy the full canonical bundle semantics.
  const reference = context.engine.getDesignReference(referenceId);
  const bundle = {
    protocol_version: { major: 1, minor: 0 },
    revision: 1,
    references: [reference],
    mappings: [],
    comparisons: [],
    issues: [passed.issue],
    verifications: [failed.record, passed.record],
    patches: [],
    applications: [],
    extensions: {},
  };
  validator.assert(PROTOCOL_SCHEMA_IDS.designReviewBundle, bundle);

  // Stale preconditions never fork the lifecycle.
  assert.throws(
    () =>
      context.engine.updateReviewIssue({
        issue_id: issue.issue_id,
        expected_revision: 1,
        to_state: "open",
        changed_by: DEVELOPER,
      }),
    (error: unknown) => isDataError(error, "conflict"),
  );
});

test("secure identifier generation mints canonical typed UUIDv7 values", () => {
  const ids = new SecureUuidV7IdGenerator();
  const first = ids.next("issue");
  const second = ids.next("issue");
  const pattern =
    /^issue_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(first, pattern);
  assert.match(second, pattern);
  assert.notEqual(first, second);
  assert.throws(() => ids.next("Bad-Prefix"), (error: unknown) => isDataError(error, "invalid_argument"));
});
