import { randomUUID } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { DataError } from "../../data/api/index.js";
import { HUB_ROLES, type HubRole } from "./audit-store.js";

const FORMAT_VERSION = 1;
const MAXIMUM_PERMISSION_FILE_BYTES = 1024 * 1024;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const BOOTSTRAP_PRINCIPALS = new Set(["hub-bootstrap-admin", "hub-bootstrap-viewer"]);

export interface HubStoredAccessGrant {
  readonly principal_id: string;
  readonly role: HubRole;
}

export interface HubPermissionProject {
  readonly project_id: string;
  readonly grants: readonly HubStoredAccessGrant[];
}

export interface HubPermissionStore {
  listProjectGrants(projectId: string): readonly HubStoredAccessGrant[];
  replaceProjectGrants(
    projectId: string,
    grants: readonly HubStoredAccessGrant[],
  ): Promise<void>;
  close?(): Promise<void>;
}

interface PermissionDocument {
  readonly format_version: typeof FORMAT_VERSION;
  readonly projects: readonly HubPermissionProject[];
}

/** In-memory permission state for embedded Hub composition and tests. */
export class MemoryHubPermissionStore implements HubPermissionStore {
  readonly #projects: Map<string, readonly HubStoredAccessGrant[]>;

  constructor(projects: readonly HubPermissionProject[]) {
    this.#projects = validatedProjects(projects);
  }

