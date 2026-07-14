import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { TextDecoder } from "node:util";

import {
  DataError,
  type ByteRange,
  type EventTimelineQuery,
  type JsonObject,
  type ObjectStore,
  type PageRequest,
  type ProtocolValidator,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import {
  CaptureSnapshotUseCase,
  GetEventTimelineQuery,
  GetSnapshotQuery,
  ListSnapshotsQuery,
  LoopbackTransportError,
  type CaptureSnapshotCommand,
  type RuntimeCapturePort,
  type RuntimeEventPumpStatus,
} from "../../engine/connection/index.js";
import {
  DesignAcceptanceEngine,
  DesignReviewEngine,
  TuningEngine,
  type RuntimeTuningPort,
} from "../../engine/design/index.js";
import { AutomationEngine, type AutomationProviderPort } from "../../engine/automation/index.js";
import {
  ExplorationEngine,
  ExplorationOperationEngine,
  ScreenGraphEngine,
  type RunExplorationCommand,
} from "../../engine/exploration/index.js";
import { KnowledgeEngine } from "../../engine/knowledge/index.js";
import { BuildDiffEngine, ValidationEngine } from "../../engine/validation/index.js";
import { PACK_LOGICAL_NAME, PACK_MEDIA_TYPE, PackExchangeService } from "../../data/exchange/index.js";

const DEFAULT_MAXIMUM_JSON_BODY_BYTES = 64 * 1024;
const MAXIMUM_CONFIGURED_JSON_BODY_BYTES = 1024 * 1024;
// Deep Wiki markdown may hold 262144 code points, which JSON escaping can
// expand several-fold, so wiki writes get their own body budget.
const MAXIMUM_WIKI_BODY_BYTES = 2 * 1024 * 1024;
const MAXIMUM_JSON_NESTING_DEPTH = 128;
const TOKEN_BYTES = 32;
const OBJECT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const CAPTURE_REASONS = new Set<CaptureSnapshotCommand["reason"]>([
  "manual",
  "before_action",
  "after_action",
  "review",
  "validation",
]);

export type HostLocalApiBindAddress = "127.0.0.1" | "::1";

export interface HostLocalApiDependencies {
  readonly runtime: RuntimeCapturePort;
  /** The live tuning boundary; absent when the composition is Snapshot-only. */
  readonly runtimeTuning?: RuntimeTuningPort;
  /** Reports live Runtime readiness without exposing transport state to API consumers. */
  readonly isRuntimeConnected?: () => boolean;
  /** Reports the Runtime event pump status when the Host composition runs one. */
  readonly runtimeEventsStatus?: () => RuntimeEventPumpStatus | undefined;
  /** Reports Runtime self-reversion audit counts when the composition tracks them. */
  readonly tuningReversionsStatus?: () => { recorded: number; failed: number } | undefined;
  /**
   * The device automation provider exploration runs on; absent when the
   * composition has no configured device, in which case the exploration
   * routes fail closed as unsupported.
   */
  readonly automationProvider?: AutomationProviderPort;
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly validator: ProtocolValidator;
}

export interface StartHostLocalApiOptions extends HostLocalApiDependencies {
  /** A literal loopback address is required. Hostnames and wildcard addresses fail closed. */
  readonly host: HostLocalApiBindAddress;
  /** Zero asks the operating system for an unused port. */
  readonly port?: number;
  readonly maximumJsonBodyBytes?: number;
}

export interface HostLocalApiHandle {
  readonly host: HostLocalApiBindAddress;
  readonly port: number;
  readonly baseUrl: string;
  /** Generated once for this server lifetime and never written to the Workspace. */
  readonly bearerToken: string;
  close(): Promise<void>;
}

interface HostApiErrorBody {
  readonly request_id: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

interface PublicError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

class RequestError extends Error implements PublicError {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(error: PublicError) {
    super(error.message);
    this.name = "RequestError";
    this.status = error.status;
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.headers !== undefined) {
      this.headers = error.headers;
    }
  }
}

/**
 * Starts the authenticated local HTTP adapter over public Engine and Data ports.
 *
 * The bearer token is intentionally independent from Runtime transport
 * authorization and rotates on every server start.
 */
export async function startHostLocalApi(
  options: StartHostLocalApiOptions,
): Promise<HostLocalApiHandle> {
  assertBindAddress(options.host);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new DataError("invalid_argument", "port must be an integer from 0 through 65535.");
  }
  const maximumJsonBodyBytes =
    options.maximumJsonBodyBytes ?? DEFAULT_MAXIMUM_JSON_BODY_BYTES;
  if (
    !Number.isInteger(maximumJsonBodyBytes) ||
    maximumJsonBodyBytes < 2 ||
    maximumJsonBodyBytes > MAXIMUM_CONFIGURED_JSON_BODY_BYTES
  ) {
    throw new DataError(
      "invalid_argument",
      "maximumJsonBodyBytes must be between 2 and 1048576 bytes.",
    );
  }

  assertDependencies(options);
  const bearerToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const bearerDigest = digestBearerToken(bearerToken);
  const capture = new CaptureSnapshotUseCase(options);
  const getSnapshot = new GetSnapshotQuery(options.workspace);
  const listSnapshots = new ListSnapshotsQuery(options.workspace);
  const getEventTimeline = new GetEventTimelineQuery(options.workspace);
  const design = new DesignReviewEngine(options);
  const designAcceptance = new DesignAcceptanceEngine({ capture, reviews: design });
  const tuning = new TuningEngine(options);
  const graph = new ScreenGraphEngine(options);
  const knowledge = new KnowledgeEngine(options);
  const validation = new ValidationEngine(options);
  const buildDiffs = new BuildDiffEngine(options);
  const exchange = new PackExchangeService({
    data: options.workspace,
    objects: options.objects,
    validator: options.validator,
  });
  // Version tagging freezes the materialized graph; it drives no device, so
  // it must work on a Host with no automation provider configured.
  const explorationCapture = {
    captureSnapshot: (reason: CaptureSnapshotCommand["reason"]) =>
      capture.execute({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference" as const,
        reason,
      }),
  };
  const tagging = new ExplorationEngine({
    workspace: options.workspace,
    capture: explorationCapture,
    automation: new AutomationEngine({
      workspace: options.workspace,
      validator: options.validator,
      providers: [],
    }),
    graph,
  });
  let explorationOperations: ExplorationOperationEngine | undefined;
  if (options.automationProvider !== undefined) {
    const automation = new AutomationEngine({
      workspace: options.workspace,
      validator: options.validator,
      providers: [options.automationProvider],
    });
    const exploration = new ExplorationEngine({
      workspace: options.workspace,
      capture: {
        captureSnapshot: (reason) =>
          capture.execute({
            include: { paths: ["trees", "screenshot"] },
            screenshot: "reference",
            reason,
          }),
      },
      automation,
      graph,
    });
    explorationOperations = new ExplorationOperationEngine({
      workspace: options.workspace,
      automation,
      exploration,
      providerId: options.automationProvider.descriptor.provider_id,
    });
  }
  const server = http.createServer(
    {
      maxHeaderSize: 16 * 1024,
    },
    (request, response) => {
      const requestId = createRequestId();
      void handleRequest({
        request,
        response,
        requestId,
        bearerDigest,
        maximumJsonBodyBytes,
        capture,
        getSnapshot,
        listSnapshots,
        getEventTimeline,
        design,
        designAcceptance,
        tuning,
        graph,
        knowledge,
        validation,
        buildDiffs,
        exchange,
        exploration: tagging,
        ...(explorationOperations === undefined ? {} : { explorationOperations }),
        ...(options.runtimeTuning === undefined ? {} : { runtimeTuning: options.runtimeTuning }),
        isRuntimeConnected: options.isRuntimeConnected ?? (() => true),
        runtimeEventsStatus: options.runtimeEventsStatus ?? (() => undefined),
        tuningReversionsStatus: options.tuningReversionsStatus ?? (() => undefined),
        workspace: options.workspace,
        objects: options.objects,
      }).catch((error: unknown) => sendError(response, requestId, error));
    },
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  try {
    await listen(server, options.host, port);
  } catch (error) {
    bearerDigest.fill(0);
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    bearerDigest.fill(0);
    throw new DataError("internal", "The Host Local API did not expose a TCP endpoint.");
  }
  if (address.address !== options.host) {
    await closeServer(server);
    bearerDigest.fill(0);
    throw new DataError("internal", "The Host Local API bound an unexpected address.");
  }

  let closed = false;
  return {
    host: options.host,
    port: address.port,
    baseUrl: `http://${options.host === "::1" ? `[${options.host}]` : options.host}:${address.port}`,
    bearerToken,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await closeServer(server);
      } finally {
        bearerDigest.fill(0);
      }
    },
  };
}

