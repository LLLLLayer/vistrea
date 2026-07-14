import { randomUUID } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { DataError } from "../../data/api/index.js";
import { HUB_ROLES, type HubRole } from "./audit-store.js";

const FORMAT_VERSION = 1;
const MAXIMUM_DIRECTORY_FILE_BYTES = 1024 * 1024;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const TEAM_BOOTSTRAP_PRINCIPALS = new Set([
  "hub-team-bootstrap-admin",
  "hub-team-bootstrap-viewer",
]);

export interface HubStoredTeamGrant {
  readonly principal_id: string;
  readonly role: HubRole;
}

export interface HubDirectoryTeam {
  readonly organization_id: string;
  readonly team_id: string;
  readonly grants: readonly HubStoredTeamGrant[];
}

export interface HubDirectoryStore {
  listTeamGrants(
    organizationId: string,
    teamId: string,
  ): readonly HubStoredTeamGrant[];
  replaceTeamGrants(
    organizationId: string,
    teamId: string,
    grants: readonly HubStoredTeamGrant[],
  ): Promise<void>;
  close?(): Promise<void>;
}

interface DirectoryDocument {
  readonly format_version: typeof FORMAT_VERSION;
  readonly teams: readonly HubDirectoryTeam[];
}

interface StoredTeam {
  readonly organizationId: string;
  readonly teamId: string;
  readonly grants: readonly HubStoredTeamGrant[];
}

/** Process-local organization/team membership state for embedded composition. */
export class MemoryHubDirectoryStore implements HubDirectoryStore {
  readonly #teams: Map<string, StoredTeam>;

  constructor(teams: readonly HubDirectoryTeam[]) {
    this.#teams = validatedTeams(teams);
  }

  listTeamGrants(
    organizationId: string,
    teamId: string,
  ): readonly HubStoredTeamGrant[] {
    return cloneGrants(requiredTeam(this.#teams, organizationId, teamId).grants);
  }

  async replaceTeamGrants(
    organizationId: string,
    teamId: string,
    grants: readonly HubStoredTeamGrant[],
  ): Promise<void> {
    const current = requiredTeam(this.#teams, organizationId, teamId);
    this.#teams.set(teamKey(organizationId, teamId), {
      ...current,
      grants: validateGrants(grants),
    });
  }
}

/**
 * Private, single-writer team directory. Team roles survive restart while
 * bearer tokens remain process-local and are reissued on every start.
 */
export class FileHubDirectoryStore implements HubDirectoryStore {
  readonly #filename: string;
  readonly #lockPath: string;
  readonly #teams: Map<string, StoredTeam>;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(filename: string, lockPath: string, teams: Map<string, StoredTeam>) {
    this.#filename = filename;
    this.#lockPath = lockPath;
    this.#teams = teams;
  }

