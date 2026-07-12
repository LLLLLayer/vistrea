import {
  DataError,
  isDataError,
  PROTOCOL_SCHEMA_IDS,
  type DesignComparison,
  type DesignComparisonQuery,
  type DesignReference,
  type DesignRegionMapping,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type ObjectStore,
  type Page,
  type PageRequest,
  type ProtocolValidator,
  type ReviewIssue,
  type ReviewIssueQuery,
  type ReviewVerificationRecord,
  type RuntimeSnapshot,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "./uuid-v7.js";
import { decodePng, meanRegionColor, type DecodedImage } from "./png.js";

export const REVIEW_ISSUE_STATES = [
  "open",
  "in_progress",
  "ready_for_verification",
  "resolved",
  "wont_fix",
] as const;

export type ReviewIssueState = (typeof REVIEW_ISSUE_STATES)[number];

/** The canonical Review Issue lifecycle from the protocol semantic rules. */
export const REVIEW_ISSUE_TRANSITIONS: Readonly<Record<ReviewIssueState, readonly ReviewIssueState[]>> = {
  open: ["in_progress", "ready_for_verification", "wont_fix"],
  in_progress: ["open", "ready_for_verification", "wont_fix"],
  ready_for_verification: ["in_progress", "resolved", "wont_fix"],
  resolved: ["open"],
  wont_fix: ["open"],
};

export const REVIEW_ISSUE_CATEGORIES = [
  "frame",
  "alignment",
  "spacing",
  "typography",
  "color",
  "corner_radius",
  "border",
  "shadow",
  "alpha",
] as const;

export const REVIEW_ISSUE_SEVERITIES = ["info", "minor", "major", "critical"] as const;

export interface DesignEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly validator: ProtocolValidator;
  readonly ids?: IdGenerator;
}

export interface RectValue {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AddDesignReferenceCommand {
  readonly name: string;
  readonly kind: "design_artifact" | "approved_build";
  readonly canvas_size: { readonly width: number; readonly height: number };
  readonly pixel_size: { readonly width: number; readonly height: number };
  /** A design asset already verified by the local Object Store. */
  readonly asset_hash: string;
  readonly created_by: JsonObject;
}

export interface MapDesignRegionCommand {
  readonly design_reference_id: string;
  readonly design_region: RectValue;
  readonly runtime_target: {
    readonly snapshot_id: string;
    readonly tree_id: string;
    readonly node_id: string;
    readonly stable_id?: string;
  };
  readonly created_by: JsonObject;
}

export interface RunDesignComparisonCommand {
  readonly design_reference_id: string;
  readonly target_snapshot_id: string;
  readonly completed_by: JsonObject;
  /**
   * Also compares the mean pixel color of every mapped design region against
   * the captured screenshot region. Requires a decodable design asset and a
   * Snapshot screenshot; when either is unavailable the comparison degrades
   * to `partial` quality with the reason recorded instead of guessing.
   */
  readonly include_pixel?: boolean;
}

export interface CreateReviewIssueCommand {
  readonly design_reference_id: string;
  readonly mapping_id?: string;
  readonly comparison_id?: string;
  readonly runtime_target: {
    readonly snapshot_id: string;
    readonly tree_id: string;
    readonly node_id: string;
    readonly stable_id?: string;
  };
  readonly title: string;
  readonly description?: string;
  readonly category: (typeof REVIEW_ISSUE_CATEGORIES)[number];
  readonly severity: (typeof REVIEW_ISSUE_SEVERITIES)[number];
  readonly expected: JsonObject;
  readonly actual: JsonObject;
  readonly created_by: JsonObject;
}

export interface UpdateReviewIssueCommand {
  readonly issue_id: string;
  readonly expected_revision: number;
  readonly to_state: ReviewIssueState;
  readonly reason?: string;
  readonly changed_by: JsonObject;
}

export interface VerifyReviewIssueCommand {
  readonly issue_id: string;
  readonly expected_revision: number;
  readonly basis: "real_build" | "runtime_preview";
  readonly result: "passed" | "failed" | "inconclusive";
  readonly verified_snapshot_id: string;
  readonly verified_build_id: string;
  readonly rationale?: string;
  readonly verified_by: JsonObject;
}

export interface VerifyReviewIssueResult {
  readonly record: ReviewVerificationRecord;
  readonly issue: ReviewIssue;
}

const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
const FRAME_TOLERANCE_LOGICAL_POINTS = 0.5;
const COLOR_TOLERANCE_MEAN_CHANNEL = 0.05;
const MAJOR_COLOR_DELTA_MEAN_CHANNEL = 0.15;
const MAJOR_FRAME_DEVIATION_LOGICAL_POINTS = 8;

/**
 * Design review use cases over the public Data and Object Store ports.
 *
 * Every value the engine persists is a canonical protocol model validated
 * against its schema, and Review Issue lifecycle changes always append one
 * continuous, legal state-history entry.
 */
type PixelContext =
  | {
      readonly status: "compared";
      readonly design: DecodedImage;
      readonly screenshot: DecodedImage;
      readonly designScaleX: number;
      readonly designScaleY: number;
      readonly screenScaleX: number;
      readonly screenScaleY: number;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export class DesignReviewEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #objects: ObjectStore;
  readonly #validator: ProtocolValidator;
  readonly #ids: IdGenerator;

  constructor(dependencies: DesignEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#objects = dependencies.objects;
    this.#validator = dependencies.validator;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  async addDesignReference(command: AddDesignReferenceCommand): Promise<DesignReference> {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    const object = await this.#objects.stat(command.asset_hash);
    this.#workspace.registerVerifiedObjects([object]);
    const now = this.#workspace.clock.now();
    const reference = {
      design_reference_id: this.#ids.next("designref"),
      protocol_version: PROTOCOL_VERSION,
      revision: 1,
      kind: command.kind,
      name: command.name,
      artifact: {
        artifact_id: this.#ids.next("artifact"),
        protocol_version: PROTOCOL_VERSION,
        kind: "design",
        object,
        created_at: now,
        retention: "pinned",
        extensions: {},
      },
      canvas_size: command.canvas_size,
      pixel_size: command.pixel_size,
      created_at: now,
      created_by: command.created_by,
      updated_at: now,
      updated_by: command.created_by,
      extensions: {},
    } as unknown as DesignReference;
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.designReference, reference);
    return this.#write((unit) => unit.designReviews.createReference(reference));
  }

