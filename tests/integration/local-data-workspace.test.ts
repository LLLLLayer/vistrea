import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import Database from "better-sqlite3";

import {
  isDataError,
  PROTOCOL_SCHEMA_IDS,
  type CommitManifest,
  type ObjectRef,
  type ProtocolValidator,
  type RefUpdatePrecondition,
  type RuntimeSnapshot,
} from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import {
  discoverSQLiteMigrations,
  type SQLiteMigration,
} from "../../data/metadata/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import {
  CaptureSnapshotUseCase,
  FixtureRuntimeCapturePort,
  GetSnapshotQuery,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

test("one Host owns a local Workspace until clean close", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const first = await LocalDataWorkspace.open({ workspaceRoot, validator });

  await assert.rejects(
    LocalDataWorkspace.open({ workspaceRoot, validator }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  assert.equal(first.data.checkHealth().ok, true);
  assert.equal(
    (await fs.stat(path.join(workspaceRoot, "metadata.sqlite"))).isFile(),
    true,
  );
  const read = first.data.beginUnitOfWork("read");
  await assert.rejects(first.close(), (error: unknown) => isDataError(error, "conflict"));
  await assert.rejects(
    LocalDataWorkspace.open({ workspaceRoot, validator }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  read.rollback();
  await first.close();

  const abandoned = path.join(workspaceRoot, ".maintenance", "backup-Abc123");
  await fs.mkdir(abandoned);
  await fs.writeFile(path.join(abandoned, "metadata.sqlite"), "abandoned", "utf8");
  const reopened = await LocalDataWorkspace.open({ workspaceRoot, validator });
  assert.equal(reopened.data.checkHealth().ok, true);
  await assert.rejects(fs.stat(abandoned), { code: "ENOENT" });
  await reopened.close();
  await assert.rejects(fs.stat(path.join(workspaceRoot, ".host.lock")), { code: "ENOENT" });
});

test("production local storage reopens one captured Snapshot and its exact object", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const fixture = await captureFixture(validator);
  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });

  const captured = await new CaptureSnapshotUseCase({
    runtime: new FixtureRuntimeCapturePort({
      snapshot: fixture.snapshot,
      objects: [{ ref: fixture.object, chunks: [fixture.bytes] }],
    }),
    workspace: workspace.data,
    objects: workspace.objects,
    validator,
  }).execute({
    include: { paths: ["trees", "screenshot"] },
    screenshot: "reference",
    reason: "manual",
  });
  assert.equal(captured.snapshot_id, fixture.snapshot.snapshot_id);
  await workspace.close();

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  assert.deepEqual(
    new GetSnapshotQuery(workspace.data).execute(fixture.snapshot.snapshot_id),
    fixture.snapshot,
  );
  assert.deepEqual(await collect(await workspace.objects.open(fixture.object.hash)), fixture.bytes);
  await workspace.close();
});

