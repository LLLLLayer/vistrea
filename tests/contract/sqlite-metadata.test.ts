import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";

import {
  PROTOCOL_SCHEMA_IDS,
  type CommitManifest,
  type GraphContext,
  type JsonObject,
  type ObjectRef,
  type ProtocolSchemaId,
  type ProtocolValidator,
  type RuntimeSnapshot,
  type ValidationFinding,
  type ValidationRun,
  type WikiNode,
  type WorkingChange,
} from "../../data/api/models.js";
import { DataError, isDataError } from "../../data/api/errors.js";
import { loadPhase0A2FixtureSeed } from "../../data/memory/fixture-seed.js";
import { createRepositoryProtocolValidator } from "../../data/memory/protocol-validator.js";
import {
  commitIdForManifest,
  SequenceClock,
  SequenceIdGenerator,
} from "../../data/memory/support.js";
import {
  SQLiteDataStore,
  VISTREA_APPLICATION_ID,
  configureSQLiteConnection,
  discoverSQLiteMigrations,
} from "../../data/metadata/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

function expectDataError(code?: DataError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(isDataError(error, code), `Expected DataError${code === undefined ? "" : `(${code})`}`);
    return true;
  };
}

async function temporaryDirectory(t: TestContext, name: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readFixture<T>(
  relativePath: string,
  schemaId: ProtocolSchemaId,
  validator: ProtocolValidator,
): Promise<T> {
  const value = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "protocol/fixtures/v1", relativePath), "utf8"),
  ) as unknown;
  validator.assert(schemaId, value);
  return value as T;
}

function pragmaInteger(database: Database.Database, name: string): number {
  const rows = database.pragma(name) as readonly Record<string, unknown>[];
  const value = Object.values(rows[0] ?? {})[0];
  assert.equal(typeof value, "number");
  return value as number;
}

test("SQLite migrations initialize a policy-compliant, checksummed Vistrea schema", async (t) => {
  const validator = await validatorPromise;
  const directory = await temporaryDirectory(t, "vistrea-sqlite-schema");
  const databasePath = path.join(directory, "metadata.sqlite");
  const migrations = discoverSQLiteMigrations();
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    migrations.map((_, index) => index + 1),
  );
  assert.equal(migrations[0]?.filename, "000001_initialize_metadata.sql");

  const store = new SQLiteDataStore({ databasePath, validator, applicationVersion: "test" });
  assert.deepEqual(store.migrationResult, {
    fromVersion: 0,
    toVersion: migrations.length,
    appliedVersions: migrations.map((migration) => migration.version),
  });
  assert.deepEqual(store.checkHealth(), {
    ok: true,
    generation: 0,
    open_units_of_work: 0,
    issues: [],
  });
  store.close();

  const database = new Database(databasePath);
  configureSQLiteConnection(database);
  assert.equal(pragmaInteger(database, "application_id"), VISTREA_APPLICATION_ID);
  assert.equal(pragmaInteger(database, "user_version"), migrations.length);
  assert.equal(pragmaInteger(database, "synchronous"), 2);
  assert.equal(pragmaInteger(database, "foreign_keys"), 1);
  assert.equal(pragmaInteger(database, "trusted_schema"), 0);
  assert.equal(pragmaInteger(database, "busy_timeout"), 5_000);
  assert.equal(pragmaInteger(database, "wal_autocheckpoint"), 1_000);
  assert.equal(
    (database.pragma("journal_mode") as readonly { readonly journal_mode: string }[])[0]
      ?.journal_mode,
    "wal",
  );

  const ledger = database
    .prepare(
      "SELECT version, filename, sha256 FROM __vistrea_schema_migrations ORDER BY version",
    )
    .all() as readonly { readonly version: number; readonly filename: string; readonly sha256: string }[];
  assert.deepEqual(
    ledger,
    migrations.map((migration) => ({
      version: migration.version,
      filename: migration.filename,
      sha256: createHash("sha256").update(migration.bytes).digest("hex"),
    })),
  );
  const tableSql = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'vistrea_resources'",
    )
    .get() as { readonly sql: string };
  assert.match(tableSql.sql, /STRICT$/);
  assert.doesNotMatch(tableSql.sql, /\bBLOB\b/);
  database.close();

  const invalidClockPath = path.join(directory, "invalid-clock.sqlite");
  assert.throws(
    () =>
      new SQLiteDataStore({
        databasePath: invalidClockPath,
        validator,
        applicationVersion: "test",
        clock: { now: () => "2026-02-30T00:00:00.000Z" },
      }),
    expectDataError("invalid_argument"),
  );
  const invalidClockDatabase = new Database(invalidClockPath);
  assert.equal(pragmaInteger(invalidClockDatabase, "application_id"), 0);
  assert.equal(pragmaInteger(invalidClockDatabase, "user_version"), 0);
  invalidClockDatabase.close();

  const damagedHealthPath = path.join(directory, "damaged-health.sqlite");
  const damagedHealthStore = new SQLiteDataStore({
    databasePath: damagedHealthPath,
    validator,
  });
  const damagedHealthDatabase = new Database(damagedHealthPath);
  damagedHealthDatabase.exec("DELETE FROM vistrea_store_meta");
  damagedHealthDatabase.close();
  const damagedHealth = damagedHealthStore.checkHealth();
  assert.equal(damagedHealth.ok, false);
  assert.equal(damagedHealth.generation, 0);
  assert.equal(damagedHealth.open_units_of_work, 0);
  assert.match(damagedHealth.issues[0] ?? "", /Workspace generation is invalid/);
  damagedHealthStore.close();
});

