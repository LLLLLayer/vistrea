import { randomUUID } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { DataError, type JsonObject } from "../../data/api/index.js";

const MAXIMUM_AUDIT_LOG_BYTES = 256 * 1024 * 1024;
const EVENT_ID_PATTERN =
  /^hub_audit_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const AUDIT_EVENT_KEYS = new Set([
  "event_id",
  "sequence",
  "occurred_at",
  "project_id",
  "principal_id",
  "role",
  "action",
  "outcome",
  "resource",
  "details",
]);

export const HUB_ROLES = [
  "viewer",
  "contributor",
  "reviewer",
  "maintainer",
  "admin",
] as const;
export type HubRole = (typeof HUB_ROLES)[number];

export const HUB_AUDIT_ACTIONS = [
  "access_denied",
  "permissions_listed",
  "audit_listed",
  "refs_listed",
  "ref_resolved",
  "ref_updated",
  "pack_imported",
  "pack_exported",
] as const;
export type HubAuditAction = (typeof HUB_AUDIT_ACTIONS)[number];

export const HUB_AUDIT_OUTCOMES = ["attempted", "succeeded", "failed", "denied"] as const;
export type HubAuditOutcome = (typeof HUB_AUDIT_OUTCOMES)[number];

export interface HubAuditEvent extends JsonObject {
  readonly event_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly project_id: string;
  readonly principal_id: string;
  readonly role?: HubRole;
  readonly action: HubAuditAction;
  readonly outcome: HubAuditOutcome;
  readonly resource: string;
  readonly details: JsonObject;
}

export interface RecordHubAuditEvent {
  readonly project_id: string;
  readonly principal_id: string;
  readonly role?: HubRole;
  readonly action: HubAuditAction;
  readonly outcome: HubAuditOutcome;
  readonly resource: string;
  readonly details?: JsonObject;
}

export interface ListHubAuditEvents {
  readonly project_id: string;
  readonly after_sequence?: number;
  readonly limit?: number;
  readonly actions?: readonly HubAuditAction[];
  readonly outcomes?: readonly HubAuditOutcome[];
}

export interface HubAuditPage extends JsonObject {
  readonly items: readonly HubAuditEvent[];
  readonly next_cursor: string;
}

export interface HubAuditStore {
  record(event: RecordHubAuditEvent): Promise<void>;
  list(options: ListHubAuditEvents): Promise<HubAuditPage>;
  close?(): Promise<void>;
}

export class MemoryHubAuditStore implements HubAuditStore {
  readonly #events: HubAuditEvent[] = [];
  readonly #now: () => Date;
  #nextSequence = 1;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async record(input: RecordHubAuditEvent): Promise<void> {
    const event = makeEvent(input, this.#nextSequence, this.#now);
    this.#nextSequence += 1;
    this.#events.push(event);
  }

  async list(options: ListHubAuditEvents): Promise<HubAuditPage> {
    return pageEvents(this.#events, options);
  }
}

/**
 * Append-only operational Hub audit storage. It is intentionally separate
 * from versioned Workspace content: audit records describe access to that
 * content and must not become Commit roots that users can rewrite.
 */
export class FileHubAuditStore implements HubAuditStore {
  readonly #handle: FileHandle;
  readonly #lockPath: string;
  readonly #events: HubAuditEvent[];
  readonly #now: () => Date;
  #nextSequence: number;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    handle: FileHandle,
    lockPath: string,
    events: HubAuditEvent[],
    nextSequence: number,
    now: () => Date,
  ) {
    this.#handle = handle;
    this.#lockPath = lockPath;
    this.#events = events;
    this.#nextSequence = nextSequence;
    this.#now = now;
  }