test("a full pack moves committed history between two local Workspaces", async (t) => {
  const validator = await validatorPromise;
  const source = await LocalDataWorkspace.open({
    workspaceRoot: await temporaryWorkspace(t),
    validator,
  });
  const target = await LocalDataWorkspace.open({
    workspaceRoot: await temporaryWorkspace(t),
    validator,
  });
  t.after(async () => {
    for (const workspace of [source, target]) {
      try {
        await workspace.close();
      } catch {
        // The workspace may already be closed by the test body.
      }
    }
  });

  const payload = Buffer.from('{"screens":["demo.home"]}', "utf8");
  const graphObject = await source.objects.put(
    (async function* () {
      yield payload;
    })(),
    {
      media_type: "application/vnd.vistrea.graph+json",
      compression: "none",
      logical_name: "graph-root.json",
    },
  );
  source.data.registerVerifiedObjects([graphObject]);
  const write = source.data.beginUnitOfWork("write");
  const commit = write.versions.createCommit({
    protocol_version: { major: 1, minor: 0 },
    parents: [],
    created_at: "2026-07-12T07:00:00.000Z",
    author: { kind: "human", id: "exchange-test@vistrea.dev", extensions: {} },
    message: "Record the exchanged runtime graph.",
    roots: { runtime_graph: graphObject },
    object_hashes: [graphObject.hash],
    extensions: {},
  } as unknown as CommitManifest);
  write.versions.updateRef("teams/im/main", commit.commit_id, {
    mode: "must_not_exist",
  } as unknown as RefUpdatePrecondition);
  write.commit();

  const pack = await source.exchange.exportPack({
    ref_names: ["teams/im/main"],
    created_by: { kind: "human", id: "exchange-test@vistrea.dev", extensions: {} },
  });
  const transferred = await target.objects.put(await source.objects.open(pack.hash), {
    expected_hash: pack.hash,
    media_type: pack.media_type,
    compression: pack.compression,
    extensions: pack.extensions,
  });
  const result = await target.exchange.importPack({ pack: transferred });
  assert.deepEqual(result.imported_commit_ids, [commit.commit_id]);
  assert.deepEqual(result.imported_object_hashes, [graphObject.hash]);

  const read = target.data.beginUnitOfWork("read");
  assert.deepEqual(read.versions.getCommit(commit.commit_id), commit);
  assert.equal(read.versions.resolveRef("teams/im/main").commit_id, commit.commit_id);
  read.rollback();
  assert.deepEqual(await collect(await target.objects.open(graphObject.hash)), payload);
});