test("all nine repositories and verified ObjectRefs survive a durable reopen", async (t) => {
  const validator = await validatorPromise;
  const seed = await loadPhase0A2FixtureSeed({ validator, repositoryRoot });
  const directory = await temporaryDirectory(t, "vistrea-sqlite-parity");
  const databasePath = path.join(directory, "metadata.sqlite");

  let store = new SQLiteDataStore({
    databasePath,
    validator,
    seed,
    clock: new SequenceClock("2026-07-12T04:00:00.000Z", 1),
    ids: new SequenceIdGenerator(900),
  });
  let unit = store.beginUnitOfWork("read");
  const snapshot = seed.snapshots?.[0] as RuntimeSnapshot;
  const observation = seed.observations?.[0];
  const event = seed.runtimeEventBatches?.[0]?.events[0];
  const graph = seed.screenGraphs?.[0];
  const wikiNode = seed.wikiNodes?.[0];
  const issue = seed.reviewIssues?.[0];
  const run = seed.validationRuns?.[0];
  const operation = seed.operationRecords?.[0];
  const ref = seed.refs?.[0];
  assert.ok(
    observation !== undefined &&
      event !== undefined &&
      graph !== undefined &&
      wikiNode !== undefined &&
      issue !== undefined &&
      run !== undefined &&
      operation !== undefined &&
      ref !== undefined,
  );
  assert.deepEqual(unit.snapshots.get(snapshot.snapshot_id), snapshot);
  assert.deepEqual(unit.observations.get(observation.observation_id), observation);
  assert.deepEqual(unit.runtimeEvents.list({ event_epoch_id: event.event_epoch_id }).items[0], event);
  assert.equal(
    unit.screenGraph.materialize(graph.context as GraphContext).screen_graph_id,
    graph.screen_graph_id,
  );
  assert.deepEqual(unit.wiki.get(wikiNode.wiki_node_id), wikiNode);
  assert.deepEqual(unit.designReviews.listIssues().items[0], issue);
  assert.deepEqual(unit.validation.getRun(run.validation_run_id), run);
  assert.deepEqual(unit.operations.getResult(operation.operation.operation_id), operation.result);
  assert.deepEqual(unit.versions.resolveRef(ref.name), ref);
  unit.rollback();
  store.close();

  store = new SQLiteDataStore({ databasePath, validator });
  unit = store.beginUnitOfWork("read");
  assert.deepEqual(unit.snapshots.get(snapshot.snapshot_id), snapshot);
  assert.deepEqual(unit.observations.get(observation.observation_id), observation);
  assert.deepEqual(unit.wiki.get(wikiNode.wiki_node_id), wikiNode);
  assert.deepEqual(unit.validation.getRun(run.validation_run_id), run);
  assert.deepEqual(unit.operations.getResult(operation.operation.operation_id), operation.result);
  assert.deepEqual(
    unit.operations.listEvents(operation.operation.operation_id).items,
    operation.events,
  );
  assert.deepEqual(unit.versions.resolveRef(ref.name), ref);
  unit.rollback();
  store.close();

  const database = new Database(databasePath);
  const operationBase = database
    .prepare(
      "SELECT json FROM vistrea_resources " +
        "WHERE repository = 'operations' AND resource_kind = 'operation' AND resource_id = ?",
    )
    .get(operation.operation.operation_id) as { readonly json: string };
  assert.equal(Object.hasOwn(JSON.parse(operationBase.json) as object, "events"), false);
  assert.equal(Object.hasOwn(JSON.parse(operationBase.json) as object, "result"), false);
  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM vistrea_operation_events WHERE operation_id = ?")
        .get(operation.operation.operation_id) as { readonly count: number }
    ).count,
    operation.events.length,
  );
  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM vistrea_object_refs")
        .get() as { readonly count: number }
    ).count,
    seed.verifiedObjects?.length,
  );
  database.close();
});

