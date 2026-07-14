import { randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { DataError, isDataError } from "../api/errors.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type BackupWorkspaceCommand,
  type Clock,
  type CollectWorkspaceGarbageCommand,
  type CollectWorkspaceGarbageResult,
  type IdGenerator,
  type JsonObject,
  type MigrationResult,
  type ObjectRef,
  type ProtocolValidator,
  type RecoverWorkspaceLockResult,
  type RecoverWorkspaceRestoreResult,
  type RetentionPolicy,
  type WorkspaceRestoreResult,
} from "../api/models.js";
import type { ExchangeService, ObjectStore, WorkspaceDataSource } from "../api/ports.js";
import { PackExchangeService } from "../exchange/index.js";
import { canonicalizeIdentityJson } from "../internal/support.js";
import {
  discoverSQLiteMigrations,
  inspectSQLiteMetadataFile,
  SQLiteDataStore,
  type MigrationAuthorization,
  type SQLiteMigration,
} from "../metadata/index.js";
import { FileObjectStore } from "../objects/index.js";

const LOCK_FILENAME = ".host.lock";
const METADATA_FILENAME = "metadata.sqlite";
const RESTORE_JOURNAL_FILENAME = ".restore-journal.json";
const MAINTENANCE_DIRECTORY = ".maintenance";
const RECOVERY_DIRECTORY = ".recovery";
const DEFAULT_GARBAGE_MINIMUM_AGE_SECONDS = 24 * 60 * 60;
const SQLITE_RUNTIME_FILES = [
  METADATA_FILENAME,
  `${METADATA_FILENAME}-wal`,
  `${METADATA_FILENAME}-shm`,
] as const;

export const WORKSPACE_BACKUP_MEDIA_TYPE =
  "application/vnd.vistrea.workspace-metadata-backup+sqlite3";

interface WorkspaceLockRecord {
  readonly format_version: 1;
  readonly token: string;
  readonly process_id: number;
  readonly acquired_at: string;
}

interface RestoreJournalFile {
  readonly name: (typeof SQLITE_RUNTIME_FILES)[number];
  readonly present: boolean;
}

interface RestoreJournal {
  readonly format_version: 1;
  readonly recovery_id: string;
  readonly backup_hash: string;
  readonly created_at: string;
  readonly original_files: readonly RestoreJournalFile[];
}

export interface LocalDataWorkspaceOptions {
  readonly workspaceRoot: string;
  readonly validator: ProtocolValidator;
  readonly applicationVersion?: string;
  readonly migrationsDirectory?: string;
  readonly migrations?: readonly SQLiteMigration[];
  readonly targetVersion?: number;
  /** Optional policy callback invoked only after the automatic backup exists. */
  readonly authorizeExistingUpgrade?: (request: MigrationAuthorization) => void;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface RestoreLocalDataWorkspaceOptions
  extends Omit<LocalDataWorkspaceOptions, "targetVersion" | "authorizeExistingUpgrade"> {
  readonly backup: ObjectRef;
}

export interface CollectLocalWorkspaceGarbageOptions
  extends Omit<LocalDataWorkspaceOptions, "targetVersion" | "authorizeExistingUpgrade"> {
  readonly command?: CollectWorkspaceGarbageCommand;
}

export interface RecoverLocalWorkspaceOptions {
  readonly workspaceRoot: string;
}

/**
 * Production local Data composition for one Host-owned Workspace.
 *
 * Product consumers receive only the public Data and Object Store ports. They
 * never receive the SQLite connection or physical object paths. Destructive
 * maintenance is exposed only as offline static operations that acquire the
 * same ownership lock as the Host.
 */
export class LocalDataWorkspace {
  readonly workspaceRoot: string;
  readonly data: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly exchange: ExchangeService;
  readonly migrationResult: MigrationResult;
  readonly #sqlite: SQLiteDataStore;
  readonly #fileObjects: FileObjectStore;
  readonly #lock: WorkspaceLock;
  #storageClosed = false;
  #closed = false;
  #maintenanceActive = false;

  private constructor(
    workspaceRoot: string,
    sqlite: SQLiteDataStore,
    objects: FileObjectStore,
    lock: WorkspaceLock,
    validator: ProtocolValidator,
    migrationBackup?: ObjectRef,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.#sqlite = sqlite;
    this.data = sqlite;
    this.#fileObjects = objects;
    this.objects = objects;
    this.exchange = new PackExchangeService({ data: sqlite, objects, validator });
    this.#lock = lock;
    this.migrationResult = {
      from_version: sqlite.migrationResult.fromVersion,
      to_version: sqlite.migrationResult.toVersion,
      applied_versions: sqlite.migrationResult.appliedVersions,
      ...(migrationBackup === undefined ? {} : { backup: migrationBackup }),
    };
  }