test("a WAL-aware backup restores exact metadata and preserves pre-restore evidence", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const first = await commitPayload(workspace, "before backup", "teams/demo/main");
  const activeRead = workspace.data.beginUnitOfWork("read");
  await assert.rejects(
    workspace.backup({
      reason: "This must wait for the active reader.",
      retention: { policy_id: "blocked-backup", reason: "Test active Unit of Work rejection." },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  activeRead.rollback();
  const backupPromise = workspace.backup({
    reason: "Checkpoint before a destructive local experiment.",
    retention: {
      policy_id: "test-manual-backup",
      reason: "Keep this recovery point for the integration test.",
    },
  });
  assert.throws(
    () => workspace.data.beginUnitOfWork("read"),
    (error: unknown) => isDataError(error, "conflict"),
  );
  assert.throws(
    () => workspace.data.registerVerifiedObjects([first.object]),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await assert.rejects(
    workspace.exchange.exportPack({
      ref_names: ["teams/demo/main"],
      created_by: { kind: "human", id: "workspace-test@vistrea.dev", extensions: {} },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  const backup = await backupPromise;
  const postBackupRead = workspace.data.beginUnitOfWork("read");
  postBackupRead.rollback();
  const objectStore = await FileObjectStore.open({ workspaceRoot });
  const backupLifecycle = await objectStore.inspectLifecycle(backup.hash);
  assert.deepEqual(backupLifecycle.active_retention_policy_ids, ["test-manual-backup"]);

  const second = await commitPayload(
    workspace,
    "after backup",
    "teams/demo/main",
    first.commit_id,
  );
  await workspace.close();

  const restored = await LocalDataWorkspace.restore({ workspaceRoot, validator, backup });
  assert.equal(restored.backup.hash, backup.hash);
  assert.match(restored.recovery_id, /^restore-/);
  await fs.stat(path.join(workspaceRoot, ".recovery", restored.recovery_id, "metadata.sqlite"));

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const read = workspace.data.beginUnitOfWork("read");
  assert.equal(read.versions.getCommit(first.commit_id).commit_id, first.commit_id);
  assert.throws(
    () => read.versions.getCommit(second.commit_id),
    (error: unknown) => isDataError(error, "not_found"),
  );
  read.rollback();
  await workspace.close();
});

test("the recovery-point catalog projects and releases exact retention policies", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  await commitPayload(workspace, "recovery catalog", "teams/recovery/main");
  const created = await workspace.createRecoveryPoint({
    reason: "Manual checkpoint before tuning the catalog.",
    retention: {
      policy_id: "workspace-recovery:test-catalog",
      reason: "Keep the catalog checkpoint until this test releases it.",
    },
  });
  assert.equal(created.recovery_point_id, created.backup.hash);
  assert.equal(created.source, "manual");
  assert.equal(created.reason, "Manual checkpoint before tuning the catalog.");
  assert.equal(created.schema_version, 1);
  assert.ok(created.generation > 0);
  assert.deepEqual(created.active_retention_policy_ids, ["workspace-recovery:test-catalog"]);

  const listed = await workspace.listRecoveryPoints();
  assert.deepEqual(listed, [created]);
  await assert.rejects(
    workspace.releaseRecoveryPoint({
      recovery_point_id: created.recovery_point_id,
      retention_policy_id: "workspace-recovery:missing",
    }),
    (error: unknown) => isDataError(error, "not_found"),
  );
  const released = await workspace.releaseRecoveryPoint({
    recovery_point_id: created.recovery_point_id,
    retention_policy_id: "workspace-recovery:test-catalog",
  });
  assert.deepEqual(released.active_retention_policy_ids, []);
  assert.deepEqual(
    released.retention_policies.map((policy) => policy.policy_id),
    [],
  );
  await workspace.close();
});

test("restore rejects a non-database backup without changing current metadata", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const durable = await commitPayload(
    workspace,
    "must survive rejected restore",
    "teams/restore/main",
  );
  const invalid = await workspace.objects.put(bytesOf(Buffer.from("not sqlite", "utf8")), {
    media_type: "application/vnd.vistrea.workspace-metadata-backup+sqlite3",
    compression: "none",
    logical_name: "invalid.sqlite",
  });
  await workspace.close();

  await assert.rejects(
    LocalDataWorkspace.restore({ workspaceRoot, validator, backup: invalid }),
    (error: unknown) => isDataError(error, "integrity_error"),
  );
  const reopened = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const read = reopened.data.beginUnitOfWork("read");
  assert.equal(read.versions.getCommit(durable.commit_id).commit_id, durable.commit_id);
  read.rollback();
  await reopened.close();
});

test("existing Workspace migration creates a pinned backup before applying SQL", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const [versionOne] = discoverSQLiteMigrations();
  assert.ok(versionOne);
  let workspace = await LocalDataWorkspace.open({
    workspaceRoot,
    validator,
    migrations: [versionOne],
  });
  await commitPayload(workspace, "schema one", "teams/migration/main");
  await workspace.close();

  const versionTwo = migration(
    2,
    "000002_add_migration_probe.sql",
    "CREATE TABLE vistrea_migration_probe (value TEXT NOT NULL) STRICT;\n",
  );
  workspace = await LocalDataWorkspace.open({
    workspaceRoot,
    validator,
    migrations: [versionOne, versionTwo],
  });
  assert.deepEqual(workspace.migrationResult.applied_versions, [2]);
  assert.equal(workspace.migrationResult.from_version, 1);
  assert.equal(workspace.migrationResult.to_version, 2);
  const migrationBackup = workspace.migrationResult.backup;
  assert.ok(migrationBackup);
  const objectStore = await FileObjectStore.open({ workspaceRoot });
  assert.deepEqual(
    (await objectStore.inspectLifecycle(migrationBackup.hash)).active_retention_policy_ids,
    ["workspace-migration:1:2"],
  );
  await workspace.close();

  const failingVersionThree = migration(
    3,
    "000003_injected_failure.sql",
    "CREATE TABLE vistrea_store_meta (duplicate TEXT);\n",
  );
  await assert.rejects(
    LocalDataWorkspace.open({
      workspaceRoot,
      validator,
      migrations: [versionOne, versionTwo, failingVersionThree],
    }),
    (error: unknown) => isDataError(error, "integrity_error"),
  );
  const database = new Database(path.join(workspaceRoot, "metadata.sqlite"), {
    readonly: true,
  });
  assert.equal(database.pragma("user_version", { simple: true }), 2);
  database.close();
  const backups = await inventoryByMediaType(
    await FileObjectStore.open({ workspaceRoot }),
    "application/vnd.vistrea.workspace-metadata-backup+sqlite3",
  );
  assert.equal(backups.length, 2);
  let foundFailedMigrationBackup = false;
  for (const candidate of backups) {
    foundFailedMigrationBackup ||= (
      await objectStore.inspectLifecycle(candidate.hash)
    ).active_retention_policy_ids.includes("workspace-migration:2:3");
  }
  assert.equal(foundFailedMigrationBackup, true);
});

test("automatic migration recovery points root their pre-migration object closure", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const [versionOne] = discoverSQLiteMigrations();
  assert.ok(versionOne);
  const versionTwo = migration(
    2,
    "000002_add_recovery_probe.sql",
    "CREATE TABLE vistrea_recovery_probe (value TEXT NOT NULL) STRICT;\n",
  );
  const migrations = [versionOne, versionTwo];
  let workspace = await LocalDataWorkspace.open({
    workspaceRoot,
    validator,
    migrations: [versionOne],
  });
  const backedUp = await commitPayload(workspace, "migration closure", "teams/migrate/main");
  await workspace.close();

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator, migrations });
  const migrationBackup = workspace.migrationResult.backup;
  assert.ok(migrationBackup);
  const [migrationPoint] = await workspace.listRecoveryPoints();
  assert.ok(migrationPoint);
  assert.equal(migrationPoint.recovery_point_id, migrationBackup.hash);
  assert.equal(migrationPoint.source, "pre_migration");
  assert.deepEqual(migrationPoint.active_retention_policy_ids, ["workspace-migration:1:2"]);
  await replaceRefWithUnrelatedPayload(
    workspace,
    "post migration history",
    "teams/migrate/main",
    backedUp.commit_id,
  );
  await workspace.close();

  const plan = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    migrations,
    command: { minimum_age_seconds: 0 },
  });
  assert.equal(plan.candidate_hashes.includes(backedUp.object.hash), false);
  assert.equal(plan.candidate_hashes.includes(migrationBackup.hash), false);
  const objectStore = await FileObjectStore.open({ workspaceRoot });
  assert.equal((await objectStore.stat(backedUp.object.hash)).hash, backedUp.object.hash);
});