test("SQLite Units of Work provide real locking, read snapshots, commit, and rollback", async (t) => {
  const validator = await validatorPromise;
  const seed = await loadPhase0A2FixtureSeed({ validator, repositoryRoot });
  const directory = await temporaryDirectory(t, "vistrea-sqlite-uow");
  const databasePath = path.join(directory, "metadata.sqlite");
  const store = new SQLiteDataStore({ databasePath, validator, seed });
  const node = seed.wikiNodes?.[0] as WikiNode;

  const lockOwner = store.beginUnitOfWork("write");
  const contender = new Database(databasePath, { timeout: 1 });
  assert.throws(() => contender.exec("BEGIN IMMEDIATE"), (error: unknown) => {
    assert.equal((error as { readonly code?: string }).code, "SQLITE_BUSY");
    return true;
  });
  contender.close();
  lockOwner.rollback();

  const readBefore = store.beginUnitOfWork("read");
  const write = store.beginUnitOfWork("write");
  write.assertOwns(write.wiki, write.versions);
  assert.throws(() => write.assertOwns(readBefore.wiki), expectDataError("conflict"));
  const committed = {
    ...node,
    revision: node.revision + 1,
    title: "Committed through SQLite",
  } as WikiNode;
  write.wiki.update(committed, { expected_revision: node.revision });
  write.commit();
  assert.equal(readBefore.wiki.get(node.wiki_node_id)["title"], node["title"]);
  readBefore.rollback();

  const rolledBack = store.beginUnitOfWork("write");
  const discarded = {
    ...committed,
    revision: committed.revision + 1,
    title: "This title must roll back",
  } as WikiNode;
  rolledBack.wiki.update(discarded, { expected_revision: committed.revision });
  rolledBack.rollback();
  store.close();

  const reopened = new SQLiteDataStore({ databasePath, validator });
  const readAfter = reopened.beginUnitOfWork("read");
  assert.equal(readAfter.wiki.get(node.wiki_node_id)["title"], "Committed through SQLite");
  assert.equal(readAfter.wiki.get(node.wiki_node_id).revision, committed.revision);
  readAfter.rollback();
  assert.equal(reopened.checkHealth().generation, 1);
  reopened.close();
});