  static async open(options: LocalDataWorkspaceOptions): Promise<LocalDataWorkspace> {
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot);
    const lock = await WorkspaceLock.acquire(workspaceRoot, options.clock);
    let sqlite: SQLiteDataStore | undefined;
    try {
      await assertNoInterruptedRestore(workspaceRoot);
      await cleanAbandonedMaintenanceFiles(workspaceRoot);
      const migrations = resolveMigrations(options);
      const targetVersion = options.targetVersion ?? migrations.at(-1)?.version ?? 0;
      const latestVersion = migrations.at(-1)?.version ?? 0;
      if (
        !Number.isSafeInteger(targetVersion) ||
        targetVersion < 1 ||
        targetVersion > latestVersion
      ) {
        throw new DataError("invalid_argument", "The requested migration target is unavailable.", {
          details: { target_version: targetVersion, latest_version: latestVersion },
        });
      }
      const metadataPath = path.join(workspaceRoot, METADATA_FILENAME);
      const existing = await inspectExistingMetadata(metadataPath, options.validator, migrations);
      const objects = await FileObjectStore.open({
        workspaceRoot,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });

      let migrationBackup: ObjectRef | undefined;
      if (existing !== undefined && existing.schemaVersion < targetVersion) {
        const preflight = new SQLiteDataStore({
          ...sqliteOptions(options, metadataPath, migrations),
          targetVersion: existing.schemaVersion,
        });
        try {
          migrationBackup = await createBackupObject({
            workspaceRoot,
            sqlite: preflight,
            objects,
            reason: `Automatic backup before schema migration ${existing.schemaVersion} -> ${targetVersion}.`,
            retention: {
              policy_id: `workspace-migration:${existing.schemaVersion}:${targetVersion}`,
              reason:
                "Preserve the verified pre-migration metadata database for explicit recovery.",
            },
          });
        } finally {
          preflight.close();
        }
      }

      sqlite = new SQLiteDataStore({
        ...sqliteOptions(options, metadataPath, migrations),
        ...(options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion }),
        ...(migrationBackup === undefined && options.authorizeExistingUpgrade === undefined
          ? {}
          : {
              authorizeExistingUpgrade: (request: MigrationAuthorization): void => {
                if (migrationBackup === undefined) {
                  options.authorizeExistingUpgrade?.(request);
                  return;
                }
                if (
                  request.fromVersion !== existing?.schemaVersion ||
                  request.toVersion !== targetVersion ||
                  request.databasePath !== metadataPath
                ) {
                  throw new DataError(
                    "integrity_error",
                    "The migration authorization does not match its verified backup.",
                  );
                }
                options.authorizeExistingUpgrade?.(request);
              },
            }),
      });
      return new LocalDataWorkspace(
        workspaceRoot,
        sqlite,
        objects,
        lock,
        options.validator,
        migrationBackup,
      );
    } catch (error) {
      try {
        sqlite?.close();
      } catch {
        // Preserve the original composition failure.
      }
      try {
        await lock.release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Local Workspace open failed and its ownership lock could not be released.",
        );
      }
      throw error;
    }
  }

  /** WAL-aware online backup; all destructive maintenance remains offline. */
  async backup(command: BackupWorkspaceCommand): Promise<ObjectRef> {
    this.#assertOpen();
    if (this.#maintenanceActive) {
      throw new DataError("conflict", "Workspace backup is already running.", {
        retryable: true,
      });
    }
    assertBackupReason(command.reason);
    this.#maintenanceActive = true;
    try {
      return await createBackupObject({
        workspaceRoot: this.workspaceRoot,
        sqlite: this.#sqlite,
        objects: this.#fileObjects,
        reason: command.reason,
        retention: command.retention,
      });
    } finally {
      this.#maintenanceActive = false;
    }
  }

  /**
   * Restores one verified backup while preserving the previous SQLite files
   * under `.recovery/`. An interruption leaves a journal that blocks normal
   * Host open until `recoverInterruptedRestore` rolls the old files back.
   */
  static async restore(
    options: RestoreLocalDataWorkspaceOptions,
  ): Promise<WorkspaceRestoreResult> {
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot);
    const lock = await WorkspaceLock.acquire(workspaceRoot, options.clock);
    let journalWritten = false;
    try {
      await assertNoInterruptedRestore(workspaceRoot);
      await cleanAbandonedMaintenanceFiles(workspaceRoot);
      options.validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, options.backup);
      if (
        options.backup.media_type !== WORKSPACE_BACKUP_MEDIA_TYPE ||
        options.backup.compression !== "none"
      ) {
        throw new DataError("invalid_argument", "The restore object is not a Workspace backup.", {
          details: {
            hash: options.backup.hash,
            media_type: options.backup.media_type,
            compression: options.backup.compression,
          },
        });
      }
      const migrations = resolveMigrations(options);
      const objects = await FileObjectStore.open({
        workspaceRoot,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      const stored = await objects.stat(options.backup.hash);
      if (canonicalizeIdentityJson(stored) !== canonicalizeIdentityJson(options.backup)) {
        throw new DataError("integrity_error", "The restore ObjectRef does not match stored bytes.", {
          details: { hash: options.backup.hash },
        });
      }

      const maintenanceRoot = await ensureControlledSubdirectory(
        workspaceRoot,
        MAINTENANCE_DIRECTORY,
      );
      const temporaryDirectory = await fs.mkdtemp(path.join(maintenanceRoot, "restore-"));
      const restoredPath = path.join(temporaryDirectory, METADATA_FILENAME);
      try {
        await writeObjectToFile(objects, options.backup, restoredPath);
        const inspection = inspectSQLiteMetadataFile({
          databasePath: restoredPath,
          validator: options.validator,
          migrations,
        });

        const recoveryId = `restore-${randomUUID()}`;
        const recoveryRoot = await ensureControlledSubdirectory(
          workspaceRoot,
          RECOVERY_DIRECTORY,
        );
        const evidenceRoot = path.join(recoveryRoot, recoveryId);
        await fs.mkdir(evidenceRoot, { mode: 0o700 });
        const originalFiles = await preserveOriginalSQLiteFiles(workspaceRoot, evidenceRoot);
        const journal: RestoreJournal = {
          format_version: 1,
          recovery_id: recoveryId,
          backup_hash: options.backup.hash,
          created_at: requireUtcTimestamp(
            options.clock?.now() ?? new Date().toISOString(),
            "restore clock",
          ),
          original_files: originalFiles,
        };
        await writeAtomicJson(path.join(workspaceRoot, RESTORE_JOURNAL_FILENAME), journal);
        journalWritten = true;

        await removeSQLiteSidecars(workspaceRoot);
        await fs.rename(restoredPath, path.join(workspaceRoot, METADATA_FILENAME));
        await syncDirectory(workspaceRoot);
        const installed = inspectSQLiteMetadataFile({
          databasePath: path.join(workspaceRoot, METADATA_FILENAME),
          validator: options.validator,
          migrations,
        });
        if (
          installed.schemaVersion !== inspection.schemaVersion ||
          installed.generation !== inspection.generation
        ) {
          throw new DataError("integrity_error", "The installed restore differs from its verified source.");
        }
        await fs.unlink(path.join(workspaceRoot, RESTORE_JOURNAL_FILENAME));
        await syncDirectory(workspaceRoot);
        journalWritten = false;
        return {
          backup: options.backup,
          restored_schema_version: installed.schemaVersion,
          restored_generation: installed.generation,
          recovery_id: recoveryId,
        };
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      if (journalWritten) {
        try {
          await recoverInterruptedRestoreWithLock(workspaceRoot);
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Workspace restore failed and automatic rollback also failed.",
          );
        }
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  /** Explicitly rolls back a restore whose durable journal survived a crash. */
  static async recoverInterruptedRestore(
    options: RecoverLocalWorkspaceOptions,
  ): Promise<RecoverWorkspaceRestoreResult> {
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot);
    const lock = await WorkspaceLock.acquire(workspaceRoot);
    try {
      return await recoverInterruptedRestoreWithLock(workspaceRoot);
    } finally {
      await lock.release();
    }
  }

  /**
   * Recovers only a valid lock whose recorded process is definitely absent.
   * Live, inaccessible, malformed, and symlinked locks fail closed.
   */
  static async recoverStaleLock(
    options: RecoverLocalWorkspaceOptions,
  ): Promise<RecoverWorkspaceLockResult> {
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot);
    const lockPath = path.join(workspaceRoot, LOCK_FILENAME);
    const source = await readRegularFile(lockPath, "Workspace lock");
    const record = parseWorkspaceLockRecord(source.toString("utf8"));
    try {
      process.kill(record.process_id, 0);
      throw new DataError("conflict", "The Workspace lock owner is still running.", {
        retryable: true,
        details: { process_id: record.process_id },
      });
    } catch (error) {
      if (error instanceof DataError) {
        throw error;
      }
      if (filesystemCode(error) !== "ESRCH") {
        throw new DataError("conflict", "The Workspace lock owner cannot be proven absent.", {
          retryable: true,
          details: {
            process_id: record.process_id,
            process_error: filesystemCode(error) ?? "unknown",
          },
        });
      }
    }

    const recoveryRoot = await ensureControlledSubdirectory(workspaceRoot, RECOVERY_DIRECTORY);
    const recoveryId = `lock-${randomUUID()}`;
    const evidenceRoot = path.join(recoveryRoot, recoveryId);
    await fs.mkdir(evidenceRoot, { mode: 0o700 });
    const evidencePath = path.join(evidenceRoot, "host.lock.json");
    await writeSyncedFile(evidencePath, source);
    const current = await readRegularFile(lockPath, "Workspace lock");
    if (!current.equals(source)) {
      throw new DataError("conflict", "The Workspace lock changed during stale-lock recovery.", {
        retryable: true,
      });
    }
    await fs.unlink(lockPath);
    await syncDirectory(workspaceRoot);
    return { recovered_process_id: record.process_id, recovery_id: recoveryId };
  }

  /** Conservative offline mark-and-sweep with dry-run enabled by default. */
  static async collectGarbage(
    options: CollectLocalWorkspaceGarbageOptions,
  ): Promise<CollectWorkspaceGarbageResult> {
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot);
    const lock = await WorkspaceLock.acquire(workspaceRoot, options.clock);
    let sqlite: SQLiteDataStore | undefined;
    try {
      await assertNoInterruptedRestore(workspaceRoot);
      await cleanAbandonedMaintenanceFiles(workspaceRoot);
      const command = normalizeGarbageCommand(options.command);
      const migrations = resolveMigrations(options);
      const metadataPath = path.join(workspaceRoot, METADATA_FILENAME);
      const inspection = await inspectExistingMetadata(metadataPath, options.validator, migrations);
      if (inspection === undefined) {
        throw new DataError("not_found", "The Workspace metadata database does not exist.");
      }
      sqlite = new SQLiteDataStore({
        ...sqliteOptions(options, metadataPath, migrations),
        targetVersion: inspection.schemaVersion,
      });
      const objects = await FileObjectStore.open({
        workspaceRoot,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      const snapshot = sqlite.maintenanceSnapshot();
      const nowText = requireUtcTimestamp(
        options.clock?.now() ?? new Date().toISOString(),
        "maintenance clock",
      );
      const now = Date.parse(nowText);
      if (!Number.isFinite(now)) {
        throw new DataError("invalid_argument", "The maintenance clock returned an invalid timestamp.");
      }

      const inventory = new Map<string, Awaited<ReturnType<FileObjectStore["inspectLifecycle"]>>>();
      for await (const object of objects.inventory()) {
        inventory.set(object.hash, await objects.inspectLifecycle(object.hash));
      }
      const missingRegistered = [...snapshot.registeredObjectHashes]
        .filter((hash) => !inventory.has(hash))
        .sort();
      const missingReachable = missingRegistered.filter((hash) =>
        snapshot.reachableObjectHashes.has(hash),
      );
      if (missingReachable.length > 0) {
        throw new DataError("integrity_error", "Reachable ObjectRefs have no physical payload.", {
          details: { hashes: missingReachable },
        });
      }

      let reachableObjects = 0;
      let retainedObjects = 0;
      let youngObjects = 0;
      const candidates: ObjectRef[] = [];
      for (const lifecycle of inventory.values()) {
        if (snapshot.reachableObjectHashes.has(lifecycle.object.hash)) {
          reachableObjects += 1;
          continue;
        }
        if (lifecycle.active_retention_policy_ids.length > 0) {
          retainedObjects += 1;
          continue;
        }
        const modifiedAt = Date.parse(lifecycle.payload_modified_at);
        if (
          !Number.isFinite(modifiedAt) ||
          now - modifiedAt < command.minimumAgeSeconds * 1_000
        ) {
          youngObjects += 1;
          continue;
        }
        candidates.push(lifecycle.object);
      }
      candidates.sort((left, right) => left.hash.localeCompare(right.hash));
      const candidateBytes = sumObjectBytes(candidates);
      let deletedObjects = 0;
      let deletedBytes = 0;
      let removedCatalogEntries = 0;
      if (!command.dryRun) {
        removedCatalogEntries = sqlite.removeUnreferencedObjectCatalogEntries([
          ...candidates.map((object) => object.hash),
          ...missingRegistered,
        ]).length;
        for (const object of candidates) {
          try {
            await objects.deletePhysical(object.hash);
          } catch (error) {
            if (!isDataError(error, "not_found")) {
              throw error;
            }
          }
          deletedObjects += 1;
          deletedBytes += object.byte_size;
        }
      }
      return {
        dry_run: command.dryRun,
        minimum_age_seconds: command.minimumAgeSeconds,
        scanned_objects: inventory.size,
        reachable_objects: reachableObjects,
        retained_objects: retainedObjects,
        young_objects: youngObjects,
        candidate_objects: candidates.length,
        candidate_bytes: candidateBytes,
        stale_catalog_entries: missingRegistered.length,
        removed_catalog_entries: removedCatalogEntries,
        deleted_objects: deletedObjects,
        deleted_bytes: deletedBytes,
        candidate_hashes: candidates.map((object) => object.hash),
      };
    } finally {
      try {
        sqlite?.close();
      } finally {
        await lock.release();
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      throw new DataError("conflict", "The local Workspace is already closed.");
    }
    if (this.#maintenanceActive) {
      throw new DataError("conflict", "The local Workspace still has active maintenance.", {
        retryable: true,
      });
    }
    if (!this.#storageClosed) {
      this.#sqlite.close();
      this.#storageClosed = true;
    }
    await this.#lock.release();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed || this.#storageClosed) {
      throw new DataError("conflict", "The local Workspace is closed.");
    }
  }
}

class WorkspaceLock {
  readonly #lockPath: string;
  readonly #record: WorkspaceLockRecord;
  #released = false;

  private constructor(lockPath: string, record: WorkspaceLockRecord) {
    this.#lockPath = lockPath;
    this.#record = record;
  }

  static async acquire(workspaceRoot: string, clock?: Clock): Promise<WorkspaceLock> {
    const lockPath = path.join(workspaceRoot, LOCK_FILENAME);
    const record: WorkspaceLockRecord = {
      format_version: 1,
      token: randomUUID(),
      process_id: process.pid,
      acquired_at: requireUtcTimestamp(
        clock?.now() ?? new Date().toISOString(),
        "Workspace lock clock",
      ),
    };
    let handle;
    let created = false;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (filesystemCode(error) === "EEXIST") {
        throw new DataError("conflict", "The local Workspace is already owned by a Host.", {
          retryable: true,
          details: { workspace_root: workspaceRoot },
        });
      }
      if (created) {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Preserve the original acquisition failure. A remaining file fails closed.
        }
      }
      throw mapFilesystemError(error, "acquire the local Workspace lock");
    } finally {
      await handle?.close();
    }
    await syncDirectory(workspaceRoot);
    return new WorkspaceLock(lockPath, record);
  }

  async release(): Promise<void> {
    if (this.#released) {
      throw new DataError("conflict", "The local Workspace lock is already released.");
    }
    try {
      const source = await readRegularFile(this.#lockPath, "Workspace lock");
      const current = parseWorkspaceLockRecord(source.toString("utf8"));
      if (current.token !== this.#record.token) {
        throw new DataError("integrity_error", "The local Workspace lock ownership changed.");
      }
      await fs.unlink(this.#lockPath);
      await syncDirectory(path.dirname(this.#lockPath));
      this.#released = true;
    } catch (error) {
      throw mapFilesystemError(error, "release the local Workspace lock");
    }
  }
}

function resolveMigrations(
  options: Pick<LocalDataWorkspaceOptions, "migrations" | "migrationsDirectory">,
): readonly SQLiteMigration[] {
  return options.migrations ?? discoverSQLiteMigrations(options.migrationsDirectory);
}

function sqliteOptions(
  options: LocalDataWorkspaceOptions,
  databasePath: string,
  migrations: readonly SQLiteMigration[],
): Omit<ConstructorParameters<typeof SQLiteDataStore>[0], "targetVersion" | "authorizeExistingUpgrade"> {
  return {
    databasePath,
    validator: options.validator,
    migrations,
    ...(options.applicationVersion === undefined
      ? {}
      : { applicationVersion: options.applicationVersion }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.ids === undefined ? {} : { ids: options.ids }),
  };
}

async function inspectExistingMetadata(
  metadataPath: string,
  validator: ProtocolValidator,
  migrations: readonly SQLiteMigration[],
): Promise<ReturnType<typeof inspectSQLiteMetadataFile> | undefined> {
  try {
    const stat = await fs.lstat(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DataError("integrity_error", "Workspace metadata.sqlite is not a regular file.");
    }
    if (stat.size === 0) {
      return undefined;
    }
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return inspectSQLiteMetadataFile({ databasePath: metadataPath, validator, migrations });
}

async function createBackupObject(options: {
  readonly workspaceRoot: string;
  readonly sqlite: SQLiteDataStore;
  readonly objects: FileObjectStore;
  readonly reason: string;
  readonly retention: RetentionPolicy;
}): Promise<ObjectRef> {
  assertBackupReason(options.reason);
  const maintenanceRoot = await ensureControlledSubdirectory(
    options.workspaceRoot,
    MAINTENANCE_DIRECTORY,
  );
  const temporaryDirectory = await fs.mkdtemp(path.join(maintenanceRoot, "backup-"));
  const backupPath = path.join(temporaryDirectory, METADATA_FILENAME);
  try {
    const backup = await options.sqlite.createVerifiedBackup(backupPath);
    const createdAt = requireUtcTimestamp(options.sqlite.clock.now(), "backup clock");
    const object = await options.objects.put(createReadStream(backupPath), {
      media_type: WORKSPACE_BACKUP_MEDIA_TYPE,
      compression: "none",
      logical_name: `metadata-schema-v${backup.schemaVersion}.sqlite`,
      extensions: {
        "vistrea.workspace_backup": {
          format_version: 1,
          schema_version: backup.schemaVersion,
          generation: backup.generation,
          created_at: createdAt,
          reason: options.reason,
        },
      },
    });
    await options.objects.pin(object.hash, options.retention);
    options.sqlite.registerVerifiedObjects([object]);
    return object;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeObjectToFile(
  objects: FileObjectStore,
  object: ObjectRef,
  destinationPath: string,
): Promise<void> {
  let handle;
  let written = 0;
  try {
    handle = await fs.open(destinationPath, "wx", 0o600);
    for await (const chunk of await objects.open(object.hash)) {
      const bytes = Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes, offset, bytes.byteLength - offset, written);
        if (result.bytesWritten <= 0) {
          throw new DataError("resource_exhausted", "The restore backup could not be written.");
        }
        offset += result.bytesWritten;
        written += result.bytesWritten;
      }
    }
    if (written !== object.byte_size) {
      throw new DataError("integrity_error", "The restore backup byte size changed during read.", {
        details: { expected_byte_size: object.byte_size, actual_byte_size: written },
      });
    }
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function preserveOriginalSQLiteFiles(
  workspaceRoot: string,
  evidenceRoot: string,
): Promise<readonly RestoreJournalFile[]> {
  const files: RestoreJournalFile[] = [];
  for (const name of SQLITE_RUNTIME_FILES) {
    const source = path.join(workspaceRoot, name);
    const destination = path.join(evidenceRoot, name);
    try {
      await copyRegularFile(source, destination, `SQLite runtime file ${name}`);
      files.push({ name, present: true });
    } catch (error) {
      if (filesystemCode(error) !== "ENOENT") {
        throw error;
      }
      files.push({ name, present: false });
    }
  }
  await syncDirectory(evidenceRoot);
  return files;
}

async function recoverInterruptedRestoreWithLock(
  workspaceRoot: string,
): Promise<RecoverWorkspaceRestoreResult> {
  const journalPath = path.join(workspaceRoot, RESTORE_JOURNAL_FILENAME);
  const journal = parseRestoreJournal(
    (await readRegularFile(journalPath, "restore journal")).toString("utf8"),
  );
  const recoveryRoot = path.join(workspaceRoot, RECOVERY_DIRECTORY);
  await assertControlledDirectory(recoveryRoot, "Workspace recovery directory");
  const evidenceRoot = path.join(recoveryRoot, journal.recovery_id);
  await assertControlledDirectory(evidenceRoot, "restore evidence directory");
  const restored: string[] = [];
  for (const file of journal.original_files) {
    const destination = path.join(workspaceRoot, file.name);
    if (!file.present) {
      await fs.rm(destination, { force: true });
      continue;
    }
    const temporaryPath = path.join(workspaceRoot, `.${file.name}.recover-${randomUUID()}`);
    await copyRegularFile(
      path.join(evidenceRoot, file.name),
      temporaryPath,
      `preserved SQLite runtime file ${file.name}`,
    );
    await fs.rename(temporaryPath, destination);
    restored.push(file.name);
  }
  await syncDirectory(workspaceRoot);
  await fs.unlink(journalPath);
  await syncDirectory(workspaceRoot);
  return { recovery_id: journal.recovery_id, restored_original_files: restored };
}

async function removeSQLiteSidecars(workspaceRoot: string): Promise<void> {
  await Promise.all(
    SQLITE_RUNTIME_FILES.slice(1).map(async (name) => {
      await fs.rm(path.join(workspaceRoot, name), { force: true });
    }),
  );
  await syncDirectory(workspaceRoot);
}

async function assertNoInterruptedRestore(workspaceRoot: string): Promise<void> {
  try {
    await fs.lstat(path.join(workspaceRoot, RESTORE_JOURNAL_FILENAME));
    throw new DataError(
      "conflict",
      "The Workspace has an interrupted restore that requires explicit recovery.",
      { details: { recovery_action: "recoverInterruptedRestore" } },
    );
  } catch (error) {
    if (filesystemCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function normalizeGarbageCommand(command: CollectWorkspaceGarbageCommand | undefined): {
  readonly dryRun: boolean;
  readonly minimumAgeSeconds: number;
} {
  const dryRun = command?.dry_run ?? true;
  const minimumAgeSeconds =
    command?.minimum_age_seconds ?? DEFAULT_GARBAGE_MINIMUM_AGE_SECONDS;
  if (typeof dryRun !== "boolean") {
    throw new DataError("invalid_argument", "dry_run must be boolean.");
  }
  if (
    !Number.isSafeInteger(minimumAgeSeconds) ||
    minimumAgeSeconds < 0 ||
    minimumAgeSeconds > 365 * 24 * 60 * 60
  ) {
    throw new DataError(
      "invalid_argument",
      "minimum_age_seconds must be a safe integer between 0 and one year.",
    );
  }
  return { dryRun, minimumAgeSeconds };
}

function assertBackupReason(reason: string): void {
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1_024) {
    throw new DataError("invalid_argument", "Backup reason must contain 1 to 1024 characters.");
  }
}

function sumObjectBytes(objects: readonly ObjectRef[]): number {
  let total = 0;
  for (const object of objects) {
    if (object.byte_size > Number.MAX_SAFE_INTEGER - total) {
      throw new DataError(
        "resource_exhausted",
        "The garbage-collection byte total exceeds the JSON-safe integer range.",
      );
    }
    total += object.byte_size;
  }
  return total;
}

function requireUtcTimestamp(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new DataError("invalid_argument", `The ${label} returned a non-canonical UTC timestamp.`);
  }
  return value;
}

async function resolveWorkspaceRoot(requested: string): Promise<string> {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new DataError("invalid_argument", "workspaceRoot must be a non-empty path.");
  }
  const requestedRoot = path.resolve(requested);
  await ensureWorkspaceDirectory(requestedRoot);
  return await fs.realpath(requestedRoot);
}

async function ensureWorkspaceDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertControlledDirectory(directory, "local Workspace root");
  } catch (error) {
    throw mapFilesystemError(error, "create the local Workspace directory");
  }
}

async function ensureControlledSubdirectory(
  workspaceRoot: string,
  name: string,
): Promise<string> {
  const directory = path.join(workspaceRoot, name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertControlledDirectory(directory, name);
  return directory;
}

async function cleanAbandonedMaintenanceFiles(workspaceRoot: string): Promise<void> {
  const maintenanceRoot = await ensureControlledSubdirectory(
    workspaceRoot,
    MAINTENANCE_DIRECTORY,
  );
  const entries = await fs.readdir(maintenanceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !/^(?:backup|restore)-[A-Za-z0-9]+$/.test(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      throw new DataError("integrity_error", "The Workspace maintenance directory is non-canonical.", {
        details: { entry: entry.name },
      });
    }
    await fs.rm(path.join(maintenanceRoot, entry.name), { recursive: true });
  }
  await syncDirectory(maintenanceRoot);
}

async function assertControlledDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DataError("integrity_error", `The ${label} is not a real directory.`);
  }
}

async function readRegularFile(filePath: string, label: string): Promise<Buffer> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DataError("integrity_error", `The ${label} is not a regular file.`);
  }
  return await fs.readFile(filePath);
}

async function writeSyncedFile(filePath: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
  label: string,
): Promise<void> {
  let source;
  let destination;
  let completed = false;
  try {
    source = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await source.stat();
    if (!stat.isFile()) {
      throw new DataError("integrity_error", `The ${label} is not a regular file.`);
    }
    destination = await fs.open(destinationPath, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let readOffset = 0;
    while (readOffset < stat.size) {
      const read = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, stat.size - readOffset),
        readOffset,
      );
      if (read.bytesRead <= 0) {
        throw new DataError("integrity_error", `The ${label} ended before its recorded size.`);
      }
      let writeOffset = 0;
      while (writeOffset < read.bytesRead) {
        const written = await destination.write(
          buffer,
          writeOffset,
          read.bytesRead - writeOffset,
          readOffset + writeOffset,
        );
        if (written.bytesWritten <= 0) {
          throw new DataError("resource_exhausted", `The ${label} could not be preserved.`);
        }
        writeOffset += written.bytesWritten;
      }
      readOffset += read.bytesRead;
    }
    await destination.sync();
    completed = true;
  } finally {
    try {
      await destination?.close();
    } finally {
      await source?.close();
    }
    if (!completed) {
      try {
        await fs.rm(destinationPath, { force: true });
      } catch {
        // Preserve the copy failure; incomplete evidence is never journaled.
      }
    }
  }
}