test("offline garbage collection is dry-run first and preserves reachable and retained objects", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const reachable = await commitPayload(workspace, "reachable", "teams/gc/main");
  const orphanBytes = Buffer.from("unreferenced capture rollback", "utf8");
  const orphan = await workspace.objects.put(bytesOf(orphanBytes), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "orphan.bin",
  });
  workspace.data.registerVerifiedObjects([orphan]);
  const retained = await workspace.objects.put(bytesOf(Buffer.from("retained", "utf8")), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "retained.bin",
  });
  await workspace.objects.pin(retained.hash, {
    policy_id: "test-retention",
    reason: "Prove retention wins over reachability cleanup.",
  });
  workspace.data.registerVerifiedObjects([retained]);
  const pack = await workspace.exchange.exportPack({
    ref_names: ["teams/gc/main"],
    created_by: { kind: "human", id: "gc-test@vistrea.dev", extensions: {} },
  });
  await workspace.close();

  const graceProtected = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: { minimum_age_seconds: 3_600 },
  });
  assert.equal(graceProtected.candidate_objects, 0);
  assert.equal(graceProtected.young_objects >= 1, true);

  const dryRun = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: { minimum_age_seconds: 0 },
  });
  assert.equal(dryRun.dry_run, true);
  assert.match(dryRun.plan_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(dryRun.candidate_hashes, [orphan.hash]);
  assert.equal(dryRun.deleted_objects, 0);
  assert.equal(
    (await (await FileObjectStore.open({ workspaceRoot })).has([orphan.hash])).has(orphan.hash),
    true,
  );

  await assert.rejects(
    LocalDataWorkspace.collectGarbage({
      workspaceRoot,
      validator,
      command: { dry_run: false, minimum_age_seconds: 0 },
    }),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
  await assert.rejects(
    LocalDataWorkspace.collectGarbage({
      workspaceRoot,
      validator,
      command: {
        dry_run: false,
        minimum_age_seconds: 0,
        expected_plan_digest: `sha256:${"0".repeat(64)}`,
      },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );

  const deleted = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: {
      dry_run: false,
      minimum_age_seconds: 0,
      expected_plan_digest: dryRun.plan_digest,
    },
  });
  assert.equal(deleted.plan_digest, dryRun.plan_digest);
  assert.equal(deleted.deleted_objects, 1);
  assert.equal(deleted.deleted_bytes, orphan.byte_size);
  assert.equal(deleted.removed_catalog_entries, 1);

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  await assert.rejects(workspace.objects.stat(orphan.hash), (error: unknown) =>
    isDataError(error, "not_found"),
  );
  assert.equal((await workspace.objects.stat(reachable.object.hash)).hash, reachable.object.hash);
  assert.equal((await workspace.objects.stat(retained.hash)).hash, retained.hash);
  assert.equal((await workspace.objects.stat(pack.hash)).hash, pack.hash);
  const repaired = await workspace.objects.put(bytesOf(orphanBytes), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "orphan.bin",
  });
  workspace.data.registerVerifiedObjects([repaired]);
  assert.equal(repaired.hash, orphan.hash);
  await workspace.objects.pin(repaired.hash, {
    policy_id: "test-repaired",
    reason: "Keep the same-hash repair while testing retention release.",
  });
  await workspace.objects.unpin(retained.hash, "test-retention");
  await workspace.close();

  const releasePlan = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: { minimum_age_seconds: 0 },
  });
  const released = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: {
      dry_run: false,
      minimum_age_seconds: 0,
      expected_plan_digest: releasePlan.plan_digest,
    },
  });
  assert.deepEqual(released.candidate_hashes, [retained.hash]);
  const afterRelease = await FileObjectStore.open({ workspaceRoot });
  await assert.rejects(afterRelease.stat(retained.hash), (error: unknown) =>
    isDataError(error, "not_found"),
  );
  assert.equal((await afterRelease.stat(pack.hash)).hash, pack.hash);
  assert.equal((await afterRelease.stat(repaired.hash)).hash, repaired.hash);
});