test("Snapshot Object associations and the verified catalog reopen atomically", async (t) => {
  const validator = await validatorPromise;
  const directory = await temporaryDirectory(t, "vistrea-sqlite-snapshot-object");
  const databasePath = path.join(directory, "metadata.sqlite");
  const snapshot = await readFixture<RuntimeSnapshot>(
    "runtime-snapshot/valid/partial-screenshot.json",
    PROTOCOL_SCHEMA_IDS.runtimeSnapshot,
    validator,
  );
  const objects = collectObjectRefs(snapshot);
  assert.ok(objects.length > 0);

  let store = new SQLiteDataStore({ databasePath, validator });
  store.registerVerifiedObjects([objects[0] as ObjectRef, objects[0] as ObjectRef, ...objects]);
  const write = store.beginUnitOfWork("write");
  write.snapshots.put(snapshot, objects);
  write.commit();
  store.close();

  store = new SQLiteDataStore({ databasePath, validator });
  store.registerVerifiedObjects(objects);
  const firstObject = objects[0] as ObjectRef;
  const conflictingObject = {
    ...firstObject,
    media_type:
      firstObject.media_type === "application/octet-stream"
        ? "image/png"
        : "application/octet-stream",
  } as ObjectRef;
  validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, conflictingObject);
  assert.throws(
    () => store.registerVerifiedObjects([conflictingObject]),
    expectDataError("integrity_error"),
  );
  const read = store.beginUnitOfWork("read");
  assert.deepEqual(read.snapshots.get(snapshot.snapshot_id), snapshot);
  read.rollback();
  store.close();

  const database = new Database(databasePath);
  const associations = database
    .prepare(
      "SELECT ordinal, object_hash FROM vistrea_snapshot_objects " +
        "WHERE snapshot_id = ? ORDER BY ordinal",
    )
    .all(snapshot.snapshot_id) as readonly {
    readonly ordinal: number;
    readonly object_hash: string;
  }[];
  assert.deepEqual(
    associations,
    objects.map((object, ordinal) => ({ ordinal, object_hash: object.hash })),
  );
  database.close();

  const seededDatabasePath = path.join(directory, "seeded-metadata.sqlite");
  let seededStore = new SQLiteDataStore({
    databasePath: seededDatabasePath,
    validator,
    seed: { verifiedObjects: objects, snapshots: [snapshot] },
  });
  seededStore.close();
  seededStore = new SQLiteDataStore({ databasePath: seededDatabasePath, validator });
  const seededRead = seededStore.beginUnitOfWork("read");
  assert.deepEqual(seededRead.snapshots.get(snapshot.snapshot_id), snapshot);
  seededRead.rollback();
  seededStore.close();
  const seededDatabase = new Database(seededDatabasePath);
  assert.equal(
    (
      seededDatabase
        .prepare("SELECT count(*) AS count FROM vistrea_snapshot_objects WHERE snapshot_id = ?")
        .get(snapshot.snapshot_id) as { readonly count: number }
    ).count,
    objects.length,
  );
  seededDatabase.close();
});