interface RequestHandlerContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly bearerDigest: Buffer;
  readonly maximumJsonBodyBytes: number;
  readonly capture: CaptureSnapshotUseCase;
  readonly getSnapshot: GetSnapshotQuery;
  readonly listSnapshots: ListSnapshotsQuery;
  readonly getEventTimeline: GetEventTimelineQuery;
  readonly design: DesignReviewEngine;
  readonly designAcceptance: DesignAcceptanceEngine;
  readonly tuning: TuningEngine;
  readonly graph: ScreenGraphEngine;
  readonly knowledge: KnowledgeEngine;
  readonly validation: ValidationEngine;
  readonly buildDiffs: BuildDiffEngine;
  readonly exchange: PackExchangeService;
  readonly exploration: ExplorationEngine;
  readonly explorationOperations?: ExplorationOperationEngine;
  readonly runtimeTuning?: RuntimeTuningPort;
  readonly isRuntimeConnected: () => boolean;
  readonly runtimeEventsStatus: () => RuntimeEventPumpStatus | undefined;
  readonly tuningReversionsStatus: () => { recorded: number; failed: number } | undefined;
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
}

async function handleRequest(context: RequestHandlerContext): Promise<void> {
  const { request, response } = context;
  applyCommonHeaders(response, context.requestId);
  authorize(request, context.bearerDigest);
  const url = parseRequestUrl(request);
  const pathname = url.pathname;

  if (pathname === "/v1/status") {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const health = context.workspace.checkHealth();
    const events = context.runtimeEventsStatus();
    const reversions = context.tuningReversionsStatus();
    writeJson(response, 200, {
      status: health.ok ? "ready" : "degraded",
      runtime_connected: context.isRuntimeConnected(),
      ...(events === undefined ? {} : { runtime_events: events }),
      ...(reversions === undefined ? {} : { tuning_reversions: reversions }),
      ...(health.ok ? {} : { message: "Workspace health verification reported an issue." }),
    });
    return;
  }

  if (pathname === "/v1/events") {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const timeline = context.getEventTimeline.execute(parseEventTimelineQuery(url));
    writeJson(response, 200, timeline);
    return;
  }

  if (pathname === "/v1/snapshots") {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const page = context.listSnapshots.execute(undefined, parsePageRequest(url));
    writeJson(response, 200, page);
    return;
  }

  if (pathname === "/v1/captures") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCaptureCommand(input);
    const cancellation = new AbortController();
    const cancel = (): void => cancellation.abort();
    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableEnded) {
        cancel();
      }
    });
    const snapshot = await context.capture.execute(command, { signal: cancellation.signal });
    writeJson(response, 201, snapshot);
    return;
  }

  const snapshotMatch = /^\/v1\/snapshots\/([^/]+)$/.exec(pathname);
  if (snapshotMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const snapshotId = decodeResourceSegment(snapshotMatch[1] as string, "snapshot ID");
    writeJson(response, 200, context.getSnapshot.execute(snapshotId));
    return;
  }

  if (pathname === "/v1/design-assets") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const object = await storeDesignAsset(request, context.objects);
    context.workspace.registerVerifiedObjects([object]);
    writeJson(response, 201, object as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/design-references") {
    if (request.method === "GET") {
      assertNoRequestBody(request);
      readSingleValueParameters(url, ["limit", "cursor"]);
      writeJson(
        response,
        200,
        context.design.listDesignReferences(readPageValues(url)) as unknown as JsonObject,
      );
      return;
    }
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["name", "kind", "canvas_size", "pixel_size", "asset_hash", "source", "created_by"],
      ["name", "kind", "canvas_size", "pixel_size", "asset_hash", "created_by"],
    );
    const reference = await context.design.addDesignReference(
      command as unknown as Parameters<DesignReviewEngine["addDesignReference"]>[0],
    );
    writeJson(response, 201, reference as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/design-baselines") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["snapshot_id", "name", "created_by"],
      ["snapshot_id", "name", "created_by"],
    );
    const reference = await context.design.promoteSnapshotBaseline(
      command as unknown as Parameters<DesignReviewEngine["promoteSnapshotBaseline"]>[0],
    );
    writeJson(response, 201, reference as unknown as JsonObject);
    return;
  }

  const designReferenceMatch = /^\/v1\/design-references\/([^/]+)$/.exec(pathname);
  if (designReferenceMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const referenceId = decodeResourceSegment(designReferenceMatch[1] as string, "design reference ID");
    writeJson(response, 200, context.design.getDesignReference(referenceId) as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/design-mappings") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(input, [
      "design_reference_id",
      "design_region",
      "runtime_target",
      "created_by",
    ]);
    const mapping = context.design.mapDesignRegion(
      command as unknown as Parameters<DesignReviewEngine["mapDesignRegion"]>[0],
    );
    writeJson(response, 201, mapping as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/design-comparisons") {
    if (request.method === "GET") {
      assertNoRequestBody(request);
      const values = readSingleValueParameters(url, [
        "design_reference_id",
        "target_snapshot_id",
        "limit",
        "cursor",
      ]);
      writeJson(
        response,
        200,
        context.design.listDesignComparisons(
          {
            ...(values["design_reference_id"] === undefined
              ? {}
              : { design_reference_id: values["design_reference_id"] }),
            ...(values["target_snapshot_id"] === undefined
              ? {}
              : { target_snapshot_id: values["target_snapshot_id"] }),
          },
          readPageValues(url),
        ) as unknown as JsonObject,
      );
      return;
    }
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["design_reference_id", "target_snapshot_id", "completed_by", "include_pixel"],
      ["design_reference_id", "target_snapshot_id", "completed_by"],
    );
    const comparison = await context.design.runDesignComparison(
      command as unknown as Parameters<DesignReviewEngine["runDesignComparison"]>[0],
    );
    writeJson(response, 201, comparison as unknown as JsonObject);
    return;
  }

  const designComparisonMatch = /^\/v1\/design-comparisons\/([^/]+)$/.exec(pathname);
  if (designComparisonMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const comparisonId = decodeResourceSegment(designComparisonMatch[1] as string, "comparison ID");
    writeJson(response, 200, context.design.getDesignComparison(comparisonId) as unknown as JsonObject);
    return;
  }

  const comparisonIssueMatch = /^\/v1\/design-comparisons\/([^/]+)\/issues$/.exec(pathname);
  if (comparisonIssueMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const comparisonId = decodeResourceSegment(comparisonIssueMatch[1] as string, "comparison ID");
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["difference_id", "title", "description", "created_by"],
      ["difference_id", "created_by"],
    );
    const issue = context.design.createReviewIssueFromDifference({
      ...(command as unknown as Omit<
        Parameters<DesignReviewEngine["createReviewIssueFromDifference"]>[0],
        "comparison_id"
      >),
      comparison_id: comparisonId,
    });
    writeJson(response, 201, issue as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/review-issues") {
    if (request.method === "POST") {
      assertNoSearchParameters(url);
      const input = await readJsonBody(request, context.maximumJsonBodyBytes);
      const command = parseCommandObject(
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
        [
          "design_reference_id",
          "runtime_target",
          "title",
          "category",
          "severity",
          "expected",
          "actual",
          "created_by",
        ],
      );
      const issue = context.design.createReviewIssue(
        command as unknown as Parameters<DesignReviewEngine["createReviewIssue"]>[0],
      );
      writeJson(response, 201, issue as unknown as JsonObject);
      return;
    }
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const page = context.design.listReviewIssues(
      parseReviewIssueQuery(url),
      readPageValues(url),
    );
    writeJson(response, 200, page as unknown as JsonObject);
    return;
  }

  const issueMatch = /^\/v1\/review-issues\/([^/]+)$/.exec(pathname);
  if (issueMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const issueId = decodeResourceSegment(issueMatch[1] as string, "review issue ID");
    writeJson(response, 200, context.design.getReviewIssue(issueId) as unknown as JsonObject);
    return;
  }

  const issueTransitionMatch = /^\/v1\/review-issues\/([^/]+)\/transitions$/.exec(pathname);
  if (issueTransitionMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const issueId = decodeResourceSegment(issueTransitionMatch[1] as string, "review issue ID");
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["expected_revision", "to_state", "reason", "changed_by"],
      ["expected_revision", "to_state", "changed_by"],
    );
    const issue = context.design.updateReviewIssue({
      ...(command as unknown as Omit<Parameters<DesignReviewEngine["updateReviewIssue"]>[0], "issue_id">),
      issue_id: issueId,
    });
    writeJson(response, 200, issue as unknown as JsonObject);
    return;
  }

  const issueVerificationMatch = /^\/v1\/review-issues\/([^/]+)\/verifications$/.exec(pathname);
  if (issueVerificationMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const issueId = decodeResourceSegment(issueVerificationMatch[1] as string, "review issue ID");
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      [
        "expected_revision",
        "basis",
        "result",
        "verified_snapshot_id",
        "verified_build_id",
        "rationale",
        "verified_by",
      ],
      [
        "expected_revision",
        "basis",
        "result",
        "verified_snapshot_id",
        "verified_build_id",
        "verified_by",
      ],
    );
    const result = await context.design.verifyReviewIssue({
      ...(command as unknown as Omit<Parameters<DesignReviewEngine["verifyReviewIssue"]>[0], "issue_id">),
      issue_id: issueId,
    });
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  const issueRecaptureMatch = /^\/v1\/review-issues\/([^/]+)\/recapture-verifications$/.exec(pathname);
  if (issueRecaptureMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const issueId = decodeResourceSegment(issueRecaptureMatch[1] as string, "review issue ID");
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["expected_revision", "verified_by"],
      ["expected_revision", "verified_by"],
    );
    const result = await context.designAcceptance.recaptureAndVerifyIssue({
      ...(command as unknown as Omit<
        Parameters<DesignAcceptanceEngine["recaptureAndVerifyIssue"]>[0],
        "issue_id"
      >),
      issue_id: issueId,
    });
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/tuning-patches") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["title", "description", "target_snapshot_id", "issue_ids", "changes", "status", "created_by"],
      ["title", "target_snapshot_id", "changes", "created_by"],
    );
    const patch = context.tuning.createTuningPatch(
      command as unknown as Parameters<TuningEngine["createTuningPatch"]>[0],
    );
    writeJson(response, 201, patch as unknown as JsonObject);
    return;
  }

  const tuningPatchMatch = /^\/v1\/tuning-patches\/([^/]+)$/.exec(pathname);
  if (tuningPatchMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const patchId = decodeResourceSegment(tuningPatchMatch[1] as string, "tuning patch ID");
    writeJson(response, 200, context.tuning.getTuningPatch(patchId) as unknown as JsonObject);
    return;
  }

  const tuningSuggestionMatch = /^\/v1\/tuning-patches\/([^/]+)\/source-suggestions$/.exec(pathname);
  if (tuningSuggestionMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const patchId = decodeResourceSegment(tuningSuggestionMatch[1] as string, "tuning patch ID");
    writeJson(response, 200, context.tuning.generateSourceSuggestions(patchId) as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/tuning-applications") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["patch_id", "preview_ttl_ms"],
      ["patch_id"],
    );
    const application = await context.tuning.applyTuningPatch(
      requireRuntimeTuning(context),
      command as unknown as Parameters<TuningEngine["applyTuningPatch"]>[1],
    );
    writeJson(response, 201, application as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/tuning-applications/active") {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const applications = context.tuning.listActiveTuning(
      requireRuntimeTuning(context).connectionId,
    );
    writeJson(response, 200, { items: applications } as unknown as JsonObject);
    return;
  }

  const tuningRevertMatch = /^\/v1\/tuning-applications\/([^/]+)\/revert$/.exec(pathname);
  if (tuningRevertMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const applicationId = decodeResourceSegment(
      tuningRevertMatch[1] as string,
      "tuning application ID",
    );
    const application = await context.tuning.revertTuningApplication(
      requireRuntimeTuning(context),
      { tuning_application_id: applicationId },
    );
    writeJson(response, 200, application as unknown as JsonObject);
    return;
  }

  const tuningApplicationMatch = /^\/v1\/tuning-applications\/([^/]+)$/.exec(pathname);
  if (tuningApplicationMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const applicationId = decodeResourceSegment(
      tuningApplicationMatch[1] as string,
      "tuning application ID",
    );
    writeJson(
      response,
      200,
      context.tuning.getTuningApplication(applicationId) as unknown as JsonObject,
    );
    return;
  }

  if (pathname === "/v1/screen-graph/state-observations") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["snapshot_id", "title", "state_kind", "entry", "capture_source", "session_id"],
      ["snapshot_id"],
    );
    const result = context.graph.recordStateObservation(
      command as unknown as Parameters<ScreenGraphEngine["recordStateObservation"]>[0],
    );
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/screen-graph/transition-observations") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["before_snapshot_id", "after_snapshot_id", "action", "capture_source", "session_id"],
      ["before_snapshot_id", "after_snapshot_id", "action"],
    );
    const result = context.graph.recordTransitionObservation(
      command as unknown as Parameters<ScreenGraphEngine["recordTransitionObservation"]>[0],
    );
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/screen-graph") {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const values = readSingleValueParameters(url, [
      "project_id",
      "application_id",
      "build_id",
      "application_version",
    ]);
    const projectId = values["project_id"];
    const applicationId = values["application_id"];
    if (projectId === undefined || applicationId === undefined) {
      throw invalidArgument("project_id and application_id are required.");
    }
    writeJson(
      response,
      200,
      context.graph.getGraph({
        project_id: projectId,
        application_id: applicationId,
        ...(values["build_id"] === undefined ? {} : { build_id: values["build_id"] }),
        ...(values["application_version"] === undefined
          ? {}
          : { application_version: values["application_version"] }),
      }) as unknown as JsonObject,
    );
    return;
  }

  if (pathname === "/v1/screen-graph/paths") {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const values = readSingleValueParameters(url, [
      "source_state_id",
      "target_state_id",
      "graph_id",
      "maximum_depth",
      "maximum_paths",
    ]);
    const sourceStateId = values["source_state_id"];
    const targetStateId = values["target_state_id"];
    if (sourceStateId === undefined || targetStateId === undefined) {
      throw invalidArgument("source_state_id and target_state_id are required.");
    }
    const graphId = values["graph_id"];
    // Lenient Number() would accept "", "0x10", or "1e2"; require plain decimals.
    const depthValue = values["maximum_depth"];
    if (depthValue !== undefined && !/^(?:0|[1-9][0-9]{0,4})$/.test(depthValue)) {
      throw invalidArgument("maximum_depth must be a plain decimal integer.");
    }
    const pathsValue = values["maximum_paths"];
    if (pathsValue !== undefined && !/^[1-9][0-9]{0,2}$/.test(pathsValue)) {
      throw invalidArgument("maximum_paths must be a plain decimal integer.");
    }
    const paths = context.graph.findPath({
      source_state_id: sourceStateId,
      target_state_id: targetStateId,
      ...(graphId === undefined ? {} : { graph_id: graphId }),
      ...(depthValue === undefined ? {} : { maximum_depth: Number(depthValue) }),
      ...(pathsValue === undefined ? {} : { maximum_paths: Number(pathsValue) }),
    });
    writeJson(response, 200, { paths } as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/screen-graph/version-tags") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["project_id", "application_id", "tag_name"],
      ["project_id", "application_id", "tag_name"],
      { project_id: "string", application_id: "string", tag_name: "string" },
    );
    const version = context.exploration.tagGraphVersion(
      command as unknown as Parameters<ExplorationEngine["tagGraphVersion"]>[0],
    );
    writeJson(response, 201, version as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/screen-graph/state-merges") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
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
      ["project_id", "application_id", "state_ids", "expected_graph_revision", "merged_by"],
      {
        project_id: "string",
        application_id: "string",
        state_ids: "string_array",
        into_state_id: "string",
        expected_graph_revision: "integer",
        merged_by: "object",
        justification: "string",
      },
    );
    const result = context.graph.mergeScreenStates(
      command as unknown as Parameters<ScreenGraphEngine["mergeScreenStates"]>[0],
    );
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/screen-graph/state-splits") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
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
      ["project_id", "application_id", "state_id", "observation_ids", "expected_graph_revision", "split_by"],
      {
        project_id: "string",
        application_id: "string",
        state_id: "string",
        observation_ids: "string_array",
        title: "string",
        expected_graph_revision: "integer",
        split_by: "object",
        justification: "string",
      },
    );
    const result = context.graph.splitScreenState(
      command as unknown as Parameters<ScreenGraphEngine["splitScreenState"]>[0],
    );
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/screen-graph/state-annotations") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
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
      ["project_id", "application_id", "state_id", "expected_graph_revision", "annotated_by"],
      {
        project_id: "string",
        application_id: "string",
        state_id: "string",
        labels: "string_array",
        summary: "string",
        expected_graph_revision: "integer",
        annotated_by: "object",
      },
    );
    const result = context.graph.annotateScreenState(
      command as unknown as Parameters<ScreenGraphEngine["annotateScreenState"]>[0],
    );
    writeJson(response, 200, result as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/exploration/operations") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const engine = requireExplorationOperations(context);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
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
      ["maximum_actions"],
    );
    const ref = engine.run(command as unknown as RunExplorationCommand);
    writeJson(response, 201, ref as unknown as JsonObject);
    return;
  }

  const explorationCancelMatch = /^\/v1\/exploration\/operations\/([^/]+)\/cancel$/.exec(pathname);
  if (explorationCancelMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const engine = requireExplorationOperations(context);
    const operationId = decodeResourceSegment(
      explorationCancelMatch[1] as string,
      "exploration operation ID",
    );
    writeJson(response, 200, engine.cancel(operationId) as unknown as JsonObject);
    return;
  }

  const explorationOperationMatch = /^\/v1\/exploration\/operations\/([^/]+)$/.exec(pathname);
  if (explorationOperationMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const engine = requireExplorationOperations(context);
    const operationId = decodeResourceSegment(
      explorationOperationMatch[1] as string,
      "exploration operation ID",
    );
    writeJson(response, 200, engine.get(operationId) as unknown as JsonObject);
    return;
  }

  const screenStateMatch = /^\/v1\/screen-states\/([^/]+)$/.exec(pathname);
  if (screenStateMatch !== null) {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const values = readSingleValueParameters(url, ["build_id", "application_version"]);
    const stateId = decodeResourceSegment(screenStateMatch[1] as string, "screen state ID");
    writeJson(
      response,
      200,
      context.graph.getState(stateId, {
        ...(values["build_id"] === undefined ? {} : { build_id: values["build_id"] }),
        ...(values["application_version"] === undefined
          ? {}
          : { application_version: values["application_version"] }),
      }) as unknown as JsonObject,
    );
    return;
  }

  if (pathname === "/v1/wiki/nodes") {
    if (request.method === "GET") {
      assertNoRequestBody(request);
      const values = readSingleValueParameters(url, [
        "text",
        "kinds",
        "labels",
        "statuses",
        "limit",
        "cursor",
      ]);
      const query = {
        ...(values["text"] === undefined ? {} : { text: values["text"] }),
        ...(values["kinds"] === undefined ? {} : { kinds: values["kinds"].split(",") }),
        ...(values["labels"] === undefined ? {} : { labels: values["labels"].split(",") }),
        ...(values["statuses"] === undefined ? {} : { statuses: values["statuses"].split(",") }),
      };
      const page = readPageValues(url);
      writeJson(
        response,
        200,
        context.knowledge.listNodes(query, page) as unknown as JsonObject,
      );
      return;
    }
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(
      request,
      Math.max(context.maximumJsonBodyBytes, MAXIMUM_WIKI_BODY_BYTES),
    );
    const command = parseCommandObject(
      input,
      ["kind", "title", "slug", "summary", "markdown", "labels", "related_resources", "created_by"],
      ["kind", "title", "markdown", "created_by"],
    );
    const node = context.knowledge.createNode(
      command as unknown as Parameters<KnowledgeEngine["createNode"]>[0],
    );
    writeJson(response, 201, node as unknown as JsonObject);
    return;
  }

  const wikiRevisionMatch = /^\/v1\/wiki\/nodes\/([^/]+)\/revisions$/.exec(pathname);
  if (wikiRevisionMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const nodeId = decodeResourceSegment(wikiRevisionMatch[1] as string, "wiki node ID");
    const input = await readJsonBody(
      request,
      Math.max(context.maximumJsonBodyBytes, MAXIMUM_WIKI_BODY_BYTES),
    );
    const command = parseCommandObject(
      input,
      [
        "expected_revision",
        "title",
        "summary",
        "markdown",
        "labels",
        "related_resources",
        "to_status",
        "updated_by",
      ],
      ["expected_revision", "updated_by"],
    );
    const node = context.knowledge.updateNode({
      ...(command as unknown as Omit<
        Parameters<KnowledgeEngine["updateNode"]>[0],
        "wiki_node_id"
      >),
      wiki_node_id: nodeId,
    });
    writeJson(response, 200, node as unknown as JsonObject);
    return;
  }

  const wikiBacklinksMatch = /^\/v1\/wiki\/nodes\/([^/]+)\/backlinks$/.exec(pathname);
  if (wikiBacklinksMatch !== null) {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    readSingleValueParameters(url, ["limit", "cursor"]);
    const nodeId = decodeResourceSegment(wikiBacklinksMatch[1] as string, "wiki node ID");
    writeJson(
      response,
      200,
      context.knowledge.backlinks(nodeId, readPageValues(url)) as unknown as JsonObject,
    );
    return;
  }

  const wikiNodeMatch = /^\/v1\/wiki\/nodes\/([^/]+)$/.exec(pathname);
  if (wikiNodeMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const nodeId = decodeResourceSegment(wikiNodeMatch[1] as string, "wiki node ID");
    writeJson(response, 200, context.knowledge.getNode(nodeId) as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/wiki/links") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["source_node_id", "target", "relation", "label", "annotation", "created_by"],
      ["source_node_id", "target", "relation", "created_by"],
    );
    const link = context.knowledge.linkNode(
      command as unknown as Parameters<KnowledgeEngine["linkNode"]>[0],
    );
    writeJson(response, 201, link as unknown as JsonObject);
    return;
  }

  const wikiUnlinkMatch = /^\/v1\/wiki\/links\/([^/]+)\/unlink$/.exec(pathname);
  if (wikiUnlinkMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const linkId = decodeResourceSegment(wikiUnlinkMatch[1] as string, "wiki link ID");
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(input, ["expected_revision"], ["expected_revision"]);
    context.knowledge.unlinkNode({
      wiki_link_id: linkId,
      expected_revision: command["expected_revision"] as number,
    });
    writeJson(response, 200, { unlinked: true });
    return;
  }

  if (pathname === "/v1/wiki/related") {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const values = readSingleValueParameters(url, ["kind", "id", "limit", "cursor"]);
    const kind = values["kind"];
    const id = values["id"];
    if (kind === undefined || id === undefined) {
      throw invalidArgument("kind and id are required.");
    }
    writeJson(
      response,
      200,
      context.knowledge.relatedTo({ kind, id }, readPageValues(url)) as unknown as JsonObject,
    );
    return;
  }

  if (pathname === "/v1/knowledge-collections") {
    if (request.method === "GET") {
      assertNoRequestBody(request);
      const values = readSingleValueParameters(url, [
        "text",
        "publication_states",
        "limit",
        "cursor",
      ]);
      const query = {
        ...(values["text"] === undefined ? {} : { text: values["text"] }),
        ...(values["publication_states"] === undefined
          ? {}
          : { publication_states: values["publication_states"].split(",") }),
      };
      writeJson(
        response,
        200,
        context.knowledge.listCollections(query, readPageValues(url)) as unknown as JsonObject,
      );
      return;
    }
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["name", "summary", "node_ids", "link_ids", "entry_node_ids", "created_by"],
      ["name", "node_ids", "entry_node_ids", "created_by"],
      {
        name: "string",
        summary: "string",
        node_ids: "string_array",
        link_ids: "string_array",
        entry_node_ids: "string_array",
        created_by: "object",
      },
    );
    writeJson(
      response,
      201,
      context.knowledge.createCollection(
        command as unknown as Parameters<KnowledgeEngine["createCollection"]>[0],
      ) as unknown as JsonObject,
    );
    return;
  }

  const collectionRevisionMatch = /^\/v1\/knowledge-collections\/([^/]+)\/revisions$/.exec(
    pathname,
  );
  if (collectionRevisionMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const collectionId = decodeResourceSegment(
      collectionRevisionMatch[1] as string,
      "Knowledge Collection ID",
    );
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      [
        "expected_revision",
        "name",
        "summary",
        "node_ids",
        "link_ids",
        "entry_node_ids",
        "updated_by",
      ],
      ["expected_revision", "updated_by"],
      {
        expected_revision: "integer",
        name: "string",
        summary: "string",
        node_ids: "string_array",
        link_ids: "string_array",
        entry_node_ids: "string_array",
        updated_by: "object",
      },
    );
    writeJson(
      response,
      200,
      context.knowledge.updateCollection({
        ...(command as unknown as Omit<
          Parameters<KnowledgeEngine["updateCollection"]>[0],
          "collection_id"
        >),
        collection_id: collectionId,
      }) as unknown as JsonObject,
    );
    return;
  }

  const collectionPublicationMatch =
    /^\/v1\/knowledge-collections\/([^/]+)\/publication$/.exec(pathname);
  if (collectionPublicationMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const collectionId = decodeResourceSegment(
      collectionPublicationMatch[1] as string,
      "Knowledge Collection ID",
    );
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      [
        "expected_revision",
        "base_commit_id",
        "target_ref_name",
        "ref_precondition",
        "published_by",
        "message",
      ],
      [
        "expected_revision",
        "base_commit_id",
        "target_ref_name",
        "ref_precondition",
        "published_by",
      ],
      {
        expected_revision: "integer",
        base_commit_id: "string",
        target_ref_name: "string",
        ref_precondition: "object",
        published_by: "object",
        message: "string",
      },
    );
    writeJson(
      response,
      201,
      (await context.knowledge.publishCollection({
        ...(command as unknown as Omit<
          Parameters<KnowledgeEngine["publishCollection"]>[0],
          "collection_id"
        >),
        collection_id: collectionId,
      })) as unknown as JsonObject,
    );
    return;
  }

  const collectionExportMatch = /^\/v1\/knowledge-collections\/([^/]+)\/exports$/.exec(
    pathname,
  );
  if (collectionExportMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const collectionId = decodeResourceSegment(
      collectionExportMatch[1] as string,
      "Knowledge Collection ID",
    );
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(input, ["formats"], [], { formats: "string_array" });
    const objects = await context.exchange.exportReadable({
      collection_id: collectionId,
      ...(command["formats"] === undefined
        ? {}
        : { formats: command["formats"] as readonly ("markdown" | "html")[] }),
    });
    writeJson(response, 201, {
      collection_id: collectionId,
      objects: objects as unknown as JsonObject[],
    });
    return;
  }

  const knowledgeCollectionMatch = /^\/v1\/knowledge-collections\/([^/]+)$/.exec(pathname);
  if (knowledgeCollectionMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const collectionId = decodeResourceSegment(
      knowledgeCollectionMatch[1] as string,
      "Knowledge Collection ID",
    );
    writeJson(
      response,
      200,
      context.knowledge.getCollection(collectionId) as unknown as JsonObject,
    );
    return;
  }

  if (pathname === "/v1/validation/snapshot-runs") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["snapshot_id", "categories", "configuration"],
      ["snapshot_id"],
    );
    const outcome = context.validation.validateSnapshot(
      command as unknown as Parameters<ValidationEngine["validateSnapshot"]>[0],
    );
    writeJson(response, 201, outcome as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/validation/graph-runs") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["project_id", "application_id", "configuration"],
      ["project_id", "application_id"],
    );
    const outcome = context.validation.validateScreenGraph(
      command as unknown as Parameters<ValidationEngine["validateScreenGraph"]>[0],
    );
    writeJson(response, 201, outcome as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/validation/build-diffs") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["project_id", "application_id", "left_build_id", "right_build_id", "baseline_tag"],
      ["project_id", "application_id", "left_build_id", "right_build_id"],
    );
    const diff = context.buildDiffs.compareBuilds(
      command as unknown as Parameters<BuildDiffEngine["compareBuilds"]>[0],
    );
    writeJson(response, 201, diff as unknown as JsonObject);
    return;
  }

  const buildDiffMatch = /^\/v1\/validation\/build-diffs\/([^/]+)$/.exec(pathname);
  if (buildDiffMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const diffId = decodeResourceSegment(buildDiffMatch[1] as string, "build diff ID");
    writeJson(response, 200, context.buildDiffs.getBuildDiff(diffId) as unknown as JsonObject);
    return;
  }

  const validationRunMatch = /^\/v1\/validation\/runs\/([^/]+)$/.exec(pathname);
  if (validationRunMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const runId = decodeResourceSegment(validationRunMatch[1] as string, "validation run ID");
    writeJson(response, 200, context.validation.getRun(runId) as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/validation/findings") {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    const values = readSingleValueParameters(url, [
      "validation_run_id",
      "statuses",
      "severities",
      "limit",
      "cursor",
    ]);
    const query = {
      ...(values["validation_run_id"] === undefined
        ? {}
        : { validation_run_id: values["validation_run_id"] }),
      ...(values["statuses"] === undefined ? {} : { statuses: values["statuses"].split(",") }),
      ...(values["severities"] === undefined
        ? {}
        : { severities: values["severities"].split(",") }),
    };
    writeJson(
      response,
      200,
      context.validation.listFindings(query, readPageValues(url)) as unknown as JsonObject,
    );
    return;
  }

  const suppressMatch = /^\/v1\/validation\/findings\/([^/]+)\/suppress$/.exec(pathname);
  if (suppressMatch !== null) {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const findingId = decodeResourceSegment(suppressMatch[1] as string, "validation finding ID");
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["expected_finding_revision", "reason_code", "justification", "created_by", "expires_at"],
      ["expected_finding_revision", "reason_code", "justification", "created_by"],
    );
    const finding = context.validation.suppressFinding({
      ...(command as unknown as Omit<
        Parameters<ValidationEngine["suppressFinding"]>[0],
        "finding_id"
      >),
      finding_id: findingId,
    });
    writeJson(response, 200, finding as unknown as JsonObject);
    return;
  }

  const validationFindingMatch = /^\/v1\/validation\/findings\/([^/]+)$/.exec(pathname);
  if (validationFindingMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const findingId = decodeResourceSegment(
      validationFindingMatch[1] as string,
      "validation finding ID",
    );
    writeJson(response, 200, context.validation.getFinding(findingId) as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/exchange/exports") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const input = await readJsonBody(request, context.maximumJsonBodyBytes);
    const command = parseCommandObject(
      input,
      ["ref_names", "commit_ids", "prerequisite_commit_ids", "created_by", "message"],
      ["created_by"],
    );
    const pack = await context.exchange.exportPack(
      command as unknown as Parameters<PackExchangeService["exportPack"]>[0],
    );
    context.workspace.registerVerifiedObjects([pack]);
    writeJson(response, 201, pack as unknown as JsonObject);
    return;
  }

  if (pathname === "/v1/exchange/imports") {
    assertMethod(request, "POST");
    assertNoSearchParameters(url);
    const contentType = request.headers["content-type"];
    if (contentType !== PACK_MEDIA_TYPE) {
      throw invalidArgument(`Pack imports require the ${PACK_MEDIA_TYPE} media type.`);
    }
    const stream = (async function* () {
      let received = 0;
      for await (const chunk of request) {
        const bytes = chunk as Buffer;
        received += bytes.byteLength;
        if (received > MAXIMUM_DESIGN_ASSET_BYTES) {
          throw new DataError("resource_exhausted", "The pack exceeds the upload limit.");
        }
        yield bytes;
      }
    })();
    // Metadata must match exportPack's exactly: the same deterministic bytes
    // re-exported later would otherwise conflict on immutable metadata.
    const pack = await context.objects.put(stream, {
      media_type: PACK_MEDIA_TYPE,
      compression: "none",
      logical_name: PACK_LOGICAL_NAME,
    });
    if (pack.byte_size === 0) {
      throw invalidArgument("An empty pack upload is not a valid container.");
    }
    context.workspace.registerVerifiedObjects([pack]);
    const result = await context.exchange.importPack({ pack });
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  const objectMatch = /^\/v1\/objects\/([^/]+)$/.exec(pathname);
  if (objectMatch !== null) {
    assertMethod(request, "GET");
    assertNoSearchParameters(url);
    assertNoRequestBody(request);
    const hash = decodeResourceSegment(objectMatch[1] as string, "object hash");
    if (!OBJECT_HASH_PATTERN.test(hash)) {
      throw invalidArgument("The object hash must be a canonical SHA-256 identifier.");
    }
    await sendObject(request, response, context.objects, hash);
    return;
  }

  throw new RequestError({
    status: 404,
    code: "not_found",
    message: "The requested Host Local API route does not exist.",
    retryable: false,
  });
}

function authorize(request: IncomingMessage, expectedDigest: Buffer): void {
  const values = rawHeaderValues(request, "authorization");
  const match = values.length === 1 ? /^Bearer ([A-Za-z0-9_-]{1,1024})$/i.exec(values[0] as string) : null;
  const candidateDigest = digestBearerToken(match?.[1] ?? "");
  const authorized = match !== null && timingSafeEqual(candidateDigest, expectedDigest);
  candidateDigest.fill(0);
  if (!authorized) {
    throw new RequestError({
      status: 401,
      code: "unauthenticated",
      message: "A valid Host Local API bearer token is required.",
      retryable: false,
      headers: { "www-authenticate": 'Bearer realm="vistrea-local", charset="UTF-8"' },
    });
  }
}

function parseRequestUrl(request: IncomingMessage): URL {
  const target = request.url;
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) {
    throw invalidArgument("The HTTP request target must be an origin-form path.");
  }
  try {
    return new URL(target, "http://127.0.0.1");
  } catch {
    throw invalidArgument("The HTTP request target is invalid.");
  }
}