test("destructive garbage collection rejects a stale dry-run plan", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const first = await workspace.objects.put(bytesOf(Buffer.from("first orphan", "utf8")), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "first-orphan.bin",
  });
  workspace.data.registerVerifiedObjects([first]);
  await workspace.close();

  const stalePlan = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: { minimum_age_seconds: 0 },
  });
  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const second = await workspace.objects.put(bytesOf(Buffer.from("second orphan", "utf8")), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "second-orphan.bin",
  });
  workspace.data.registerVerifiedObjects([second]);
  await workspace.close();

  await assert.rejects(
    LocalDataWorkspace.collectGarbage({
      workspaceRoot,
      validator,
      command: {
        dry_run: false,
        minimum_age_seconds: 0,
        expected_plan_digest: stalePlan.plan_digest,
      },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  const objectStore = await FileObjectStore.open({ workspaceRoot });
  assert.equal((await objectStore.stat(first.hash)).hash, first.hash);
  assert.equal((await objectStore.stat(second.hash)).hash, second.hash);

  const currentPlan = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: { minimum_age_seconds: 0 },
  });
  assert.notEqual(currentPlan.plan_digest, stalePlan.plan_digest);
  assert.deepEqual(currentPlan.candidate_hashes, [first.hash, second.hash].sort());
});

