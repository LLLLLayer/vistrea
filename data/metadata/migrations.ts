import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { DataError } from "../api/errors.js";
import type { Clock } from "../api/models.js";

export const VISTREA_APPLICATION_ID = 0x56535452;
const adjacentMigrationsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
export const DEFAULT_MIGRATIONS_DIRECTORY = fs.existsSync(adjacentMigrationsDirectory)
  ? adjacentMigrationsDirectory
  : path.resolve(process.cwd(), "data/metadata/migrations");

const MIGRATION_FILENAME = /^([0-9]{6})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const LEDGER_TABLE = "__vistrea_schema_migrations";
const REQUIRED_TABLES = [
  "vistrea_object_refs",
  "vistrea_operation_events",
  "vistrea_operation_results",
  "vistrea_resources",
  "vistrea_runtime_event_gaps",
  "vistrea_screen_graph_versions",
  "vistrea_snapshot_objects",
  "vistrea_snapshot_pins",
  "vistrea_store_meta",
] as const;

export interface SQLiteMigration {
  readonly version: number;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sql: string;
  readonly sha256: string;
}

interface PackagedMigrationManifest {
  readonly version: number;
  readonly migrations: readonly {
    readonly filename: string;
    readonly sha256: string;
  }[];
}

export interface MigrationAuthorization {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly databasePath: string;
}

export interface ApplySQLiteMigrationsOptions {
  readonly databasePath: string;
  readonly applicationVersion: string;
  readonly clock: Clock;
  readonly migrations?: readonly SQLiteMigration[];
  readonly migrationsDirectory?: string;
  readonly targetVersion?: number;
  /**
   * Existing Workspaces must be backed up and pinned before this callback
   * authorizes a forward migration. A new database does not invoke it.
   */
  readonly authorizeExistingUpgrade?: (request: MigrationAuthorization) => void;
}

export interface AppliedMigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appliedVersions: readonly number[];
}

interface LedgerRow {
  readonly version: number;
  readonly filename: string;
  readonly sha256: string;
}

function sqliteInteger(db: Database.Database, pragma: string): number {
  const rows = db.pragma(pragma) as readonly Record<string, unknown>[];
  const first = rows[0];
  const value = first === undefined ? undefined : Object.values(first)[0];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DataError("integrity_error", `PRAGMA ${pragma} returned an invalid integer.`);
  }
  return value;
}

function sqliteString(db: Database.Database, pragma: string): string {
  const rows = db.pragma(pragma) as readonly Record<string, unknown>[];
  const first = rows[0];
  const value = first === undefined ? undefined : Object.values(first)[0];
  if (typeof value !== "string") {
    throw new DataError("integrity_error", `PRAGMA ${pragma} returned an invalid value.`);
  }
  return value;
}

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

function validateMigrationSql(filename: string, sql: string): void {
  const inspected = stripCommentsAndStrings(sql);
  const forbidden = /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|VACUUM|ATTACH|DETACH)\b/i.exec(inspected);
  const forbiddenPragma = /\bPRAGMA\s+(application_id|journal_mode|user_version)\b/i.exec(
    inspected,
  );
  if (
    forbidden !== null ||
    forbiddenPragma !== null ||
    /\b__vistrea_schema_migrations\b/i.test(inspected)
  ) {
    throw new DataError("invalid_argument", "Migration SQL contains a forbidden statement.", {
      details: {
        filename,
        token:
          forbidden?.[1]?.toUpperCase() ??
          (forbiddenPragma === null
            ? "__vistrea_schema_migrations"
            : `PRAGMA ${forbiddenPragma[1] ?? "unknown"}`),
      },
    });
  }
}

function validateMigrationSequence(migrations: readonly SQLiteMigration[]): void {
  if (migrations.length === 0) {
    throw new DataError("integrity_error", "At least one SQLite migration is required.");
  }
  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1;
    const match = MIGRATION_FILENAME.exec(migration.filename);
    const bytes = Buffer.from(migration.bytes);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new DataError("integrity_error", "SQLite migration is not valid UTF-8.", {
        details: { filename: migration.filename, cause: String(error) },
      });
    }
    const calculatedHash = createHash("sha256").update(bytes).digest("hex");
    if (
      match === null ||
      Number(match[1]) !== expectedVersion ||
      migration.version !== expectedVersion ||
      bytes.includes(0x0d) ||
      (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
      decoded !== migration.sql ||
      calculatedHash !== migration.sha256
    ) {
      throw new DataError("integrity_error", "The supplied SQLite migration sequence is invalid.", {
        details: {
          filename: migration.filename,
          version: migration.version,
          expected_version: expectedVersion,
        },
      });
    }
    validateMigrationSql(migration.filename, migration.sql);
  });
}

