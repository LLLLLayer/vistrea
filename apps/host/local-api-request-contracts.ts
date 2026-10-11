import type { ImplementedHostOperation } from "../../integrations/shared/index.js";

/**
 * The transport shape accepted by each Host Local API operation.
 *
 * `none` and `query` reject request bodies. `json` accepts one strict JSON
 * command object and rejects unknown fields or mismatched field types before
 * dispatching to the Engine. `binary` owns a media-type-specific byte stream.
 */
export type HostLocalApiRequestShape = "binary" | "json" | "none" | "query";

export const HOST_LOCAL_API_REQUEST_SHAPES = {
  GetWorkspaceStatus: "none",
  CreateWorkspaceRecoveryPoint: "json",
  ListWorkspaceRecoveryPoints: "none",
  ReleaseWorkspaceRecoveryPoint: "json",
  CaptureSnapshot: "json",
  ListSnapshots: "query",
  GetSnapshot: "none",
  GetEventTimeline: "query",

  AddDesignAsset: "binary",
  AddDesignReference: "json",
  PromoteVisualBaseline: "json",
  GetDesignReference: "none",
  ListDesignReferences: "query",
  MapDesignRegion: "json",
  RunDesignComparison: "json",
  GetDesignComparison: "none",
  ListDesignComparisons: "query",
  CreateReviewIssue: "json",
  CreateReviewIssueFromDifference: "json",
  ListReviewIssues: "query",
  GetReviewIssue: "none",
  TransitionReviewIssue: "json",
  VerifyReviewIssue: "json",
  RecaptureAndVerifyIssue: "json",

  CreateTuningPatch: "json",
  GetTuningPatch: "none",
  GenerateTuningSourceSuggestions: "none",
  ApplyTuningPatch: "json",
  RevertTuningApplication: "none",
  GetTuningApplication: "none",
  ListActiveTuning: "none",

  RecordStateObservation: "json",
  RecordTransitionObservation: "json",
  GetScreenGraph: "query",
  GetScreenState: "query",
  MergeScreenStates: "json",
  SplitScreenState: "json",
  AnnotateScreenState: "json",
  TagGraphVersion: "json",
  FindScreenPath: "query",
  RunExploration: "json",
  GetExplorationOperation: "none",
  CancelExploration: "none",

  CreateWikiNode: "json",
  UpdateWikiNode: "json",
  GetWikiNode: "none",
  ListWikiNodes: "query",
  LinkWikiNode: "json",
  UnlinkWikiNode: "json",
  GetWikiBacklinks: "query",
  GetRelatedWikiNodes: "query",
  CreateKnowledgeCollection: "json",
  UpdateKnowledgeCollection: "json",
  GetKnowledgeCollection: "none",
  ListKnowledgeCollections: "query",
  PublishKnowledgeCollection: "json",
  ExportKnowledgeCollection: "json",

  ValidateSnapshot: "json",
  ValidateScreenGraph: "json",
  GetValidationRun: "none",
  ListValidationFindings: "query",
  GetValidationFinding: "none",
  SuppressValidationFinding: "json",
  CompareBuilds: "json",
  GetBuildDiff: "none",

  GetSyncStatus: "json",
  FetchWorkspace: "json",
  PushWorkspace: "json",
  GetSyncActivity: "json",

  ExportPack: "json",
  ImportPack: "binary",
  GetObject: "none",
} as const satisfies Readonly<Record<ImplementedHostOperation, HostLocalApiRequestShape>>;