async function writeAtomicJson(filePath: string, value: JsonObject | RestoreJournal): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeSyncedFile(temporaryPath, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

function parseWorkspaceLockRecord(source: string): WorkspaceLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new DataError("integrity_error", "The Workspace lock is not valid JSON.");
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "acquired_at",
    "format_version",
    "process_id",
    "token",
  ])) {
    throw new DataError("integrity_error", "The Workspace lock has an invalid shape.");
  }
  if (
    value["format_version"] !== 1 ||
    typeof value["token"] !== "string" ||
    value["token"].length === 0 ||
    !Number.isSafeInteger(value["process_id"]) ||
    (value["process_id"] as number) <= 0 ||
    typeof value["acquired_at"] !== "string" ||
    !Number.isFinite(Date.parse(value["acquired_at"]))
  ) {
    throw new DataError("integrity_error", "The Workspace lock has invalid values.");
  }
  return value as unknown as WorkspaceLockRecord;
}

function parseRestoreJournal(source: string): RestoreJournal {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new DataError("integrity_error", "The restore journal is not valid JSON.");
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "backup_hash",
    "created_at",
    "format_version",
    "original_files",
    "recovery_id",
  ])) {
    throw new DataError("integrity_error", "The restore journal has an invalid shape.");
  }
  const files = value["original_files"];
  if (
    value["format_version"] !== 1 ||
    typeof value["recovery_id"] !== "string" ||
    !/^restore-[0-9a-f-]{36}$/.test(value["recovery_id"]) ||
    typeof value["backup_hash"] !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value["backup_hash"]) ||
    typeof value["created_at"] !== "string" ||
    !Number.isFinite(Date.parse(value["created_at"])) ||
    !Array.isArray(files) ||
    files.length !== SQLITE_RUNTIME_FILES.length
  ) {
    throw new DataError("integrity_error", "The restore journal has invalid values.");
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ["name", "present"]) ||
      file["name"] !== SQLITE_RUNTIME_FILES[index] ||
      typeof file["present"] !== "boolean"
    ) {
      throw new DataError("integrity_error", "The restore journal file inventory is invalid.");
    }
  }
  return value as unknown as RestoreJournal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (["EINVAL", "ENOTSUP", "EISDIR"].includes(filesystemCode(error) ?? "")) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function filesystemCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function mapFilesystemError(error: unknown, action: string): DataError {
  if (error instanceof DataError) {
    return error;
  }
  const code = filesystemCode(error) ?? "unknown";
  const exhausted = code === "ENOSPC" || code === "EDQUOT";
  return new DataError(
    exhausted ? "resource_exhausted" : "internal",
    `Unable to ${action}.`,
    { details: { filesystem_code: code } },
  );
}
