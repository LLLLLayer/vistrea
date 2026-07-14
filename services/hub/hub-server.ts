import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import https from "node:https";

import {
  DataError,
  isDataError,
  type JsonObject,
  type ObjectStore,
  type ProtocolValidator,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { PACK_LOGICAL_NAME, PACK_MEDIA_TYPE, PackExchangeService } from "../../data/exchange/index.js";
import {
  HUB_AUDIT_ACTIONS,
  HUB_ROLES,
  MemoryHubAuditStore,
  type HubAuditAction,
  type HubAuditEvent,
  type HubAuditStore,
  type RecordHubAuditEvent,
  type HubRole,
} from "./audit-store.js";

const TOKEN_BYTES = 32;
const MAXIMUM_JSON_BODY_BYTES = 64 * 1024;
const MAXIMUM_PACK_BYTES = 256 * 1024 * 1024;
export const HUB_SERVER_LIMITS = {
  projects: 128,
  principalsPerProject: 256,
} as const;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HubBindAddress = string;

export interface HubAccessGrant {
  readonly principal_id: string;
  readonly role: HubRole;
}

export interface HubProject {
  readonly project_id: string;
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
  /** Additional startup-managed principals. Bootstrap admin/viewer always exist. */
  readonly access?: readonly HubAccessGrant[];
}

export interface HubTlsConfig {
  /** PEM certificate chain path; read once at startup. */
  readonly certificatePath: string;
  /** PEM private key path; read once at startup and never logged. */
  readonly privateKeyPath: string;
}

export interface StartHubServerOptions {
  /**
   * Plain HTTP binds loopback-only because the bearer token would otherwise
   * travel unencrypted; TLS unlocks non-loopback interfaces for cross-team
   * collaboration.
   */
  readonly host: HubBindAddress;
  readonly port?: number;
  /** Every served namespace; unknown projects are indistinguishable from invalid credentials. */
  readonly projects: readonly HubProject[];
  readonly validator: ProtocolValidator;
  readonly tls?: HubTlsConfig;
  /** Defaults to an in-memory store; standalone Hub composition supplies a durable store. */
  readonly audit?: HubAuditStore;
}

export interface HubIssuedAccessGrant extends HubAccessGrant {
  /** Rotates with this Hub process and is returned only through protected composition. */
  readonly bearerToken: string;
}

export interface HubProjectTokens {
  readonly project_id: string;
  /** Backward-compatible bootstrap admin token for this project only. */
  readonly bearerToken: string;
  /** Backward-compatible bootstrap viewer token for this project only. */
  readonly readOnlyToken: string;
  /** Every issued project principal, including the two bootstrap grants. */
  readonly accessGrants: readonly HubIssuedAccessGrant[];
}

export interface HubServerHandle {
  readonly host: HubBindAddress;
  readonly port: number;
  readonly baseUrl: string;
  /** Project-scoped bootstrap and named-principal grants; never persisted by the server. */
  readonly projects: readonly HubProjectTokens[];
  close(): Promise<void>;
}

interface HubPrincipalRuntime {
  readonly principalId: string;
  readonly role: HubRole;
  readonly bearerDigest: Buffer;
}

interface HubProjectRuntime {
  readonly project: HubProject;
  readonly exchange: PackExchangeService;
  readonly principals: readonly HubPrincipalRuntime[];
}

interface PublicError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

class HubRequestError extends Error implements PublicError {
  readonly status: number;
  readonly code: string;

  constructor(error: PublicError) {
    super(error.message);
    this.name = "HubRequestError";
    this.status = error.status;
    this.code = error.code;
  }
}

/**
 * Optional cross-team pack relay with project-scoped RBAC, durable-audit port,
 * and a safe collaboration activity projection. Local Workspaces stay fully
 * usable without it.
 */
export async function startHubServer(options: StartHubServerOptions): Promise<HubServerHandle> {
  if (options.projects.length === 0 || options.projects.length > HUB_SERVER_LIMITS.projects) {
    throw new DataError(
      "invalid_argument",
      `The Hub serves between 1 and ${HUB_SERVER_LIMITS.projects} projects per process.`,
    );
  }
  const projects = new Map<string, HubProjectRuntime>();
  const projectTokens: HubProjectTokens[] = [];
  for (const project of options.projects) {
    if (!PROJECT_ID_PATTERN.test(project.project_id)) {
      throw new DataError("invalid_argument", "A Hub project identifier is invalid.");
    }
    if (projects.has(project.project_id)) {
      throw new DataError("invalid_argument", "Hub project identifiers must be unique.");
    }
    const issued = issueProjectAccess(project);
    projects.set(project.project_id, {
      project,
      exchange: new PackExchangeService({
        data: project.workspace,
        objects: project.objects,
        validator: options.validator,
      }),
      principals: issued.accessGrants.map((grant) => ({
        principalId: grant.principal_id,
        role: grant.role,
        bearerDigest: digestToken(grant.bearerToken),
      })),
    });
    projectTokens.push({
      project_id: project.project_id,
      bearerToken: issued.bootstrapAdminToken,
      readOnlyToken: issued.bootstrapViewerToken,
      accessGrants: issued.accessGrants,
    });
  }
  // A plain-HTTP bearer token must never leave the machine; TLS unlocks
  // other interfaces because the token then travels encrypted.
  const loopback = options.host === "127.0.0.1" || options.host === "::1";
  if (options.tls === undefined && !loopback) {
    throw new DataError(
      "invalid_argument",
      "The Hub binds loopback interfaces only without TLS.",
    );
  }
  if (!/^[A-Za-z0-9.:\-]{1,255}$/.test(options.host)) {
    throw new DataError("invalid_argument", "The Hub bind address is invalid.");
  }
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
  ) {
    throw new DataError("invalid_argument", "The Hub port must be an integer from 0 through 65535.");
  }
  const audit = options.audit ?? new MemoryHubAuditStore();

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void handleRequest(request, response, projects, audit).catch((error: unknown) =>
      sendError(response, error),
    );
  };
  const server: Server =
    options.tls === undefined
      ? http.createServer({ maxHeaderSize: 16 * 1024 }, handler)
      : https.createServer(
          {
            maxHeaderSize: 16 * 1024,
            cert: readFileSync(options.tls.certificatePath),
            key: readFileSync(options.tls.privateKeyPath),
            minVersion: "TLSv1.3",
            maxVersion: "TLSv1.3",
          },
          handler,
        );
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  server.listen(options.port ?? 0, options.host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new DataError("internal", "The Hub did not expose a TCP endpoint.");
  }

  let closed = false;
  const scheme = options.tls === undefined ? "http" : "https";
  return {
    host: options.host,
    port: address.port,
    baseUrl: `${scheme}://${options.host === "::1" ? `[${options.host}]` : options.host}:${address.port}`,
    projects: projectTokens,
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        try {
          await closeServer(server);
        } finally {
          for (const runtime of projects.values()) {
            for (const principal of runtime.principals) {
              principal.bearerDigest.fill(0);
            }
          }
        }
      }
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projects: ReadonlyMap<string, HubProjectRuntime>,
  audit: HubAuditStore,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  const projectMatch = /^\/v1\/projects\/([^/]+)\/(.+)$/.exec(pathname);
  if (projectMatch === null) {
    throw new HubRequestError({
      status: 404,
      code: "not_found",
      message: "The requested Hub route does not exist.",
    });
  }
  const projectId = decodePathComponent(projectMatch[1] as string);
  const runtime = projects.get(projectId);
  // The token is checked against THIS project, so a token for another
  // namespace is indistinguishable from no token at all.
  const principal = runtime === undefined ? undefined : authorize(request, runtime.principals);
  if (runtime === undefined || principal === undefined) {
    throw new HubRequestError({
      status: 401,
      code: "unauthenticated",
      message: "A valid Hub bearer token for this project is required.",
    });
  }
  const exchange = runtime.exchange;
  const workspace = runtime.project.workspace;
  const objects = runtime.project.objects;
  const resource = projectMatch[2] as string;

  if (resource === "me" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    writeJson(response, 200, {
      principal_id: principal.principalId,
      role: principal.role,
      capabilities: capabilitiesForRole(principal.role),
    });
    return;
  }

  if (resource === "permissions" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "admin", resource);
    const items = runtime.principals
      .map((candidate) => ({
        principal_id: candidate.principalId,
        role: candidate.role,
        capabilities: capabilitiesForRole(candidate.role),
      }))
      .sort((left, right) => left.principal_id.localeCompare(right.principal_id));
    await audit.record({
      project_id: projectId,
      principal_id: principal.principalId,
      role: principal.role,
      action: "permissions_listed",
      outcome: "succeeded",
      resource,
    });
    writeJson(response, 200, { items });
    return;
  }

  if (resource === "audit-events" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "admin", resource);
    const pagination = parseEventPagination(url);
    const page = await audit.list({
      project_id: projectId,
      after_sequence: pagination.afterSequence,
      limit: pagination.limit,
    });
    await audit.record({
      project_id: projectId,
      principal_id: principal.principalId,
      role: principal.role,
      action: "audit_listed",
      outcome: "succeeded",
      resource,
      details: { after_sequence: pagination.afterSequence, limit: pagination.limit },
    });
    writeJson(response, 200, page);
    return;
  }

  if (resource === "events" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const pagination = parseEventPagination(url);
    const page = await audit.list({
      project_id: projectId,
      after_sequence: pagination.afterSequence,
      limit: pagination.limit,
      actions: [...HUB_AUDIT_ACTIONS].filter(isCollaborationAction),
      outcomes: ["succeeded"],
    });
    writeJson(response, 200, {
      items: page.items.map(collaborationEvent),
      next_cursor: page.next_cursor,
    });
    return;
  }

  if (resource === "refs" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const page = await auditedOperation(
      audit,
      auditContext(projectId, principal, "refs_listed", resource),
      false,
      async () => {
        const unit = workspace.beginUnitOfWork("read");
        try {
          return unit.versions.listRefs();
        } finally {
          unit.rollback();
        }
      },
    );
    writeJson(response, 200, { items: page.items } as unknown as JsonObject);
    return;
  }

  if (resource === "refs:resolve" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const body = await readJsonBody(request);
    const name = body["name"];
    if (typeof name !== "string" || name.length === 0 || name.length > 255) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "refs:resolve requires a bounded ref name.",
      });
    }
    const ref = await auditedOperation(
      audit,
      auditContext(projectId, principal, "ref_resolved", resource, { ref_name: name }),
      false,
      async () => {
        const unit = workspace.beginUnitOfWork("read");
        try {
          return unit.versions.resolveRef(name);
        } finally {
          unit.rollback();
        }
      },
    );
    writeJson(response, 200, ref as unknown as JsonObject);
    return;
  }

  if (resource === "refs:update" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "maintainer", resource);
    const body = await readJsonBody(request);
    const name = body["name"];
    const commitId = body["commit_id"];
    const precondition = body["precondition"];
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 255 ||
      typeof commitId !== "string" ||
      precondition === null ||
      typeof precondition !== "object" ||
      Array.isArray(precondition)
    ) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "refs:update requires name, commit_id, and an explicit precondition.",
      });
    }
    const ref = await auditedOperation(
      audit,
      auditContext(projectId, principal, "ref_updated", resource, { ref_name: name }),
      true,
      async () => {
        const unit = workspace.beginUnitOfWork("write");
        try {
          const updated = unit.versions.updateRef(name, commitId, precondition as never);
          unit.commit();
          return updated;
        } catch (error) {
          try {
            unit.rollback();
          } catch {
            // The original failure is the meaningful error.
          }
          throw error;
        }
      },
    );
    writeJson(response, 200, ref as unknown as JsonObject);
    return;
  }

  if (resource === "packs:import" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "maintainer", resource);
    if (request.headers["content-type"] !== PACK_MEDIA_TYPE) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: `Pack imports require the ${PACK_MEDIA_TYPE} media type.`,
      });
    }
    const result = await auditedOperation(
      audit,
      auditContext(projectId, principal, "pack_imported", resource),
      true,
      async () => {
        const stream = (async function* () {
          let received = 0;
          for await (const chunk of request) {
            const bytes = chunk as Buffer;
            received += bytes.byteLength;
            if (received > MAXIMUM_PACK_BYTES) {
              throw new DataError("resource_exhausted", "The pack exceeds the Hub upload limit.");
            }
            yield bytes;
          }
        })();
        // Metadata must match exportPack's exactly: the same deterministic
        // bytes re-exported later would otherwise conflict on immutable metadata.
        const pack = await objects.put(stream, {
          media_type: PACK_MEDIA_TYPE,
          compression: "none",
          logical_name: PACK_LOGICAL_NAME,
        });
        if (pack.byte_size === 0) {
          throw new HubRequestError({
            status: 400,
            code: "invalid_argument",
            message: "An empty pack upload is not a valid container.",
          });
        }
        workspace.registerVerifiedObjects([pack]);
        return await exchange.importPack({ pack });
      },
    );
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (resource === "packs:export" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const body = await readJsonBody(request);
    assertExportCommand(body);
    // Streamed, never persisted: one stored object per export would let any
    // caller grow the Hub's disk without bound.
    const context = auditContext(projectId, principal, "pack_exported", resource);
    try {
      const bytes = await exchange.exportPackBytes(
        body as unknown as Parameters<PackExchangeService["exportPackBytes"]>[0],
      );
      response.writeHead(200, { "content-type": PACK_MEDIA_TYPE });
      for await (const chunk of bytes) {
        if (!response.write(chunk)) {
          const settled = new AbortController();
          try {
            await Promise.race([
              once(response, "drain", { signal: settled.signal }).catch(() => {}),
              once(response, "close", { signal: settled.signal }).catch(() => {}),
            ]);
          } finally {
            settled.abort();
          }
        }
        if (response.destroyed) {
          throw new HubRequestError({
            status: 499,
            code: "connection_closed",
            message: "The Hub pack export connection closed before completion.",
          });
        }
      }
      await audit.record({ ...context, outcome: "succeeded" });
      response.end();
    } catch (error) {
      await audit.record({
        ...context,
        outcome: "failed",
        details: { ...(context.details ?? {}), error_code: publicErrorCode(error) },
      });
      throw error;
    }
    return;
  }

  throw new HubRequestError({
    status: 404,
    code: "not_found",
    message: "The requested Hub route does not exist.",
  });
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "The Hub path contains invalid percent encoding.",
    });
  }
}