test("Commit plus Ref CAS remains atomic across SQLite reopen and conflict", async (t) => {
  const validator = await validatorPromise;
  const seed = await loadPhase0A2FixtureSeed({ validator, repositoryRoot });
  const directory = await temporaryDirectory(t, "vistrea-sqlite-version-cas");
  const databasePath = path.join(directory, "metadata.sqlite");
  let store = new SQLiteDataStore({
    databasePath,
    validator,
    seed,
    clock: new SequenceClock("2026-07-12T04:00:00.000Z", 1),
    ids: new SequenceIdGenerator(900),
  });
  const initialCommit = seed.commits?.[0];
  const workingSet = seed.workingSets?.[0];
  const currentRef = seed.refs?.[0];
  assert.ok(initialCommit !== undefined && workingSet !== undefined && currentRef !== undefined);
  const change = await readFixture<WorkingChange>(
    "working-change/valid/upsert-screen.json",
    PROTOCOL_SCHEMA_IDS.workingChange,
    validator,
  );
  store.registerVerifiedObjects([change.payload as ObjectRef]);

  const write = store.beginUnitOfWork("write");
  const updatedWorkingSet = write.versions.appendWorkingChanges(
    workingSet.working_set_id,
    [change],
    { expected_revision: workingSet.revision },
  );
  const manifest = {
    ...initialCommit.manifest,
    parents: [initialCommit.commit_id],
    created_at: "2026-07-12T08:00:00.000Z",
    message: "Persist the SQLite CAS fixture.",
    object_hashes: [
      ...initialCommit.manifest.object_hashes,
      (change.payload as ObjectRef).hash,
    ],
  } as CommitManifest;
  validator.assert(PROTOCOL_SCHEMA_IDS.commitManifest, manifest);
  const committed = write.versions.commitWorkingSetAndUpdateRef({
    working_set_id: updatedWorkingSet.working_set_id,
    working_set_precondition: { expected_revision: updatedWorkingSet.revision },
    manifest,
    target_ref_name: currentRef.name,
    ref_precondition: {
      mode: "must_match",
      expected_commit_id: currentRef.commit_id,
    } as never,
  });
  write.commit();
  store.close();

  store = new SQLiteDataStore({ databasePath, validator });
  let read = store.beginUnitOfWork("read");
  assert.deepEqual(read.versions.getCommit(committed.commit.commit_id), committed.commit);
  assert.deepEqual(read.versions.resolveRef(currentRef.name), committed.ref);
  read.rollback();

  const conflictingManifest = {
    ...manifest,
    created_at: "2026-07-12T08:00:01.000Z",
    message: "This SQLite Commit must remain invisible.",
  } as CommitManifest;
  const invisibleCommitId = commitIdForManifest(conflictingManifest);
  const conflicting = store.beginUnitOfWork("write");
  assert.throws(
    () =>
      conflicting.versions.commitWorkingSetAndUpdateRef({
        working_set_id: updatedWorkingSet.working_set_id,
        working_set_precondition: { expected_revision: updatedWorkingSet.revision },
        manifest: conflictingManifest,
        target_ref_name: currentRef.name,
        ref_precondition: {
          mode: "must_match",
          expected_commit_id: currentRef.commit_id,
        } as never,
      }),
    expectDataError("conflict"),
  );
  assert.throws(
    () => conflicting.versions.getCommit(invisibleCommitId),
    expectDataError("not_found"),
  );
  conflicting.rollback();
  store.close();

  store = new SQLiteDataStore({ databasePath, validator });
  read = store.beginUnitOfWork("read");
  assert.throws(() => read.versions.getCommit(invisibleCommitId), expectDataError("not_found"));
  assert.deepEqual(read.versions.resolveRef(currentRef.name), committed.ref);
  read.rollback();
  store.close();
});

