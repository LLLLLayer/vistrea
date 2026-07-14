import Database from "better-sqlite3";
import fs from "node:fs/promises";

import { DataError } from "../api/errors.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type BuildDiff,
  type Clock,
  type Commit,
  type DesignComparison,
  type DesignReference,
  type DesignRegionMapping,
  type IdGenerator,
  type KnowledgeCollection,
  type ObjectRef,
  type Observation,
  type OperationRecord,
  type ProtocolSchemaId,
  type ProtocolValidator,
  type Ref,
  type ReviewIssue,
  type ReviewVerificationRecord,
  type RuntimeEventBatch,
  type RuntimeSnapshot,
  type ScreenGraph,
  type StateIdentityDecision,
  type Tag,
  type TuningApplication,
  type TuningPatch,
  type ValidationFinding,
  type ValidationRun,
  type ValidationSuppression,
  type WikiLink,
  type WikiNode,
  type WorkingSet,
} from "../api/models.js";
import type {
  DataUnitOfWork,
  UnitOfWorkMode,
  WorkspaceDataSource,
  WorkspaceHealth,
} from "../api/ports.js";
import { createEmptyDataState, type DataState } from "../internal/state.js";
import {
  cloneFrozen,
  cloneValue,
  SystemClock,
  SystemIdGenerator,
} from "../internal/support.js";
import {
  collectEmbeddedObjectHashes,
  StateDataUnitOfWork,
} from "../internal/state-uow.js";
import {
  applySQLiteMigrations,
  assertSQLiteFileIdentity,
  configureSQLiteConnection,
  discoverSQLiteMigrations,
  type AppliedMigrationResult,
  type MigrationAuthorization,
  type SQLiteMigration,
  verifySQLiteMetadataSchema,
} from "./migrations.js";
import {
  deterministicJson,
  loadMetadataState,
  loadObjectCatalog,
  persistObjectCatalogEntries,
  replaceMetadataState,
} from "./persistence.js";

export interface SQLiteDataSeed {
  readonly verifiedObjects?: readonly ObjectRef[];
  readonly snapshots?: readonly RuntimeSnapshot[];
  readonly observations?: readonly Observation[];
  readonly runtimeEventBatches?: readonly RuntimeEventBatch[];
  readonly screenGraphs?: readonly ScreenGraph[];
  readonly screenGraphsByVersion?: Readonly<Record<string, string>>;
  readonly identityDecisions?: readonly StateIdentityDecision[];
  readonly wikiNodes?: readonly WikiNode[];
  readonly wikiLinks?: readonly WikiLink[];
  readonly knowledgeCollections?: readonly KnowledgeCollection[];
  readonly designReferences?: readonly DesignReference[];
  readonly designRegionMappings?: readonly DesignRegionMapping[];
  readonly designComparisons?: readonly DesignComparison[];
  readonly reviewIssues?: readonly ReviewIssue[];
  readonly reviewVerificationRecords?: readonly ReviewVerificationRecord[];
  readonly tuningPatches?: readonly TuningPatch[];
  readonly tuningApplications?: readonly TuningApplication[];
  readonly validationRuns?: readonly ValidationRun[];
  readonly validationFindings?: readonly ValidationFinding[];
  readonly validationSuppressions?: readonly ValidationSuppression[];
  readonly buildDiffs?: readonly BuildDiff[];
  readonly operationRecords?: readonly OperationRecord[];
  readonly commits?: readonly Commit[];
  readonly refs?: readonly Ref[];
  readonly tags?: readonly Tag[];
  readonly workingSets?: readonly WorkingSet[];
}

export interface SQLiteDataStoreOptions {
  readonly databasePath: string;
  readonly validator: ProtocolValidator;
  readonly applicationVersion?: string;
  readonly migrationsDirectory?: string;
  readonly migrations?: readonly SQLiteMigration[];
  readonly targetVersion?: number;
  readonly authorizeExistingUpgrade?: (request: MigrationAuthorization) => void;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Fixture-backed initial data is accepted only for an otherwise empty schema. */
  readonly seed?: SQLiteDataSeed;
}