test("retained metadata backups root their complete reachable object closure through GC", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const backedUp = await commitPayload(workspace, "backup closure", "teams/closure/main");
  const backup = await workspace.backup({
    reason: "Protect the complete reachable object closure.",
    retention: {
      policy_id: "test-backup-closure",
      reason: "Keep the metadata recovery point and everything it reaches.",
    },
  });
  await replaceRefWithUnrelatedPayload(
    workspace,
    "current unrelated history",
    "teams/closure/main",
    backedUp.commit_id,
  );
  const orphan = await workspace.objects.put(bytesOf(Buffer.from("collect me", "utf8")), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "collect-me.bin",
  });
  workspace.data.registerVerifiedObjects([orphan]);
  await workspace.close();

  const plan = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: { minimum_age_seconds: 0 },
  });
  assert.deepEqual(plan.candidate_hashes, [orphan.hash]);
  assert.equal(plan.candidate_hashes.includes(backedUp.object.hash), false);
  await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: {
      dry_run: false,
      minimum_age_seconds: 0,
      expected_plan_digest: plan.plan_digest,
    },
  });

  const afterCollection = await FileObjectStore.open({ workspaceRoot });
  assert.equal((await afterCollection.stat(backedUp.object.hash)).hash, backedUp.object.hash);
  await assert.rejects(afterCollection.stat(orphan.hash), (error: unknown) =>
    isDataError(error, "not_found"),
  );

  await LocalDataWorkspace.restore({ workspaceRoot, validator, backup });
  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const read = workspace.data.beginUnitOfWork("read");
  assert.equal(read.versions.resolveRef("teams/closure/main").commit_id, backedUp.commit_id);
  read.rollback();
  assert.deepEqual(
    await collect(await workspace.objects.open(backedUp.object.hash)),
    Buffer.from("backup closure", "utf8"),
  );
  await workspace.close();
});

test("restore rejects a backup with a missing reachable object before journal or swap", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const backedUp = await commitPayload(workspace, "missing closure", "teams/missing/main");
  const backup = await workspace.backup({
    reason: "Exercise restore closure verification.",
    retention: {
      policy_id: "test-missing-closure",
      reason: "Keep the recovery point while one dependency is removed.",
    },
  });
  const current = await replaceRefWithUnrelatedPayload(
    workspace,
    "current survives failed restore",
    "teams/missing/main",
    backedUp.commit_id,
  );
  await workspace.close();

  const metadataPath = path.join(workspaceRoot, "metadata.sqlite");
  const metadataBefore = await fs.readFile(metadataPath);
  const objectStore = await FileObjectStore.open({ workspaceRoot });
  await objectStore.deletePhysical(backedUp.object.hash);
  await assert.rejects(
    LocalDataWorkspace.restore({ workspaceRoot, validator, backup }),
    (error: unknown) => isDataError(error, "integrity_error"),
  );
  assert.deepEqual(await fs.readFile(metadataPath), metadataBefore);
  await assert.rejects(fs.stat(path.join(workspaceRoot, ".restore-journal.json")), {
    code: "ENOENT",
  });

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const read = workspace.data.beginUnitOfWork("read");
  assert.equal(read.versions.resolveRef("teams/missing/main").commit_id, current.commit_id);
  read.rollback();
  await workspace.close();
});