function assertMethod(request: IncomingMessage, expected: "GET" | "POST"): void {
  if (request.method !== expected) {
    throw new RequestError({
      status: 405,
      code: "unsupported",
      message: `This route requires ${expected}.`,
      retryable: false,
      headers: { allow: expected },
    });
  }
}

function assertNoRequestBody(request: IncomingMessage): void {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && contentLength !== "0") {
    throw invalidArgument("GET requests must not contain a body.");
  }
  if (request.headers["transfer-encoding"] !== undefined) {
    throw invalidArgument("GET requests must not contain a body.");
  }
}

function assertNoSearchParameters(url: URL): void {
  if ([...url.searchParams].length > 0) {
    throw invalidArgument("This route does not accept query parameters.");
  }
}

const EVENT_EPOCH_ID_PATTERN =
  /^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_KIND_QUERY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAXIMUM_DESIGN_ASSET_BYTES = 64 * 1024 * 1024;
const MEDIA_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

function requireExplorationOperations(
  context: RequestHandlerContext,
): ExplorationOperationEngine {
  if (context.explorationOperations === undefined) {
    throw new RequestError({
      status: 501,
      code: "unsupported",
      message: "No device automation provider is configured on this Host.",
      retryable: false,
    });
  }
  return context.explorationOperations;
}