function authorize(
  request: IncomingMessage,
  principals: readonly HubPrincipalRuntime[],
): HubPrincipalRuntime | undefined {
  const header = request.headers.authorization;
  const match =
    typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{1,1024})$/i.exec(header) : null;
  const candidate = digestToken(match?.[1] ?? "");
  let authorized: HubPrincipalRuntime | undefined;
  for (const principal of principals) {
    if (match !== null && timingSafeEqual(candidate, principal.bearerDigest)) {
      authorized = principal;
    }
  }
  candidate.fill(0);
  return authorized;
}

function issueProjectAccess(project: HubProject): {
  readonly bootstrapAdminToken: string;
  readonly bootstrapViewerToken: string;
  readonly accessGrants: readonly HubIssuedAccessGrant[];
} {
  if ((project.access?.length ?? 0) > HUB_SERVER_LIMITS.principalsPerProject - 2) {
    throw new DataError(
      "resource_exhausted",
      `A Hub project supports at most ${HUB_SERVER_LIMITS.principalsPerProject} principals.`,
    );
  }
  const bootstrapAdminToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const bootstrapViewerToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const accessGrants: HubIssuedAccessGrant[] = [
    {
      principal_id: "hub-bootstrap-admin",
      role: "admin",
      bearerToken: bootstrapAdminToken,
    },
    {
      principal_id: "hub-bootstrap-viewer",
      role: "viewer",
      bearerToken: bootstrapViewerToken,
    },
  ];
  const principals = new Set(accessGrants.map((grant) => grant.principal_id));
  for (const grant of project.access ?? []) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(grant.principal_id) ||
      !HUB_ROLES.includes(grant.role) ||
      principals.has(grant.principal_id)
    ) {
      throw new DataError(
        "invalid_argument",
        "Hub access grants require unique bounded principals and supported roles.",
      );
    }
    principals.add(grant.principal_id);
    accessGrants.push({
      principal_id: grant.principal_id,
      role: grant.role,
      bearerToken: randomBytes(TOKEN_BYTES).toString("base64url"),
    });
  }
  return { bootstrapAdminToken, bootstrapViewerToken, accessGrants };
}

