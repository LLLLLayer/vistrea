import type {
  BuildDiff,
  Commit,
  DesignComparison,
  DesignReference,
  DesignRegionMapping,
  KnowledgeCollection,
  ObjectRef,
  Observation,
  OperationRecord,
  Ref,
  ReviewIssue,
  ReviewVerificationRecord,
  RuntimeEvent,
  RuntimeSnapshot,
  ScreenGraph,
  StateIdentityDecision,
  Tag,
  TuningApplication,
  TuningPatch,
  ValidationFinding,
  ValidationRun,
  ValidationSuppression,
  WikiLink,
  WikiNode,
  WorkingSet,
} from "../api/models.js";

export interface DeletedWikiLink {
  readonly link: WikiLink;
  readonly deleted_revision: number;
}

export interface MemoryState {
  snapshots: Map<string, RuntimeSnapshot>;
  snapshotObjects: Map<string, readonly ObjectRef[]>;
  snapshotPins: Map<string, readonly string[]>;
  observations: Map<string, Observation>;
  runtimeEvents: Map<string, RuntimeEvent>;
  reportedEventGaps: Map<string, readonly Readonly<{ first_sequence: number; last_sequence: number }>[]>
  screenGraphs: Map<string, ScreenGraph>;
  screenGraphsByVersion: Map<string, string>;
  identityDecisions: Map<string, StateIdentityDecision>;
  wikiNodes: Map<string, WikiNode>;
  wikiLinks: Map<string, WikiLink>;
  deletedWikiLinks: Map<string, DeletedWikiLink>;
  knowledgeCollections: Map<string, KnowledgeCollection>;
  designReferences: Map<string, DesignReference>;
  designRegionMappings: Map<string, DesignRegionMapping>;
  designComparisons: Map<string, DesignComparison>;
  reviewIssues: Map<string, ReviewIssue>;
  reviewVerificationRecords: Map<string, ReviewVerificationRecord>;
  tuningPatches: Map<string, TuningPatch>;
  tuningApplications: Map<string, TuningApplication>;
  validationRuns: Map<string, ValidationRun>;
  validationFindings: Map<string, ValidationFinding>;
  validationSuppressions: Map<string, ValidationSuppression>;
  buildDiffs: Map<string, BuildDiff>;
  operations: Map<string, OperationRecord>;
  commits: Map<string, Commit>;
  refs: Map<string, Ref>;
  tags: Map<string, Tag>;
  workingSets: Map<string, WorkingSet>;
}

export function createEmptyMemoryState(): MemoryState {
  return {
    snapshots: new Map(),
    snapshotObjects: new Map(),
    snapshotPins: new Map(),
    observations: new Map(),
    runtimeEvents: new Map(),
    reportedEventGaps: new Map(),
    screenGraphs: new Map(),
    screenGraphsByVersion: new Map(),
    identityDecisions: new Map(),
    wikiNodes: new Map(),
    wikiLinks: new Map(),
    deletedWikiLinks: new Map(),
    knowledgeCollections: new Map(),
    designReferences: new Map(),
    designRegionMappings: new Map(),
    designComparisons: new Map(),
    reviewIssues: new Map(),
    reviewVerificationRecords: new Map(),
    tuningPatches: new Map(),
    tuningApplications: new Map(),
    validationRuns: new Map(),
    validationFindings: new Map(),
    validationSuppressions: new Map(),
    buildDiffs: new Map(),
    operations: new Map(),
    commits: new Map(),
    refs: new Map(),
    tags: new Map(),
    workingSets: new Map(),
  };
}