function requireRuntimeTuning(context: RequestHandlerContext): RuntimeTuningPort {
  if (context.runtimeTuning === undefined) {
    throw new RequestError({
      status: 503,
      code: "unavailable",
      message: "An authorized Runtime connection is not available.",
      retryable: true,
    });
  }
  return context.runtimeTuning;
}

/** Structural command parsing; protocol-value validation stays in the Engine. */
/** The command field shapes the Host checks before it trusts a body. */
type CommandFieldType = "string" | "string_array" | "integer" | "object";

function parseCommandObject(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
  types: Readonly<Record<string, CommandFieldType>> = {},
): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidArgument("The command body must be a JSON object.");
  }
  const value = input as JsonObject;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidArgument(`Unsupported command field: ${key}.`);
    }
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      throw invalidArgument(`Missing required command field: ${key}.`);
    }
  }
  // The Host is the trust boundary. Checking only field names lets a wrong type
  // reach the Engine, where `new Set("abc")` becomes three plausible state ids
  // and the caller gets a misleading not_found instead of the real complaint.
  for (const [key, expected] of Object.entries(types)) {
    if (!(key in value) || value[key] === undefined) {
      continue;
    }
    const actual = value[key];
    const matches =
      expected === "string"
        ? typeof actual === "string"
        : expected === "integer"
          ? typeof actual === "number" && Number.isSafeInteger(actual)
          : expected === "string_array"
            ? Array.isArray(actual) && actual.every((item) => typeof item === "string")
            : actual !== null && typeof actual === "object" && !Array.isArray(actual);
    if (!matches) {
      throw invalidArgument(`The ${key} command field must be ${COMMAND_TYPE_NAMES[expected]}.`);
    }
  }
  return value;
}

