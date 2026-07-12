import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DataError } from "../api/errors.js";
import type { Clock, IdGenerator, ProtocolValidator } from "../api/models.js";
import type { ObjectStore, WorkspaceDataSource } from "../api/ports.js";
import {
  SQLiteDataStore,
  type MigrationAuthorization,
  type SQLiteMigration,
} from "../metadata/index.js";
import { FileObjectStore } from "../objects/index.js";

const LOCK_FILENAME = ".host.lock";

interface WorkspaceLockRecord {
  readonly format_version: 1;
  readonly token: string;
  readonly process_id: number;
  readonly acquired_at: string;
}

export interface LocalDataWorkspaceOptions {
  readonly workspaceRoot: string;
  readonly validator: ProtocolValidator;
  readonly applicationVersion?: string;
  readonly migrationsDirectory?: string;
  readonly migrations?: readonly SQLiteMigration[];
  readonly targetVersion?: number;
  readonly authorizeExistingUpgrade?: (request: MigrationAuthorization) => void;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/**
 * Production local Data composition for one Host-owned Workspace.
 *
 * Product consumers receive only the public Data and Object Store ports. They
 * never receive the SQLite connection or physical object paths.
 */
export class LocalDataWorkspace {
  readonly workspaceRoot: string;
  readonly data: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly #sqlite: SQLiteDataStore;
  readonly #lock: WorkspaceLock;
  #storageClosed = false;
  #closed = false;

  private constructor(
    workspaceRoot: string,
    sqlite: SQLiteDataStore,
    objects: FileObjectStore,
    lock: WorkspaceLock,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.#sqlite = sqlite;
    this.data = sqlite;
    this.objects = objects;
    this.#lock = lock;
  }

  static async open(options: LocalDataWorkspaceOptions): Promise<LocalDataWorkspace> {
    if (typeof options.workspaceRoot !== "string" || options.workspaceRoot.length === 0) {
      throw new DataError("invalid_argument", "workspaceRoot must be a non-empty path.");
    }
    const requestedRoot = path.resolve(options.workspaceRoot);
    await ensureWorkspaceDirectory(requestedRoot);
    const workspaceRoot = await fs.realpath(requestedRoot);
    const lock = await WorkspaceLock.acquire(workspaceRoot, options.clock);
    let sqlite: SQLiteDataStore | undefined;
    try {
      sqlite = new SQLiteDataStore({
        databasePath: path.join(workspaceRoot, "metadata.sqlite"),
        validator: options.validator,
        ...(options.applicationVersion === undefined
          ? {}
          : { applicationVersion: options.applicationVersion }),
        ...(options.migrationsDirectory === undefined
          ? {}
          : { migrationsDirectory: options.migrationsDirectory }),
        ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
        ...(options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion }),
        ...(options.authorizeExistingUpgrade === undefined
          ? {}
          : { authorizeExistingUpgrade: options.authorizeExistingUpgrade }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.ids === undefined ? {} : { ids: options.ids }),
      });
      const objects = await FileObjectStore.open({
        workspaceRoot,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      return new LocalDataWorkspace(workspaceRoot, sqlite, objects, lock);
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

  async close(): Promise<void> {
    if (this.#closed) {
      throw new DataError("conflict", "The local Workspace is already closed.");
    }
    if (!this.#storageClosed) {
      this.#sqlite.close();
      this.#storageClosed = true;
    }
    await this.#lock.release();
    this.#closed = true;
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
      acquired_at: clock?.now() ?? new Date().toISOString(),
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
      const stat = await fs.lstat(this.#lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new DataError("integrity_error", "The local Workspace lock is not a regular file.");
      }
      const source = await fs.readFile(this.#lockPath, "utf8");
      let current: unknown;
      try {
        current = JSON.parse(source) as unknown;
      } catch {
        throw new DataError("integrity_error", "The local Workspace lock is not valid JSON.");
      }
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        (current as { readonly token?: unknown }).token !== this.#record.token
      ) {
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

async function ensureWorkspaceDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DataError("integrity_error", "The local Workspace root is not a real directory.");
    }
  } catch (error) {
    throw mapFilesystemError(error, "create the local Workspace directory");
  }
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