const HUB_ROLE_ORDER: Readonly<Record<HubRole, number>> = {
  viewer: 0,
  contributor: 1,
  reviewer: 2,
  maintainer: 3,
  admin: 4,
};

async function requireRole(
  audit: HubAuditStore,
  projectId: string,
  principal: HubPrincipalRuntime,
  required: HubRole,
  resource: string,
): Promise<void> {
  if (HUB_ROLE_ORDER[principal.role] >= HUB_ROLE_ORDER[required]) {
    return;
  }
  await audit.record({
    project_id: projectId,
    principal_id: principal.principalId,
    role: principal.role,
    action: "access_denied",
    outcome: "denied",
    resource,
    details: { required_role: required },
  });
  throw new HubRequestError({
    status: 403,
    code: "forbidden",
    message: "The Hub principal does not have permission for this operation.",
  });
}

function capabilitiesForRole(role: HubRole): readonly string[] {
  const capabilities = ["refs.read", "packs.export", "events.read"];
  if (HUB_ROLE_ORDER[role] >= HUB_ROLE_ORDER.contributor) {
    capabilities.push("collaboration.contribute");
  }
  if (HUB_ROLE_ORDER[role] >= HUB_ROLE_ORDER.reviewer) {
    capabilities.push("collaboration.review");
  }
  if (HUB_ROLE_ORDER[role] >= HUB_ROLE_ORDER.maintainer) {
    capabilities.push("refs.update", "packs.import", "retention.manage");
  }
  if (role === "admin") {
    capabilities.push("permissions.read", "audit.read");
  }
  return capabilities;
}

