import { randomBytes } from "node:crypto";

import {
  parseStrictJson,
  StrictJsonError,
  type JsonObject,
  type JsonValue,
} from "./strict-json.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_TIMEOUT_MILLISECONDS = 300_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_REQUEST_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SNAPSHOT_ID_PATTERN =
  /^snapshot_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID_PATTERN =
  /^workspace_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTEXT_ID_PATTERN = /^(?:request|trace)_[A-Za-z0-9._:-]{1,240}$/;

export const HOST_LOCAL_API_ENVIRONMENT = {
  url: "VISTREA_HOST_URL",
  token: "VISTREA_HOST_TOKEN",
  timeoutMilliseconds: "VISTREA_HOST_TIMEOUT_MS",
  maximumResponseBytes: "VISTREA_HOST_MAX_RESPONSE_BYTES",
} as const;

export const IMPLEMENTED_HOST_OPERATIONS = [
  "GetWorkspaceStatus",
  "CaptureSnapshot",
  "ListSnapshots",
  "GetSnapshot",
] as const;

export type ImplementedHostOperation = (typeof IMPLEMENTED_HOST_OPERATIONS)[number];

export type HostClientErrorCode =
  | "invalid_argument"
  | "not_found"
  | "already_exists"
  | "conflict"
  | "unauthenticated"
  | "forbidden"
  | "unsupported"
  | "policy_blocked"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "integrity_error"
  | "resource_exhausted"
  | "internal";

const HOST_ERROR_CODES = new Set<HostClientErrorCode>([
  "invalid_argument",
  "not_found",
  "already_exists",
  "conflict",
  "unauthenticated",
  "forbidden",
  "unsupported",
  "policy_blocked",
  "unavailable",
  "timeout",
  "cancelled",
  "integrity_error",
  "resource_exhausted",
  "internal",
]);

export class HostClientError extends Error {
  readonly code: HostClientErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly requestId?: string;

  constructor(
    code: HostClientErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly httpStatus?: number;
      readonly requestId?: string;
    } = {},
  ) {
    super(message);
    this.name = "HostClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
    if (options.requestId !== undefined) {
      this.requestId = options.requestId;
    }
  }
}

export function isHostClientError(value: unknown): value is HostClientError {
  return value instanceof HostClientError;
}

export interface HostLocalApiClientOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
}

export interface HostRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly requestId?: string;
  readonly traceId?: string;
}

export interface CreateClientFromEnvironmentOptions {
  readonly timeoutMilliseconds?: number;
}

export function createHostLocalApiClientFromEnvironment(
  environment: NodeJS.ProcessEnv,
  options: CreateClientFromEnvironmentOptions = {},
): HostLocalApiClient {
  const baseUrl = environment[HOST_LOCAL_API_ENVIRONMENT.url];
  const bearerToken = environment[HOST_LOCAL_API_ENVIRONMENT.token];
  if (baseUrl === undefined || bearerToken === undefined) {
    throw invalidConfiguration();
  }
  const configuredTimeout = parseOptionalEnvironmentInteger(
    environment[HOST_LOCAL_API_ENVIRONMENT.timeoutMilliseconds],
    1,
    MAXIMUM_TIMEOUT_MILLISECONDS,
  );
  const maximumResponseBytes = parseOptionalEnvironmentInteger(
    environment[HOST_LOCAL_API_ENVIRONMENT.maximumResponseBytes],
    1,
    MAXIMUM_RESPONSE_BYTES,
  );
  const timeoutMilliseconds = options.timeoutMilliseconds ?? configuredTimeout;
  return new HostLocalApiClient({
    baseUrl,
    bearerToken,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    ...(maximumResponseBytes === undefined ? {} : { maximumResponseBytes }),
  });
}

export class HostLocalApiClient {
  readonly #baseUrl: string;
  readonly #bearerToken: string;
  readonly #timeoutMilliseconds: number;
  readonly #maximumResponseBytes: number;