export interface SQLiteMetadataInspection {
  readonly schemaVersion: number;
  readonly generation: number;
}

export interface SQLiteBackupResult extends SQLiteMetadataInspection {
  readonly databasePath: string;
  readonly byteSize: number;
}

export interface SQLiteMaintenanceSnapshot {
  readonly registeredObjectHashes: ReadonlySet<string>;
  readonly reachableObjectHashes: ReadonlySet<string>;
}

export interface InspectSQLiteMetadataFileOptions {
  readonly databasePath: string;
  readonly validator: ProtocolValidator;
  readonly migrations?: readonly SQLiteMigration[];
  readonly migrationsDirectory?: string;
}

/** Opens and semantically verifies one metadata file without mutating it. */
export function inspectSQLiteMetadataFile(
  options: InspectSQLiteMetadataFileOptions,
): SQLiteMetadataInspection {
  const migrations =
    options.migrations ?? discoverSQLiteMigrations(options.migrationsDirectory);
  let database: Database.Database | undefined;
  try {
    database = new Database(options.databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000,
    });
    assertSQLiteFileIdentity(database);
    database.pragma("foreign_keys = ON");
    database.pragma("trusted_schema = OFF");
    database.pragma("busy_timeout = 5000");
    const schema = verifySQLiteMetadataSchema(database, migrations);
    const catalog = loadObjectCatalog(database, options.validator);
    loadMetadataState(database, options.validator, catalog);
    return {
      schemaVersion: schema.schemaVersion,
      generation: readGeneration(database),
    };
  } catch (error) {
    throw mapSQLiteError(error, "verify the SQLite metadata file");
  } finally {
    database?.close();
  }
}

export class SQLiteDataStore implements WorkspaceDataSource {
  readonly clock: Clock;
  readonly databasePath: string;
  readonly migrationResult: AppliedMigrationResult;
  readonly #ids: IdGenerator;
  readonly #validator: ProtocolValidator;
  readonly #database: Database.Database;
  readonly #migrations: readonly SQLiteMigration[];
  readonly #verifiedObjects = new Map<string, ObjectRef>();
  readonly #openUnits = new Set<string>();
  readonly #unitDatabases = new Map<string, Database.Database>();
  #state = createEmptyDataState();
  #closed = false;

  constructor(options: SQLiteDataStoreOptions) {
    if (options.databasePath === ":memory:" || options.databasePath.length === 0) {
      throw new DataError(
        "invalid_argument",
        "SQLiteDataStore requires a durable file path so transaction connections share one Workspace.",
      );
    }
    this.databasePath = options.databasePath;
    this.#validator = options.validator;
    // A durable Workspace records real capture times and restart-safe
    // identities; deterministic clocks and IDs are injected only by tests.
    this.clock = options.clock ?? new SystemClock();
    this.#ids = options.ids ?? new SystemIdGenerator();
    const migrations =
      options.migrations ?? discoverSQLiteMigrations(options.migrationsDirectory);
    this.#migrations = migrations;
    let database: Database.Database | undefined;
    try {
      database = new Database(this.databasePath, { timeout: 5_000 });
      assertSQLiteFileIdentity(database);
      configureSQLiteConnection(database);
      const migrationResult = applySQLiteMigrations(database, {
        databasePath: this.databasePath,
        applicationVersion: options.applicationVersion ?? "0.0.0",
        clock: this.clock,
        migrations,
        ...(options.targetVersion === undefined
          ? {}
          : { targetVersion: options.targetVersion }),
        ...(options.authorizeExistingUpgrade === undefined
          ? {}
          : { authorizeExistingUpgrade: options.authorizeExistingUpgrade }),
      });
      this.#database = database;
      this.migrationResult = migrationResult;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the original migration/open failure.
      }
      throw mapSQLiteError(error, "open or migrate the SQLite metadata store");
    }

