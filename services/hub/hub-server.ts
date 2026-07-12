import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  DataError,
  isDataError,
  type JsonObject,
  type ObjectStore,
  type ProtocolValidator,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { PACK_MEDIA_TYPE, PackExchangeService } from "../../data/exchange/index.js";

const TOKEN_BYTES = 32;
const MAXIMUM_JSON_BODY_BYTES = 64 * 1024;
const MAXIMUM_PACK_BYTES = 256 * 1024 * 1024;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HubBindAddress = "127.0.0.1" | "::1";

export interface StartHubServerOptions {
  /** The Hub is optional infrastructure; it binds loopback-only for now. */
  readonly host: HubBindAddress;
  readonly port?: number;
  /**
   * The single project this Hub instance serves in the first slice. Requests
   * for any other project fail with `not_found` instead of being silently
   * remapped.
   */
  readonly projectId: string;
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly validator: ProtocolValidator;
}

export interface HubServerHandle {
  readonly host: HubBindAddress;
  readonly port: number;
  readonly baseUrl: string;
  /** Generated once for this server lifetime and never persisted. */
  readonly bearerToken: string;
  close(): Promise<void>;
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
  if (!PROJECT_ID_PATTERN.test(options.projectId)) {
    throw new DataError("invalid_argument", "The Hub project identifier is invalid.");
  }
  // Callers can cast arbitrary strings into HubBindAddress; the bearer token
  // travels as plain HTTP, so refuse any non-loopback interface at runtime.
  if (options.host !== "127.0.0.1" && options.host !== "::1") {
    throw new DataError("invalid_argument", "The Hub binds loopback interfaces only.");
  }
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
  ) {
    throw new DataError("invalid_argument", "The Hub port must be an integer from 0 through 65535.");
  }
  const exchange = new PackExchangeService({
    data: options.workspace,
    objects: options.objects,
    validator: options.validator,
  });
  const bearerToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const bearerDigest = digestToken(bearerToken);

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void handleRequest(request, response, options, exchange, bearerDigest).catch(
      (error: unknown) => sendError(response, error),
    );
  });
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
  return {
    host: options.host,
    port: address.port,
    baseUrl: `http://${options.host === "::1" ? `[${options.host}]` : options.host}:${address.port}`,
    bearerToken,
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
  options: StartHubServerOptions,
  exchange: PackExchangeService,
  bearerDigest: Buffer,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  authorize(request, bearerDigest);
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
  if (projectId !== options.projectId) {
    throw new HubRequestError({
      status: 404,
      code: "not_found",
      message: "This Hub instance does not serve the requested project.",
    });
  }
  const resource = projectMatch[2] as string;

  if (resource === "refs" && request.method === "GET") {
    const unit = options.workspace.beginUnitOfWork("read");
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
    const unit = options.workspace.beginUnitOfWork("read");
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
    const unit = options.workspace.beginUnitOfWork("write");
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
    const pack = await options.objects.put(stream, {
      media_type: PACK_MEDIA_TYPE,
      compression: "none",
    });
    if (pack.byte_size === 0) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "An empty pack upload is not a valid container.",
      });
    }
    options.workspace.registerVerifiedObjects([pack]);
    const result = await exchange.importPack({ pack });
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (resource === "packs:export" && request.method === "POST") {
    const body = await readJsonBody(request);
    const pack = await exchange.exportPack(
      body as unknown as Parameters<PackExchangeService["exportPack"]>[0],
    );
    options.workspace.registerVerifiedObjects([pack]);
    response.writeHead(200, {
      "content-type": PACK_MEDIA_TYPE,
      "content-length": String(pack.byte_size),
      etag: `"${pack.hash}"`,
    });
    for await (const chunk of await options.objects.open(pack.hash)) {
      response.write(chunk);
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

function authorize(request: IncomingMessage, expectedDigest: Buffer): void {
  const header = request.headers.authorization;
  const match =
    typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{1,1024})$/i.exec(header) : null;
  const candidate = digestToken(match?.[1] ?? "");
  const authorized = match !== null && timingSafeEqual(candidate, expectedDigest);
  candidate.fill(0);
  if (!authorized) {
    throw new HubRequestError({
      status: 401,
      code: "unauthenticated",
      message: "A valid Hub bearer token is required.",
    });
  }
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