export function discoverSQLiteMigrations(
  directory = DEFAULT_MIGRATIONS_DIRECTORY,
): readonly SQLiteMigration[] {
  let entries: readonly string[];
  try {
    entries = fs.readdirSync(directory, { encoding: "utf8" });
  } catch (error) {
    throw new DataError("integrity_error", "The SQLite migration directory is unavailable.", {
      details: { directory, cause: String(error) },
    });
  }

  const unexpectedSql = entries.filter(
    (entry) => entry.endsWith(".sql") && !MIGRATION_FILENAME.test(entry),
  );
  if (unexpectedSql.length > 0) {
    throw new DataError("integrity_error", "The migration directory contains invalid SQL filenames.", {
      details: { filenames: unexpectedSql.sort() },
    });
  }

  const filenames = entries.filter((entry) => MIGRATION_FILENAME.test(entry)).sort();
  if (filenames.length === 0) {
    throw new DataError("integrity_error", "At least one SQLite migration is required.", {
      details: { directory },
    });
  }

  const migrations = filenames.map((filename, index) => {
    const match = MIGRATION_FILENAME.exec(filename);
    const version = Number(match?.[1]);
    const expectedVersion = index + 1;
    if (version !== expectedVersion) {
      throw new DataError("integrity_error", "SQLite migration versions must be gap-free.", {
        details: { filename, version, expected_version: expectedVersion },
      });
    }

    const bytes = fs.readFileSync(path.join(directory, filename));
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new DataError("integrity_error", "SQLite migrations must not contain a UTF-8 BOM.", {
        details: { filename },
      });
    }
    if (bytes.includes(0x0d)) {
      throw new DataError("integrity_error", "SQLite migrations must use LF line endings.", {
        details: { filename },
      });
    }

    let sql: string;
    try {
      sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new DataError("integrity_error", "SQLite migration is not valid UTF-8.", {
        details: { filename, cause: String(error) },
      });
    }
    validateMigrationSql(filename, sql);
    return {
      version,
      filename,
      bytes,
      sql,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const manifestPath = path.join(directory, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    } catch (error) {
      throw new DataError("integrity_error", "The packaged migration manifest is invalid.", {
        details: { manifest_path: manifestPath, cause: String(error) },
      });
    }
    if (parsedManifest === null || typeof parsedManifest !== "object") {
      throw new DataError("integrity_error", "The packaged migration manifest is invalid.", {
        details: { manifest_path: manifestPath },
      });
    }
    const manifest = parsedManifest as Partial<PackagedMigrationManifest>;
    const manifestMigrations = manifest.migrations;
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifestMigrations) ||
      manifestMigrations.length !== migrations.length ||
      migrations.some((migration, index) => {
        const entry = manifestMigrations[index];
        return entry?.filename !== migration.filename || entry.sha256 !== migration.sha256;
      })
    ) {
      throw new DataError(
        "integrity_error",
        "Packaged SQLite migrations do not match their checksum manifest.",
        { details: { manifest_path: manifestPath } },
      );
    }
  }
  return migrations;
}

export function configureSQLiteConnection(db: Database.Database): void {
  const journalMode = sqliteString(db, "journal_mode = WAL").toLowerCase();
  if (journalMode !== "wal") {
    throw new DataError("unsupported", "SQLite did not enable WAL journal mode.", {
      details: { journal_mode: journalMode },
    });
  }
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  db.pragma("busy_timeout = 5000");
  db.pragma("wal_autocheckpoint = 1000");

  const observed = {
    synchronous: sqliteInteger(db, "synchronous"),
    foreign_keys: sqliteInteger(db, "foreign_keys"),
    trusted_schema: sqliteInteger(db, "trusted_schema"),
    busy_timeout: sqliteInteger(db, "busy_timeout"),
    wal_autocheckpoint: sqliteInteger(db, "wal_autocheckpoint"),
  };
  if (
    observed.synchronous !== 2 ||
    observed.foreign_keys !== 1 ||
    observed.trusted_schema !== 0 ||
    observed.busy_timeout !== 5000 ||
    observed.wal_autocheckpoint !== 1000
  ) {
    throw new DataError("unsupported", "SQLite did not retain the required connection policy.", {
      details: observed,
    });
  }

  const jsonProbe = db.prepare("SELECT json_valid('{}') AS available").get() as
    | { readonly available?: unknown }
    | undefined;
  if (jsonProbe?.available !== 1) {
    throw new DataError("unsupported", "The embedded SQLite library does not provide JSON support.");
  }
  const version = (
    db.prepare("SELECT sqlite_version() AS version").get() as
      | { readonly version?: unknown }
      | undefined
  )?.version;
  if (typeof version !== "string" || compareSQLiteVersions(version, "3.37.0") < 0) {
    throw new DataError("unsupported", "The embedded SQLite library does not support STRICT tables.", {
      details: { sqlite_version: typeof version === "string" ? version : "unknown" },
    });
  }
}

function compareSQLiteVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] =>
    value.split(".").map((part) => (/^[0-9]+$/.test(part) ? Number(part) : -1));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function userSchemaNames(db: Database.Database): readonly string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_schema " +
          "WHERE name NOT LIKE 'sqlite_%' ORDER BY name COLLATE BINARY",
      )
      .all() as readonly { readonly name: string }[]
  ).map((row) => row.name);
}

/** Rejects unrelated databases before any persistent connection PRAGMA is applied. */
export function assertSQLiteFileIdentity(db: Database.Database): void {
  const applicationId = sqliteInteger(db, "application_id");
  const names = userSchemaNames(db);
  const newEmptyDatabase = applicationId === 0 && names.length === 0;
  if (!newEmptyDatabase && applicationId !== VISTREA_APPLICATION_ID) {
    throw new DataError("integrity_error", "The SQLite file is not a Vistrea metadata database.", {
      details: { application_id: applicationId, user_schema_objects: names.length },
    });
  }
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const quickCheck = db.pragma("quick_check") as readonly Record<string, unknown>[];
  if (
    quickCheck.length !== 1 ||
    Object.values(quickCheck[0] ?? {})[0] !== "ok"
  ) {
    throw new DataError("integrity_error", "SQLite quick_check failed.", {
      details: { row_count: quickCheck.length, rows_json: JSON.stringify(quickCheck) },
    });
  }
}

function assertForeignKeyIntegrity(db: Database.Database): void {
  const failures = db.pragma("foreign_key_check") as readonly unknown[];
  if (failures.length > 0) {
    throw new DataError("integrity_error", "SQLite foreign_key_check failed.", {
      details: { failure_count: failures.length },
    });
  }
}

function assertExpectedSchema(db: Database.Database): void {
  const names = new Set(userSchemaNames(db));
  for (const table of [LEDGER_TABLE, ...REQUIRED_TABLES]) {
    if (!names.has(table)) {
      throw new DataError("integrity_error", "The SQLite schema is missing a required table.", {
        details: { table },
      });
    }
  }
}

function ledgerRows(db: Database.Database): readonly LedgerRow[] {
  return db
    .prepare(
      `SELECT version, filename, sha256 FROM ${LEDGER_TABLE} ORDER BY version`,
    )
    .all() as readonly LedgerRow[];
}

function verifyAppliedMigrations(
  db: Database.Database,
  migrations: readonly SQLiteMigration[],
  currentVersion: number,
): void {
  const rows = ledgerRows(db);
  if (rows.length !== currentVersion) {
    throw new DataError("integrity_error", "The migration ledger is not contiguous.", {
      details: { user_version: currentVersion, ledger_rows: rows.length },
    });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const bundled = migrations[index];
    const expectedVersion = index + 1;
    if (
      row === undefined ||
      bundled === undefined ||
      row.version !== expectedVersion ||
      row.filename !== bundled.filename ||
      row.sha256 !== bundled.sha256
    ) {
      throw new DataError("integrity_error", "The migration ledger does not match bundled history.", {
        details: {
          version: expectedVersion,
          ledger_filename: row?.filename ?? null,
          bundled_filename: bundled?.filename ?? null,
          ledger_sha256: row?.sha256 ?? null,
          bundled_sha256: bundled?.sha256 ?? null,
        },
      });
    }
  }
}

function createLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ${LEDGER_TABLE} (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      filename TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      applied_at TEXT NOT NULL,
      app_version TEXT NOT NULL,
      sqlite_version TEXT NOT NULL
    ) STRICT
  `);
}

export function applySQLiteMigrations(
  db: Database.Database,
  options: ApplySQLiteMigrationsOptions,
): AppliedMigrationResult {
  if (options.applicationVersion.trim().length === 0) {
    throw new DataError("invalid_argument", "A non-empty application version is required.");
  }
  const migrations =
    options.migrations ?? discoverSQLiteMigrations(options.migrationsDirectory);
  validateMigrationSequence(migrations);
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const targetVersion = options.targetVersion ?? latestVersion;
  if (
    !Number.isSafeInteger(targetVersion) ||
    targetVersion < 1 ||
    targetVersion > latestVersion
  ) {
    throw new DataError("invalid_argument", "The requested migration target is unavailable.", {
      details: { target_version: targetVersion, latest_version: latestVersion },
    });
  }

  assertDatabaseIntegrity(db);
  const names = userSchemaNames(db);
  const applicationId = sqliteInteger(db, "application_id");
  const currentVersion = sqliteInteger(db, "user_version");
  const genuinelyEmpty = names.length === 0 && applicationId === 0 && currentVersion === 0;

  if (!genuinelyEmpty && applicationId !== VISTREA_APPLICATION_ID) {
    throw new DataError("integrity_error", "The SQLite file is not a Vistrea metadata database.", {
      details: { application_id: applicationId, user_schema_objects: names.length },
    });
  }
  if (currentVersion > latestVersion) {
    throw new DataError("unsupported", "The Workspace schema is newer than this Vistrea binary.", {
      details: { current_version: currentVersion, latest_version: latestVersion },
    });
  }
  if (currentVersion > targetVersion) {
    throw new DataError("unsupported", "Automatic SQLite down migrations are not supported.", {
      details: { current_version: currentVersion, target_version: targetVersion },
    });
  }

  if (!genuinelyEmpty) {
    if (!names.includes(LEDGER_TABLE)) {
      throw new DataError("integrity_error", "The Vistrea migration ledger is missing.");
    }
    verifyAppliedMigrations(db, migrations, currentVersion);
    assertExpectedSchema(db);
    assertForeignKeyIntegrity(db);
  }

  if (currentVersion === targetVersion) {
    return { fromVersion: currentVersion, toVersion: targetVersion, appliedVersions: [] };
  }
  if (currentVersion > 0) {
    if (options.authorizeExistingUpgrade === undefined) {
      throw new DataError(
        "unsupported",
        "A verified and pinned SQLite backup is required before migration.",
        { details: { current_version: currentVersion, target_version: targetVersion } },
      );
    }
    const authorizationResult: unknown = options.authorizeExistingUpgrade({
      fromVersion: currentVersion,
      toVersion: targetVersion,
      databasePath: options.databasePath,
    });
    if (authorizationResult instanceof Promise) {
      throw new DataError(
        "invalid_argument",
        "SQLite upgrade authorization must complete synchronously before migration.",
      );
    }
  }

  const pending = migrations.filter(
    (migration) => migration.version > currentVersion && migration.version <= targetVersion,
  );
  const appliedVersions: number[] = [];
  try {
    db.exec("BEGIN IMMEDIATE");
    if (genuinelyEmpty) {
      db.pragma(`application_id = ${VISTREA_APPLICATION_ID}`);
      createLedger(db);
    }
    const sqliteVersion = (
      db.prepare("SELECT sqlite_version() AS version").get() as { readonly version: string }
    ).version;
    const insertLedger = db.prepare(
      `INSERT INTO ${LEDGER_TABLE} ` +
        "(version, filename, sha256, applied_at, app_version, sqlite_version) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const migration of pending) {
      db.exec(migration.sql);
      const appliedAt = options.clock.now();
      if (!isCanonicalUtcTimestamp(appliedAt)) {
        throw new DataError("invalid_argument", "Migration clock returned a non-canonical UTC timestamp.", {
          details: { applied_at: appliedAt },
        });
      }
      insertLedger.run(
        migration.version,
        migration.filename,
        migration.sha256,
        appliedAt,
        options.applicationVersion,
        sqliteVersion,
      );
      db.pragma(`user_version = ${migration.version}`);
      appliedVersions.push(migration.version);
    }
    assertForeignKeyIntegrity(db);
    assertExpectedSchema(db);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) {
      db.exec("ROLLBACK");
    }
    if (error instanceof DataError) {
      throw error;
    }
    const sqliteCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    throw new DataError(
      sqliteCode === "SQLITE_BUSY" ? "conflict" : "integrity_error",
      "The SQLite migration batch failed and was rolled back.",
      {
        retryable: sqliteCode === "SQLITE_BUSY",
        details: { sqlite_code: sqliteCode ?? "unknown", cause: String(error) },
      },
    );
  }

  assertDatabaseIntegrity(db);
  if (sqliteInteger(db, "application_id") !== VISTREA_APPLICATION_ID) {
    throw new DataError("integrity_error", "The Vistrea application ID was not persisted.");
  }
  if (sqliteInteger(db, "user_version") !== targetVersion) {
    throw new DataError("integrity_error", "The SQLite user_version was not persisted.");
  }
  verifyAppliedMigrations(db, migrations, targetVersion);
  assertExpectedSchema(db);
  return { fromVersion: currentVersion, toVersion: targetVersion, appliedVersions };
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    value,
  );
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((component) => Number(component));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
}