test("Validation summaries persist with Finding mutations in one SQLite transaction", async (t) => {
  const validator = await validatorPromise;
  const seed = await loadPhase0A2FixtureSeed({ validator, repositoryRoot });
  const directory = await temporaryDirectory(t, "vistrea-sqlite-validation");
  const databasePath = path.join(directory, "metadata.sqlite");
  let store = new SQLiteDataStore({ databasePath, validator, seed });
  const currentRun = seed.validationRuns?.[0] as ValidationRun;
  const currentFinding = seed.validationFindings?.[0] as ValidationFinding;
  const findingRecord = structuredClone(currentFinding) as unknown as Record<string, unknown>;
  delete findingRecord["active_suppression_id"];
  Object.assign(findingRecord, {
    status: "resolved",
    resolved_at: "2026-07-12T02:22:00.000Z",
    updated_at: "2026-07-12T02:22:00.000Z",
    revision: currentFinding.revision + 1,
  });
  const resolvedFinding = findingRecord as unknown as ValidationFinding;
  const nextRun = {
    ...currentRun,
    revision: currentRun.revision + 1,
    updated_at: "2026-07-12T02:22:00.000Z",
    finding_counts: {
      total: 1,
      open: 0,
      suppressed: 0,
      resolved: 1,
      by_severity: { info: 0, warning: 1, error: 0, critical: 0 },
    },
  } as ValidationRun;
  validator.assert(PROTOCOL_SCHEMA_IDS.validationFinding, resolvedFinding);
  validator.assert(PROTOCOL_SCHEMA_IDS.validationRun, nextRun);

  const write = store.beginUnitOfWork("write");
  write.validation.updateFinding(
    nextRun,
    resolvedFinding,
    { expected_revision: currentRun.revision },
    { expected_revision: currentFinding.revision },
  );
  write.commit();
  store.close();

  store = new SQLiteDataStore({ databasePath, validator });
  const read = store.beginUnitOfWork("read");
  assert.equal(read.validation.getFinding(currentFinding.finding_id).status, "resolved");
  assert.deepEqual(read.validation.getRun(currentRun.validation_run_id).finding_counts, nextRun.finding_counts);
  read.rollback();
  store.close();

  const database = new Database(databasePath);
  const row = database
    .prepare(
      "SELECT json FROM vistrea_resources " +
        "WHERE repository = 'validation' AND resource_kind = 'validation_run' AND resource_id = ?",
    )
    .get(currentRun.validation_run_id) as { readonly json: string };
  const corrupted = JSON.parse(row.json) as {
    finding_counts: { resolved: number; suppressed: number };
  };
  corrupted.finding_counts.resolved = 0;
  corrupted.finding_counts.suppressed = 1;
  database
    .prepare(
      "UPDATE vistrea_resources SET json = ? " +
        "WHERE repository = 'validation' AND resource_kind = 'validation_run' AND resource_id = ?",
    )
    .run(JSON.stringify(corrupted), currentRun.validation_run_id);
  database.close();
  assert.throws(
    () => new SQLiteDataStore({ databasePath, validator }),
    expectDataError("integrity_error"),
  );
});

test("migration discovery rejects gaps and unsafe SQL before touching a database", async (t) => {
  const directory = await temporaryDirectory(t, "vistrea-sqlite-discovery");
  await fs.writeFile(path.join(directory, "000001_first.sql"), "CREATE TABLE first (id INTEGER) STRICT;\n");
  await fs.writeFile(path.join(directory, "000003_third.sql"), "CREATE TABLE third (id INTEGER) STRICT;\n");
  assert.throws(() => discoverSQLiteMigrations(directory), expectDataError("integrity_error"));

  await fs.rm(path.join(directory, "000003_third.sql"));
  await fs.writeFile(path.join(directory, "000002_unsafe.sql"), "VACUUM;\n");
  assert.throws(() => discoverSQLiteMigrations(directory), expectDataError("invalid_argument"));

  await fs.rm(path.join(directory, "000002_unsafe.sql"));
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      version: 1,
      migrations: [{ filename: "000001_first.sql", sha256: "0".repeat(64) }],
    }),
  );
  assert.throws(() => discoverSQLiteMigrations(directory), expectDataError("integrity_error"));
});