const COMMAND_TYPE_NAMES: Readonly<Record<CommandFieldType, string>> = {
  string: "a string",
  string_array: "an array of strings",
  integer: "an integer",
  object: "an object",
};

function parseReviewIssueQuery(url: URL):
  | { states?: string[]; design_reference_id?: string; screen_state_id?: string }
  | undefined {
  const allowed = new Set([
    "states",
    "design_reference_id",
    "screen_state_id",
    "limit",
    "cursor",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw invalidArgument(`Unsupported review-issues query parameter: ${key}.`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw invalidArgument(`The ${key} query parameter may appear only once.`);
    }
  }
  const statesSource = url.searchParams.get("states");
  const states = statesSource === null ? undefined : statesSource.split(",");
  if (
    states !== undefined &&
    (states.length === 0 ||
      states.length > 8 ||
      !states.every((state) => /^[a-z_]{1,32}$/.test(state)))
  ) {
    throw invalidArgument("states must be a comma-separated list of issue states.");
  }
  const designReferenceId = url.searchParams.get("design_reference_id") ?? undefined;
  const screenStateId = url.searchParams.get("screen_state_id") ?? undefined;
  if (
    screenStateId !== undefined &&
    !/^screenstate_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      screenStateId,
    )
  ) {
    throw invalidArgument("screen_state_id must be a canonical Screen State ID.");
  }
  if (states === undefined && designReferenceId === undefined && screenStateId === undefined) {
    return undefined;
  }
  return {
    ...(states === undefined ? {} : { states }),
    ...(designReferenceId === undefined ? {} : { design_reference_id: designReferenceId }),
    ...(screenStateId === undefined ? {} : { screen_state_id: screenStateId }),
  };
}

