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
const EVENT_EPOCH_ID_PATTERN =
  /^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID_PATTERN =
  /^event_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONTEXT_ID_PATTERN = /^(?:request|trace)_[A-Za-z0-9._:-]{1,240}$/;
const DESIGN_REFERENCE_ID_PATTERN =
  /^designref_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAPPING_ID_PATTERN =
  /^mapping_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMPARISON_ID_PATTERN =
  /^comparison_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUE_ID_PATTERN =
  /^issue_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERIFICATION_ID_PATTERN =
  /^verification_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TUNING_PATCH_ID_PATTERN =
  /^patch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TUNING_APPLICATION_ID_PATTERN =
  /^tuningapp_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const MAXIMUM_ASSET_BASE64_CHARACTERS = 8 * 1024 * 1024;

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
  "GetEventTimeline",
  "AddDesignAsset",
  "AddDesignReference",
  "GetDesignReference",
  "MapDesignRegion",
  "RunDesignComparison",
  "GetDesignComparison",
  "CreateReviewIssue",
  "ListReviewIssues",
  "GetReviewIssue",
  "TransitionReviewIssue",
  "VerifyReviewIssue",
  "CreateTuningPatch",
  "GetTuningPatch",
  "ApplyTuningPatch",
  "RevertTuningApplication",
  "GetTuningApplication",
  "ListActiveTuning",
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
      case "AddDesignAsset": {
        const upload = assertExactObject(
          input,
          ["asset_base64", "media_type", "logical_name"],
          "Design asset input",
          true,
        );
        const assetBase64 = upload["asset_base64"];
        const mediaType = upload["media_type"];
        const logicalName = upload["logical_name"];
        if (
          typeof assetBase64 !== "string" ||
          assetBase64.length === 0 ||
          assetBase64.length > MAXIMUM_ASSET_BASE64_CHARACTERS ||
          typeof mediaType !== "string" ||
          !MEDIA_TYPE_PATTERN.test(mediaType) ||
          (logicalName !== undefined &&
            (typeof logicalName !== "string" ||
              logicalName.length === 0 ||
              logicalName.length > 512))
        ) {
          throw invalidInput();
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(assetBase64, "base64");
        } catch {
          throw invalidInput();
        }
        if (bytes.byteLength === 0 || bytes.toString("base64") !== assetBase64) {
          throw invalidInput();
        }
        const value = await this.#requestBinary("/v1/design-assets", bytes, mediaType, {
          ...(logicalName === undefined
            ? {}
            : { "x-vistrea-logical-name": logicalName }),
        }, options);
        return validateObjectRef(value);
      }
      case "AddDesignReference": {
        const command = assertExactObject(
          input,
          ["name", "kind", "canvas_size", "pixel_size", "asset_hash", "created_by"],
          "Design reference input",
        );
        const value = await this.#request("POST", "/v1/design-references", command, 201, options);
        return validateIdentifiedResource(value, "design_reference_id", DESIGN_REFERENCE_ID_PATTERN);
      }
      case "GetDesignReference": {
        const query = assertExactObject(input, ["design_reference_id"], "Design reference lookup");
        const referenceId = query["design_reference_id"];
        if (typeof referenceId !== "string" || !DESIGN_REFERENCE_ID_PATTERN.test(referenceId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/design-references/${encodeURIComponent(referenceId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "design_reference_id", DESIGN_REFERENCE_ID_PATTERN);
      }
      case "MapDesignRegion": {
        const command = assertExactObject(
          input,
          ["design_reference_id", "design_region", "runtime_target", "created_by"],
          "Design mapping input",
        );
        const value = await this.#request("POST", "/v1/design-mappings", command, 201, options);
        return validateIdentifiedResource(value, "mapping_id", MAPPING_ID_PATTERN);
      }
      case "RunDesignComparison": {
        const command = assertExactObject(
          input,
          ["design_reference_id", "target_snapshot_id", "completed_by"],
          "Design comparison input",
        );
        const value = await this.#request("POST", "/v1/design-comparisons", command, 201, options);
        return validateIdentifiedResource(value, "comparison_id", COMPARISON_ID_PATTERN);
      }
      case "GetDesignComparison": {
        const query = assertExactObject(input, ["comparison_id"], "Design comparison lookup");
        const comparisonId = query["comparison_id"];
        if (typeof comparisonId !== "string" || !COMPARISON_ID_PATTERN.test(comparisonId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/design-comparisons/${encodeURIComponent(comparisonId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "comparison_id", COMPARISON_ID_PATTERN);
      }
      case "CreateReviewIssue": {
        const command = assertExactObject(
          input,
          [
            "design_reference_id",
            "mapping_id",
            "comparison_id",
            "runtime_target",
            "title",
            "description",
            "category",
            "severity",
            "expected",
            "actual",
            "created_by",
          ],
          "Review issue input",
          true,
        );
        const value = await this.#request("POST", "/v1/review-issues", command, 201, options);
        return validateIdentifiedResource(value, "issue_id", ISSUE_ID_PATTERN);
      }
      case "ListReviewIssues": {
        const query = assertExactObject(
          input,
          ["states", "design_reference_id", "limit", "cursor"],
          "Review issue query",
          true,
        );
        const parameters = new URLSearchParams();
        const states = query["states"];
        if (states !== undefined) {
          if (
            !Array.isArray(states) ||
            states.length === 0 ||
            states.length > 8 ||
            !states.every((state) => typeof state === "string" && /^[a-z_]{1,32}$/.test(state))
          ) {
            throw invalidInput();
          }
          parameters.set("states", states.join(","));
        }
        const referenceId = query["design_reference_id"];
        if (referenceId !== undefined) {
          if (typeof referenceId !== "string" || !DESIGN_REFERENCE_ID_PATTERN.test(referenceId)) {
            throw invalidInput();
          }
          parameters.set("design_reference_id", referenceId);
        }
        if (query["limit"] !== undefined) {
          if (!Number.isInteger(query["limit"]) || (query["limit"] as number) < 1 || (query["limit"] as number) > 500) {
            throw invalidInput();
          }
          parameters.set("limit", String(query["limit"]));
        }
        if (query["cursor"] !== undefined) {
          if (typeof query["cursor"] !== "string" || query["cursor"].length === 0 || query["cursor"].length > 4096) {
            throw invalidInput();
          }
          parameters.set("cursor", query["cursor"]);
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request("GET", `/v1/review-issues${suffix}`, undefined, 200, options);
        return validateReviewIssuePage(value);
      }
      case "GetReviewIssue": {
        const query = assertExactObject(input, ["issue_id"], "Review issue lookup");
        const issueId = query["issue_id"];
        if (typeof issueId !== "string" || !ISSUE_ID_PATTERN.test(issueId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/review-issues/${encodeURIComponent(issueId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "issue_id", ISSUE_ID_PATTERN);
      }
      case "TransitionReviewIssue": {
        const command = assertExactObject(
          input,
          ["issue_id", "expected_revision", "to_state", "reason", "changed_by"],
          "Review issue transition input",
          true,
        );
        const issueId = command["issue_id"];
        if (typeof issueId !== "string" || !ISSUE_ID_PATTERN.test(issueId)) {
          throw invalidInput();
        }
        const { issue_id: _omitted, ...body } = command;
        const value = await this.#request(
          "POST",
          `/v1/review-issues/${encodeURIComponent(issueId)}/transitions`,
          body,
          200,
          options,
        );
        return validateIdentifiedResource(value, "issue_id", ISSUE_ID_PATTERN);
      }
      case "VerifyReviewIssue": {
        const command = assertExactObject(
          input,
          [
            "issue_id",
            "expected_revision",
            "basis",
            "result",
            "verified_snapshot_id",
            "verified_build_id",
            "rationale",
            "verified_by",
          ],
          "Review issue verification input",
          true,
        );
        const issueId = command["issue_id"];
        if (typeof issueId !== "string" || !ISSUE_ID_PATTERN.test(issueId)) {
          throw invalidInput();
        }
        const { issue_id: _omitted, ...body } = command;
        const value = await this.#request(
          "POST",
          `/v1/review-issues/${encodeURIComponent(issueId)}/verifications`,
          body,
          201,
          options,
        );
        const record = requireObject(requireObject(value)["record"]);
        const issue = requireObject(requireObject(value)["issue"]);
        validateIdentifiedResource(record, "verification_record_id", VERIFICATION_ID_PATTERN);
        validateIdentifiedResource(issue, "issue_id", ISSUE_ID_PATTERN);
        return requireObject(value);
      }
      case "CreateTuningPatch": {
        const command = assertExactObject(
          input,
          ["title", "description", "target_snapshot_id", "issue_ids", "changes", "status", "created_by"],
          "Tuning patch input",
          true,
        );
        const value = await this.#request("POST", "/v1/tuning-patches", command, 201, options);
        return validateIdentifiedResource(value, "patch_id", TUNING_PATCH_ID_PATTERN);
      }
      case "GetTuningPatch": {
        const query = assertExactObject(input, ["patch_id"], "Tuning patch lookup");
        const patchId = query["patch_id"];
        if (typeof patchId !== "string" || !TUNING_PATCH_ID_PATTERN.test(patchId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/tuning-patches/${encodeURIComponent(patchId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "patch_id", TUNING_PATCH_ID_PATTERN);
      }
      case "ApplyTuningPatch": {
        const command = assertExactObject(
          input,
          ["patch_id", "preview_ttl_ms"],
          "Tuning application input",
          true,
        );
        const patchId = command["patch_id"];
        if (typeof patchId !== "string" || !TUNING_PATCH_ID_PATTERN.test(patchId)) {
          throw invalidInput();
        }
        const value = await this.#request("POST", "/v1/tuning-applications", command, 201, options);
        return validateIdentifiedResource(
          value,
          "tuning_application_id",
          TUNING_APPLICATION_ID_PATTERN,
        );
      }
      case "RevertTuningApplication": {
        const command = assertExactObject(
          input,
          ["tuning_application_id"],
          "Tuning reversion input",
        );
        const applicationId = command["tuning_application_id"];
        if (
          typeof applicationId !== "string" ||
          !TUNING_APPLICATION_ID_PATTERN.test(applicationId)
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          `/v1/tuning-applications/${encodeURIComponent(applicationId)}/revert`,
          {},
          200,
          options,
        );
        return validateIdentifiedResource(
          value,
          "tuning_application_id",
          TUNING_APPLICATION_ID_PATTERN,
        );
      }
      case "GetTuningApplication": {
        const query = assertExactObject(
          input,
          ["tuning_application_id"],
          "Tuning application lookup",
        );
        const applicationId = query["tuning_application_id"];
        if (
          typeof applicationId !== "string" ||
          !TUNING_APPLICATION_ID_PATTERN.test(applicationId)
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/tuning-applications/${encodeURIComponent(applicationId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(
          value,
          "tuning_application_id",
          TUNING_APPLICATION_ID_PATTERN,
        );
      }
      case "ListActiveTuning": {
        assertExactObject(input, [], "Active tuning query");
        const value = await this.#request(
          "GET",
          "/v1/tuning-applications/active",
          undefined,
          200,
          options,
        );
        const page = requireObject(value);
        assertKeys(page, ["items"]);
        const items = page["items"];
        if (!Array.isArray(items) || items.length > 500) {
          throw invalidHostResult();
        }
        for (const itemValue of items) {
          validateIdentifiedResource(
            itemValue as JsonValue,
            "tuning_application_id",
            TUNING_APPLICATION_ID_PATTERN,
          );
        }
        return page;
      }
      case "GetEventTimeline": {
        const query = normalizeEventTimelineInput(input);
        const parameters = new URLSearchParams();
        if (query["event_epoch_id"] !== undefined) {
          parameters.set("event_epoch_id", query["event_epoch_id"] as string);
        }
        if (query["kinds"] !== undefined) {
          parameters.set("kinds", (query["kinds"] as readonly string[]).join(","));
        }
        if (query["first_sequence"] !== undefined) {
          parameters.set("first_sequence", String(query["first_sequence"]));
        }
        if (query["last_sequence"] !== undefined) {
          parameters.set("last_sequence", String(query["last_sequence"]));
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request("GET", `/v1/events${suffix}`, undefined, 200, options);
        return validateEventTimeline(value);
      }
      default:
        throw new HostClientError("unsupported", "The Host operation is not implemented.");
    }
  }

  async #requestBinary(
    route: string,
    body: Buffer,
    contentType: string,
    headers: Readonly<Record<string, string>>,
    options: HostRequestOptions,
  ): Promise<JsonValue> {
    return this.#request("POST", route, undefined, 201, options, {
      rawBody: body,
      contentType,
      headers,
    });
  }

  async #request(
    method: "GET" | "POST",
    route: string,
    body: JsonObject | undefined,
    expectedStatus: number,
    options: HostRequestOptions,
    raw?: {
      readonly rawBody: Buffer;
      readonly contentType: string;
      readonly headers: Readonly<Record<string, string>>;
    },
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
          ...(raw === undefined ? {} : { "content-type": raw.contentType, ...raw.headers }),
          ...(requestId === undefined ? {} : { "x-vistrea-request-id": requestId }),
          ...(traceId === undefined ? {} : { "x-vistrea-trace-id": traceId }),
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        ...(raw === undefined ? {} : { body: new Uint8Array(raw.rawBody) }),
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
  assertKeys(
    status,
    ["status", "runtime_connected", "runtime_events", "workspace_id", "message"],
    true,
  );
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
  const events = status["runtime_events"];
  if (events !== undefined) {
    const record = requireObject(events);
    assertKeys(
      record,
      ["state", "event_epoch_id", "persisted_through_sequence", "error_code"],
      true,
    );
    if (
      (record["state"] !== "idle" &&
        record["state"] !== "unsupported" &&
        record["state"] !== "running" &&
        record["state"] !== "stopped" &&
        record["state"] !== "failed") ||
      (record["event_epoch_id"] !== undefined &&
        (typeof record["event_epoch_id"] !== "string" ||
          !EVENT_EPOCH_ID_PATTERN.test(record["event_epoch_id"]))) ||
      (record["persisted_through_sequence"] !== undefined &&
        (!Number.isSafeInteger(record["persisted_through_sequence"]) ||
          (record["persisted_through_sequence"] as number) < 0)) ||
      (record["error_code"] !== undefined &&
        (typeof record["error_code"] !== "string" || record["error_code"].length > 64))
    ) {
      throw invalidHostResult();
    }
  }
  return status;
}

function normalizeEventTimelineInput(value: unknown): JsonObject {
  const input = assertExactObject(
    value,
    ["event_epoch_id", "kinds", "first_sequence", "last_sequence"],
    "Event timeline input",
    true,
  );
  const eventEpochId = input["event_epoch_id"];
  if (
    eventEpochId !== undefined &&
    (typeof eventEpochId !== "string" || !EVENT_EPOCH_ID_PATTERN.test(eventEpochId))
  ) {
    throw invalidInput();
  }
  const kinds = input["kinds"];
  if (
    kinds !== undefined &&
    (!Array.isArray(kinds) ||
      kinds.length === 0 ||
      kinds.length > 16 ||
      new Set(kinds).size !== kinds.length ||
      !kinds.every(
        (kind) => typeof kind === "string" && EVENT_KIND_PATTERN.test(kind),
      ))
  ) {
    throw invalidInput();
  }
  for (const field of ["first_sequence", "last_sequence"] as const) {
    const sequence = input[field];
    if (
      sequence !== undefined &&
      (!Number.isSafeInteger(sequence) || (sequence as number) < 0)
    ) {
      throw invalidInput();
    }
  }
  if (
    input["first_sequence"] !== undefined &&
    input["last_sequence"] !== undefined &&
    (input["first_sequence"] as number) > (input["last_sequence"] as number)
  ) {
    throw invalidInput();
  }
  return input;
}

function validateEventTimeline(value: JsonValue): JsonObject {
  const timeline = requireObject(value);
  assertKeys(timeline, ["event_epoch_id", "events", "reported_gaps"], true);
  const events = timeline["events"];
  const gaps = timeline["reported_gaps"];
  if (
    (timeline["event_epoch_id"] !== undefined &&
      (typeof timeline["event_epoch_id"] !== "string" ||
        !EVENT_EPOCH_ID_PATTERN.test(timeline["event_epoch_id"]))) ||
    !Array.isArray(events) ||
    events.length > 100_000 ||
    !Array.isArray(gaps) ||
    gaps.length > 100_000
  ) {
    throw invalidHostResult();
  }
  for (const eventValue of events) {
    const event = requireObject(eventValue);
    if (
      typeof event["event_id"] !== "string" ||
      !EVENT_ID_PATTERN.test(event["event_id"]) ||
      !Number.isSafeInteger(event["sequence"]) ||
      (event["sequence"] as number) < 0 ||
      typeof event["kind"] !== "string" ||
      !EVENT_KIND_PATTERN.test(event["kind"])
    ) {
      throw invalidHostResult();
    }
  }
  for (const gapValue of gaps) {
    const gap = requireObject(gapValue);
    assertKeys(gap, ["first_sequence", "last_sequence"]);
    if (
      !Number.isSafeInteger(gap["first_sequence"]) ||
      (gap["first_sequence"] as number) < 0 ||
      !Number.isSafeInteger(gap["last_sequence"]) ||
      (gap["last_sequence"] as number) < (gap["first_sequence"] as number)
    ) {
      throw invalidHostResult();
    }
  }
  return timeline;
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

function validateObjectRef(value: JsonValue): JsonObject {
  const object = requireObject(value);
  if (
    typeof object["hash"] !== "string" ||
    !OBJECT_HASH_PATTERN.test(object["hash"]) ||
    typeof object["media_type"] !== "string" ||
    !Number.isSafeInteger(object["byte_size"])
  ) {
    throw invalidHostResult();
  }
  return object;
}

function validateIdentifiedResource(
  value: JsonValue,
  idField: string,
  pattern: RegExp,
): JsonObject {
  const resource = requireObject(value);
  const identifier = resource[idField];
  if (typeof identifier !== "string" || !pattern.test(identifier)) {
    throw invalidHostResult();
  }
  return resource;
}

function validateReviewIssuePage(value: JsonValue): JsonObject {
  const page = requireObject(value);
  assertKeys(page, ["items", "next_cursor", "snapshot_version"], true);
  const items = page["items"];
  if (!Array.isArray(items) || items.length > 500) {
    throw invalidHostResult();
  }
  for (const itemValue of items) {
    validateIdentifiedResource(itemValue as JsonValue, "issue_id", ISSUE_ID_PATTERN);
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