type AuditOperationContext = Omit<RecordHubAuditEvent, "outcome">;

function auditContext(
  projectId: string,
  principal: HubPrincipalRuntime,
  action: HubAuditAction,
  resource: string,
  details: JsonObject = {},
): AuditOperationContext {
  return {
    project_id: projectId,
    principal_id: principal.principalId,
    role: principal.role,
    action,
    resource,
    details,
  };
}

async function auditedOperation<T>(
  audit: HubAuditStore,
  context: AuditOperationContext,
  mutating: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (mutating) {
    await audit.record({ ...context, outcome: "attempted" });
  }
  try {
    const result = await operation();
    await audit.record({ ...context, outcome: "succeeded" });
    return result;
  } catch (error) {
    await audit.record({
      ...context,
      outcome: "failed",
      details: { ...(context.details ?? {}), error_code: publicErrorCode(error) },
    });
    throw error;
  }
}

function publicErrorCode(error: unknown): string {
  if (error instanceof HubRequestError || isDataError(error)) {
    return error.code;
  }
  return "internal";
}

function parseEventPagination(url: URL): { readonly afterSequence: number; readonly limit: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== "cursor" && key !== "limit") {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "Hub event pagination accepts only cursor and limit.",
      });
    }
  }
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "Hub event pagination values must be unique.",
    });
  }
  const cursor = url.searchParams.get("cursor") ?? "0";
  const limitSource = url.searchParams.get("limit") ?? "100";
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(cursor) || !/^[1-9][0-9]{0,2}$/.test(limitSource)) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "Hub event pagination is invalid.",
    });
  }
  const afterSequence = Number(cursor);
  const limit = Number(limitSource);
  if (!Number.isSafeInteger(afterSequence) || limit > 500) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "Hub event pagination is invalid.",
    });
  }
  return { afterSequence, limit };
}