async function storeDesignAsset(
  request: IncomingMessage,
  objects: ObjectStore,
): Promise<Awaited<ReturnType<ObjectStore["put"]>>> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !MEDIA_TYPE_PATTERN.test(contentType)) {
    throw invalidArgument("Design assets require a canonical Content-Type media type.");
  }
  const logicalNameHeader = request.headers["x-vistrea-logical-name"];
  const logicalName = typeof logicalNameHeader === "string" ? logicalNameHeader : undefined;
  if (logicalName !== undefined && (logicalName.length === 0 || logicalName.length > 512)) {
    throw invalidArgument("The design asset logical name must contain 1 through 512 characters.");
  }
  const stream = (async function* () {
    let received = 0;
    for await (const chunk of request) {
      const bytes = chunk as Buffer;
      received += bytes.byteLength;
      if (received > MAXIMUM_DESIGN_ASSET_BYTES) {
        // DataError passes through the Object Store error mapping unchanged.
        throw new DataError("resource_exhausted", "The design asset exceeds the upload limit.");
      }
      yield bytes;
    }
  })();
  const object = await objects.put(stream, {
    media_type: contentType,
    compression: "none",
    ...(logicalName === undefined ? {} : { logical_name: logicalName }),
  });
  if (object.byte_size === 0) {
    throw invalidArgument("The design asset body must not be empty.");
  }
  return object;
}

function readSingleValueParameters(
  url: URL,
  allowedKeys: readonly string[],
): Readonly<Record<string, string>> {
  const allowed = new Set(allowedKeys);
  const values: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw invalidArgument(`Unsupported query parameter: ${key}.`);
    }
    const all = url.searchParams.getAll(key);
    if (all.length !== 1) {
      throw invalidArgument(`The ${key} query parameter may appear only once.`);
    }
    values[key] = all[0] as string;
  }
  return values;
}