  listProjectGrants(projectId: string): readonly HubStoredAccessGrant[] {
    return cloneGrants(requiredProject(this.#projects, projectId));
  }

  async replaceProjectGrants(
    projectId: string,
    grants: readonly HubStoredAccessGrant[],
  ): Promise<void> {
    requiredProject(this.#projects, projectId);
    this.#projects.set(projectId, validateGrants(grants));
  }
}

/**
 * Private, single-writer Hub permission state. Roles survive a restart while
 * bearer tokens never enter this file and are reissued on every process start.
 */
export class FileHubPermissionStore implements HubPermissionStore {
  readonly #filename: string;
  readonly #lockPath: string;
  readonly #projects: Map<string, readonly HubStoredAccessGrant[]>;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    filename: string,
    lockPath: string,
    projects: Map<string, readonly HubStoredAccessGrant[]>,
  ) {
    this.#filename = filename;
    this.#lockPath = lockPath;
    this.#projects = projects;
  }

  static async open(
    filename: string,
    initialProjects: readonly HubPermissionProject[],
  ): Promise<FileHubPermissionStore> {
    if (!path.isAbsolute(filename)) {
      throw new DataError("invalid_argument", "The Hub permission file path must be absolute.");
    }
    const initial = validatedProjects(initialProjects);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const lockPath = `${filename}.lock`;
    let lockHandle: FileHandle;
    try {
      lockHandle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (filesystemCode(error) === "EEXIST") {
        throw new DataError("conflict", "Another Hub process owns the permission file.");
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

      const existing = await readPermissionDocument(filename);
      const projects = existing === undefined ? initial : validatedProjects(existing.projects);
      assertSameProjectSet(initial, projects);
      if (existing === undefined) {
        await writePermissionDocument(filename, projects);
      }
      return new FileHubPermissionStore(filename, lockPath, projects);
    } catch (error) {
      await fs.rm(lockPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  listProjectGrants(projectId: string): readonly HubStoredAccessGrant[] {
    if (this.#closed) {
      throw new DataError("internal", "The Hub permission store is closed.");
    }
    return cloneGrants(requiredProject(this.#projects, projectId));
  }

  replaceProjectGrants(
    projectId: string,
    grants: readonly HubStoredAccessGrant[],
  ): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new DataError("internal", "The Hub permission store is closed."));
    }
    const validated = validateGrants(grants);
    const operation = this.#pending.then(async () => {
      requiredProject(this.#projects, projectId);
      const next = new Map(this.#projects);
      next.set(projectId, validated);
      await writePermissionDocument(this.#filename, next);
      this.#projects.set(projectId, validated);
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

async function readPermissionDocument(filename: string): Promise<PermissionDocument | undefined> {
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
    throw new DataError("integrity_error", "The Hub permission file must be a regular file.");
  }
  if (stat.size > MAXIMUM_PERMISSION_FILE_BYTES) {
    throw new DataError("resource_exhausted", "The Hub permission file exceeds its limit.");
  }
  const handle = await fs.open(
    filename,
    filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAXIMUM_PERMISSION_FILE_BYTES) {
      throw new DataError("integrity_error", "The Hub permission file is invalid.");
    }
    await handle.chmod(0o600);
    const source = await handle.readFile("utf8");
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new DataError("integrity_error", "The Hub permission file is not valid JSON.");
    }
    return assertPermissionDocument(value);
  } finally {
    await handle.close();
  }
}

async function writePermissionDocument(
  filename: string,
  projects: ReadonlyMap<string, readonly HubStoredAccessGrant[]>,
): Promise<void> {
  const document: PermissionDocument = {
    format_version: FORMAT_VERSION,
    projects: [...projects]
      .map(([project_id, grants]) => ({ project_id, grants: cloneGrants(grants) }))
      .sort((left, right) => left.project_id.localeCompare(right.project_id)),
  };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  if (bytes.byteLength > MAXIMUM_PERMISSION_FILE_BYTES) {
    throw new DataError("resource_exhausted", "The Hub permission file exceeds its limit.");
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

function assertPermissionDocument(value: unknown): PermissionDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataError("integrity_error", "The Hub permission document is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).length !== 2 ||
    record["format_version"] !== FORMAT_VERSION ||
    !Array.isArray(record["projects"])
  ) {
    throw new DataError("integrity_error", "The Hub permission document is invalid.");
  }
  const projects = record["projects"].map((candidate: unknown) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new DataError("integrity_error", "A Hub permission project is invalid.");
    }
    const project = candidate as Readonly<Record<string, unknown>>;
    if (
      Object.keys(project).length !== 2 ||
      typeof project["project_id"] !== "string" ||
      !Array.isArray(project["grants"])
    ) {
      throw new DataError("integrity_error", "A Hub permission project is invalid.");
    }
    return {
      project_id: project["project_id"],
      grants: project["grants"] as readonly HubStoredAccessGrant[],
    };
  });
  return { format_version: FORMAT_VERSION, projects };
}

function validatedProjects(
  projects: readonly HubPermissionProject[],
): Map<string, readonly HubStoredAccessGrant[]> {
  const result = new Map<string, readonly HubStoredAccessGrant[]>();
  for (const project of projects) {
    if (!PROJECT_ID_PATTERN.test(project.project_id) || result.has(project.project_id)) {
      throw new DataError("integrity_error", "Hub permission projects must be unique and valid.");
    }
    result.set(project.project_id, validateGrants(project.grants));
  }
  if (result.size === 0) {
    throw new DataError("invalid_argument", "Hub permission state requires at least one project.");
  }
  return result;
}

function validateGrants(
  grants: readonly HubStoredAccessGrant[],
): readonly HubStoredAccessGrant[] {
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
      BOOTSTRAP_PRINCIPALS.has(grant.principal_id) ||
      !HUB_ROLES.includes(grant.role) ||
      principals.has(grant.principal_id)
    ) {
      throw new DataError("integrity_error", "Hub permission grants are invalid.");
    }
    principals.add(grant.principal_id);
    return { principal_id: grant.principal_id, role: grant.role };
  });
}

function requiredProject(
  projects: ReadonlyMap<string, readonly HubStoredAccessGrant[]>,
  projectId: string,
): readonly HubStoredAccessGrant[] {
  const grants = projects.get(projectId);
  if (grants === undefined) {
    throw new DataError("not_found", "The Hub permission project does not exist.");
  }
  return grants;
}

function assertSameProjectSet(
  configured: ReadonlyMap<string, readonly HubStoredAccessGrant[]>,
  persisted: ReadonlyMap<string, readonly HubStoredAccessGrant[]>,
): void {
  if (
    configured.size !== persisted.size ||
    [...configured.keys()].some((projectId) => !persisted.has(projectId))
  ) {
    throw new DataError(
      "conflict",
      "Configured Hub projects do not match the persisted permission file.",
    );
  }
}

function cloneGrants(
  grants: readonly HubStoredAccessGrant[],
): readonly HubStoredAccessGrant[] {
  return grants.map((grant) => ({ principal_id: grant.principal_id, role: grant.role }));
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