  static async open(
    filename: string,
    initialTeams: readonly HubDirectoryTeam[],
  ): Promise<FileHubDirectoryStore> {
    if (!path.isAbsolute(filename)) {
      throw new DataError("invalid_argument", "The Hub directory file path must be absolute.");
    }
    const initial = validatedTeams(initialTeams);
    if (initial.size === 0) {
      throw new DataError("invalid_argument", "The Hub directory requires at least one team.");
    }
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const lockPath = `${filename}.lock`;
    let lockHandle: FileHandle;
    try {
      lockHandle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (filesystemCode(error) === "EEXIST") {
        throw new DataError("conflict", "Another Hub process owns the directory file.");
      }
      throw error;
    }
    try {
      try {
        await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
        await lockHandle.sync();
      } finally {
        await lockHandle.close();
      }

      const existing = await readDirectoryDocument(filename);
      const teams = existing === undefined ? initial : validatedTeams(existing.teams);
      assertSameTeamSet(initial, teams);
      if (existing === undefined) {
        await writeDirectoryDocument(filename, teams);
      }
      return new FileHubDirectoryStore(filename, lockPath, teams);
    } catch (error) {
      await fs.rm(lockPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  listTeamGrants(
    organizationId: string,
    teamId: string,
  ): readonly HubStoredTeamGrant[] {
    if (this.#closed) {
      throw new DataError("internal", "The Hub directory store is closed.");
    }
    return cloneGrants(requiredTeam(this.#teams, organizationId, teamId).grants);
  }

  replaceTeamGrants(
    organizationId: string,
    teamId: string,
    grants: readonly HubStoredTeamGrant[],
  ): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new DataError("internal", "The Hub directory store is closed."));
    }
    const validated = validateGrants(grants);
    const operation = this.#pending.then(async () => {
      const current = requiredTeam(this.#teams, organizationId, teamId);
      const next = new Map(this.#teams);
      next.set(teamKey(organizationId, teamId), { ...current, grants: validated });
      await writeDirectoryDocument(this.#filename, next);
      this.#teams.set(teamKey(organizationId, teamId), { ...current, grants: validated });
    });
    this.#pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#pending;
    await fs.rm(this.#lockPath, { force: true });
  }
}

async function readDirectoryDocument(filename: string): Promise<DirectoryDocument | undefined> {
  const stat = await fs.lstat(filename).catch((error: unknown) => {
    if (filesystemCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (stat === undefined) {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DataError("integrity_error", "The Hub directory file must be a regular file.");
  }
  if (stat.size > MAXIMUM_DIRECTORY_FILE_BYTES) {
    throw new DataError("resource_exhausted", "The Hub directory file exceeds its limit.");
  }
  const handle = await fs.open(
    filename,
    filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAXIMUM_DIRECTORY_FILE_BYTES) {
      throw new DataError("integrity_error", "The Hub directory file is invalid.");
    }
    await handle.chmod(0o600);
    const source = await handle.readFile("utf8");
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new DataError("integrity_error", "The Hub directory file is not valid JSON.");
    }
    return assertDirectoryDocument(value);
  } finally {
    await handle.close();
  }
}

async function writeDirectoryDocument(
  filename: string,
  teams: ReadonlyMap<string, StoredTeam>,
): Promise<void> {
  const document: DirectoryDocument = {
    format_version: FORMAT_VERSION,
    teams: [...teams.values()]
      .map((team) => ({
        organization_id: team.organizationId,
        team_id: team.teamId,
        grants: cloneGrants(team.grants),
      }))
      .sort((left, right) =>
        teamKey(left.organization_id, left.team_id).localeCompare(
          teamKey(right.organization_id, right.team_id),
        ),
      ),
  };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  if (bytes.byteLength > MAXIMUM_DIRECTORY_FILE_BYTES) {
    throw new DataError("resource_exhausted", "The Hub directory file exceeds its limit.");
  }
  const temporaryPath = `${filename}.tmp-${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      temporaryPath,
      filesystemConstants.O_CREAT |
        filesystemConstants.O_EXCL |
        filesystemConstants.O_WRONLY |
        filesystemConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function assertDirectoryDocument(value: unknown): DirectoryDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataError("integrity_error", "The Hub directory document is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).length !== 2 ||
    record["format_version"] !== FORMAT_VERSION ||
    !Array.isArray(record["teams"])
  ) {
    throw new DataError("integrity_error", "The Hub directory document is invalid.");
  }
  const teams = record["teams"].map((candidate: unknown) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new DataError("integrity_error", "A Hub directory team is invalid.");
    }
    const team = candidate as Readonly<Record<string, unknown>>;
    if (
      Object.keys(team).length !== 3 ||
      typeof team["organization_id"] !== "string" ||
      typeof team["team_id"] !== "string" ||
      !Array.isArray(team["grants"])
    ) {
      throw new DataError("integrity_error", "A Hub directory team is invalid.");
    }
    return {
      organization_id: team["organization_id"],
      team_id: team["team_id"],
      grants: team["grants"] as readonly HubStoredTeamGrant[],
    };
  });
  return { format_version: FORMAT_VERSION, teams };
}

function validatedTeams(teams: readonly HubDirectoryTeam[]): Map<string, StoredTeam> {
  const result = new Map<string, StoredTeam>();
  for (const team of teams) {
    const key = teamKey(team.organization_id, team.team_id);
    if (
      !SCOPE_ID_PATTERN.test(team.organization_id) ||
      !SCOPE_ID_PATTERN.test(team.team_id) ||
      result.has(key)
    ) {
      throw new DataError("integrity_error", "Hub directory teams must be unique and valid.");
    }
    result.set(key, {
      organizationId: team.organization_id,
      teamId: team.team_id,
      grants: validateGrants(team.grants),
    });
  }
  return result;
}

function validateGrants(
  grants: readonly HubStoredTeamGrant[],
): readonly HubStoredTeamGrant[] {
  const principals = new Set<string>();
  return grants.map((grant) => {
    if (
      grant === null ||
      typeof grant !== "object" ||
      Array.isArray(grant) ||
      Object.keys(grant).some((key) => key !== "principal_id" && key !== "role") ||
      Object.keys(grant).length !== 2 ||
      typeof grant.principal_id !== "string" ||
      !PRINCIPAL_ID_PATTERN.test(grant.principal_id) ||
      TEAM_BOOTSTRAP_PRINCIPALS.has(grant.principal_id) ||
      !HUB_ROLES.includes(grant.role) ||
      principals.has(grant.principal_id)
    ) {
      throw new DataError("integrity_error", "Hub directory grants are invalid.");
    }
    principals.add(grant.principal_id);
    return { principal_id: grant.principal_id, role: grant.role };
  });
}

function requiredTeam(
  teams: ReadonlyMap<string, StoredTeam>,
  organizationId: string,
  teamId: string,
): StoredTeam {
  const team = teams.get(teamKey(organizationId, teamId));
  if (team === undefined) {
    throw new DataError("not_found", "The Hub directory team does not exist.");
  }
  return team;
}

function assertSameTeamSet(
  configured: ReadonlyMap<string, StoredTeam>,
  persisted: ReadonlyMap<string, StoredTeam>,
): void {
  if (
    configured.size !== persisted.size ||
    [...configured.keys()].some((key) => !persisted.has(key))
  ) {
    throw new DataError(
      "conflict",
      "Configured Hub teams do not match the persisted directory file.",
    );
  }
}

function cloneGrants(
  grants: readonly HubStoredTeamGrant[],
): readonly HubStoredTeamGrant[] {
  return grants.map((grant) => ({ principal_id: grant.principal_id, role: grant.role }));
}

function teamKey(organizationId: string, teamId: string): string {
  return `${organizationId}\u0000${teamId}`;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, filesystemConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