  constructor(options: HostLocalApiClientOptions) {
    this.#baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    if (!TOKEN_PATTERN.test(options.bearerToken)) {
      throw invalidConfiguration();
    }
    this.#bearerToken = options.bearerToken;
    this.#timeoutMilliseconds = normalizeIntegerOption(
      options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
      1,
      MAXIMUM_TIMEOUT_MILLISECONDS,
    );
    this.#maximumResponseBytes = normalizeIntegerOption(
      options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
      1,
      MAXIMUM_RESPONSE_BYTES,
    );
  }

  async execute(
    operation: ImplementedHostOperation,
    input: unknown = {},
    options: HostRequestOptions = {},
  ): Promise<JsonObject> {
    switch (operation) {
      case "GetWorkspaceStatus": {
        assertExactObject(input, [], "Workspace status input");
        const value = await this.#request("GET", "/v1/status", undefined, 200, options);
        return validateWorkspaceStatus(value);
      }
      case "CaptureSnapshot": {
        const command = normalizeCaptureInput(input);
        const value = await this.#request("POST", "/v1/captures", command, 201, options);
        return validateRuntimeSnapshot(value);
      }
      case "ListSnapshots": {
        const query = normalizeListInput(input);
        const parameters = new URLSearchParams();
        if (query["limit"] !== undefined) {
          parameters.set("limit", String(query["limit"]));
        }
        if (query["cursor"] !== undefined) {
          parameters.set("cursor", query["cursor"] as string);
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request(
          "GET",
          `/v1/snapshots${suffix}`,
          undefined,
          200,
          options,
        );
        return validateSnapshotPage(value);
      }
      case "GetSnapshot": {
        const getInput = assertExactObject(input, ["snapshot_id"], "Get Snapshot input");
        const snapshotId = getInput["snapshot_id"];
        if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/snapshots/${encodeURIComponent(snapshotId)}`,
          undefined,
          200,
          options,
        );
        const snapshot = validateRuntimeSnapshot(value);
        if (snapshot["snapshot_id"] !== snapshotId) {
          throw new HostClientError(
            "integrity_error",
            "The Host returned a different Snapshot than requested.",
          );
        }
        return snapshot;
      }
      default:
        throw new HostClientError("unsupported", "The Host operation is not implemented.");
    }
  }

  async #request(
    method: "GET" | "POST",
    route: string,
    body: JsonObject | undefined,
    expectedStatus: number,
    options: HostRequestOptions,
  ): Promise<JsonValue> {
    const timeoutMilliseconds = normalizeIntegerOption(
      options.timeoutMilliseconds ?? this.#timeoutMilliseconds,
      1,
      MAXIMUM_TIMEOUT_MILLISECONDS,
    );
    const requestId = normalizeContextId(options.requestId, "request");
    const traceId = normalizeContextId(options.traceId, "trace");
    let encodedBody: string | undefined;
    if (body !== undefined) {
      encodedBody = JSON.stringify(body);
      if (Buffer.byteLength(encodedBody, "utf8") > MAXIMUM_REQUEST_BYTES) {
        throw new HostClientError(
          "resource_exhausted",
          "The Host request exceeds the local adapter limit.",
        );
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMilliseconds);
    timeout.unref();
    const cancel = (): void => controller.abort();
    if (options.signal?.aborted === true) {
      cancel();
    } else {
      options.signal?.addEventListener("abort", cancel, { once: true });
    }

    try {
      const response = await fetch(`${this.#baseUrl}${route}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#bearerToken}`,
          ...(encodedBody === undefined ? {} : { "content-type": "application/json" }),
          ...(requestId === undefined ? {} : { "x-vistrea-request-id": requestId }),
          ...(traceId === undefined ? {} : { "x-vistrea-trace-id": traceId }),
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
      });
      let value: JsonValue;
      try {
        value = await readBoundedJsonResponse(response, this.#maximumResponseBytes);
      } catch (error) {
        if (error instanceof HostClientError || controller.signal.aborted) {
          throw error;
        }
        throw new HostClientError(
          "integrity_error",
          "The Host response body failed integrity verification.",
        );
      }
      if (response.status !== expectedStatus) {
        if (response.status >= 200 && response.status < 300) {
          throw new HostClientError(
            "integrity_error",
            "The Host returned an unexpected success status.",
            { httpStatus: response.status },
          );
        }
        throw parseHostError(value, response.status, this.#bearerToken);
      }
      return value;
    } catch (error) {
      if (error instanceof HostClientError) {
        throw error;
      }
      if (timedOut) {
        throw new HostClientError("timeout", "The Host request timed out.", {
          retryable: true,
        });
      }
      if (options.signal?.aborted === true) {
        throw new HostClientError("cancelled", "The Host request was cancelled.");
      }
      throw new HostClientError("unavailable", "The Host Local API is unavailable.", {
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
}

async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<JsonValue> {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    await cancelResponseBody(response);
    throw new HostClientError(
      "integrity_error",
      "The Host returned an invalid JSON content type.",
      { httpStatus: response.status },
    );
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    await cancelResponseBody(response);
    throw new HostClientError(
      "integrity_error",
      "The Host returned an unsupported content encoding.",
      { httpStatus: response.status },
    );
  }
  const declaredLength = response.headers.get("content-length");
  let expectedByteLength: number | undefined;
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      await cancelResponseBody(response);
      throw new HostClientError("integrity_error", "The Host returned an invalid body length.");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      await cancelResponseBody(response);
      throw responseTooLarge();
    }
    if (length > maximumBytes) {
      await cancelResponseBody(response);
      throw responseTooLarge();
    }
    expectedByteLength = length;
  }
  if (response.body === null) {
    throw new HostClientError("integrity_error", "The Host returned an empty JSON body.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > maximumBytes - total) {
      await cancelResponseBody(response);
      throw responseTooLarge();
    }
    const copy = Buffer.from(chunk);
    chunks.push(copy);
    total += copy.byteLength;
  }
  if (total === 0) {
    throw new HostClientError("integrity_error", "The Host returned an empty JSON body.");
  }
  if (expectedByteLength !== undefined && total !== expectedByteLength) {
    throw new HostClientError(
      "integrity_error",
      "The Host response body length does not match Content-Length.",
    );
  }
  try {
    return parseStrictJson(Buffer.concat(chunks, total));
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new HostClientError("integrity_error", "The Host returned invalid JSON.");
    }
    throw error;
  }
}

function parseHostError(value: JsonValue, status: number, bearerToken: string): HostClientError {
  const envelope = requireObject(value);
  assertKeys(envelope, ["request_id", "error"]);
  const requestId = envelope["request_id"];
  const error = requireObject(envelope["error"]);
  assertKeys(error, ["code", "message", "retryable"]);
  const code = error["code"];
  const message = error["message"];
  const retryable = error["retryable"];
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > 256 ||
    typeof code !== "string" ||
    !HOST_ERROR_CODES.has(code as HostClientErrorCode) ||
    typeof message !== "string" ||
    typeof retryable !== "boolean"
  ) {
    throw new HostClientError("integrity_error", "The Host returned an invalid error envelope.");
  }
  return new HostClientError(
    code as HostClientErrorCode,
    redactSecret(message, bearerToken),
    { retryable, httpStatus: status, requestId },
  );
}

function normalizeCaptureInput(value: unknown): JsonObject {
  const input = assertExactObject(value, ["include", "screenshot", "reason"], "Capture input", true);
  const result: Record<string, JsonValue> = {};
  if (input["include"] !== undefined) {
    const include = assertExactObject(input["include"], ["paths"], "Capture include");
    const paths = include["paths"];
    if (!Array.isArray(paths) || paths.length > 64) {
      throw invalidInput();
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (typeof path !== "string" || path.length === 0 || path.length > 128 || seen.has(path)) {
        throw invalidInput();
      }
      seen.add(path);
      normalized.push(path);
    }
    result["include"] = { paths: normalized };
  }
  const screenshot = input["screenshot"];
  if (screenshot !== undefined) {
    if (screenshot !== "none" && screenshot !== "reference") {
      throw invalidInput();
    }
    result["screenshot"] = screenshot;
  }
  const reason = input["reason"];
  if (reason !== undefined) {
    if (
      reason !== "manual" &&
      reason !== "before_action" &&
      reason !== "after_action" &&
      reason !== "review" &&
      reason !== "validation"
    ) {
      throw invalidInput();
    }
    result["reason"] = reason;
  }
  return result;
}

function normalizeListInput(value: unknown): JsonObject {
  const input = assertExactObject(value, ["limit", "cursor"], "List Snapshots input", true);
  const limit = input["limit"];
  const cursor = input["cursor"];
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500)) {
    throw invalidInput();
  }
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096)) {
    throw invalidInput();
  }
  return {
    ...(limit === undefined ? {} : { limit: limit as number }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function validateWorkspaceStatus(value: JsonValue): JsonObject {
  const status = requireObject(value);
  assertKeys(status, ["status", "runtime_connected", "workspace_id", "message"], true);
  if (
    (status["status"] !== "ready" && status["status"] !== "degraded") ||
    typeof status["runtime_connected"] !== "boolean" ||
    (status["workspace_id"] !== undefined &&
      (typeof status["workspace_id"] !== "string" ||
        !WORKSPACE_ID_PATTERN.test(status["workspace_id"]))) ||
    (status["message"] !== undefined &&
      (typeof status["message"] !== "string" || status["message"].length > 1024))
  ) {
    throw invalidHostResult();
  }
  return status;
}

function validateRuntimeSnapshot(value: JsonValue): JsonObject {
  const snapshot = requireObject(value);
  const snapshotId = snapshot["snapshot_id"];
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw invalidHostResult();
  }
  return snapshot;
}

function validateSnapshotPage(value: JsonValue): JsonObject {
  const page = requireObject(value);
  assertKeys(page, ["items", "next_cursor", "snapshot_version"], true);
  const items = page["items"];
  if (!Array.isArray(items) || items.length > 500) {
    throw invalidHostResult();
  }
  for (const itemValue of items) {
    const item = requireObject(itemValue);
    assertKeys(item, ["snapshot_id", "captured_at", "runtime_context"]);
    if (
      typeof item["snapshot_id"] !== "string" ||
      !SNAPSHOT_ID_PATTERN.test(item["snapshot_id"] as string) ||
      !isObject(item["captured_at"]) ||
      !isObject(item["runtime_context"])
    ) {
      throw invalidHostResult();
    }
  }
  if (
    (page["next_cursor"] !== undefined &&
      (typeof page["next_cursor"] !== "string" ||
        page["next_cursor"].length === 0 ||
        page["next_cursor"].length > 4096)) ||
    (page["snapshot_version"] !== undefined &&
      (typeof page["snapshot_version"] !== "string" ||
        page["snapshot_version"].length === 0 ||
        page["snapshot_version"].length > 256))
  ) {
    throw invalidHostResult();
  }
  return page;
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  _name: string,
  optionalKeys = false,
): JsonObject {
  if (!isObject(value)) {
    throw invalidInput();
  }
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (actual.some((key) => !allowed.has(key))) {
    throw invalidInput();
  }
  if (!optionalKeys && keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalidInput();
  }
  return value;
}

function assertKeys(
  value: JsonObject,
  allowedKeys: readonly string[],
  optionalKeys = false,
): void {
  const actual = Object.keys(value);
  const allowed = new Set(allowedKeys);
  if (actual.some((key) => !allowed.has(key))) {
    throw invalidHostResult();
  }
  if (!optionalKeys && allowedKeys.some((key) => !Object.hasOwn(value, key))) {
    throw invalidHostResult();
  }
}

function requireObject(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    throw invalidHostResult();
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function normalizeLoopbackBaseUrl(value: string): string {
  const canonical =
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value) ??
    /^http:\/\/\[::1\]:([1-9][0-9]{0,4})$/.exec(value);
  if (canonical === null) {
    throw invalidConfiguration();
  }
  const requestedPort = Number(canonical[1]);
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
    throw invalidConfiguration();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfiguration();
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw invalidConfiguration();
  }
  return value;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the deterministic adapter limit error if cancellation races the peer.
  }
}

function normalizeContextId(
  value: string | undefined,
  expectedPrefix: "request" | "trace",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!CONTEXT_ID_PATTERN.test(value) || !value.startsWith(`${expectedPrefix}_`)) {
    throw invalidInput();
  }
  return value;
}

function normalizeIntegerOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidConfiguration();
  }
  return value;
}

function parseOptionalEnvironmentInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw invalidConfiguration();
  }
  return normalizeIntegerOption(Number(value), minimum, maximum);
}

function redactSecret(message: string, secret: string): string {
  const redacted = message.replaceAll(secret, "[redacted]");
  return redacted.length <= 1024 ? redacted : `${redacted.slice(0, 1021)}...`;
}

function invalidConfiguration(): HostClientError {
  return new HostClientError("invalid_argument", "Host Local API configuration is invalid.");
}

function invalidInput(): HostClientError {
  return new HostClientError("invalid_argument", "The adapter input is invalid.");
}

function invalidHostResult(): HostClientError {
  return new HostClientError("integrity_error", "The Host returned an invalid result.");
}

function responseTooLarge(): HostClientError {
  return new HostClientError(
    "resource_exhausted",
    "The Host response exceeds the local adapter limit.",
  );
}

export function createCorrelationId(prefix: "request" | "trace"): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
