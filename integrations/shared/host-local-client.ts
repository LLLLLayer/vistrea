import { createHash, randomBytes } from "node:crypto";

import {
  parseStrictJson,
  StrictJsonError,
  type JsonObject,
  type JsonValue,
} from "./strict-json.js";
import {
  IMPLEMENTED_HOST_OPERATIONS,
  type ImplementedHostOperation,
} from "./host-operation-manifest.js";

export { IMPLEMENTED_HOST_OPERATIONS } from "./host-operation-manifest.js";
export type { ImplementedHostOperation } from "./host-operation-manifest.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_TIMEOUT_MILLISECONDS = 300_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_REQUEST_BYTES = 64 * 1024;
// Deep Wiki markdown may hold 262144 code points, which JSON escaping can
// expand several-fold; wiki writes get their own request budget.
const MAXIMUM_WIKI_REQUEST_BYTES = 2 * 1024 * 1024;
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
const DIFFERENCE_ID_PATTERN =
  /^difference_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUE_ID_PATTERN =
  /^issue_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERIFICATION_ID_PATTERN =
  /^verification_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TUNING_PATCH_ID_PATTERN =
  /^patch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TUNING_APPLICATION_ID_PATTERN =
  /^tuningapp_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const OBSERVATION_ID_PATTERN =
  /^observation_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_ID_PATTERN =
  /^operation_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_STATES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const SCREEN_GRAPH_ID_PATTERN =
  /^graph_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCREEN_STATE_ID_PATTERN =
  /^screenstate_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSITION_ID_PATTERN =
  /^transition_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const WIKI_NODE_ID_PATTERN =
  /^wiki_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WIKI_LINK_ID_PATTERN =
  /^wikilink_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KNOWLEDGE_COLLECTION_ID_PATTERN =
  /^collection_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESOURCE_KIND_PATTERN = /^[a-z][a-z0-9._-]*$/;
const VALIDATION_RUN_ID_PATTERN =
  /^validationrun_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALIDATION_FINDING_ID_PATTERN =
  /^finding_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUILD_DIFF_ID_PATTERN =
  /^builddiff_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUILD_ID_PATTERN =
  /^build_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_ID_PATTERN = /^commit:sha256:[0-9a-f]{64}$/;
const REF_NAME_PATTERN =
  /^(?:users|teams|builds|baselines|releases)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/;
const PACK_MEDIA_TYPE = "application/vnd.vistrea-pack";
const OBJECT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const MAXIMUM_ASSET_BASE64_CHARACTERS = 8 * 1024 * 1024;