function parseEventTimelineQuery(url: URL): EventTimelineQuery | undefined {
  const allowed = new Set(["event_epoch_id", "kinds", "first_sequence", "last_sequence"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw invalidArgument(`Unsupported events query parameter: ${key}.`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw invalidArgument(`The ${key} query parameter may appear only once.`);
    }
  }

  const eventEpochId = url.searchParams.get("event_epoch_id");
  if (eventEpochId !== null && !EVENT_EPOCH_ID_PATTERN.test(eventEpochId)) {
    throw invalidArgument("event_epoch_id must be a typed UUIDv7 identifier.");
  }
  const kindsSource = url.searchParams.get("kinds");
  const kinds = kindsSource === null ? null : kindsSource.split(",");
  if (
    kinds !== null &&
    (kinds.length === 0 ||
      kinds.length > 16 ||
      new Set(kinds).size !== kinds.length ||
      !kinds.every((kind) => EVENT_KIND_QUERY_PATTERN.test(kind)))
  ) {
    throw invalidArgument("kinds must be a comma-separated list of unique event kinds.");
  }
  const firstSequence = parseSequenceParameter(url, "first_sequence");
  const lastSequence = parseSequenceParameter(url, "last_sequence");
  if (
    firstSequence !== undefined &&
    lastSequence !== undefined &&
    firstSequence > lastSequence
  ) {
    throw invalidArgument("first_sequence must not exceed last_sequence.");
  }

  if (
    eventEpochId === null &&
    kinds === null &&
    firstSequence === undefined &&
    lastSequence === undefined
  ) {
    return undefined;
  }
  return {
    ...(eventEpochId === null ? {} : { event_epoch_id: eventEpochId }),
    ...(kinds === null ? {} : { kinds }),
    ...(firstSequence === undefined ? {} : { first_sequence: firstSequence }),
    ...(lastSequence === undefined ? {} : { last_sequence: lastSequence }),
  };
}

function parseSequenceParameter(url: URL, name: string): number | undefined {
  const source = url.searchParams.get(name);
  if (source === null) {
    return undefined;
  }
  if (!/^(?:0|[1-9][0-9]{0,14})$/.test(source)) {
    throw invalidArgument(`${name} must be a JSON-safe unsigned integer.`);
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value)) {
    throw invalidArgument(`${name} must be a JSON-safe unsigned integer.`);
  }
  return value;
}

function parsePageRequest(url: URL): PageRequest | undefined {
  const allowed = new Set(["limit", "cursor"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw invalidArgument(`Unsupported snapshots query parameter: ${key}.`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw invalidArgument(`The ${key} query parameter may appear only once.`);
    }
  }
  return readPageValues(url);
}

/** Reads limit/cursor after the route has validated its own key set. */
function readPageValues(url: URL): PageRequest | undefined {
  const limitSource = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  let limit: number | undefined;
  if (limitSource !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limitSource)) {
      throw invalidArgument("limit must be an integer from 1 through 500.");
    }
    limit = Number(limitSource);
    if (limit > 500) {
      throw invalidArgument("limit must be an integer from 1 through 500.");
    }
  }
  if (cursor !== null && (cursor.length === 0 || cursor.length > 4096)) {
    throw invalidArgument("cursor must contain between 1 and 4096 characters.");
  }
  if (limit === undefined && cursor === null) {
    return undefined;
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === null ? {} : { cursor }),
  };
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity") {
    throw new RequestError({
      status: 415,
      code: "unsupported",
      message: "Compressed request bodies are not supported.",
      retryable: false,
    });
  }
  const contentType = request.headers["content-type"];
  if (
    contentType === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new RequestError({
      status: 415,
      code: "unsupported",
      message: "The request Content-Type must be application/json.",
      retryable: false,
    });
  }

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw invalidArgument("Content-Length is invalid.");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      throw bodyTooLarge(maximumBytes);
    }
    if (length > maximumBytes) {
      request.resume();
      throw bodyTooLarge(maximumBytes);
    }
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue as Uint8Array);
    if (chunk.byteLength > maximumBytes - byteLength) {
      request.resume();
      throw bodyTooLarge(maximumBytes);
    }
    byteLength += chunk.byteLength;
    chunks.push(Buffer.from(chunk));
  }
  if (byteLength === 0) {
    throw invalidArgument("The request body must contain a JSON object.");
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, byteLength));
  } catch {
    throw invalidArgument("The request body is not valid UTF-8 JSON.");
  }
  new UniqueJsonKeyScanner(source).scan();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw invalidArgument("The request body is not valid UTF-8 JSON.");
  }
}

/** Validates JSON structure and compares decoded object keys before JSON.parse can overwrite them. */
class UniqueJsonKeyScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.invalid();
    }
  }

  private scanValue(depth: number): void {
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") {
      this.assertCanEnterContainer(depth);
      this.scanObject(depth + 1);
    } else if (character === "[") {
      this.assertCanEnterContainer(depth);
      this.scanArray(depth + 1);
    } else if (character === '"') {
      this.scanString();
    } else if (character === "t") {
      this.scanLiteral("true");
    } else if (character === "f") {
      this.scanLiteral("false");
    } else if (character === "n") {
      this.scanLiteral("null");
    } else if (character === "-" || isAsciiDigit(character)) {
      this.scanNumber();
    } else {
      this.invalid();
    }
  }

  private assertCanEnterContainer(depth: number): void {
    if (depth >= MAXIMUM_JSON_NESTING_DEPTH) {
      throw invalidArgument("The JSON request body exceeds the nesting limit.");
    }
  }

  private scanObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("}")) {
      return;
    }

    const keys = new Set<string>();
    while (true) {
      if (this.source[this.index] !== '"') {
        this.invalid();
      }
      const key = this.scanString();
      if (keys.has(key)) {
        throw invalidArgument("JSON object keys must be unique.");
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume("}")) {
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) {
      return;
    }
    while (true) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume("]")) {
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index] as string;
      if (character === '"') {
        this.index += 1;
        try {
          const value = JSON.parse(this.source.slice(start, this.index)) as unknown;
          if (typeof value === "string") {
            return value;
          }
        } catch {
          this.invalid();
        }
        this.invalid();
      }
      if (character === "\\") {
        this.index += 1;
        if (this.index >= this.source.length) {
          this.invalid();
        }
        this.index += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        this.invalid();
      }
      this.index += 1;
    }
    this.invalid();
  }

  private scanLiteral(literal: string): void {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.invalid();
    }
    this.index += literal.length;
  }

  private scanNumber(): void {
    const match = JSON_NUMBER_PATTERN.exec(this.source.slice(this.index));
    if (match === null) {
      this.invalid();
    }
    this.index += (match[0] as string).length;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) {
      this.invalid();
    }
  }

  private invalid(): never {
    throw invalidArgument("The request body is not valid UTF-8 JSON.");
  }
}

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function parseCaptureCommand(value: unknown): CaptureSnapshotCommand {
  const input = requirePlainRecord(value, "Capture request");
  assertAllowedKeys(input, ["include", "screenshot", "reason"], "Capture request");

  const includeValue = input["include"];
  let include: CaptureSnapshotCommand["include"] = { paths: ["trees", "screenshot"] };
  if (includeValue !== undefined) {
    const includeInput = requirePlainRecord(includeValue, "include");
    assertAllowedKeys(includeInput, ["paths"], "include");
    const paths = includeInput["paths"];
    if (!Array.isArray(paths) || paths.length > 64) {
      throw invalidArgument("include.paths must be an array with at most 64 entries.");
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (typeof path !== "string" || path.length === 0 || path.length > 128) {
        throw invalidArgument("Every include.paths entry must contain 1 through 128 characters.");
      }
      if (seen.has(path)) {
        throw invalidArgument("include.paths entries must be unique.");
      }
      seen.add(path);
      normalized.push(path);
    }
    include = { paths: normalized };
  }

  const screenshotValue = input["screenshot"];
  if (
    screenshotValue !== undefined &&
    screenshotValue !== "none" &&
    screenshotValue !== "reference"
  ) {
    throw invalidArgument('screenshot must be either "none" or "reference".');
  }
  const reasonValue = input["reason"];
  if (
    reasonValue !== undefined &&
    (typeof reasonValue !== "string" ||
      !CAPTURE_REASONS.has(reasonValue as CaptureSnapshotCommand["reason"]))
  ) {
    throw invalidArgument("reason is not a supported Snapshot capture reason.");
  }

  return {
    include,
    screenshot: screenshotValue ?? "reference",
    reason: (reasonValue as CaptureSnapshotCommand["reason"] | undefined) ?? "manual",
  };
}