  static async open(
    filename: string,
    options: { readonly now?: () => Date } = {},
  ): Promise<FileHubAuditStore> {
    if (!path.isAbsolute(filename)) {
      throw new DataError("invalid_argument", "The Hub audit log path must be absolute.");
    }
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const lockPath = `${filename}.lock`;
    let lockHandle: FileHandle;
    try {
      lockHandle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (filesystemCode(error) === "EEXIST") {
        throw new DataError("conflict", "Another Hub process owns the audit log.");
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
      return await FileHubAuditStore.#openOwned(filename, lockPath, options);
    } catch (error) {
      await fs.rm(lockPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  static async #openOwned(
    filename: string,
    lockPath: string,
    options: { readonly now?: () => Date },
  ): Promise<FileHubAuditStore> {
    const existing = await fs.lstat(filename).catch((error: unknown) => {
      if (filesystemCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (existing?.isSymbolicLink() === true || (existing !== undefined && !existing.isFile())) {
      throw new DataError("integrity_error", "The Hub audit log must be a regular file.");
    }
    if (existing !== undefined && existing.size > MAXIMUM_AUDIT_LOG_BYTES) {
      throw new DataError("resource_exhausted", "The Hub audit log requires rotation.");
    }

    const handle = await fs.open(
      filename,
      filesystemConstants.O_APPEND |
        filesystemConstants.O_CREAT |
        filesystemConstants.O_RDWR |
        filesystemConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new DataError("integrity_error", "The Hub audit log must be a regular file.");
      }
      await handle.chmod(0o600);
      const source = await handle.readFile("utf8");
      const events = parseAuditLog(source);
      const nextSequence = (events.at(-1)?.sequence ?? 0) + 1;
      return new FileHubAuditStore(
        handle,
        lockPath,
        events,
        nextSequence,
        options.now ?? (() => new Date()),
      );
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  record(input: RecordHubAuditEvent): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new DataError("internal", "The Hub audit store is closed."));
    }
    const operation = this.#pending.then(async () => {
      const event = makeEvent(input, this.#nextSequence, this.#now);
      const line = `${JSON.stringify(event)}\n`;
      const stat = await this.#handle.stat();
      if (stat.size + Buffer.byteLength(line) > MAXIMUM_AUDIT_LOG_BYTES) {
        throw new DataError("resource_exhausted", "The Hub audit log requires rotation.");
      }
      await this.#handle.appendFile(line, "utf8");
      await this.#handle.sync();
      this.#nextSequence += 1;
      this.#events.push(event);
    });
    this.#pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async list(options: ListHubAuditEvents): Promise<HubAuditPage> {
    await this.#pending;
    return pageEvents(this.#events, options);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#pending;
    await this.#handle.close();
    await fs.rm(this.#lockPath, { force: true });
  }
}

function makeEvent(
  input: RecordHubAuditEvent,
  sequence: number,
  now: () => Date,
): HubAuditEvent {
  const occurredAt = now().toISOString();
  const candidate: HubAuditEvent = {
    event_id: `hub_audit_${randomUUID()}`,
    sequence,
    occurred_at: occurredAt,
    project_id: input.project_id,
    principal_id: input.principal_id,
    ...(input.role === undefined ? {} : { role: input.role }),
    action: input.action,
    outcome: input.outcome,
    resource: input.resource,
    details: structuredClone(input.details ?? {}),
  };
  assertAuditEvent(candidate);
  return candidate;
}

function parseAuditLog(source: string): HubAuditEvent[] {
  if (source.length > 0 && !source.endsWith("\n")) {
    throw new DataError("integrity_error", "The Hub audit log has an incomplete final record.");
  }
  const events: HubAuditEvent[] = [];
  let previousSequence = 0;
  for (const line of source.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new DataError("integrity_error", "The Hub audit log contains invalid JSON.");
    }
    assertAuditEvent(value);
    if (value.sequence <= previousSequence) {
      throw new DataError("integrity_error", "Hub audit sequences must increase strictly.");
    }
    previousSequence = value.sequence;
    events.push(value);
  }
  return events;
}

function assertAuditEvent(value: unknown): asserts value is HubAuditEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataError("integrity_error", "A Hub audit event is invalid.");
  }
  const event = value as Readonly<Record<string, unknown>>;
  const details = event["details"];
  if (
    Object.keys(event).some((key) => !AUDIT_EVENT_KEYS.has(key)) ||
    typeof event["event_id"] !== "string" ||
    !EVENT_ID_PATTERN.test(event["event_id"]) ||
    !Number.isSafeInteger(event["sequence"]) ||
    (event["sequence"] as number) < 1 ||
    typeof event["occurred_at"] !== "string" ||
    !isCanonicalTimestamp(event["occurred_at"]) ||
    typeof event["project_id"] !== "string" ||
    !PROJECT_ID_PATTERN.test(event["project_id"]) ||
    typeof event["principal_id"] !== "string" ||
    !PRINCIPAL_ID_PATTERN.test(event["principal_id"]) ||
    (event["role"] !== undefined && !HUB_ROLES.includes(event["role"] as HubRole)) ||
    !HUB_AUDIT_ACTIONS.includes(event["action"] as HubAuditAction) ||
    !HUB_AUDIT_OUTCOMES.includes(event["outcome"] as HubAuditOutcome) ||
    typeof event["resource"] !== "string" ||
    !RESOURCE_PATTERN.test(event["resource"]) ||
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    throw new DataError("integrity_error", "A Hub audit event is invalid.");
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function pageEvents(
  events: readonly HubAuditEvent[],
  options: ListHubAuditEvents,
): HubAuditPage {
  const after = options.after_sequence ?? 0;
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    throw new DataError("invalid_argument", "Hub audit pagination is invalid.");
  }
  const actionSet = options.actions === undefined ? undefined : new Set(options.actions);
  const outcomeSet = options.outcomes === undefined ? undefined : new Set(options.outcomes);
  // Persisted sequences order the shared append-only file globally. API
  // pages replace them with project-local ordinals so one tenant cannot infer
  // another tenant's traffic from cursor gaps.
  const projectEvents = events
    .filter((event) => event.project_id === options.project_id)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
  const matching = projectEvents.filter(
    (event) =>
      event.sequence > after &&
      (actionSet === undefined || actionSet.has(event.action)) &&
      (outcomeSet === undefined || outcomeSet.has(event.outcome)),
  );
  const items = matching.slice(0, limit);
  return {
    items,
    next_cursor: String(items.at(-1)?.sequence ?? after),
  };
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