export const HOST_LOCAL_API_ENVIRONMENT = {
  url: "VISTREA_HOST_URL",
  token: "VISTREA_HOST_TOKEN",
  timeoutMilliseconds: "VISTREA_HOST_TIMEOUT_MS",
  maximumResponseBytes: "VISTREA_HOST_MAX_RESPONSE_BYTES",
} as const;

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
          ["name", "kind", "canvas_size", "pixel_size", "asset_hash", "source", "created_by"],
          "Design reference input",
          true,
        );
        if (
          command["name"] === undefined ||
          command["kind"] === undefined ||
          command["canvas_size"] === undefined ||
          command["pixel_size"] === undefined ||
          command["asset_hash"] === undefined ||
          command["created_by"] === undefined
        ) {
          throw invalidInput();
        }
        const value = await this.#request("POST", "/v1/design-references", command, 201, options);
        return validateIdentifiedResource(value, "design_reference_id", DESIGN_REFERENCE_ID_PATTERN);
      }
      case "PromoteVisualBaseline": {
        const command = assertExactObject(
          input,
          ["snapshot_id", "name", "created_by"],
          "Visual baseline input",
        );
        if (
          typeof command["snapshot_id"] !== "string" ||
          !SNAPSHOT_ID_PATTERN.test(command["snapshot_id"]) ||
          typeof command["name"] !== "string" ||
          command["name"].length === 0
        ) {
          throw invalidInput();
        }
        const value = await this.#request("POST", "/v1/design-baselines", command, 201, options);
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
      case "ListDesignReferences": {
        const query = normalizeListInput(input);
        const parameters = pageParameters(query);
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request(
          "GET",
          `/v1/design-references${suffix}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResourcePage(value, "design_reference_id", DESIGN_REFERENCE_ID_PATTERN);
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
          ["design_reference_id", "target_snapshot_id", "completed_by", "include_pixel"],
          "Design comparison input",
          true,
        );
        if (
          command["design_reference_id"] === undefined ||
          command["target_snapshot_id"] === undefined ||
          command["completed_by"] === undefined ||
          (command["include_pixel"] !== undefined && typeof command["include_pixel"] !== "boolean")
        ) {
          throw invalidInput();
        }
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
      case "ListDesignComparisons": {
        const query = assertExactObject(
          input,
          ["design_reference_id", "target_snapshot_id", "limit", "cursor"],
          "Design comparison listing",
          true,
        );
        if (
          (query["design_reference_id"] !== undefined &&
            (typeof query["design_reference_id"] !== "string" ||
              !DESIGN_REFERENCE_ID_PATTERN.test(query["design_reference_id"]))) ||
          (query["target_snapshot_id"] !== undefined &&
            (typeof query["target_snapshot_id"] !== "string" ||
              !SNAPSHOT_ID_PATTERN.test(query["target_snapshot_id"])))
        ) {
          throw invalidInput();
        }
        const parameters = pageParameters(query);
        if (query["design_reference_id"] !== undefined) {
          parameters.set("design_reference_id", query["design_reference_id"] as string);
        }
        if (query["target_snapshot_id"] !== undefined) {
          parameters.set("target_snapshot_id", query["target_snapshot_id"] as string);
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request(
          "GET",
          `/v1/design-comparisons${suffix}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResourcePage(value, "comparison_id", COMPARISON_ID_PATTERN);
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
      case "CreateReviewIssueFromDifference": {
        const command = assertExactObject(
          input,
          ["comparison_id", "difference_id", "title", "description", "created_by"],
          "Design difference issue input",
          true,
        );
        const comparisonId = command["comparison_id"];
        const differenceId = command["difference_id"];
        if (
          typeof comparisonId !== "string" ||
          !COMPARISON_ID_PATTERN.test(comparisonId) ||
          typeof differenceId !== "string" ||
          !DIFFERENCE_ID_PATTERN.test(differenceId)
        ) {
          throw invalidInput();
        }
        const { comparison_id: _omitted, ...body } = command;
        const value = await this.#request(
          "POST",
          `/v1/design-comparisons/${encodeURIComponent(comparisonId)}/issues`,
          body,
          201,
          options,
        );
        return validateIdentifiedResource(value, "issue_id", ISSUE_ID_PATTERN);
      }
      case "ListReviewIssues": {
        const query = assertExactObject(
          input,
          ["states", "design_reference_id", "screen_state_id", "limit", "cursor"],
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
        const screenStateId = query["screen_state_id"];
        if (screenStateId !== undefined) {
          if (typeof screenStateId !== "string" || !SCREEN_STATE_ID_PATTERN.test(screenStateId)) {
            throw invalidInput();
          }
          parameters.set("screen_state_id", screenStateId);
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
      case "RecaptureAndVerifyIssue": {
        const command = assertExactObject(
          input,
          ["issue_id", "expected_revision", "verified_by"],
          "Review issue recapture verification input",
        );
        const issueId = command["issue_id"];
        if (typeof issueId !== "string" || !ISSUE_ID_PATTERN.test(issueId)) {
          throw invalidInput();
        }
        const { issue_id: _omitted, ...body } = command;
        const value = requireObject(await this.#request(
          "POST",
          `/v1/review-issues/${encodeURIComponent(issueId)}/recapture-verifications`,
          body,
          201,
          options,
        ));
        validateRuntimeSnapshot(value["snapshot"] as JsonValue);
        validateIdentifiedResource(value["comparison"] as JsonValue, "comparison_id", COMPARISON_ID_PATTERN);
        validateIdentifiedResource(value["verification"] as JsonValue, "verification_record_id", VERIFICATION_ID_PATTERN);
        validateIdentifiedResource(value["issue"] as JsonValue, "issue_id", ISSUE_ID_PATTERN);
        return value;
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
      case "GenerateTuningSourceSuggestions": {
        const query = assertExactObject(input, ["patch_id"], "Tuning source suggestion input");
        const patchId = query["patch_id"];
        if (typeof patchId !== "string" || !TUNING_PATCH_ID_PATTERN.test(patchId)) {
          throw invalidInput();
        }
        const value = requireObject(await this.#request(
          "GET",
          `/v1/tuning-patches/${encodeURIComponent(patchId)}/source-suggestions`,
          undefined,
          200,
          options,
        ));
        assertKeys(value, ["patch_id", "patch_revision", "target_snapshot_id", "suggestions"]);
        if (value["patch_id"] !== patchId || !Array.isArray(value["suggestions"])) {
          throw invalidHostResult();
        }
        return value;
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
      case "RecordStateObservation": {
        const command = assertExactObject(
          input,
          ["snapshot_id", "title", "state_kind", "entry", "capture_source", "session_id"],
          "State observation input",
          true,
        );
        const snapshotId = command["snapshot_id"];
        if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/screen-graph/state-observations",
          command,
          201,
          options,
        );
        return validateStateObservationResult(value);
      }
      case "RecordTransitionObservation": {
        const command = assertExactObject(
          input,
          ["before_snapshot_id", "after_snapshot_id", "action", "capture_source", "session_id"],
          "Transition observation input",
          true,
        );
        for (const key of ["before_snapshot_id", "after_snapshot_id"]) {
          const snapshotId = command[key];
          if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
            throw invalidInput();
          }
        }
        const value = await this.#request(
          "POST",
          "/v1/screen-graph/transition-observations",
          command,
          201,
          options,
        );
        return validateTransitionObservationResult(value);
      }
      case "GetScreenGraph": {
        const query = assertExactObject(
          input,
          ["project_id", "application_id", "build_id", "application_version"],
          "Screen graph lookup",
          true,
        );
        const projectId = query["project_id"];
        const applicationId = query["application_id"];
        const buildId = query["build_id"];
        const applicationVersion = query["application_version"];
        if (
          typeof projectId !== "string" ||
          !PROJECT_ID_PATTERN.test(projectId) ||
          typeof applicationId !== "string" ||
          !APPLICATION_ID_PATTERN.test(applicationId) ||
          ((buildId === undefined) !== (applicationVersion === undefined)) ||
          (buildId !== undefined &&
            (typeof buildId !== "string" || !BUILD_ID_PATTERN.test(buildId))) ||
          (applicationVersion !== undefined &&
            (typeof applicationVersion !== "string" ||
              applicationVersion.length < 1 ||
              applicationVersion.length > 128))
        ) {
          throw invalidInput();
        }
        const parameters = new URLSearchParams();
        parameters.set("project_id", projectId);
        parameters.set("application_id", applicationId);
        if (typeof buildId === "string" && typeof applicationVersion === "string") {
          parameters.set("build_id", buildId);
          parameters.set("application_version", applicationVersion);
        }
        const value = await this.#request(
          "GET",
          `/v1/screen-graph?${parameters.toString()}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "screen_graph_id", SCREEN_GRAPH_ID_PATTERN);
      }
      case "GetScreenState": {
        const query = assertExactObject(
          input,
          ["screen_state_id", "build_id", "application_version"],
          "Screen state lookup",
          true,
        );
        const stateId = query["screen_state_id"];
        const buildId = query["build_id"];
        const applicationVersion = query["application_version"];
        if (
          typeof stateId !== "string" ||
          !SCREEN_STATE_ID_PATTERN.test(stateId) ||
          ((buildId === undefined) !== (applicationVersion === undefined)) ||
          (buildId !== undefined &&
            (typeof buildId !== "string" || !BUILD_ID_PATTERN.test(buildId))) ||
          (applicationVersion !== undefined &&
            (typeof applicationVersion !== "string" ||
              applicationVersion.length < 1 ||
              applicationVersion.length > 128))
        ) {
          throw invalidInput();
        }
        const parameters = new URLSearchParams();
        if (typeof buildId === "string" && typeof applicationVersion === "string") {
          parameters.set("build_id", buildId);
          parameters.set("application_version", applicationVersion);
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request(
          "GET",
          `/v1/screen-states/${encodeURIComponent(stateId)}${suffix}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "screen_state_id", SCREEN_STATE_ID_PATTERN);
      }
      case "MergeScreenStates": {
        const command = assertExactObject(
          input,
          [
            "project_id",
            "application_id",
            "state_ids",
            "into_state_id",
            "expected_graph_revision",
            "merged_by",
            "justification",
          ],
          "State merge input",
          true,
        );
        const stateIds = command["state_ids"];
        if (
          typeof command["project_id"] !== "string" ||
          !PROJECT_ID_PATTERN.test(command["project_id"]) ||
          typeof command["application_id"] !== "string" ||
          !APPLICATION_ID_PATTERN.test(command["application_id"]) ||
          command["merged_by"] === undefined ||
          !Array.isArray(stateIds) ||
          stateIds.length < 2 ||
          stateIds.length > 64 ||
          stateIds.some(
            (value) => typeof value !== "string" || !SCREEN_STATE_ID_PATTERN.test(value),
          ) ||
          (command["into_state_id"] !== undefined &&
            (typeof command["into_state_id"] !== "string" ||
              !SCREEN_STATE_ID_PATTERN.test(command["into_state_id"]))) ||
          !Number.isSafeInteger(command["expected_graph_revision"]) ||
          (command["expected_graph_revision"] as number) < 1 ||
          (command["justification"] !== undefined &&
            (typeof command["justification"] !== "string" ||
              command["justification"].length === 0 ||
              command["justification"].length > 1024))
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/screen-graph/state-merges",
          command,
          201,
          options,
        );
        return validateIdentityCuration(value);
      }
      case "SplitScreenState": {
        const command = assertExactObject(
          input,
          [
            "project_id",
            "application_id",
            "state_id",
            "observation_ids",
            "title",
            "expected_graph_revision",
            "split_by",
            "justification",
          ],
          "State split input",
          true,
        );
        const observationIds = command["observation_ids"];
        if (
          typeof command["project_id"] !== "string" ||
          !PROJECT_ID_PATTERN.test(command["project_id"]) ||
          typeof command["application_id"] !== "string" ||
          !APPLICATION_ID_PATTERN.test(command["application_id"]) ||
          command["split_by"] === undefined ||
          typeof command["state_id"] !== "string" ||
          !SCREEN_STATE_ID_PATTERN.test(command["state_id"]) ||
          !Array.isArray(observationIds) ||
          observationIds.length === 0 ||
          observationIds.length > 256 ||
          observationIds.some(
            (value) => typeof value !== "string" || !OBSERVATION_ID_PATTERN.test(value),
          ) ||
          !Number.isSafeInteger(command["expected_graph_revision"]) ||
          (command["expected_graph_revision"] as number) < 1 ||
          (command["title"] !== undefined &&
            (typeof command["title"] !== "string" ||
              command["title"].length === 0 ||
              command["title"].length > 512)) ||
          (command["justification"] !== undefined &&
            (typeof command["justification"] !== "string" ||
              command["justification"].length === 0 ||
              command["justification"].length > 1024))
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/screen-graph/state-splits",
          command,
          201,
          options,
        );
        return validateIdentityCuration(value);
      }
      case "AnnotateScreenState": {
        const command = assertExactObject(
          input,
          [
            "project_id",
            "application_id",
            "state_id",
            "labels",
            "summary",
            "expected_graph_revision",
            "annotated_by",
          ],
          "State annotation input",
          true,
        );
        const labels = command["labels"];
        if (
          typeof command["project_id"] !== "string" ||
          !PROJECT_ID_PATTERN.test(command["project_id"]) ||
          typeof command["application_id"] !== "string" ||
          !APPLICATION_ID_PATTERN.test(command["application_id"]) ||
          command["annotated_by"] === undefined ||
          typeof command["state_id"] !== "string" ||
          !SCREEN_STATE_ID_PATTERN.test(command["state_id"]) ||
          !Number.isSafeInteger(command["expected_graph_revision"]) ||
          (command["expected_graph_revision"] as number) < 1 ||
          (labels === undefined && command["summary"] === undefined) ||
          (labels !== undefined &&
            (!Array.isArray(labels) ||
              labels.length > 32 ||
              labels.some(
                (value) => typeof value !== "string" || value.length === 0 || value.length > 128,
              ))) ||
          (command["summary"] !== undefined &&
            (typeof command["summary"] !== "string" || command["summary"].length > 280))
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/screen-graph/state-annotations",
          command,
          200,
          options,
        );
        return validateStateAnnotation(value);
      }
      case "TagGraphVersion": {
        const command = assertExactObject(
          input,
          ["project_id", "application_id", "tag_name"],
          "Graph version tag input",
        );
        if (
          typeof command["project_id"] !== "string" ||
          !PROJECT_ID_PATTERN.test(command["project_id"]) ||
          typeof command["application_id"] !== "string" ||
          !APPLICATION_ID_PATTERN.test(command["application_id"]) ||
          typeof command["tag_name"] !== "string" ||
          !TAG_NAME_PATTERN.test(command["tag_name"])
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/screen-graph/version-tags",
          command,
          201,
          options,
        );
        const version = requireObject(value);
        assertKeys(version, [
          "tag_name",
          "screen_graph_id",
          "source_graph_id",
          "revision",
          "state_count",
          "transition_count",
        ]);
        return version;
      }
      case "FindScreenPath": {
        const query = assertExactObject(
          input,
          ["source_state_id", "target_state_id", "graph_id", "maximum_depth", "maximum_paths"],
          "Screen path query",
          true,
        );
        for (const key of ["source_state_id", "target_state_id"]) {
          const stateId = query[key];
          if (typeof stateId !== "string" || !SCREEN_STATE_ID_PATTERN.test(stateId)) {
            throw invalidInput();
          }
        }
        const graphId = query["graph_id"];
        if (
          graphId !== undefined &&
          (typeof graphId !== "string" || !SCREEN_GRAPH_ID_PATTERN.test(graphId))
        ) {
          throw invalidInput();
        }
        const depth = query["maximum_depth"];
        if (depth !== undefined && (!Number.isSafeInteger(depth) || (depth as number) < 0)) {
          throw invalidInput();
        }
        const maximumPaths = query["maximum_paths"];
        if (
          maximumPaths !== undefined &&
          (!Number.isSafeInteger(maximumPaths) || (maximumPaths as number) < 1)
        ) {
          throw invalidInput();
        }
        const parameters = new URLSearchParams();
        parameters.set("source_state_id", query["source_state_id"] as string);
        parameters.set("target_state_id", query["target_state_id"] as string);
        if (graphId !== undefined) {
          parameters.set("graph_id", graphId as string);
        }
        if (depth !== undefined) {
          parameters.set("maximum_depth", String(depth));
        }
        if (maximumPaths !== undefined) {
          parameters.set("maximum_paths", String(maximumPaths));
        }
        const value = await this.#request(
          "GET",
          `/v1/screen-graph/paths?${parameters.toString()}`,
          undefined,
          200,
          options,
        );
        return validateScreenPathResult(value);
      }
      case "CreateWikiNode": {
        const command = assertExactObject(
          input,
          ["kind", "title", "slug", "summary", "markdown", "labels", "related_resources", "created_by"],
          "Wiki node input",
          true,
        );
        const value = await this.#request("POST", "/v1/wiki/nodes", command, 201, options, undefined, MAXIMUM_WIKI_REQUEST_BYTES);
        return validateIdentifiedResource(value, "wiki_node_id", WIKI_NODE_ID_PATTERN);
      }
      case "UpdateWikiNode": {
        const command = assertExactObject(
          input,
          [
            "wiki_node_id",
            "expected_revision",
            "title",
            "summary",
            "markdown",
            "labels",
            "related_resources",
            "to_status",
            "updated_by",
          ],
          "Wiki node revision input",
          true,
        );
        const nodeId = command["wiki_node_id"];
        if (typeof nodeId !== "string" || !WIKI_NODE_ID_PATTERN.test(nodeId)) {
          throw invalidInput();
        }
        const { wiki_node_id: _nodeId, ...body } = command;
        const value = await this.#request(
          "POST",
          `/v1/wiki/nodes/${encodeURIComponent(nodeId)}/revisions`,
          body,
          200,
          options,
          undefined,
          MAXIMUM_WIKI_REQUEST_BYTES,
        );
        return validateIdentifiedResource(value, "wiki_node_id", WIKI_NODE_ID_PATTERN);
      }
      case "GetWikiNode": {
        const query = assertExactObject(input, ["wiki_node_id"], "Wiki node lookup");
        const nodeId = query["wiki_node_id"];
        if (typeof nodeId !== "string" || !WIKI_NODE_ID_PATTERN.test(nodeId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/wiki/nodes/${encodeURIComponent(nodeId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "wiki_node_id", WIKI_NODE_ID_PATTERN);
      }
      case "ListWikiNodes": {
        const query = assertExactObject(
          input,
          ["text", "kinds", "labels", "statuses", "limit", "cursor"],
          "Wiki search input",
          true,
        );
        const parameters = new URLSearchParams();
        for (const key of ["text", "cursor"] as const) {
          const value = query[key];
          if (value !== undefined) {
            if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
              throw invalidInput();
            }
            parameters.set(key, value);
          }
        }
        for (const key of ["kinds", "labels", "statuses"] as const) {
          const value = query[key];
          if (value !== undefined) {
            if (
              !Array.isArray(value) ||
              value.length === 0 ||
              value.length > 16 ||
              !value.every(
                (entry) => typeof entry === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(entry),
              )
            ) {
              throw invalidInput();
            }
            parameters.set(key, value.join(","));
          }
        }
        const limit = query["limit"];
        if (limit !== undefined) {
          if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 500) {
            throw invalidInput();
          }
          parameters.set("limit", String(limit));
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request("GET", `/v1/wiki/nodes${suffix}`, undefined, 200, options);
        return validateWikiNodePage(value);
      }
      case "LinkWikiNode": {
        const command = assertExactObject(
          input,
          ["source_node_id", "target", "relation", "label", "annotation", "created_by"],
          "Wiki link input",
          true,
        );
        const sourceId = command["source_node_id"];
        if (typeof sourceId !== "string" || !WIKI_NODE_ID_PATTERN.test(sourceId)) {
          throw invalidInput();
        }
        const value = await this.#request("POST", "/v1/wiki/links", command, 201, options);
        return validateIdentifiedResource(value, "wiki_link_id", WIKI_LINK_ID_PATTERN);
      }
      case "UnlinkWikiNode": {
        const command = assertExactObject(
          input,
          ["wiki_link_id", "expected_revision"],
          "Wiki unlink input",
        );
        const linkId = command["wiki_link_id"];
        if (
          typeof linkId !== "string" ||
          !WIKI_LINK_ID_PATTERN.test(linkId) ||
          !Number.isSafeInteger(command["expected_revision"])
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          `/v1/wiki/links/${encodeURIComponent(linkId)}/unlink`,
          { expected_revision: command["expected_revision"] as number },
          200,
          options,
        );
        const result = requireObject(value);
        assertKeys(result, ["unlinked"]);
        if (result["unlinked"] !== true) {
          throw invalidHostResult();
        }
        return result;
      }
      case "GetWikiBacklinks": {
        const query = assertExactObject(
          input,
          ["wiki_node_id", "limit", "cursor"],
          "Wiki backlink lookup",
          true,
        );
        const nodeId = query["wiki_node_id"];
        if (typeof nodeId !== "string" || !WIKI_NODE_ID_PATTERN.test(nodeId)) {
          throw invalidInput();
        }
        const parameters = pageParameters(query);
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request(
          "GET",
          `/v1/wiki/nodes/${encodeURIComponent(nodeId)}/backlinks${suffix}`,
          undefined,
          200,
          options,
        );
        return validateWikiLinkPage(value);
      }
      case "GetRelatedWikiNodes": {
        const query = assertExactObject(
          input,
          ["kind", "id", "limit", "cursor"],
          "Related wiki lookup",
          true,
        );
        const kind = query["kind"];
        const id = query["id"];
        if (
          typeof kind !== "string" ||
          !RESOURCE_KIND_PATTERN.test(kind) ||
          typeof id !== "string" ||
          id.length === 0 ||
          id.length > 320
        ) {
          throw invalidInput();
        }
        const parameters = pageParameters(query);
        parameters.set("kind", kind);
        parameters.set("id", id);
        const value = await this.#request(
          "GET",
          `/v1/wiki/related?${parameters.toString()}`,
          undefined,
          200,
          options,
        );
        return validateWikiNodePage(value);
      }
      case "CreateKnowledgeCollection": {
        const command = assertExactObject(
          input,
          ["name", "summary", "node_ids", "link_ids", "entry_node_ids", "created_by"],
          "Knowledge Collection input",
          true,
        );
        const value = await this.#request(
          "POST",
          "/v1/knowledge-collections",
          command,
          201,
          options,
        );
        return validateIdentifiedResource(
          value,
          "collection_id",
          KNOWLEDGE_COLLECTION_ID_PATTERN,
        );
      }
      case "UpdateKnowledgeCollection": {
        const command = assertExactObject(
          input,
          [
            "collection_id",
            "expected_revision",
            "name",
            "summary",
            "node_ids",
            "link_ids",
            "entry_node_ids",
            "updated_by",
          ],
          "Knowledge Collection revision input",
          true,
        );
        const collectionId = command["collection_id"];
        if (
          typeof collectionId !== "string" ||
          !KNOWLEDGE_COLLECTION_ID_PATTERN.test(collectionId) ||
          !Number.isSafeInteger(command["expected_revision"])
        ) {
          throw invalidInput();
        }
        const { collection_id: _collectionId, ...body } = command;
        const value = await this.#request(
          "POST",
          `/v1/knowledge-collections/${encodeURIComponent(collectionId)}/revisions`,
          body,
          200,
          options,
        );
        return validateIdentifiedResource(
          value,
          "collection_id",
          KNOWLEDGE_COLLECTION_ID_PATTERN,
        );
      }
      case "GetKnowledgeCollection": {
        const query = assertExactObject(
          input,
          ["collection_id"],
          "Knowledge Collection lookup",
        );
        const collectionId = query["collection_id"];
        if (
          typeof collectionId !== "string" ||
          !KNOWLEDGE_COLLECTION_ID_PATTERN.test(collectionId)
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/knowledge-collections/${encodeURIComponent(collectionId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(
          value,
          "collection_id",
          KNOWLEDGE_COLLECTION_ID_PATTERN,
        );
      }
      case "ListKnowledgeCollections": {
        const query = assertExactObject(
          input,
          ["text", "publication_states", "limit", "cursor"],
          "Knowledge Collection list input",
          true,
        );
        const parameters = pageParameters(query);
        const text = query["text"];
        if (text !== undefined) {
          if (typeof text !== "string" || text.length === 0 || text.length > 4_096) {
            throw invalidInput();
          }
          parameters.set("text", text);
        }
        const states = query["publication_states"];
        if (states !== undefined) {
          if (
            !Array.isArray(states) ||
            states.length === 0 ||
            states.some(
              (state) =>
                typeof state !== "string" ||
                !["draft", "published", "archived"].includes(state),
            )
          ) {
            throw invalidInput();
          }
          parameters.set("publication_states", states.join(","));
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request(
          "GET",
          `/v1/knowledge-collections${suffix}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResourcePage(
          value,
          "collection_id",
          KNOWLEDGE_COLLECTION_ID_PATTERN,
        );
      }
      case "PublishKnowledgeCollection": {
        const command = assertExactObject(
          input,
          [
            "collection_id",
            "expected_revision",
            "base_commit_id",
            "target_ref_name",
            "ref_precondition",
            "published_by",
            "message",
          ],
          "Knowledge Collection publication input",
          true,
        );
        const collectionId = command["collection_id"];
        if (
          typeof collectionId !== "string" ||
          !KNOWLEDGE_COLLECTION_ID_PATTERN.test(collectionId) ||
          !Number.isSafeInteger(command["expected_revision"]) ||
          typeof command["base_commit_id"] !== "string" ||
          !COMMIT_ID_PATTERN.test(command["base_commit_id"] as string) ||
          typeof command["target_ref_name"] !== "string" ||
          !REF_NAME_PATTERN.test(command["target_ref_name"] as string)
        ) {
          throw invalidInput();
        }
        validateRefPreconditionInput(command["ref_precondition"]);
        const { collection_id: _collectionId, ...body } = command;
        const value = await this.#request(
          "POST",
          `/v1/knowledge-collections/${encodeURIComponent(collectionId)}/publication`,
          body,
          201,
          options,
        );
        return validateKnowledgePublicationResult(value, collectionId);
      }
      case "ExportKnowledgeCollection": {
        const command = assertExactObject(
          input,
          ["collection_id", "formats"],
          "Knowledge Collection export input",
          true,
        );
        const collectionId = command["collection_id"];
        const formats = command["formats"];
        if (
          typeof collectionId !== "string" ||
          !KNOWLEDGE_COLLECTION_ID_PATTERN.test(collectionId) ||
          (formats !== undefined &&
            (!Array.isArray(formats) ||
              formats.length === 0 ||
              new Set(formats).size !== formats.length ||
              formats.some(
                (format) =>
                  typeof format !== "string" || !["markdown", "html"].includes(format),
              )))
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          `/v1/knowledge-collections/${encodeURIComponent(collectionId)}/exports`,
          formats === undefined ? {} : { formats },
          201,
          options,
        );
        return validateKnowledgeExportResult(value, collectionId);
      }
      case "ValidateSnapshot": {
        const command = assertExactObject(
          input,
          ["snapshot_id", "categories", "configuration"],
          "Snapshot validation input",
          true,
        );
        const snapshotId = command["snapshot_id"];
        if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
          throw invalidInput();
        }
        validateValidationConfigurationInput(command["configuration"]);
        const value = await this.#request(
          "POST",
          "/v1/validation/snapshot-runs",
          command,
          201,
          options,
        );
        return validateValidationOutcome(value);
      }
      case "ValidateScreenGraph": {
        const command = assertExactObject(
          input,
          ["project_id", "application_id", "configuration"],
          "Screen graph validation input",
          true,
        );
        validateValidationConfigurationInput(command["configuration"]);
        const projectId = command["project_id"];
        const applicationId = command["application_id"];
        if (
          typeof projectId !== "string" ||
          !PROJECT_ID_PATTERN.test(projectId) ||
          typeof applicationId !== "string" ||
          !APPLICATION_ID_PATTERN.test(applicationId)
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/validation/graph-runs",
          command,
          201,
          options,
        );
        return validateValidationOutcome(value);
      }
      case "GetValidationRun": {
        const query = assertExactObject(input, ["validation_run_id"], "Validation run lookup");
        const runId = query["validation_run_id"];
        if (typeof runId !== "string" || !VALIDATION_RUN_ID_PATTERN.test(runId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/validation/runs/${encodeURIComponent(runId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "validation_run_id", VALIDATION_RUN_ID_PATTERN);
      }
      case "ListValidationFindings": {
        const query = assertExactObject(
          input,
          ["validation_run_id", "statuses", "severities", "limit", "cursor"],
          "Validation finding query",
          true,
        );
        const parameters = pageParameters(query);
        const runId = query["validation_run_id"];
        if (runId !== undefined) {
          if (typeof runId !== "string" || !VALIDATION_RUN_ID_PATTERN.test(runId)) {
            throw invalidInput();
          }
          parameters.set("validation_run_id", runId);
        }
        for (const key of ["statuses", "severities"] as const) {
          const value = query[key];
          if (value !== undefined) {
            if (
              !Array.isArray(value) ||
              value.length === 0 ||
              value.length > 8 ||
              !value.every(
                (entry) => typeof entry === "string" && /^[a-z][a-z_]{0,31}$/.test(entry),
              )
            ) {
              throw invalidInput();
            }
            parameters.set(key, value.join(","));
          }
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const value = await this.#request(
          "GET",
          `/v1/validation/findings${suffix}`,
          undefined,
          200,
          options,
        );
        return validateFindingPage(value);
      }
      case "GetValidationFinding": {
        const query = assertExactObject(input, ["finding_id"], "Validation finding lookup");
        const findingId = query["finding_id"];
        if (typeof findingId !== "string" || !VALIDATION_FINDING_ID_PATTERN.test(findingId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/validation/findings/${encodeURIComponent(findingId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "finding_id", VALIDATION_FINDING_ID_PATTERN);
      }
      case "SuppressValidationFinding": {
        const command = assertExactObject(
          input,
          [
            "finding_id",
            "expected_finding_revision",
            "reason_code",
            "justification",
            "created_by",
            "expires_at",
          ],
          "Validation suppression input",
          true,
        );
        const findingId = command["finding_id"];
        if (
          typeof findingId !== "string" ||
          !VALIDATION_FINDING_ID_PATTERN.test(findingId) ||
          !Number.isSafeInteger(command["expected_finding_revision"])
        ) {
          throw invalidInput();
        }
        const { finding_id: _findingId, ...body } = command;
        const value = await this.#request(
          "POST",
          `/v1/validation/findings/${encodeURIComponent(findingId)}/suppress`,
          body,
          200,
          options,
        );
        return validateIdentifiedResource(value, "finding_id", VALIDATION_FINDING_ID_PATTERN);
      }
      case "CompareBuilds": {
        const command = assertExactObject(
          input,
          ["project_id", "application_id", "left_build_id", "right_build_id", "baseline_tag"],
          "Build diff input",
          true,
        );
        if (
          typeof command["project_id"] !== "string" ||
          !PROJECT_ID_PATTERN.test(command["project_id"]) ||
          typeof command["application_id"] !== "string" ||
          !APPLICATION_ID_PATTERN.test(command["application_id"]) ||
          typeof command["left_build_id"] !== "string" ||
          !BUILD_ID_PATTERN.test(command["left_build_id"]) ||
          typeof command["right_build_id"] !== "string" ||
          !BUILD_ID_PATTERN.test(command["right_build_id"]) ||
          (command["baseline_tag"] !== undefined &&
            (typeof command["baseline_tag"] !== "string" ||
              !TAG_NAME_PATTERN.test(command["baseline_tag"])))
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/validation/build-diffs",
          command,
          201,
          options,
        );
        return validateIdentifiedResource(value, "build_diff_id", BUILD_DIFF_ID_PATTERN);
      }
      case "GetBuildDiff": {
        const query = assertExactObject(input, ["build_diff_id"], "Build diff lookup");
        const diffId = query["build_diff_id"];
        if (typeof diffId !== "string" || !BUILD_DIFF_ID_PATTERN.test(diffId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/validation/build-diffs/${encodeURIComponent(diffId)}`,
          undefined,
          200,
          options,
        );
        return validateIdentifiedResource(value, "build_diff_id", BUILD_DIFF_ID_PATTERN);
      }
      case "ExportPack": {
        const command = assertExactObject(
          input,
          ["ref_names", "commit_ids", "prerequisite_commit_ids", "created_by", "message"],
          "Pack export input",
          true,
        );
        for (const key of ["commit_ids", "prerequisite_commit_ids"] as const) {
          const values = command[key];
          if (values !== undefined) {
            if (
              !Array.isArray(values) ||
              values.length > 64 ||
              !values.every(
                (entry) => typeof entry === "string" && COMMIT_ID_PATTERN.test(entry),
              )
            ) {
              throw invalidInput();
            }
          }
        }
        const refNames = command["ref_names"];
        if (refNames !== undefined) {
          if (
            !Array.isArray(refNames) ||
            refNames.length > 64 ||
            !refNames.every(
              (entry) => typeof entry === "string" && REF_NAME_PATTERN.test(entry),
            )
          ) {
            throw invalidInput();
          }
        }
        const value = await this.#request("POST", "/v1/exchange/exports", command, 201, options);
        const pack = requireObject(value);
        const hash = pack["hash"];
        if (
          typeof hash !== "string" ||
          !OBJECT_HASH_PATTERN.test(hash) ||
          pack["media_type"] !== PACK_MEDIA_TYPE
        ) {
          throw invalidHostResult();
        }
        return pack;
      }
      case "ImportPack": {
        const upload = assertExactObject(input, ["pack_base64"], "Pack import input");
        const packBase64 = upload["pack_base64"];
        if (
          typeof packBase64 !== "string" ||
          packBase64.length === 0 ||
          packBase64.length > MAXIMUM_ASSET_BASE64_CHARACTERS
        ) {
          throw invalidInput();
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(packBase64, "base64");
        } catch {
          throw invalidInput();
        }
        if (bytes.byteLength === 0 || bytes.toString("base64") !== packBase64) {
          throw invalidInput();
        }
        const value = await this.#requestBinary(
          "/v1/exchange/imports",
          bytes,
          PACK_MEDIA_TYPE,
          {},
          options,
        );
        const result = requireObject(value);
        assertKeys(
          result,
          [
            "mode",
            "imported_commit_ids",
            "existing_commit_ids",
            "imported_object_hashes",
            "existing_object_hashes",
            "created_refs",
            "unchanged_ref_names",
            "conflicting_refs",
          ],
        );
        if (result["mode"] !== "full" && result["mode"] !== "thin") {
          throw invalidHostResult();
        }
        return result;
      }
      case "GetObject": {
        const query = assertExactObject(input, ["hash"], "Object lookup");
        const hash = query["hash"];
        if (typeof hash !== "string" || !OBJECT_HASH_PATTERN.test(hash)) {
          throw invalidInput();
        }
        return await this.#requestObject(hash, options);
      }
      case "RunExploration": {
        const command = assertExactObject(
          input,
          [
            "maximum_actions",
            "maximum_depth",
            "settle_milliseconds",
            "application_id",
            "maximum_recovery_attempts",
            "excluded_stable_ids",
            "actor_id",
          ],
          "Exploration input",
          true,
        );
        const maximumActions = command["maximum_actions"];
        const maximumDepth = command["maximum_depth"];
        const settle = command["settle_milliseconds"];
        const applicationId = command["application_id"];
        const maximumRecoveryAttempts = command["maximum_recovery_attempts"];
        const excluded = command["excluded_stable_ids"];
        const actorId = command["actor_id"];
        if (
          !Number.isSafeInteger(maximumActions) ||
          (maximumActions as number) < 1 ||
          (maximumActions as number) > 500 ||
          (maximumDepth !== undefined &&
            (!Number.isSafeInteger(maximumDepth) ||
              (maximumDepth as number) < 1 ||
              (maximumDepth as number) > 32)) ||
          (settle !== undefined &&
            (!Number.isSafeInteger(settle) ||
              (settle as number) < 0 ||
              (settle as number) > 60_000)) ||
          (applicationId !== undefined &&
            (typeof applicationId !== "string" ||
              applicationId.length === 0 ||
              applicationId.length > 256)) ||
          (maximumRecoveryAttempts !== undefined &&
            (!Number.isSafeInteger(maximumRecoveryAttempts) ||
              (maximumRecoveryAttempts as number) < 0 ||
              (maximumRecoveryAttempts as number) > 5)) ||
          (excluded !== undefined &&
            (!Array.isArray(excluded) ||
              excluded.length > 128 ||
              excluded.some(
                (value) => typeof value !== "string" || value.length === 0 || value.length > 256,
              ))) ||
          (actorId !== undefined &&
            (typeof actorId !== "string" || actorId.length === 0 || actorId.length > 256))
        ) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          "/v1/exploration/operations",
          command,
          201,
          options,
        );
        return validateOperationRef(value);
      }
      case "GetExplorationOperation": {
        const query = assertExactObject(input, ["operation_id"], "Exploration operation lookup");
        const operationId = query["operation_id"];
        if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "GET",
          `/v1/exploration/operations/${encodeURIComponent(operationId)}`,
          undefined,
          200,
          options,
        );
        return validateOperationRecord(value);
      }
      case "CancelExploration": {
        const command = assertExactObject(input, ["operation_id"], "Exploration cancel input");
        const operationId = command["operation_id"];
        if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
          throw invalidInput();
        }
        const value = await this.#request(
          "POST",
          `/v1/exploration/operations/${encodeURIComponent(operationId)}/cancel`,
          undefined,
          200,
          options,
        );
        return validateOperationRef(value);
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
        return unreachableOperation(operation);
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
    maximumBodyBytes: number = MAXIMUM_REQUEST_BYTES,
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
      if (Buffer.byteLength(encodedBody, "utf8") > maximumBodyBytes) {
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

  /** Downloads one content-addressed object and proves its digest. */
  async #requestObject(hash: string, options: HostRequestOptions): Promise<JsonObject> {
    const timeoutMilliseconds = normalizeIntegerOption(
      options.timeoutMilliseconds ?? this.#timeoutMilliseconds,
      1,
      MAXIMUM_TIMEOUT_MILLISECONDS,
    );
    const requestId = normalizeContextId(options.requestId, "request");
    const traceId = normalizeContextId(options.traceId, "trace");
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
      const response = await fetch(`${this.#baseUrl}/v1/objects/${encodeURIComponent(hash)}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#bearerToken}`,
          ...(requestId === undefined ? {} : { "x-vistrea-request-id": requestId }),
          ...(traceId === undefined ? {} : { "x-vistrea-trace-id": traceId }),
        },
      });
      if (response.status !== 200) {
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
        throw parseHostError(value, response.status, this.#bearerToken);
      }
      const mediaType = response.headers.get("content-type");
      if (mediaType === null || !MEDIA_TYPE_PATTERN.test(mediaType)) {
        await cancelResponseBody(response);
        throw new HostClientError(
          "integrity_error",
          "The Host returned an invalid object content type.",
        );
      }
      const bytes = await readBoundedBytesResponse(response, this.#maximumResponseBytes);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== hash) {
        throw new HostClientError(
          "integrity_error",
          "The Host object bytes do not match the requested hash.",
        );
      }
      return {
        hash,
        media_type: mediaType,
        byte_size: bytes.byteLength,
        bytes_base64: bytes.toString("base64"),
      };
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

function unreachableOperation(operation: never): never {
  throw new HostClientError(
    "unsupported",
    `The Host operation is not implemented: ${String(operation)}.`,
  );
}

/** The byte-body sibling of readBoundedJsonResponse for object downloads. */
async function readBoundedBytesResponse(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
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
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await cancelResponseBody(response);
      throw responseTooLarge();
    }
    expectedByteLength = length;
  }
  if (response.body === null) {
    throw new HostClientError("integrity_error", "The Host returned an empty object body.");
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
  if (expectedByteLength !== undefined && total !== expectedByteLength) {
    throw new HostClientError(
      "integrity_error",
      "The Host response body length does not match Content-Length.",
    );
  }
  return Buffer.concat(chunks, total);
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

function validateValidationConfigurationInput(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const configuration = assertExactObject(
    value,
    ["disabled_rules", "minimum_touch_target_points"],
    "Validation configuration",
    true,
  );
  const disabled = configuration["disabled_rules"];
  const threshold = configuration["minimum_touch_target_points"];
  if (
    (disabled !== undefined &&
      (!Array.isArray(disabled) ||
        disabled.length > 16 ||
        disabled.some(
          (rule) => typeof rule !== "string" || rule.length === 0 || rule.length > 128,
        ))) ||
    (threshold !== undefined &&
      (typeof threshold !== "number" ||
        !Number.isFinite(threshold) ||
        threshold < 1 ||
        threshold > 200))
  ) {
    throw invalidInput();
  }
}

function validateStateAnnotation(value: JsonValue): JsonObject {
  const result = requireObject(value);
  assertKeys(result, ["screen_graph_id", "graph_revision", "state"]);
  const graphId = result["screen_graph_id"];
  const revision = result["graph_revision"];
  if (
    typeof graphId !== "string" ||
    !SCREEN_GRAPH_ID_PATTERN.test(graphId) ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 1
  ) {
    throw invalidHostResult();
  }
  requireObject(result["state"]);
  return result;
}

function validateIdentityCuration(value: JsonValue): JsonObject {
  const result = requireObject(value);
  assertKeys(result, ["screen_graph_id", "graph_revision", "decision", "state"]);
  const graphId = result["screen_graph_id"];
  const revision = result["graph_revision"];
  if (
    typeof graphId !== "string" ||
    !SCREEN_GRAPH_ID_PATTERN.test(graphId) ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 1
  ) {
    throw invalidHostResult();
  }
  requireObject(result["decision"]);
  requireObject(result["state"]);
  return result;
}

function validateOperationRef(value: JsonValue): JsonObject {
  const ref = requireObject(value);
  assertKeys(
    ref,
    ["operation_id", "kind", "state", "created_at", "updated_at", "progress", "result_ref", "error"],
    true,
  );
  if (
    typeof ref["operation_id"] !== "string" ||
    !OPERATION_ID_PATTERN.test(ref["operation_id"]) ||
    typeof ref["kind"] !== "string" ||
    ref["kind"].length === 0 ||
    ref["kind"].length > 128 ||
    typeof ref["state"] !== "string" ||
    !OPERATION_STATES.has(ref["state"]) ||
    typeof ref["created_at"] !== "string" ||
    typeof ref["updated_at"] !== "string"
  ) {
    throw invalidHostResult();
  }
  return ref;
}

function validateOperationRecord(value: JsonValue): JsonObject {
  const record = requireObject(value);
  assertKeys(
    record,
    ["protocol_version", "operation", "revision", "events", "result", "extensions"],
    true,
  );
  const revision = record["revision"];
  const events = record["events"];
  if (
    record["operation"] === undefined ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 1 ||
    !Array.isArray(events) ||
    events.length === 0
  ) {
    throw invalidHostResult();
  }
  validateOperationRef(record["operation"] as JsonValue);
  return record;
}

function validateWorkspaceStatus(value: JsonValue): JsonObject {
  const status = requireObject(value);
  assertKeys(
    status,
    ["status", "runtime_connected", "runtime_events", "tuning_reversions", "workspace_id", "message"],
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
  const reversions = status["tuning_reversions"];
  if (reversions !== undefined) {
    const record = requireObject(reversions);
    assertKeys(record, ["recorded", "failed"]);
    if (
      !Number.isSafeInteger(record["recorded"]) ||
      (record["recorded"] as number) < 0 ||
      !Number.isSafeInteger(record["failed"]) ||
      (record["failed"] as number) < 0
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

function validateRefPreconditionInput(value: JsonValue | undefined): void {
  const precondition = requireObject(value);
  const mode = precondition["mode"];
  if (mode === "must_match") {
    assertKeys(precondition, ["mode", "expected_commit_id"]);
    if (
      typeof precondition["expected_commit_id"] !== "string" ||
      !COMMIT_ID_PATTERN.test(precondition["expected_commit_id"])
    ) {
      throw invalidInput();
    }
    return;
  }
  if (mode === "must_not_exist") {
    assertKeys(precondition, ["mode"]);
    return;
  }
  if (mode === "force") {
    assertKeys(precondition, ["mode", "authorization"]);
    requireObject(precondition["authorization"]);
    return;
  }
  throw invalidInput();
}

function validateKnowledgePublicationResult(
  value: JsonValue,
  expectedCollectionId: string,
): JsonObject {
  const result = requireObject(value);
  assertKeys(result, ["collection", "commit", "ref", "bundle_root"]);
  const collection = validateIdentifiedResource(
    result["collection"] as JsonValue,
    "collection_id",
    KNOWLEDGE_COLLECTION_ID_PATTERN,
  );
  const commit = requireObject(result["commit"]);
  const ref = requireObject(result["ref"]);
  const commitId = commit["commit_id"];
  if (
    collection["collection_id"] !== expectedCollectionId ||
    typeof commitId !== "string" ||
    !COMMIT_ID_PATTERN.test(commitId) ||
    !isObject(commit["manifest"]) ||
    typeof ref["name"] !== "string" ||
    !REF_NAME_PATTERN.test(ref["name"]) ||
    ref["commit_id"] !== commitId ||
    !Number.isSafeInteger(ref["revision"])
  ) {
    throw invalidHostResult();
  }
  const publication = requireObject(collection["publication"]);
  if (publication["state"] !== "published" || publication["commit_id"] !== commitId) {
    throw invalidHostResult();
  }
  validateObjectRef(result["bundle_root"] as JsonValue);
  return result;
}

function validateKnowledgeExportResult(
  value: JsonValue,
  expectedCollectionId: string,
): JsonObject {
  const result = requireObject(value);
  assertKeys(result, ["collection_id", "objects"]);
  const objects = result["objects"];
  if (
    result["collection_id"] !== expectedCollectionId ||
    !Array.isArray(objects) ||
    objects.length === 0 ||
    objects.length > 2
  ) {
    throw invalidHostResult();
  }
  const mediaTypes = new Set<string>();
  for (const object of objects) {
    const ref = validateObjectRef(object as JsonValue);
    const mediaType = ref["media_type"];
    if (
      (mediaType !== "text/markdown" && mediaType !== "text/html") ||
      mediaTypes.has(mediaType)
    ) {
      throw invalidHostResult();
    }
    mediaTypes.add(mediaType);
  }
  return result;
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

function pageParameters(query: JsonObject): URLSearchParams {
  const parameters = new URLSearchParams();
  const limit = query["limit"];
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 500) {
      throw invalidInput();
    }
    parameters.set("limit", String(limit));
  }
  const cursor = query["cursor"];
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4_096) {
      throw invalidInput();
    }
    parameters.set("cursor", cursor);
  }
  return parameters;
}

function validateValidationOutcome(value: JsonValue): JsonObject {
  const outcome = requireObject(value);
  assertKeys(outcome, ["run", "findings"]);
  validateIdentifiedResource(
    outcome["run"] as JsonValue,
    "validation_run_id",
    VALIDATION_RUN_ID_PATTERN,
  );
  const findings = outcome["findings"];
  if (!Array.isArray(findings) || findings.length > 5_000) {
    throw invalidHostResult();
  }
  for (const finding of findings) {
    validateIdentifiedResource(
      finding as JsonValue,
      "finding_id",
      VALIDATION_FINDING_ID_PATTERN,
    );
  }
  return outcome;
}

function validateFindingPage(value: JsonValue): JsonObject {
  const page = requireObject(value);
  assertKeys(page, ["items", "next_cursor", "snapshot_version"], true);
  const items = page["items"];
  if (!Array.isArray(items) || items.length > 500) {
    throw invalidHostResult();
  }
  for (const item of items) {
    validateIdentifiedResource(item as JsonValue, "finding_id", VALIDATION_FINDING_ID_PATTERN);
  }
  return page;
}

function validateIdentifiedResourcePage(
  value: JsonValue,
  key: string,
  pattern: RegExp,
): JsonObject {
  const page = requireObject(value);
  assertKeys(page, ["items", "next_cursor", "snapshot_version"], true);
  const items = page["items"];
  if (!Array.isArray(items) || items.length > 500) {
    throw invalidHostResult();
  }
  for (const item of items) {
    validateIdentifiedResource(item as JsonValue, key, pattern);
  }
  return page;
}

function validateWikiNodePage(value: JsonValue): JsonObject {
  const page = requireObject(value);
  assertKeys(page, ["items", "next_cursor", "snapshot_version"], true);
  const items = page["items"];
  if (!Array.isArray(items) || items.length > 500) {
    throw invalidHostResult();
  }
  for (const item of items) {
    validateIdentifiedResource(item as JsonValue, "wiki_node_id", WIKI_NODE_ID_PATTERN);
  }
  return page;
}

function validateWikiLinkPage(value: JsonValue): JsonObject {
  const page = requireObject(value);
  assertKeys(page, ["items", "next_cursor", "snapshot_version"], true);
  const items = page["items"];
  if (!Array.isArray(items) || items.length > 500) {
    throw invalidHostResult();
  }
  for (const item of items) {
    validateIdentifiedResource(item as JsonValue, "wiki_link_id", WIKI_LINK_ID_PATTERN);
  }
  return page;
}

function validateStateObservationResult(value: JsonValue): JsonObject {
  const result = requireObject(value);
  assertKeys(result, [
    "screen_graph_id",
    "graph_revision",
    "screen_state",
    "observation_id",
    "created",
  ]);
  if (
    typeof result["screen_graph_id"] !== "string" ||
    !SCREEN_GRAPH_ID_PATTERN.test(result["screen_graph_id"]) ||
    typeof result["created"] !== "boolean" ||
    !Number.isSafeInteger(result["graph_revision"])
  ) {
    throw invalidHostResult();
  }
  validateIdentifiedResource(
    result["screen_state"] as JsonValue,
    "screen_state_id",
    SCREEN_STATE_ID_PATTERN,
  );
  return result;
}

function validateTransitionObservationResult(value: JsonValue): JsonObject {
  const result = requireObject(value);
  assertKeys(result, [
    "screen_graph_id",
    "graph_revision",
    "transition",
    "action_id",
    "source_state_id",
    "target_state_id",
    "observation_id",
    "created",
  ]);
  if (
    typeof result["screen_graph_id"] !== "string" ||
    !SCREEN_GRAPH_ID_PATTERN.test(result["screen_graph_id"]) ||
    typeof result["created"] !== "boolean" ||
    typeof result["source_state_id"] !== "string" ||
    !SCREEN_STATE_ID_PATTERN.test(result["source_state_id"]) ||
    typeof result["target_state_id"] !== "string" ||
    !SCREEN_STATE_ID_PATTERN.test(result["target_state_id"])
  ) {
    throw invalidHostResult();
  }
  validateIdentifiedResource(
    result["transition"] as JsonValue,
    "transition_id",
    TRANSITION_ID_PATTERN,
  );
  return result;
}

function validateScreenPathResult(value: JsonValue): JsonObject {
  const result = requireObject(value);
  assertKeys(result, ["paths"]);
  const paths = result["paths"];
  if (!Array.isArray(paths) || paths.length > 500) {
    throw invalidHostResult();
  }
  for (const pathValue of paths) {
    const path = requireObject(pathValue as JsonValue);
    assertKeys(path, ["state_ids", "transition_ids"]);
    const stateIds = path["state_ids"];
    const transitionIds = path["transition_ids"];
    if (
      !Array.isArray(stateIds) ||
      !Array.isArray(transitionIds) ||
      !stateIds.every(
        (id) => typeof id === "string" && SCREEN_STATE_ID_PATTERN.test(id),
      ) ||
      !transitionIds.every(
        (id) => typeof id === "string" && TRANSITION_ID_PATTERN.test(id),
      )
    ) {
      throw invalidHostResult();
    }
  }
  return result;
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