test("releasing backup retention lets its otherwise unreachable closure be collected", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const backedUp = await commitPayload(workspace, "released closure", "teams/release/main");
  const backup = await workspace.backup({
    reason: "Exercise recovery-point release.",
    retention: {
      policy_id: "test-release-closure",
      reason: "Release this recovery point before collection.",
    },
  });
  await replaceRefWithUnrelatedPayload(
    workspace,
    "replacement after release",
    "teams/release/main",
    backedUp.commit_id,
  );
  await workspace.close();

  const objectStore = await FileObjectStore.open({ workspaceRoot });
  await objectStore.unpin(backup.hash, "test-release-closure");
  const plan = await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: { minimum_age_seconds: 0 },
  });
  assert.equal(plan.candidate_hashes.includes(backedUp.object.hash), true);
  assert.equal(plan.candidate_hashes.includes(backup.hash), true);
  await LocalDataWorkspace.collectGarbage({
    workspaceRoot,
    validator,
    command: {
      dry_run: false,
      minimum_age_seconds: 0,
      expected_plan_digest: plan.plan_digest,
    },
  });
  await assert.rejects(objectStore.stat(backedUp.object.hash), (error: unknown) =>
    isDataError(error, "not_found"),
  );
  await assert.rejects(objectStore.stat(backup.hash), (error: unknown) =>
    isDataError(error, "not_found"),
  );
});

