import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { isDataError } from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import { TuningEngine } from "../../engine/design/index.js";
import { BuildDiffEngine, ValidationEngine } from "../../engine/validation/index.js";
import { createDisposableWorkspace } from "../../tools/acceptance/disposable-workspace.js";

const repositoryRoot = process.cwd();

test("the disposable persisted Workspace supports the complete local acceptance surface", async (t) => {
  const workspacePath = await temporaryPath(t);
  const manifest = await createDisposableWorkspace({ repositoryRoot, workspacePath });
  const validator = await createRepositoryProtocolValidator({ repositoryRoot });
  let workspace = await LocalDataWorkspace.open({ workspaceRoot: workspacePath, validator });

  const read = workspace.data.beginUnitOfWork("read");
  assert.equal(read.snapshots.get(manifest.left_snapshot_id).snapshot_id, manifest.left_snapshot_id);
  assert.equal(read.snapshots.get(manifest.right_snapshot_id).snapshot_id, manifest.right_snapshot_id);
  assert.equal(read.wiki.getCollection(manifest.collection_id).collection_id, manifest.collection_id);
  assert.equal(read.wiki.get(manifest.wiki_node_id).wiki_node_id, manifest.wiki_node_id);
  assert.equal(
    read.wiki.get(manifest.post_recovery_marker_node_id).wiki_node_id,
    manifest.post_recovery_marker_node_id,
  );
  read.rollback();

  const sourceHandoff = new TuningEngine({ workspace: workspace.data, validator })
    .generateSourceSuggestions(manifest.tuning_patch_id);
  assert.equal(sourceHandoff.suggestions.length, 1);
  assert.equal(sourceHandoff.suggestions[0]?.status, "actionable");

  const validation = new ValidationEngine({ workspace: workspace.data, validator })
    .validateSnapshot({ snapshot_id: manifest.left_snapshot_id });
  assert.equal(validation.run["state"], "succeeded");

  const buildDiff = new BuildDiffEngine({ workspace: workspace.data, validator }).compareBuilds({
    project_id: manifest.project_id,
    application_id: manifest.application_id,
    left_build_id: manifest.left_build_id,
    right_build_id: manifest.right_build_id,
  });
  const summary = buildDiff["summary"] as { readonly total: number };
  assert.ok(summary.total > 0);

  const points = await workspace.listRecoveryPoints();
  assert.ok(points.some((point) => point.recovery_point_id === manifest.recovery_point_id));
  await workspace.close();

  const dryRun = await LocalDataWorkspace.collectGarbage({
    workspaceRoot: workspacePath,
    validator,
    command: { minimum_age_seconds: 0 },
  });
  assert.deepEqual(dryRun.candidate_hashes, [manifest.gc_candidate_hash]);
  const collected = await LocalDataWorkspace.collectGarbage({
    workspaceRoot: workspacePath,
    validator,
    command: {
      dry_run: false,
      minimum_age_seconds: 0,
      expected_plan_digest: dryRun.plan_digest,
    },
  });
  assert.equal(collected.deleted_objects, 1);
  assert.equal(
    (await (await FileObjectStore.open({ workspaceRoot: workspacePath })).has([
      manifest.gc_candidate_hash,
    ])).has(manifest.gc_candidate_hash),
    false,
  );

  const objectStore = await FileObjectStore.open({ workspaceRoot: workspacePath });
  const backup = await objectStore.stat(manifest.recovery_point_id);
  await LocalDataWorkspace.restore({ workspaceRoot: workspacePath, validator, backup });

  workspace = await LocalDataWorkspace.open({ workspaceRoot: workspacePath, validator });
  const restored = workspace.data.beginUnitOfWork("read");
  assert.equal(restored.wiki.get(manifest.wiki_node_id).wiki_node_id, manifest.wiki_node_id);
  assert.throws(
    () => restored.wiki.get(manifest.post_recovery_marker_node_id),
    (error: unknown) => isDataError(error, "not_found"),
  );
  restored.rollback();
  await workspace.close();
});

test("the disposable fixture refuses to add data to an occupied destination", async (t) => {
  const workspacePath = await temporaryPath(t);
  await fs.writeFile(path.join(workspacePath, "owner-data.txt"), "preserve me\n", "utf8");
  await assert.rejects(
    createDisposableWorkspace({ repositoryRoot, workspacePath }),
    /destination must be empty/,
  );
  assert.equal(await fs.readFile(path.join(workspacePath, "owner-data.txt"), "utf8"), "preserve me\n");
});

async function temporaryPath(t: TestContext): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-disposable-workspace-"));
  t.after(async () => fs.rm(value, { recursive: true, force: true }));
  return value;
}