function isCollaborationAction(action: HubAuditAction): boolean {
  return action === "ref_updated" || action === "pack_imported" || action === "pack_exported";
}

function collaborationEvent(event: HubAuditEvent): JsonObject {
  const kind =
    event.action === "ref_updated"
      ? "RefUpdated"
      : event.action === "pack_imported"
        ? "HubPackImported"
        : "HubPackExported";
  return {
    event_id: event.event_id,
    sequence: event.sequence,
    occurred_at: event.occurred_at,
    kind,
    actor: { principal_id: event.principal_id, role: event.role ?? "viewer" },
    resource: event.resource,
    details: event.details,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    received += bytes.byteLength;
    if (received > MAXIMUM_JSON_BODY_BYTES) {
      throw new HubRequestError({
        status: 400,
        code: "resource_exhausted",
        message: "The request body exceeds the Hub limit.",
      });
    }
    chunks.push(bytes);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JsonObject;
  } catch {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "The request body must be a JSON object.",
    });
  }
}

function writeJson(response: ServerResponse, status: number, body: JsonObject): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  let status = 500;
  let code = "internal";
  let message = "The Hub could not complete the request.";
  if (error instanceof HubRequestError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (isDataError(error)) {
    code = error.code;
    message = error.message;
    status =
      error.code === "invalid_argument"
        ? 400
        : error.code === "not_found"
          ? 404
          : error.code === "conflict" || error.code === "already_exists"
            ? 409
            : error.code === "resource_exhausted"
              ? 413
              : error.code === "unsupported"
                ? 501
                : 500;
  }
  writeJson(response, status, { error: { code, message } });
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
}

/** Export commands come from the network: their shape is not assumed. */
function assertExportCommand(body: JsonObject): void {
  const refNames = body["ref_names"];
  const commitIds = body["commit_ids"];
  const prerequisites = body["prerequisite_commit_ids"];
  const message = body["message"];
  const isStringArray = (value: unknown): boolean =>
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 64 &&
      value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256));
  if (
    !isStringArray(refNames) ||
    !isStringArray(commitIds) ||
    !isStringArray(prerequisites) ||
    body["created_by"] === null ||
    typeof body["created_by"] !== "object" ||
    Array.isArray(body["created_by"]) ||
    (message !== undefined &&
      (typeof message !== "string" || message.length === 0 || message.length > 2048))
  ) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "packs:export requires bounded ref names, commit ids, and an actor.",
    });
  }
}