async function sendObject(
  request: IncomingMessage,
  response: ServerResponse,
  objects: ObjectStore,
  hash: string,
): Promise<void> {
  const object = await objects.stat(hash);
  const rangeHeaders = rawHeaderValues(request, "range");
  if (rangeHeaders.length > 1) {
    throw unsatisfiableRange(object.byte_size);
  }
  const selection = parseRange(rangeHeaders[0], object.byte_size);
  const stream = await objects.open(hash, selection?.range);
  const contentLength = selection?.length ?? object.byte_size;
  response.statusCode = selection === undefined ? 200 : 206;
  response.setHeader("content-type", object.media_type);
  response.setHeader("content-length", String(contentLength));
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("etag", `"${object.hash}"`);
  if (selection !== undefined) {
    response.setHeader("content-range", selection.contentRange);
  }

  let written = 0;
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) {
        throw new DataError("integrity_error", "The Object Store returned a non-byte chunk.");
      }
      if (chunk.byteLength > contentLength - written) {
        throw new DataError("integrity_error", "The Object Store returned too many bytes.");
      }
      written += chunk.byteLength;
      if (!response.write(chunk)) {
        // Detach the losing waiter, or every stalled chunk leaks a listener.
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
    if (written !== contentLength) {
      throw new DataError("integrity_error", "The Object Store returned too few bytes.");
    }
    response.end();
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    throw error;
  }
}

interface RangeSelection {
  readonly range: ByteRange;
  readonly length: number;
  readonly contentRange: string;
}

function parseRange(value: string | undefined, byteSize: number): RangeSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.includes(",")) {
    throw unsatisfiableRange(byteSize);
  }
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value);
  if (match === null || (match[1] === "" && match[2] === "") || byteSize === 0) {
    throw unsatisfiableRange(byteSize);
  }

  const first = match[1] as string;
  const second = match[2] as string;
  let start: number;
  let end: number;
  if (first === "") {
    const suffixLength = parseSafeRangeInteger(second, byteSize);
    if (suffixLength === 0) {
      throw unsatisfiableRange(byteSize);
    }
    const length = Math.min(suffixLength, byteSize);
    start = byteSize - length;
    end = byteSize - 1;
  } else {
    start = parseSafeRangeInteger(first, byteSize);
    if (start >= byteSize) {
      throw unsatisfiableRange(byteSize);
    }
    if (second === "") {
      end = byteSize - 1;
    } else {
      end = parseSafeRangeInteger(second, byteSize);
      if (end < start) {
        throw unsatisfiableRange(byteSize);
      }
      end = Math.min(end, byteSize - 1);
    }
  }
  const length = end - start + 1;
  return {
    range: { offset: start, length },
    length,
    contentRange: `bytes ${start}-${end}/${byteSize}`,
  };
}

function parseSafeRangeInteger(value: string, byteSize: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw unsatisfiableRange(byteSize);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw unsatisfiableRange(byteSize);
  }
  return result;
}

function unsatisfiableRange(byteSize: number): RequestError {
  return new RequestError({
    status: 416,
    code: "invalid_argument",
    message: "The requested byte range is invalid or unsatisfiable.",
    retryable: false,
    headers: { "content-range": `bytes */${byteSize}` },
  });
}

function bodyTooLarge(maximumBytes: number): RequestError {
  return new RequestError({
    status: 413,
    code: "resource_exhausted",
    message: `The JSON request body exceeds the ${maximumBytes}-byte limit.`,
    retryable: false,
  });
}

function decodeResourceSegment(value: string, name: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidArgument(`The ${name} is not valid percent-encoded text.`);
  }
  if (
    decoded.length === 0 ||
    decoded.length > 512 ||
    /[\u0000-\u001f\u007f/\\]/.test(decoded)
  ) {
    throw invalidArgument(`The ${name} is invalid.`);
  }
  return decoded;
}

function requirePlainRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw invalidArgument(`${name} contains unsupported fields: ${unexpected.sort().join(", ")}.`);
  }
}

function invalidArgument(message: string): RequestError {
  return new RequestError({
    status: 400,
    code: "invalid_argument",
    message,
    retryable: false,
  });
}

function applyCommonHeaders(response: ServerResponse, requestId: string): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-vistrea-request-id", requestId);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(body.byteLength));
  response.end(body);
}

function sendError(response: ServerResponse, requestId: string, error: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  applyCommonHeaders(response, requestId);
  const publicError = toPublicError(error);
  for (const [name, value] of Object.entries(publicError.headers ?? {})) {
    response.setHeader(name, value);
  }
  const body: HostApiErrorBody = {
    request_id: requestId,
    error: {
      code: publicError.code,
      message: publicError.message,
      retryable: publicError.retryable,
    },
  };
  writeJson(response, publicError.status, body);
}

function toPublicError(error: unknown): PublicError {
  if (error instanceof RequestError) {
    return error;
  }
  if (error instanceof DataError) {
    switch (error.code) {
      case "invalid_argument":
        return {
          status: 400,
          code: error.code,
          message: "The request was rejected as invalid.",
          retryable: error.retryable,
        };
      case "not_found":
        return {
          status: 404,
          code: error.code,
          message: "The requested resource does not exist.",
          retryable: error.retryable,
        };
      case "already_exists":
      case "conflict":
        return {
          status: 409,
          code: error.code,
          message: "The request conflicts with the current Workspace state.",
          retryable: error.retryable,
        };
      case "unsupported":
        return {
          status: 422,
          code: error.code,
          message: "The requested capability is not supported.",
          retryable: error.retryable,
        };
      case "resource_exhausted":
        return {
          status: 507,
          code: error.code,
          message: "The Host does not have enough resources to complete the request.",
          retryable: error.retryable,
        };
      case "integrity_error":
        return {
          status: 500,
          code: error.code,
          message: "Stored or captured data failed integrity verification.",
          retryable: false,
        };
      case "internal":
        return {
          status: 500,
          code: error.code,
          message: "The Host could not complete the request.",
          retryable: error.retryable,
        };
    }
  }
  if (error instanceof LoopbackTransportError) {
    switch (error.code) {
      case "timeout":
        return {
          status: 504,
          code: error.code,
          message: "The Runtime capture timed out.",
          retryable: true,
        };
      case "unavailable":
        return {
          status: 503,
          code: error.code,
          message: "An authorized Runtime connection is not available.",
          retryable: true,
        };
      case "resource_exhausted":
        return {
          status: 507,
          code: error.code,
          message: "The Runtime capture exceeded an authorized resource limit.",
          retryable: false,
        };
      case "unsupported":
      case "forbidden":
        return {
          status: 422,
          code: error.code,
          message: "The Runtime cannot perform the requested capture.",
          retryable: false,
        };
      case "cancelled":
        return {
          status: 409,
          code: error.code,
          message: "The Runtime capture was cancelled.",
          retryable: true,
        };
      case "conflict":
        return {
          status: 409,
          code: error.code,
          message: "The Runtime state conflicts with the requested operation.",
          retryable: true,
        };
      case "unauthenticated":
        return {
          status: 502,
          code: error.code,
          message: "The Runtime connection rejected the capture.",
          retryable: false,
        };
      case "protocol_error":
        return {
          status: 502,
          code: "integrity_error",
          message: "The Runtime capture failed transport integrity verification.",
          retryable: false,
        };
      case "remote_error":
        return {
          status: 502,
          code: "internal",
          message: "The Runtime could not complete the capture.",
          retryable: false,
        };
    }
  }
  return {
    status: 500,
    code: "internal",
    message: "The Host could not complete the request.",
    retryable: false,
  };
}

function rawHeaderValues(request: IncomingMessage, name: string): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if ((request.rawHeaders[index] as string).toLowerCase() === name) {
      result.push(request.rawHeaders[index + 1] as string);
    }
  }
  return result;
}

function digestBearerToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function createRequestId(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `request_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertBindAddress(host: string): asserts host is HostLocalApiBindAddress {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new DataError(
      "invalid_argument",
      "The Host Local API must bind to the literal loopback address 127.0.0.1 or ::1.",
    );
  }
}

function assertDependencies(options: HostLocalApiDependencies): void {
  if (
    typeof options.runtime?.captureSnapshot !== "function" ||
    typeof options.workspace?.registerVerifiedObjects !== "function" ||
    typeof options.workspace?.beginUnitOfWork !== "function" ||
    typeof options.workspace?.checkHealth !== "function" ||
    typeof options.objects?.put !== "function" ||
    typeof options.objects?.stat !== "function" ||
    typeof options.objects?.open !== "function" ||
    typeof options.validator?.assert !== "function"
  ) {
    throw new DataError("invalid_argument", "Host Local API dependencies are incomplete.");
  }
}

async function listen(server: Server, host: HostLocalApiBindAddress, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