    try {
      for (const [hash, object] of loadObjectCatalog(this.#database, this.#validator)) {
        this.#verifiedObjects.set(hash, object);
      }
      if (options.seed !== undefined) {
        const generation = this.#readGeneration(this.#database);
        const resourceCount = (
          this.#database.prepare("SELECT count(*) AS count FROM vistrea_resources").get() as {
            readonly count: number;
          }
        ).count;
        if (generation !== 0 || resourceCount !== 0) {
          throw new DataError(
            "already_exists",
            "Fixture-backed initial data can only initialize an empty metadata schema.",
          );
        }
        this.#loadSeed(options.seed);
        this.#database.exec("BEGIN IMMEDIATE");
        replaceMetadataState(this.#database, this.#state);
        this.#database.exec("COMMIT");
        this.#state = createEmptyDataState();
      }
      this.#database.exec("BEGIN");
      this.#readGeneration(this.#database);
      const durableCatalog = loadObjectCatalog(this.#database, this.#validator);
      loadMetadataState(this.#database, this.#validator, durableCatalog);
      this.#database.exec("ROLLBACK");
    } catch (error) {
      if (this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
      try {
        this.#database.close();
      } finally {
        this.#closed = true;
      }
      throw mapSQLiteError(error, "load or initialize the SQLite metadata state");
    }
  }

  beginUnitOfWork(mode: UnitOfWorkMode): DataUnitOfWork {
    this.#assertOpen();
    if (mode !== "read" && mode !== "write") {
      throw new DataError("invalid_argument", "Unit of Work mode must be read or write.");
    }
    const id = this.#ids.next("uow");
    let database: Database.Database | undefined;
    try {
      database = new Database(this.databasePath, { timeout: 5_000 });
      assertSQLiteFileIdentity(database);
      configureSQLiteConnection(database);
      database.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
      const baseGeneration = this.#readGeneration(database);
      const verifiedObjects = loadObjectCatalog(database, this.#validator);
      const state = loadMetadataState(database, this.#validator, verifiedObjects);
      const unit = new StateDataUnitOfWork(
        this,
        id,
        mode,
        baseGeneration,
        "sqlite",
        state,
        this.#validator,
        this.clock,
        this.#ids,
      );
      this.#openUnits.add(id);
      this.#unitDatabases.set(id, database);
      return unit;
    } catch (error) {
      if (database?.inTransaction === true) {
        database.exec("ROLLBACK");
      }
      database?.close();
      throw mapSQLiteError(error, `begin the ${mode} SQLite Unit of Work`);
    }
  }

  checkHealth(): WorkspaceHealth {
    this.#assertOpen();
    const issues: string[] = [];
    let generation = 0;
    try {
      this.#database.exec("BEGIN");
      generation = this.#readGeneration(this.#database);
      const quickCheck = this.#database.pragma("quick_check") as readonly Record<string, unknown>[];
      if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {})[0] !== "ok") {
        issues.push("SQLite quick_check did not return ok.");
      }
      const foreignKeyFailures = this.#database.pragma("foreign_key_check") as readonly unknown[];
      if (foreignKeyFailures.length > 0) {
        issues.push(`SQLite foreign_key_check reported ${foreignKeyFailures.length} row(s).`);
      }
      const verifiedObjects = loadObjectCatalog(this.#database, this.#validator);
      loadMetadataState(this.#database, this.#validator, verifiedObjects);
      this.#database.exec("ROLLBACK");
    } catch (error) {
      if (this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
      issues.push(String(error));
    }
    return {
      ok: issues.length === 0,
      generation,
      open_units_of_work: this.#openUnits.size,
      issues,
    };
  }

  registerVerifiedObjects(objects: readonly ObjectRef[]): void {
    this.#assertOpen();
    const pending = new Map<string, ObjectRef>();
    for (const object of objects) {
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
      const current = this.#verifiedObjects.get(object.hash) ?? pending.get(object.hash);
      if (current !== undefined && deterministicJson(current) !== deterministicJson(object)) {
        throw new DataError("integrity_error", "One object hash resolved to conflicting metadata.", {
          details: { hash: object.hash },
        });
      }
      if (current === undefined) {
        pending.set(object.hash, cloneValue(object));
      }
    }
    if (pending.size === 0) {
      return;
    }
    const pendingObjects = [...pending.values()];
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      persistObjectCatalogEntries(this.#database, pendingObjects);
      const durableCatalog = loadObjectCatalog(this.#database, this.#validator);
      for (const object of pendingObjects) {
        const durable = durableCatalog.get(object.hash);
        if (durable === undefined || deterministicJson(durable) !== deterministicJson(object)) {
          throw new DataError("integrity_error", "One object hash resolved to conflicting metadata.", {
            details: { hash: object.hash },
          });
        }
      }
      this.#database.exec("COMMIT");
      for (const object of pendingObjects) {
        this.#verifiedObjects.set(object.hash, cloneValue(object));
      }
    } catch (error) {
      if (this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw mapSQLiteError(error, "register verified ObjectRefs");
    }
  }

  /** Creates and independently verifies a WAL-aware SQLite backup. */
  async createVerifiedBackup(destinationPath: string): Promise<SQLiteBackupResult> {
    this.#assertMaintenanceIdle();
    try {
      try {
        await fs.lstat(destinationPath);
        throw new DataError("already_exists", "The SQLite backup destination already exists.", {
          details: { destination_path: destinationPath },
        });
      } catch (error) {
        if (filesystemCode(error) !== "ENOENT") {
          throw error;
        }
      }
      await this.#database.backup(destinationPath);
      const stat = await fs.lstat(destinationPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new DataError("integrity_error", "The SQLite backup is not a regular file.");
      }
      const inspection = inspectSQLiteMetadataFile({
        databasePath: destinationPath,
        validator: this.#validator,
        migrations: this.#migrations,
      });
      return {
        databasePath: destinationPath,
        byteSize: stat.size,
        ...inspection,
      };
    } catch (error) {
      throw mapSQLiteError(error, "create and verify the SQLite metadata backup");
    }
  }

  /** Offline-maintenance view used by the local Workspace garbage collector. */
  maintenanceSnapshot(): SQLiteMaintenanceSnapshot {
    this.#assertMaintenanceIdle();
    try {
      this.#database.exec("BEGIN");
      const catalog = loadObjectCatalog(this.#database, this.#validator);
      const state = loadMetadataState(this.#database, this.#validator, catalog);
      const reachable = collectMaintenanceReachableObjectHashes(state);
      this.#database.exec("ROLLBACK");
      return {
        registeredObjectHashes: new Set(catalog.keys()),
        reachableObjectHashes: reachable,
      };
    } catch (error) {
      if (this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw mapSQLiteError(error, "inspect SQLite object reachability");
    }
  }

  /**
   * Removes only catalog rows proven unreachable in the same transaction.
   * Physical deletion happens afterwards, so interruption can leave a safe
   * unregistered orphan but never a catalog row that claims missing bytes.
   */
  removeUnreferencedObjectCatalogEntries(hashes: readonly string[]): readonly string[] {
    this.#assertMaintenanceIdle();
    const requested = [...new Set(hashes)].sort();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const catalog = loadObjectCatalog(this.#database, this.#validator);
      const state = loadMetadataState(this.#database, this.#validator, catalog);
      const reachable = collectMaintenanceReachableObjectHashes(state);
      const becameReachable = requested.filter((hash) => reachable.has(hash));
      if (becameReachable.length > 0) {
        throw new DataError("conflict", "An object became reachable before catalog cleanup.", {
          retryable: true,
          details: { hashes: becameReachable },
        });
      }
      const remove = this.#database.prepare("DELETE FROM vistrea_object_refs WHERE hash = ?");
      const removed: string[] = [];
      for (const hash of requested) {
        if (remove.run(hash).changes === 1) {
          removed.push(hash);
        }
      }
      this.#database.exec("COMMIT");
      for (const hash of removed) {
        this.#verifiedObjects.delete(hash);
      }
      return removed;
    } catch (error) {
      if (this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw mapSQLiteError(error, "remove unreachable ObjectRefs from the SQLite catalog");
    }
  }

  _isVerifiedObject(hash: string): boolean {
    return this.#verifiedObjects.has(hash);
  }

  _verifiedObject(hash: string): ObjectRef | undefined {
    const value = this.#verifiedObjects.get(hash);
    return value === undefined ? undefined : cloneFrozen(value);
  }

  _commit(unit: StateDataUnitOfWork): void {
    if (!this.#openUnits.has(unit.id)) {
      throw new DataError("conflict", "The Unit of Work is no longer active.", {
        details: { unit_of_work_id: unit.id },
      });
    }
    const database = this.#unitDatabase(unit.id);
    try {
      if (unit.mode === "write") {
        const currentGeneration = this.#readGeneration(database);
        if (unit.baseGeneration !== currentGeneration) {
          throw new DataError("conflict", "The Workspace changed after this Unit of Work began.", {
            retryable: true,
            details: {
              unit_of_work_id: unit.id,
              base_generation: unit.baseGeneration,
              current_generation: currentGeneration,
            },
          });
        }
        if (currentGeneration === Number.MAX_SAFE_INTEGER) {
          throw new DataError("resource_exhausted", "The Workspace generation is exhausted.");
        }
        replaceMetadataState(database, unit.state);
        const updated = database
          .prepare(
            "UPDATE vistrea_store_meta SET generation = generation + 1 " +
              "WHERE singleton = 1 AND generation = ?",
          )
          .run(unit.baseGeneration);
        if (updated.changes !== 1) {
          throw new DataError("conflict", "The SQLite Workspace generation changed.", {
            retryable: true,
            details: { base_generation: unit.baseGeneration },
          });
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) {
        database.exec("ROLLBACK");
      }
      throw mapSQLiteError(error, "commit the SQLite Unit of Work");
    } finally {
      database.close();
      this.#unitDatabases.delete(unit.id);
      this.#openUnits.delete(unit.id);
    }
  }

  _rollback(unit: StateDataUnitOfWork): void {
    const database = this.#unitDatabase(unit.id);
    try {
      if (database.inTransaction) {
        database.exec("ROLLBACK");
      }
    } finally {
      database.close();
      this.#unitDatabases.delete(unit.id);
      this.#openUnits.delete(unit.id);
    }
  }

  close(): void {
    this.#assertOpen();
    if (this.#openUnits.size > 0) {
      throw new DataError("conflict", "The SQLite store still has open Units of Work.", {
        details: { open_units_of_work: this.#openUnits.size },
      });
    }
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DataError("conflict", "The SQLite metadata store is closed.");
    }
  }

  #assertMaintenanceIdle(): void {
    this.#assertOpen();
    if (this.#openUnits.size > 0) {
      throw new DataError("conflict", "Workspace maintenance requires all Units of Work to close.", {
        details: { open_units_of_work: this.#openUnits.size },
      });
    }
  }

  #readGeneration(database: Database.Database): number {
    const row = database
      .prepare("SELECT generation FROM vistrea_store_meta WHERE singleton = 1")
      .get() as { readonly generation?: unknown } | undefined;
    if (typeof row?.generation !== "number" || !Number.isSafeInteger(row.generation)) {
      throw new DataError("integrity_error", "The SQLite Workspace generation is invalid.");
    }
    return row.generation;
  }

  #unitDatabase(unitId: string): Database.Database {
    const database = this.#unitDatabases.get(unitId);
    if (database === undefined) {
      throw new DataError("conflict", "The SQLite Unit of Work has no active transaction.", {
        details: { unit_of_work_id: unitId },
      });
    }
    return database;
  }

  #loadSeed(seed: SQLiteDataSeed): void {
    this.registerVerifiedObjects(seed.verifiedObjects ?? []);
    const add = <T>(
      values: readonly T[] | undefined,
      map: Map<string, T>,
      id: (value: T) => string,
      schemaId: ProtocolSchemaId,
    ): void => {
      for (const value of values ?? []) {
        this.#validator.assert(schemaId, value);
        const key = id(value);
        if (map.has(key)) {
          throw new DataError("already_exists", "The seed contains a duplicate resource.", {
            details: { resource_id: key },
          });
        }
        map.set(key, cloneValue(value));
      }
    };

    add(seed.snapshots, this.#state.snapshots, (value) => value.snapshot_id, PROTOCOL_SCHEMA_IDS.runtimeSnapshot);
    add(seed.observations, this.#state.observations, (value) => value.observation_id, PROTOCOL_SCHEMA_IDS.observation);
    add(seed.screenGraphs, this.#state.screenGraphs, (value) => value.screen_graph_id, PROTOCOL_SCHEMA_IDS.screenGraph);
    add(seed.identityDecisions, this.#state.identityDecisions, (value) => value.state_identity_decision_id, PROTOCOL_SCHEMA_IDS.stateIdentityDecision);
    add(seed.wikiNodes, this.#state.wikiNodes, (value) => value.wiki_node_id, PROTOCOL_SCHEMA_IDS.wikiNode);
    add(seed.wikiLinks, this.#state.wikiLinks, (value) => value.wiki_link_id, PROTOCOL_SCHEMA_IDS.wikiLink);
    add(seed.knowledgeCollections, this.#state.knowledgeCollections, (value) => value.collection_id, PROTOCOL_SCHEMA_IDS.knowledgeCollection);
    add(seed.designReferences, this.#state.designReferences, (value) => value.design_reference_id, PROTOCOL_SCHEMA_IDS.designReference);
    add(seed.designRegionMappings, this.#state.designRegionMappings, (value) => value.mapping_id, PROTOCOL_SCHEMA_IDS.designRegionMapping);
    add(seed.designComparisons, this.#state.designComparisons, (value) => value.comparison_id, PROTOCOL_SCHEMA_IDS.designComparison);
    add(seed.reviewIssues, this.#state.reviewIssues, (value) => value.issue_id, PROTOCOL_SCHEMA_IDS.reviewIssue);
    add(seed.reviewVerificationRecords, this.#state.reviewVerificationRecords, (value) => value.verification_record_id, PROTOCOL_SCHEMA_IDS.reviewVerificationRecord);
    add(seed.tuningPatches, this.#state.tuningPatches, (value) => value.patch_id, PROTOCOL_SCHEMA_IDS.tuningPatch);
    add(seed.tuningApplications, this.#state.tuningApplications, (value) => value.tuning_application_id, PROTOCOL_SCHEMA_IDS.tuningApplication);
    add(seed.validationRuns, this.#state.validationRuns, (value) => value.validation_run_id, PROTOCOL_SCHEMA_IDS.validationRun);
    add(seed.validationFindings, this.#state.validationFindings, (value) => value.finding_id, PROTOCOL_SCHEMA_IDS.validationFinding);
    add(seed.validationSuppressions, this.#state.validationSuppressions, (value) => value.suppression_id, PROTOCOL_SCHEMA_IDS.validationSuppression);
    add(seed.buildDiffs, this.#state.buildDiffs, (value) => value.build_diff_id, PROTOCOL_SCHEMA_IDS.buildDiff);
    add(seed.operationRecords, this.#state.operations, (value) => value.operation.operation_id, PROTOCOL_SCHEMA_IDS.operationRecord);
    add(seed.commits, this.#state.commits, (value) => value.commit_id, PROTOCOL_SCHEMA_IDS.commit);
    add(seed.refs, this.#state.refs, (value) => value.name, PROTOCOL_SCHEMA_IDS.ref);
    add(seed.tags, this.#state.tags, (value) => value.name, PROTOCOL_SCHEMA_IDS.tag);
    add(seed.workingSets, this.#state.workingSets, (value) => value.working_set_id, PROTOCOL_SCHEMA_IDS.workingSet);

    for (const snapshot of seed.snapshots ?? []) {
      const objects = [...collectEmbeddedObjectHashes(snapshot)]
        .sort()
        .map((hash) => {
          const object = this.#verifiedObjects.get(hash);
          if (object === undefined) {
            throw new DataError(
              "integrity_error",
              "A seeded Snapshot references an ObjectRef that was not registered as verified.",
              { details: { snapshot_id: snapshot.snapshot_id, hash } },
            );
          }
          return cloneValue(object);
        });
      if (objects.length > 0) {
        this.#state.snapshotObjects.set(snapshot.snapshot_id, objects);
      }
    }

    for (const batch of seed.runtimeEventBatches ?? []) {
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.runtimeEventBatch, batch);
      for (const event of batch.events) {
        if (this.#state.runtimeEvents.has(event.event_id)) {
          throw new DataError("already_exists", "The seed contains a duplicate runtime event.", {
            details: { event_id: event.event_id },
          });
        }
        this.#state.runtimeEvents.set(event.event_id, cloneValue(event));
      }
    }
    for (const [selector, graphId] of Object.entries(seed.screenGraphsByVersion ?? {})) {
      if (!this.#state.screenGraphs.has(graphId)) {
        throw new DataError("not_found", "A seeded graph version points to an unknown graph.", {
          details: { selector, screen_graph_id: graphId },
        });
      }
      this.#state.screenGraphsByVersion.set(selector, graphId);
    }
    for (const hash of collectEmbeddedObjectHashes(seed)) {
      if (!this.#verifiedObjects.has(hash)) {
        throw new DataError(
          "integrity_error",
          "Seed metadata references an object that was not registered as verified.",
          { details: { hash } },
        );
      }
    }
  }
}

function readGeneration(database: Database.Database): number {
  const row = database
    .prepare("SELECT generation FROM vistrea_store_meta WHERE singleton = 1")
    .get() as { readonly generation?: unknown } | undefined;
  if (typeof row?.generation !== "number" || !Number.isSafeInteger(row.generation)) {
    throw new DataError("integrity_error", "The SQLite Workspace generation is invalid.");
  }
  return row.generation;
}

function collectMaintenanceReachableObjectHashes(state: DataState): ReadonlySet<string> {
  const hashes = new Set<string>();
  const rootCommitIds = new Set<string>();
  const versionMaps = new Set<ReadonlyMap<string, unknown>>([
    state.commits,
    state.refs,
    state.tags,
    state.workingSets,
  ]);

  for (const candidate of Object.values(state)) {
    if (!(candidate instanceof Map) || versionMaps.has(candidate)) {
      continue;
    }
    for (const value of candidate.values()) {
      for (const hash of collectEmbeddedObjectHashes(value)) {
        hashes.add(hash);
      }
      collectEmbeddedCommitIds(value, state.commits, rootCommitIds);
    }
  }

  for (const ref of state.refs.values()) {
    rootCommitIds.add(ref.commit_id);
    for (const hash of collectEmbeddedObjectHashes(ref)) {
      hashes.add(hash);
    }
    collectEmbeddedCommitIds(ref, state.commits, rootCommitIds);
  }
  for (const tag of state.tags.values()) {
    rootCommitIds.add(tag.commit_id);
    for (const hash of collectEmbeddedObjectHashes(tag)) {
      hashes.add(hash);
    }
    collectEmbeddedCommitIds(tag, state.commits, rootCommitIds);
  }
  for (const workingSet of state.workingSets.values()) {
    rootCommitIds.add(workingSet.base_commit_id);
    for (const hash of collectEmbeddedObjectHashes(workingSet)) {
      hashes.add(hash);
    }
    collectEmbeddedCommitIds(workingSet, state.commits, rootCommitIds);
  }

  const pending = [...rootCommitIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const commitId = pending.pop() as string;
    if (visited.has(commitId)) {
      continue;
    }
    const commit = state.commits.get(commitId);
    if (commit === undefined) {
      throw new DataError("integrity_error", "Live metadata references a missing Commit.", {
        details: { commit_id: commitId },
      });
    }
    visited.add(commitId);
    pending.push(...commit.manifest.parents);
    for (const hash of commit.manifest.object_hashes) {
      hashes.add(hash);
    }
  }
  return hashes;
}

function collectEmbeddedCommitIds(
  value: unknown,
  commits: ReadonlyMap<string, Commit>,
  output: Set<string>,
): void {
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
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (
        typeof child === "string" &&
        (key === "commit_id" || key.endsWith("_commit_id")) &&
        commits.has(child)
      ) {
        output.add(child);
      }
      visit(child);
    }
  };
  visit(value);
}

function filesystemCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function mapSQLiteError(error: unknown, action: string): DataError {
  if (error instanceof DataError) {
    return error;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unknown";
  const busy = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
  return new DataError(
    busy ? "conflict" : "integrity_error",
    `Failed to ${action}.`,
    {
      retryable: busy,
      details: { sqlite_code: code, cause: String(error) },
    },
  );
}
