import fs from "node:fs/promises";
import path from "node:path";

import {
  PROTOCOL_SCHEMA_IDS,
  type BuildDiff,
  type Commit,
  type DesignComparison,
  type DesignReference,
  type DesignRegionMapping,
  type JsonObject,
  type JsonValue,
  type KnowledgeCollection,
  type ObjectRef,
  type Observation,
  type OperationRecord,
  type ProtocolSchemaId,
  type ProtocolValidator,
  type Ref,
  type ReviewIssue,
  type ReviewVerificationRecord,
  type RuntimeEventBatch,
  type RuntimeSnapshot,
  type ScreenGraph,
  type StateIdentityDecision,
  type Tag,
  type TuningApplication,
  type TuningPatch,
  type ValidationFinding,
  type ValidationRun,
  type ValidationSuppression,
  type WikiLink,
  type WikiNode,
  type WorkingSet,
} from "../api/models.js";
import type { MemoryDataSeed } from "./memory-data.js";

export interface FixtureSeedOptions {
  readonly validator: ProtocolValidator;
  readonly repositoryRoot?: string;
}

interface KnowledgeBundle extends JsonObject {
  readonly nodes: readonly WikiNode[];
  readonly links: readonly WikiLink[];
  readonly collections: readonly KnowledgeCollection[];
}

interface DesignReviewBundle extends JsonObject {
  readonly references: readonly DesignReference[];
  readonly mappings: readonly DesignRegionMapping[];
  readonly comparisons: readonly DesignComparison[];
  readonly issues: readonly ReviewIssue[];
  readonly verifications: readonly ReviewVerificationRecord[];
  readonly patches: readonly TuningPatch[];
  readonly applications: readonly TuningApplication[];
}

interface ValidationBundle extends JsonObject {
  readonly run: ValidationRun;
  readonly findings: readonly ValidationFinding[];
  readonly suppressions: readonly ValidationSuppression[];
}

/** Loads one deterministic, protocol-backed local fact base for consumer tests. */
export async function loadPhase0A2FixtureSeed(
  options: FixtureSeedOptions,
): Promise<MemoryDataSeed> {
  const root = path.resolve(options.repositoryRoot ?? process.cwd());
  const fixtures = path.join(root, "protocol/fixtures/v1");
  const read = async <T>(relativePath: string, schemaId: ProtocolSchemaId): Promise<T> => {
    const value = JSON.parse(await fs.readFile(path.join(fixtures, relativePath), "utf8")) as unknown;
    options.validator.assert(schemaId, value);
    return value as T;
  };

  const [
    snapshot,
    runtimeEventBatch,
    graph,
    knowledge,
    design,
    validation,
    buildDiff,
    operation,
    commit,
    ref,
    tag,
    workingSet,
  ] = await Promise.all([
    read<RuntimeSnapshot>("runtime-snapshot/valid/minimal.json", PROTOCOL_SCHEMA_IDS.runtimeSnapshot),
    read<RuntimeEventBatch>(
      "runtime-event-batch/valid/ordered-with-filtered-gap.json",
      PROTOCOL_SCHEMA_IDS.runtimeEventBatch,
    ),
    read<ScreenGraph>("graph/valid/coherent.json", PROTOCOL_SCHEMA_IDS.screenGraph),
    read<KnowledgeBundle>(
      "knowledge/valid/bundle.json",
      PROTOCOL_SCHEMA_IDS.knowledgeGraph,
    ),
    read<DesignReviewBundle>(
      "design/valid/review-bundle.json",
      PROTOCOL_SCHEMA_IDS.designReviewBundle,
    ),
    read<ValidationBundle>(
      "validation/valid/bundle.json",
      PROTOCOL_SCHEMA_IDS.validationBundle,
    ),
    read<BuildDiff>("validation/valid/build-diff.json", PROTOCOL_SCHEMA_IDS.buildDiff),
    read<OperationRecord>(
      "operation/valid/succeeded-inline.json",
      PROTOCOL_SCHEMA_IDS.operationRecord,
    ),
    read<Commit>("commit/valid/initial.json", PROTOCOL_SCHEMA_IDS.commit),
    read<Ref>("ref/valid/team-main.json", PROTOCOL_SCHEMA_IDS.ref),
    read<Tag>("tag/valid/baseline-v1.json", PROTOCOL_SCHEMA_IDS.tag),
    read<WorkingSet>("working-set/valid/after-genesis.json", PROTOCOL_SCHEMA_IDS.workingSet),
  ]);

  const verifiedObjects = collectObjectRefs([
    snapshot,
    graph,
    knowledge,
    design,
    validation,
    buildDiff,
    operation,
    commit,
  ]);
  for (const object of verifiedObjects) {
    options.validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
  }

  const selector = graph.context["version_selector"] as JsonObject | undefined;
  const selectorKey = selector === undefined ? undefined : versionSelectorKey(selector);

  return {
    verifiedObjects,
    snapshots: [snapshot],
    observations: [...graph.observations] as readonly Observation[],
    runtimeEventBatches: [runtimeEventBatch],
    screenGraphs: [graph],
    ...(selectorKey === undefined
      ? {}
      : { screenGraphsByVersion: { [selectorKey]: graph.screen_graph_id } }),
    identityDecisions: [...graph.identity_decisions] as readonly StateIdentityDecision[],
    wikiNodes: knowledge.nodes,
    wikiLinks: knowledge.links,
    knowledgeCollections: knowledge.collections,
    designReferences: design.references,
    designRegionMappings: design.mappings,
    designComparisons: design.comparisons,
    reviewIssues: design.issues,
    reviewVerificationRecords: design.verifications,
    tuningPatches: design.patches,
    tuningApplications: design.applications,
    validationRuns: [validation.run],
    validationFindings: validation.findings,
    validationSuppressions: validation.suppressions,
    buildDiffs: [buildDiff],
    operationRecords: [operation],
    commits: [commit],
    refs: [ref],
    tags: [tag],
    workingSets: [workingSet],
  };
}

function collectObjectRefs(values: readonly JsonValue[]): ObjectRef[] {
  const objects = new Map<string, ObjectRef>();
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const object = value as JsonObject;
    if (
      typeof object["hash"] === "string" &&
      typeof object["media_type"] === "string" &&
      typeof object["byte_size"] === "number" &&
      typeof object["compression"] === "string" &&
      typeof object["extensions"] === "object"
    ) {
      objects.set(object["hash"], object as ObjectRef);
    }
    for (const child of Object.values(object)) {
      visit(child);
    }
  };
  for (const value of values) {
    visit(value);
  }
  return [...objects.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

function versionSelectorKey(selector: JsonObject): string {
  if (selector["kind"] === "commit") {
    return `commit:${String(selector["commit_id"])}`;
  }
  if (selector["kind"] === "ref") {
    return `ref:${String(selector["ref_name"])}`;
  }
  return `tag:${String(selector["tag_name"])}`;
}
