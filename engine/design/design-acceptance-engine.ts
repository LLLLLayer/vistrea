import {
  DataError,
  type DesignComparison,
  type JsonObject,
  type ReviewIssue,
  type ReviewVerificationRecord,
  type RuntimeSnapshot,
} from "../../data/api/index.js";
import type { CaptureSnapshotCommand } from "../connection/index.js";
import type { DesignReviewEngine } from "./design-review-engine.js";

export interface DesignRecapturePort {
  execute(command: CaptureSnapshotCommand): Promise<RuntimeSnapshot>;
}

export interface RecaptureAndVerifyIssueCommand {
  readonly issue_id: string;
  readonly expected_revision: number;
  readonly verified_by: JsonObject;
}

export interface RecaptureAndVerifyIssueResult {
  readonly snapshot: RuntimeSnapshot;
  readonly comparison: DesignComparison;
  readonly verification: ReviewVerificationRecord;
  readonly issue: ReviewIssue;
}

/** Product-level design acceptance orchestration over reusable Engine ports. */
export class DesignAcceptanceEngine {
  readonly #capture: DesignRecapturePort;
  readonly #reviews: DesignReviewEngine;

  constructor(dependencies: {
    readonly capture: DesignRecapturePort;
    readonly reviews: DesignReviewEngine;
  }) {
    this.#capture = dependencies.capture;
    this.#reviews = dependencies.reviews;
  }

  /**
   * Captures fresh visual truth, reruns the referenced comparison, and appends
   * an immutable verification record. Partial comparison coverage can never
   * resolve an issue: it produces an inconclusive result.
   */
  async recaptureAndVerifyIssue(
    command: RecaptureAndVerifyIssueCommand,
  ): Promise<RecaptureAndVerifyIssueResult> {
    const current = this.#reviews.getReviewIssue(command.issue_id);
    if (current.revision !== command.expected_revision) {
      throw new DataError("conflict", "The Review Issue revision is stale.", {
        details: {
          issue_id: command.issue_id,
          expected_revision: command.expected_revision,
          actual_revision: current.revision,
        },
      });
    }
    if (current.state !== "ready_for_verification") {
      throw new DataError(
        "conflict",
        "Only a Review Issue that is ready for verification can be recaptured.",
        { details: { issue_id: command.issue_id, state: current.state } },
      );
    }
    const originalSnapshot = this.#reviews.getReviewIssueTargetSnapshot(command.issue_id);
    const originalRuntimeContext = originalSnapshot["runtime_context"] as JsonObject;
    const originalBuildId = originalRuntimeContext["build_id"];
    if (typeof originalBuildId !== "string") {
      throw new DataError(
        "integrity_error",
        "The reviewed Snapshot has no build identity.",
        { details: { snapshot_id: originalSnapshot.snapshot_id } },
      );
    }
    const snapshot = await this.#capture.execute({
      include: { paths: ["trees", "screenshot"] },
      screenshot: "reference",
      reason: "review",
    });
    const runtimeContext = snapshot["runtime_context"] as JsonObject;
    const buildId = runtimeContext["build_id"];
    if (typeof buildId !== "string") {
      throw new DataError("integrity_error", "The captured Snapshot has no build identity.");
    }
    if (buildId === originalBuildId) {
      throw new DataError(
        "conflict",
        "Design acceptance requires a capture from a different real build.",
        {
          details: {
            issue_id: command.issue_id,
            original_build_id: originalBuildId,
            candidate_build_id: buildId,
          },
        },
      );
    }
    const comparison = await this.#reviews.runDesignComparison({
      design_reference_id: current.design_reference_id,
      target_snapshot_id: snapshot.snapshot_id,
      completed_by: command.verified_by,
      include_pixel: true,
    });
    const issueTarget = current["runtime_target"] as JsonObject;
    const matchingDifference = (comparison["differences"] as readonly JsonObject[]).find(
      (difference) => {
        if (difference["category"] !== current["category"]) return false;
        if (
          typeof current["mapping_id"] === "string" &&
          difference["mapping_id"] === current["mapping_id"]
        ) {
          return true;
        }
        const target = difference["runtime_target"] as JsonObject | undefined;
        return (
          target !== undefined &&
          typeof issueTarget["stable_id"] === "string" &&
          target["stable_id"] === issueTarget["stable_id"]
        );
      },
    );
    const result =
      comparison["quality"] !== "complete"
        ? "inconclusive" as const
        : matchingDifference === undefined
          ? "passed" as const
          : "failed" as const;
    const verified = await this.#reviews.verifyReviewIssue({
      issue_id: command.issue_id,
      expected_revision: command.expected_revision,
      basis: "real_build",
      result,
      verified_snapshot_id: snapshot.snapshot_id,
      verified_build_id: buildId,
      rationale:
        result === "passed"
          ? "A fresh real-build capture no longer contains the reviewed design difference."
          : result === "failed"
            ? "A fresh real-build capture still contains the reviewed design difference."
            : "The fresh comparison has partial coverage and cannot prove acceptance.",
      verified_by: command.verified_by,
    });
    return {
      snapshot,
      comparison,
      verification: verified.record,
      issue: verified.issue,
    };
  }
}
