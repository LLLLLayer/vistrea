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

const TOKEN_BYTES = 32;
const MAXIMUM_JSON_BODY_BYTES = 64 * 1024;
const MAXIMUM_PACK_BYTES = 256 * 1024 * 1024;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HubBindAddress = string;

export interface HubProject {
  readonly project_id: string;
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
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
  /** Every served project namespace; requests outside them fail `not_found`. */
  readonly projects: readonly HubProject[];
  readonly validator: ProtocolValidator;
  readonly tls?: HubTlsConfig;
}

export interface HubProjectTokens {
  readonly project_id: string;
  /** Read-write token for this project only; never persisted. */
  readonly bearerToken: string;
  /** Read-only token for this project only: listing, resolution, and export. */
  readonly readOnlyToken: string;
}

export interface HubServerHandle {
  readonly host: HubBindAddress;
  readonly port: number;
  readonly baseUrl: string;
  /** One token pair per served project: a team's token never reaches another team's namespace. */
  readonly projects: readonly HubProjectTokens[];
  close(): Promise<void>;
}

type HubRole = "read-write" | "read-only";

interface HubProjectRuntime {
  readonly project: HubProject;
  readonly exchange: PackExchangeService;
  readonly bearerDigest: Buffer;
  readonly readOnlyDigest: Buffer;
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
 * The first optional Vistrea Hub slice: a loopback pack relay over one shared
 * remote Workspace, following the `packs:import`/`packs:export` and ref
 * endpoints of the Hub API contract. Local Workspaces stay fully usable
 * without it.
 */
export async function startHubServer(options: StartHubServerOptions): Promise<HubServerHandle> {
  if (options.projects.length === 0) {
    throw new DataError("invalid_argument", "The Hub serves at least one project.");
  }
  const projects = new Map<string, HubProjectRuntime>();
  for (const project of options.projects) {
    if (!PROJECT_ID_PATTERN.test(project.project_id)) {
      throw new DataError("invalid_argument", "A Hub project identifier is invalid.");
    }
    if (projects.has(project.project_id)) {
      throw new DataError("invalid_argument", "Hub project identifiers must be unique.");
    }
    projects.set(project.project_id, {
      project,
      exchange: new PackExchangeService({
        data: project.workspace,
        objects: project.objects,
        validator: options.validator,
      }),
      bearerDigest: digestToken(randomBytes(TOKEN_BYTES).toString("base64url")),
      readOnlyDigest: digestToken(randomBytes(TOKEN_BYTES).toString("base64url")),
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
  // Tokens are minted per project: a Hub that served one pair for every
  // namespace would give every team write access to every other team.
  const projectTokens: HubProjectTokens[] = [];
  for (const [projectId, runtime] of projects) {
    const bearerToken = randomBytes(TOKEN_BYTES).toString("base64url");
    const readOnlyToken = randomBytes(TOKEN_BYTES).toString("base64url");
    projects.set(projectId, {
      ...runtime,
      bearerDigest: digestToken(bearerToken),
      readOnlyDigest: digestToken(readOnlyToken),
    });
    projectTokens.push({ project_id: projectId, bearerToken, readOnlyToken });
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void handleRequest(request, response, projects).catch((error: unknown) =>
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
        await closeServer(server);
      }
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projects: ReadonlyMap<string, HubProjectRuntime>,
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
  const projectId = decodeURIComponent(projectMatch[1] as string);
  const runtime = projects.get(projectId);
  // The token is checked against THIS project, so a token for another
  // namespace is indistinguishable from no token at all.
  const role =
    runtime === undefined
      ? undefined
      : authorize(request, runtime.bearerDigest, runtime.readOnlyDigest);
  if (runtime === undefined || role === undefined) {
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
  if (role === "read-only" && (resource === "refs:update" || resource === "packs:import")) {
    throw new HubRequestError({
      status: 403,
      code: "forbidden",
      message: "A read-only Hub token cannot mutate refs or import packs.",
    });
  }

  if (resource === "refs" && request.method === "GET") {
    const unit = workspace.beginUnitOfWork("read");
    try {
      const page = unit.versions.listRefs();
      writeJson(response, 200, { items: page.items } as unknown as JsonObject);
    } finally {
      unit.rollback();
    }
    return;
  }

  if (resource === "refs:resolve" && request.method === "POST") {
    const body = await readJsonBody(request);
    const name = body["name"];
    if (typeof name !== "string" || name.length === 0 || name.length > 255) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "refs:resolve requires a bounded ref name.",
      });
    }
    const unit = workspace.beginUnitOfWork("read");
    try {
      writeJson(response, 200, unit.versions.resolveRef(name) as unknown as JsonObject);
    } finally {
      unit.rollback();
    }
    return;
  }

  if (resource === "refs:update" && request.method === "POST") {
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
    const unit = workspace.beginUnitOfWork("write");
    try {
      const ref = unit.versions.updateRef(name, commitId, precondition as never);
      unit.commit();
      writeJson(response, 200, ref as unknown as JsonObject);
    } catch (error) {
      try {
        unit.rollback();
      } catch {
        // The original failure is the meaningful error.
      }
      throw error;
    }
    return;
  }

  if (resource === "packs:import" && request.method === "POST") {
    if (request.headers["content-type"] !== PACK_MEDIA_TYPE) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: `Pack imports require the ${PACK_MEDIA_TYPE} media type.`,
      });
    }
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
    // Metadata must match exportPack's exactly: the same deterministic bytes
    // re-exported later would otherwise conflict on immutable metadata.
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
    const result = await exchange.importPack({ pack });
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (resource === "packs:export" && request.method === "POST") {
    const body = await readJsonBody(request);
    assertExportCommand(body);
    // Streamed, never persisted: one stored object per export would let any
    // caller grow the Hub's disk without bound.
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
        return;
      }
    }
    response.end();
    return;
  }

  throw new HubRequestError({
    status: 404,
    code: "not_found",
    message: "The requested Hub route does not exist.",
  });
}

function authorize(
  request: IncomingMessage,
  readWriteDigest: Buffer,
  readOnlyDigest: Buffer,
): HubRole | undefined {
  const header = request.headers.authorization;
  const match =
    typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{1,1024})$/i.exec(header) : null;
  const candidate = digestToken(match?.[1] ?? "");
  const readWrite = match !== null && timingSafeEqual(candidate, readWriteDigest);
  const readOnly = match !== null && timingSafeEqual(candidate, readOnlyDigest);
  candidate.fill(0);
  return readWrite ? "read-write" : readOnly ? "read-only" : undefined;
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