  mapDesignRegion(command: MapDesignRegionCommand): DesignRegionMapping {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    const now = this.#workspace.clock.now();
    const mapping = {
      mapping_id: this.#ids.next("mapping"),
      protocol_version: PROTOCOL_VERSION,
      revision: 1,
      design_reference_id: command.design_reference_id,
      design_region: command.design_region,
      runtime_target: { ...command.runtime_target, extensions: {} },
      method: "manual",
      state: "confirmed",
      confidence: 1,
      created_at: now,
      created_by: command.created_by,
      updated_at: now,
      updated_by: command.created_by,
      extensions: {},
    } as unknown as DesignRegionMapping;
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.designRegionMapping, mapping);
    return this.#write((unit) => {
      unit.designReviews.getReference(command.design_reference_id);
      unit.snapshots.get(command.runtime_target.snapshot_id);
      return unit.designReviews.createRegionMapping(mapping);
    });
  }

  /**
   * Compares every confirmed region mapping of one design reference against a
   * captured Snapshot. Nodes are located by stable ID first so a mapping
   * recorded on an earlier Snapshot still resolves on a later build.
   */
  async runDesignComparison(command: RunDesignComparisonCommand): Promise<DesignComparison> {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.completed_by);
    const pixel =
      command.include_pixel === true
        ? await this.#loadPixelContext(command.design_reference_id, command.target_snapshot_id)
        : undefined;
    return this.#write((unit) => {
      unit.designReviews.getReference(command.design_reference_id);
      const snapshot = unit.snapshots.get(command.target_snapshot_id);
      const mappings = collectAllPages((page) =>
        unit.designReviews.listRegionMappings(
          { design_reference_id: command.design_reference_id },
          page,
        ),
      ).filter((mapping) => mapping["state"] === "confirmed");
      if (mappings.length === 0) {
        throw new DataError(
          "invalid_argument",
          "The design reference has no confirmed region mappings to compare.",
          { details: { design_reference_id: command.design_reference_id } },
        );
      }

      const nodes = indexSnapshotNodes(snapshot);
      const differences: JsonObject[] = [];
      let quality: "complete" | "partial" = nodes.completeInlineTrees ? "complete" : "partial";
      for (const mapping of mappings) {
        const target = mapping["runtime_target"] as JsonObject;
        // node_id values are per-capture identities, so the fallback is only
        // sound when the mapping was recorded on this exact Snapshot; on any
        // other Snapshot it silently measures an unrelated node.
        const located =
          nodes.byStableId.get(String(target["stable_id"] ?? "")) ??
          (String(target["snapshot_id"]) === snapshot.snapshot_id
            ? nodes.byNodeId.get(String(target["node_id"]))
            : undefined);
        if (located === undefined) {
          quality = "partial";
          continue;
        }
        const expected = mapping["design_region"] as unknown as RectValue;
        const actual = located.frame;
        const runtimeTarget = {
          snapshot_id: snapshot.snapshot_id,
          tree_id: located.treeId,
          node_id: located.nodeId,
          ...(located.stableId === undefined ? {} : { stable_id: located.stableId }),
          extensions: {},
        };
        const delta = frameDeviation(expected, actual);
        if (delta > FRAME_TOLERANCE_LOGICAL_POINTS) {
          differences.push({
            difference_id: this.#ids.next("difference"),
            mapping_id: String(mapping["mapping_id"]),
            runtime_target: runtimeTarget,
            category: "frame",
            severity:
              delta > MAJOR_FRAME_DEVIATION_LOGICAL_POINTS ? "major" : "minor",
            expected: { kind: "rect", value: rectValue(expected), extensions: {} },
            actual: { kind: "rect", value: rectValue(actual), extensions: {} },
            delta,
            evidence: [],
            extensions: {},
          });
        }
        if (pixel !== undefined && pixel.status === "compared") {
          const designColor = meanRegionColor(pixel.design, {
            x: expected.x * pixel.designScaleX,
            y: expected.y * pixel.designScaleY,
            width: expected.width * pixel.designScaleX,
            height: expected.height * pixel.designScaleY,
          });
          const screenColor = meanRegionColor(pixel.screenshot, {
            x: actual.x * pixel.screenScaleX,
            y: actual.y * pixel.screenScaleY,
            width: actual.width * pixel.screenScaleX,
            height: actual.height * pixel.screenScaleY,
          });
          if (designColor === undefined || screenColor === undefined) {
            quality = "partial";
          } else {
            const colorDelta =
              (Math.abs(designColor.red - screenColor.red) +
                Math.abs(designColor.green - screenColor.green) +
                Math.abs(designColor.blue - screenColor.blue)) /
              3;
            if (colorDelta > COLOR_TOLERANCE_MEAN_CHANNEL) {
              differences.push({
                difference_id: this.#ids.next("difference"),
                mapping_id: String(mapping["mapping_id"]),
                runtime_target: runtimeTarget,
                category: "color",
                severity:
                  colorDelta > MAJOR_COLOR_DELTA_MEAN_CHANNEL ? "major" : "minor",
                expected: {
                  kind: "color_rgba",
                  value: {
                    red: designColor.red,
                    green: designColor.green,
                    blue: designColor.blue,
                    alpha: designColor.alpha,
                  },
                  color_space: "srgb",
                  extensions: {},
                },
                actual: {
                  kind: "color_rgba",
                  value: {
                    red: screenColor.red,
                    green: screenColor.green,
                    blue: screenColor.blue,
                    alpha: screenColor.alpha,
                  },
                  color_space: "srgb",
                  extensions: {},
                },
                delta: colorDelta,
                evidence: [],
                extensions: {
                  "vistrea.pixel": {
                    design_sampled_pixels: designColor.sampled_pixels,
                    screenshot_sampled_pixels: screenColor.sampled_pixels,
                  },
                },
              });
            }
          }
        }
      }
      if (pixel !== undefined && pixel.status === "unavailable") {
        quality = "partial";
      }

      const comparison = {
        comparison_id: this.#ids.next("comparison"),
        protocol_version: PROTOCOL_VERSION,
        revision: 1,
        design_reference_id: command.design_reference_id,
        target_snapshot_id: command.target_snapshot_id,
        quality,
        mapping_ids: mappings.map((mapping) => String(mapping["mapping_id"])),
        differences,
        evidence: [],
        completed_at: this.#workspace.clock.now(),
        completed_by: command.completed_by,
        extensions:
          pixel === undefined
            ? {}
            : {
                "vistrea.pixel":
                  pixel.status === "compared"
                    ? { status: "compared" }
                    : { status: "unavailable", reason: pixel.reason },
              },
      } as unknown as DesignComparison;
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.designComparison, comparison);
      unit.designReviews.appendComparison(comparison);
      return comparison;
    });
  }

  /**
   * Loads and decodes the design asset and the Snapshot screenshot for pixel
   * comparison. Every failure is a reason, never a guess.
   */
  async #loadPixelContext(referenceId: string, snapshotId: string): Promise<PixelContext> {
    let designHash: string | undefined;
    let screenshotHash: string | undefined;
    let designScaleX = 1;
    let designScaleY = 1;
    let screenScaleX = 1;
    let screenScaleY = 1;
    {
      const unit = this.#workspace.beginUnitOfWork("read");
      try {
        const reference = unit.designReviews.getReference(referenceId) as unknown as JsonObject;
        const snapshot = unit.snapshots.get(snapshotId) as unknown as JsonObject;
        const artifact = reference["artifact"] as JsonObject | undefined;
        const artifactObject = artifact?.["object"] as JsonObject | undefined;
        designHash = artifactObject?.["hash"] as string | undefined;
        const canvas = reference["canvas_size"] as JsonObject | undefined;
        const pixels = reference["pixel_size"] as JsonObject | undefined;
        if (canvas !== undefined && pixels !== undefined) {
          designScaleX = (pixels["width"] as number) / (canvas["width"] as number);
          designScaleY = (pixels["height"] as number) / (canvas["height"] as number);
        }
        const screenshot = snapshot["screenshot"] as JsonObject | undefined;
        screenshotHash = (screenshot?.["object"] as JsonObject | undefined)?.["hash"] as
          | string
          | undefined;
        const display = snapshot["display"] as JsonObject | undefined;
        screenScaleX = (display?.["pixel_scale_x"] as number | undefined) ?? 1;
        screenScaleY = (display?.["pixel_scale_y"] as number | undefined) ?? 1;
      } finally {
        unit.rollback();
      }
    }
    if (designHash === undefined) {
      return { status: "unavailable", reason: "The design reference has no decodable asset." };
    }
    if (screenshotHash === undefined) {
      return { status: "unavailable", reason: "The Snapshot carries no screenshot evidence." };
    }
    try {
      const [design, screenshot] = await Promise.all([
        this.#readObjectBytes(designHash),
        this.#readObjectBytes(screenshotHash),
      ]);
      return {
        status: "compared",
        design: decodePng(design),
        screenshot: decodePng(screenshot),
        designScaleX,
        designScaleY,
        screenScaleX,
        screenScaleY,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: isDataError(error) ? error.message : "The image bytes could not be decoded.",
      };
    }
  }

  async #readObjectBytes(hash: string): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.#objects.open(hash)) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  createReviewIssue(command: CreateReviewIssueCommand): ReviewIssue {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    const now = this.#workspace.clock.now();
    const issue = {
      issue_id: this.#ids.next("issue"),
      protocol_version: PROTOCOL_VERSION,
      revision: 1,
      design_reference_id: command.design_reference_id,
      ...(command.mapping_id === undefined ? {} : { mapping_id: command.mapping_id }),
      ...(command.comparison_id === undefined ? {} : { comparison_id: command.comparison_id }),
      runtime_target: { ...command.runtime_target, extensions: {} },
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      category: command.category,
      severity: command.severity,
      state: "open",
      expected: command.expected,
      actual: command.actual,
      evidence: [],
      state_history: [
        {
          revision: 1,
          to_state: "open",
          changed_at: now,
          changed_by: command.created_by,
          extensions: {},
        },
      ],
      verification_record_ids: [],
      tuning_patch_ids: [],
      created_at: now,
      created_by: command.created_by,
      updated_at: now,
      updated_by: command.created_by,
      extensions: {},
    } as unknown as ReviewIssue;
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.reviewIssue, issue);
    return this.#write((unit) => {
      unit.designReviews.getReference(command.design_reference_id);
      return unit.designReviews.createIssue(issue);
    });
  }

  updateReviewIssue(command: UpdateReviewIssueCommand): ReviewIssue {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.changed_by);
    return this.#write((unit) => {
      const current = findIssue(unit, command.issue_id);
      const next = this.#transitionIssue(current, {
        toState: command.to_state,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
        changedBy: command.changed_by,
      });
      return unit.designReviews.updateIssue(next, {
        expected_revision: command.expected_revision,
      });
    });
  }

  /**
   * Appends immutable verification evidence and moves the issue lifecycle in
   * one atomic Unit of Work: passed verifications resolve the issue, failed or
   * inconclusive ones return it to in_progress with the record attached. The
   * evidence itself is a content-addressed verification document; a
   * first-class Artifact repository remains a later Data slice, so the link
   * carries the document hash in a namespaced extension.
   */
  async verifyReviewIssue(command: VerifyReviewIssueCommand): Promise<VerifyReviewIssueResult> {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.verified_by);
    const verificationRecordId = this.#ids.next("verification");
    const documentBytes = Buffer.from(
      JSON.stringify({
        verification_record_id: verificationRecordId,
        issue_id: command.issue_id,
        basis: command.basis,
        result: command.result,
        verified_snapshot_id: command.verified_snapshot_id,
        verified_build_id: command.verified_build_id,
      }),
      "utf8",
    );
    const evidenceObject = await this.#objects.put(
      (async function* () {
        yield documentBytes;
      })(),
      {
        media_type: "application/json",
        compression: "none",
        logical_name: `${verificationRecordId}.json`,
      },
    );
    this.#workspace.registerVerifiedObjects([evidenceObject]);

    return this.#write((unit) => {
      const current = findIssue(unit, command.issue_id);
      if (current.state !== "ready_for_verification") {
        throw new DataError(
          "conflict",
          "Only a Review Issue that is ready for verification can be verified.",
          { details: { issue_id: command.issue_id, state: current.state } },
        );
      }
      const now = this.#workspace.clock.now();
      const record = {
        verification_record_id: verificationRecordId,
        protocol_version: PROTOCOL_VERSION,
        revision: 1,
        issue_id: command.issue_id,
        issue_revision: current.revision,
        basis: command.basis,
        result: command.result,
        verified_snapshot_id: command.verified_snapshot_id,
        verified_build_id: command.verified_build_id,
        evidence: [
          {
            artifact_link_id: this.#ids.next("artifactlink"),
            artifact_id: this.#ids.next("artifact"),
            target: { kind: "review_issue", id: command.issue_id },
            relation: "evidence",
            created_at: now,
            created_by: command.verified_by,
            extensions: { "vistrea.evidence_object_hash": evidenceObject.hash },
          },
        ],
        verified_at: now,
        verified_by: command.verified_by,
        extensions: {},
      } as unknown as ReviewVerificationRecord;
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.reviewVerificationRecord, record);
      unit.designReviews.appendVerification(record);

      const recordId = String((record as JsonObject)["verification_record_id"]);
      const passed = command.result === "passed";
      const rationale =
        command.rationale ??
        (passed
          ? "A verified build matches the expected design value."
          : "Verification did not confirm the expected design value.");
      const issue = this.#transitionIssue(
        current,
        {
          toState: passed ? "resolved" : "in_progress",
          reason: rationale,
          changedBy: command.verified_by,
          verificationRecordId: recordId,
        },
        (candidate, changedAt) => ({
          ...candidate,
          verification_record_ids: [
            ...(candidate["verification_record_ids"] as readonly string[]),
            recordId,
          ],
          ...(passed
            ? {
                resolution: {
                  kind: "verified",
                  rationale,
                  verification_record_id: recordId,
                  resolved_at: changedAt,
                  resolved_by: command.verified_by,
                  extensions: {},
                },
              }
            : {}),
        }),
      );
      const updated = unit.designReviews.updateIssue(issue, {
        expected_revision: command.expected_revision,
      });
      return { record, issue: updated };
    });
  }

  getDesignReference(id: string): DesignReference {
    return this.#read((unit) => unit.designReviews.getReference(id));
  }

  getDesignComparison(id: string): DesignComparison {
    return this.#read((unit) => unit.designReviews.getComparison(id));
  }

  listDesignReferences(page?: PageRequest): Page<DesignReference> {
    return this.#read((unit) => unit.designReviews.listReferences(page));
  }

  listDesignComparisons(
    query?: DesignComparisonQuery,
    page?: PageRequest,
  ): Page<DesignComparison> {
    return this.#read((unit) => unit.designReviews.listComparisons(query, page));
  }

  getReviewIssue(id: string): ReviewIssue {
    return this.#read((unit) => findIssue(unit, id));
  }

  listReviewIssues(query?: ReviewIssueQuery, page?: PageRequest): Page<ReviewIssue> {
    return this.#read((unit) => unit.designReviews.listIssues(query, page));
  }

  #transitionIssue(
    current: ReviewIssue,
    change: {
      readonly toState: ReviewIssueState;
      readonly reason?: string;
      readonly changedBy: JsonObject;
      readonly verificationRecordId?: string;
    },
    amend: (issue: JsonObject, changedAt: string) => JsonObject = (issue) => issue,
  ): ReviewIssue {
    const fromState = current.state as ReviewIssueState;
    if (!REVIEW_ISSUE_TRANSITIONS[fromState]?.includes(change.toState)) {
      throw new DataError(
        "conflict",
        `A Review Issue cannot transition from ${fromState} to ${change.toState}.`,
        { details: { issue_id: current.issue_id, from_state: fromState, to_state: change.toState } },
      );
    }
    const now = this.#workspace.clock.now();
    const nextRevision = current.revision + 1;
    const candidate = amend({
      ...(current as JsonObject),
      revision: nextRevision,
      state: change.toState,
      state_history: [
        ...(current["state_history"] as readonly JsonValue[]),
        {
          revision: nextRevision,
          from_state: fromState,
          to_state: change.toState,
          ...(change.reason === undefined ? {} : { reason: change.reason }),
          ...(change.verificationRecordId === undefined
            ? {}
            : { verification_record_id: change.verificationRecordId }),
          changed_at: now,
          changed_by: change.changedBy,
          extensions: {},
        },
      ],
      updated_at: now,
      updated_by: change.changedBy,
    }, now);
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.reviewIssue, candidate);
    return candidate as unknown as ReviewIssue;
  }

  #read<T>(operation: (unit: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>) => T): T {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      return operation(unit);
    } finally {
      unit.rollback();
    }
  }

  #write<T>(operation: (unit: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>) => T): T {
    const unit = this.#workspace.beginUnitOfWork("write");
    try {
      const result = operation(unit);
      unit.commit();
      return result;
    } catch (error) {
      try {
        unit.rollback();
      } catch {
        // Preserve the original command failure.
      }
      throw error;
    }
  }
}