test("SQLite open rejects foreign files, newer schemas, and checksum drift without mutation", async (t) => {
  const validator = await validatorPromise;
  const directory = await temporaryDirectory(t, "vistrea-sqlite-rejections");

  const foreignPath = path.join(directory, "foreign.sqlite");
  let database = new Database(foreignPath);
  database.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT");
  database.close();
  assert.throws(
    () => new SQLiteDataStore({ databasePath: foreignPath, validator }),
    expectDataError("integrity_error"),
  );
  database = new Database(foreignPath);
  assert.equal(pragmaInteger(database, "application_id"), 0);
  assert.equal(pragmaInteger(database, "user_version"), 0);
  assert.equal(
    (database.pragma("journal_mode") as readonly { readonly journal_mode: string }[])[0]
      ?.journal_mode,
    "delete",
  );
  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'unrelated'")
        .get() as { readonly count: number }
    ).count,
    1,
  );
  database.close();

  const newerPath = path.join(directory, "newer.sqlite");
  let store = new SQLiteDataStore({ databasePath: newerPath, validator });
  store.close();
  database = new Database(newerPath);
  database.pragma("user_version = 2");
  database.close();
  assert.throws(
    () => new SQLiteDataStore({ databasePath: newerPath, validator }),
    expectDataError("unsupported"),
  );
  database = new Database(newerPath);
  assert.equal(pragmaInteger(database, "user_version"), 2);
  database.close();

  const checksumPath = path.join(directory, "checksum.sqlite");
  store = new SQLiteDataStore({ databasePath: checksumPath, validator });
  store.close();
  database = new Database(checksumPath);
  database
    .prepare("UPDATE __vistrea_schema_migrations SET sha256 = ? WHERE version = 1")
    .run("0".repeat(64));
  database.close();
  assert.throws(
    () => new SQLiteDataStore({ databasePath: checksumPath, validator }),
    expectDataError("integrity_error"),
  );
});

test("a failed forward migration rolls the complete pending batch back", async (t) => {
  const validator = await validatorPromise;
  const directory = await temporaryDirectory(t, "vistrea-sqlite-failed-migration");
  const databasePath = path.join(directory, "metadata.sqlite");
  const migrationDirectory = path.join(directory, "migrations");
  await fs.mkdir(migrationDirectory);
  await fs.copyFile(
    path.join(repositoryRoot, "data/metadata/migrations/000001_initialize_metadata.sql"),
    path.join(migrationDirectory, "000001_initialize_metadata.sql"),
  );
  await fs.writeFile(
    path.join(migrationDirectory, "000002_injected_failure.sql"),
    "CREATE TABLE should_rollback (id INTEGER PRIMARY KEY) STRICT;\n" +
      "INSERT INTO table_that_does_not_exist (id) VALUES (1);\n",
  );

  const versionOne = discoverSQLiteMigrations().slice(0, 1);
  const initial = new SQLiteDataStore({ databasePath, validator, migrations: versionOne });
  initial.close();
  let authorizationCount = 0;
  assert.throws(
    () =>
      new SQLiteDataStore({
        databasePath,
        validator,
        migrationsDirectory: migrationDirectory,
        authorizeExistingUpgrade: () => {
          authorizationCount += 1;
        },
      }),
    expectDataError("integrity_error"),
  );
  assert.equal(authorizationCount, 1);

  const database = new Database(databasePath);
  assert.equal(pragmaInteger(database, "application_id"), VISTREA_APPLICATION_ID);
  assert.equal(pragmaInteger(database, "user_version"), 1);
  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM __vistrea_schema_migrations")
        .get() as { readonly count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'should_rollback'")
        .get() as { readonly count: number }
    ).count,
    0,
  );
  database.close();

  const reopened = new SQLiteDataStore({ databasePath, validator, migrations: versionOne });
  assert.equal(reopened.checkHealth().generation, 0);
  reopened.close();
});

function collectObjectRefs(value: unknown): ObjectRef[] {
  const objects = new Map<string, ObjectRef>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    const object = candidate as JsonObject;
    if (
      typeof object["hash"] === "string" &&
      typeof object["media_type"] === "string" &&
      typeof object["byte_size"] === "number" &&
      typeof object["compression"] === "string" &&
      object["extensions"] !== null &&
      typeof object["extensions"] === "object"
    ) {
      objects.set(object["hash"], object as ObjectRef);
    }
    for (const child of Object.values(object)) {
      visit(child);
    }
  };
  visit(value);
  return [...objects.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}