test("an interrupted restore blocks open and explicit recovery restores original bytes", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  await commitPayload(workspace, "restore journal", "teams/recovery/main");
  await workspace.close();

  const metadataPath = path.join(workspaceRoot, "metadata.sqlite");
  const original = await fs.readFile(metadataPath);
  const recoveryId = `restore-${randomUUID()}`;
  const evidenceRoot = path.join(workspaceRoot, ".recovery", recoveryId);
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(path.join(evidenceRoot, "metadata.sqlite"), original);
  await fs.writeFile(metadataPath, "interrupted replacement", "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, ".restore-journal.json"),
    `${JSON.stringify({
      format_version: 1,
      recovery_id: recoveryId,
      backup_hash: `sha256:${"0".repeat(64)}`,
      created_at: new Date().toISOString(),
      original_files: [
        { name: "metadata.sqlite", present: true },
        { name: "metadata.sqlite-wal", present: false },
        { name: "metadata.sqlite-shm", present: false },
      ],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    LocalDataWorkspace.open({ workspaceRoot, validator }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  const recovered = await LocalDataWorkspace.recoverInterruptedRestore({ workspaceRoot });
  assert.equal(recovered.recovery_id, recoveryId);
  assert.deepEqual(await fs.readFile(metadataPath), original);
  const reopened = await LocalDataWorkspace.open({ workspaceRoot, validator });
  assert.equal(reopened.data.checkHealth().ok, true);
  await reopened.close();
});

test("stale-lock recovery refuses a live owner and preserves dead-owner evidence", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  await assert.rejects(
    LocalDataWorkspace.recoverStaleLock({ workspaceRoot }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await workspace.close();

  const staleRecord = {
    format_version: 1,
    token: randomUUID(),
    process_id: 999_999,
    acquired_at: new Date().toISOString(),
  };
  const lockPath = path.join(workspaceRoot, ".host.lock");
  await fs.writeFile(lockPath, `${JSON.stringify(staleRecord)}\n`, { mode: 0o600 });
  const recovered = await LocalDataWorkspace.recoverStaleLock({ workspaceRoot });
  assert.equal(recovered.recovered_process_id, staleRecord.process_id);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(workspaceRoot, ".recovery", recovered.recovery_id, "host.lock.json"),
        "utf8",
      ),
    ),
    staleRecord,
  );
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });

  await fs.writeFile(lockPath, "{}\n", { mode: 0o600 });
  await assert.rejects(
    LocalDataWorkspace.recoverStaleLock({ workspaceRoot }),
    (error: unknown) => isDataError(error, "integrity_error"),
  );
});

async function temporaryWorkspace(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-local-workspace-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function captureFixture(
  validator: ProtocolValidator,
): Promise<{ snapshot: RuntimeSnapshot; object: ObjectRef; bytes: Uint8Array }> {
  const [snapshotSource, artifact, objectFixture] = await Promise.all([
    readJson("protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
    readJson("protocol/fixtures/v1/artifact/valid/screenshot.json"),
    readJson("protocol/fixtures/v1/object/valid/plain-text.json"),
  ]);
  const snapshot = structuredClone(snapshotSource) as Record<string, unknown>;
  const screenshot = snapshot["screenshot"] as Record<string, unknown>;
  const object = structuredClone(
    (artifact as Record<string, unknown>)["object"],
  ) as ObjectRef;
  screenshot["object"] = object;
  const payloadBase64 = (objectFixture as Record<string, unknown>)["payload_base64"];
  assert.equal(typeof payloadBase64, "string");
  const bytes = Buffer.from(payloadBase64 as string, "base64");
  assert.equal(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    object.hash,
  );
  validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshot);
  validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
  return { snapshot: snapshot as RuntimeSnapshot, object, bytes };
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(path.join(repositoryRoot, relativePath), "utf8"),
  ) as unknown;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function* bytesOf(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}

async function commitPayload(
  workspace: LocalDataWorkspace,
  payloadText: string,
  refName: string,
  parentCommitId?: string,
): Promise<{ readonly commit_id: string; readonly object: ObjectRef }> {
  const payload = Buffer.from(payloadText, "utf8");
  const object = await workspace.objects.put(bytesOf(payload), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: `${payloadText.replaceAll(" ", "-")}.bin`,
  });
  workspace.data.registerVerifiedObjects([object]);
  const unit = workspace.data.beginUnitOfWork("write");
  try {
    const commit = unit.versions.createCommit({
      protocol_version: { major: 1, minor: 0 },
      parents: parentCommitId === undefined ? [] : [parentCommitId],
      created_at: new Date().toISOString(),
      author: { kind: "human", id: "workspace-test@vistrea.dev", extensions: {} },
      message: `Persist ${payloadText}.`,
      roots: { runtime_graph: object },
      object_hashes: [object.hash],
      extensions: {},
    } as unknown as CommitManifest);
    unit.versions.updateRef(
      refName,
      commit.commit_id,
      (parentCommitId === undefined
        ? { mode: "must_not_exist" }
        : { mode: "must_match", expected_commit_id: parentCommitId }) as unknown as RefUpdatePrecondition,
    );
    unit.commit();
    return { commit_id: commit.commit_id, object };
  } catch (error) {
    unit.rollback();
    throw error;
  }
}

async function replaceRefWithUnrelatedPayload(
  workspace: LocalDataWorkspace,
  payloadText: string,
  refName: string,
  expectedCommitId: string,
): Promise<{ readonly commit_id: string; readonly object: ObjectRef }> {
  const payload = Buffer.from(payloadText, "utf8");
  const object = await workspace.objects.put(bytesOf(payload), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: `${payloadText.replaceAll(" ", "-")}.bin`,
  });
  workspace.data.registerVerifiedObjects([object]);
  const unit = workspace.data.beginUnitOfWork("write");
  try {
    const commit = unit.versions.createCommit({
      protocol_version: { major: 1, minor: 0 },
      parents: [],
      created_at: new Date().toISOString(),
      author: { kind: "human", id: "workspace-test@vistrea.dev", extensions: {} },
      message: `Replace ${refName} with ${payloadText}.`,
      roots: { runtime_graph: object },
      object_hashes: [object.hash],
      extensions: {},
    } as unknown as CommitManifest);
    unit.versions.updateRef(refName, commit.commit_id, {
      mode: "must_match",
      expected_commit_id: expectedCommitId,
    } as unknown as RefUpdatePrecondition);
    unit.commit();
    return { commit_id: commit.commit_id, object };
  } catch (error) {
    unit.rollback();
    throw error;
  }
}

function migration(version: number, filename: string, sql: string): SQLiteMigration {
  const bytes = Buffer.from(sql, "utf8");
  return {
    version,
    filename,
    bytes,
    sql,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function inventoryByMediaType(
  store: FileObjectStore,
  mediaType: string,
): Promise<readonly ObjectRef[]> {
  const values: ObjectRef[] = [];
  for await (const object of store.inventory({ media_types: [mediaType] })) {
    values.push(object);
  }
  return values;
}