function findIssue(
  unit: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>,
  issueId: string,
): ReviewIssue {
  const issue = collectAllPages((page) => unit.designReviews.listIssues(undefined, page)).find(
    (candidate) => candidate.issue_id === issueId,
  );
  if (issue === undefined) {
    throw new DataError("not_found", "The Review Issue does not exist.", {
      details: { issue_id: issueId },
    });
  }
  return issue;
}

interface LocatedNode {
  readonly treeId: string;
  readonly nodeId: string;
  readonly stableId: string | undefined;
  readonly frame: RectValue;
}

interface SnapshotNodeIndex {
  readonly byNodeId: ReadonlyMap<string, LocatedNode>;
  readonly byStableId: ReadonlyMap<string, LocatedNode>;
  readonly completeInlineTrees: boolean;
}

function indexSnapshotNodes(snapshot: RuntimeSnapshot): SnapshotNodeIndex {
  const byNodeId = new Map<string, LocatedNode>();
  const byStableId = new Map<string, LocatedNode>();
  let completeInlineTrees = true;
  const trees = snapshot["trees"];
  if (!Array.isArray(trees)) {
    throw new DataError("integrity_error", "A validated RuntimeSnapshot has no tree array.");
  }
  for (const treeValue of trees) {
    const tree = treeValue as JsonObject;
    const payload = tree["payload"] as JsonObject;
    const inlineNodes = payload["inline_nodes"];
    if (!Array.isArray(inlineNodes)) {
      // Object-backed trees keep the comparison honest as partial coverage.
      completeInlineTrees = false;
      continue;
    }
    for (const nodeValue of inlineNodes) {
      const node = nodeValue as JsonObject;
      const frame = node["frame"] as unknown as RectValue;
      const located: LocatedNode = {
        treeId: String(tree["tree_id"]),
        nodeId: String(node["node_id"]),
        stableId: typeof node["stable_id"] === "string" ? node["stable_id"] : undefined,
        frame,
      };
      byNodeId.set(located.nodeId, located);
      if (located.stableId !== undefined && !byStableId.has(located.stableId)) {
        byStableId.set(located.stableId, located);
      }
    }
  }
  return { byNodeId, byStableId, completeInlineTrees };
}

function frameDeviation(expected: RectValue, actual: RectValue): number {
  return Math.max(
    Math.abs(expected.x - actual.x),
    Math.abs(expected.y - actual.y),
    Math.abs(expected.width - actual.width),
    Math.abs(expected.height - actual.height),
  );
}

function rectValue(rect: RectValue): JsonObject {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function collectAllPages<T>(
  loadPage: (page: PageRequest | undefined) => Page<T>,
): T[] {
  const values: T[] = [];
  let cursor: string | undefined;
  do {
    const page = loadPage(cursor === undefined ? undefined : { cursor });
    values.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== undefined);
  return values;
}
