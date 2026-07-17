export interface HostOperationDescriptor {
  readonly operation: string;
  readonly kind: "C" | "Q";
  readonly method: "GET" | "POST";
  readonly route: string;
  readonly cli: string;
}

/**
 * Machine-readable parity contract for every operation implemented by the
 * Host Local API and strict JSON CLI. The operation catalog is validated
 * against this manifest by the Host contract suite.
 */
export const HOST_OPERATION_MANIFEST = [
  { operation: "GetWorkspaceStatus", kind: "Q", method: "GET", route: "/v1/status", cli: "workspace status" },
  { operation: "CreateWorkspaceRecoveryPoint", kind: "C", method: "POST", route: "/v1/workspace/recovery-points", cli: "workspace recovery-point create" },
  { operation: "ListWorkspaceRecoveryPoints", kind: "Q", method: "GET", route: "/v1/workspace/recovery-points", cli: "workspace recovery-point list" },
  { operation: "ReleaseWorkspaceRecoveryPoint", kind: "C", method: "POST", route: "/v1/workspace/recovery-points/release", cli: "workspace recovery-point release" },
  { operation: "CaptureSnapshot", kind: "C", method: "POST", route: "/v1/captures", cli: "snapshot capture" },
  { operation: "ListSnapshots", kind: "Q", method: "GET", route: "/v1/snapshots", cli: "snapshot list" },
  { operation: "GetSnapshot", kind: "Q", method: "GET", route: "/v1/snapshots/<id>", cli: "snapshot get" },
  { operation: "GetEventTimeline", kind: "Q", method: "GET", route: "/v1/events", cli: "events list" },

  { operation: "AddDesignAsset", kind: "C", method: "POST", route: "/v1/design-assets", cli: "design upload-asset" },
  { operation: "AddDesignReference", kind: "C", method: "POST", route: "/v1/design-references", cli: "design add-reference" },
  { operation: "PromoteVisualBaseline", kind: "C", method: "POST", route: "/v1/design-baselines", cli: "design promote-baseline" },
  { operation: "GetDesignReference", kind: "Q", method: "GET", route: "/v1/design-references/<id>", cli: "design get-reference" },
  { operation: "ListDesignReferences", kind: "Q", method: "GET", route: "/v1/design-references", cli: "design list-references" },
  { operation: "MapDesignRegion", kind: "C", method: "POST", route: "/v1/design-mappings", cli: "design map" },
  { operation: "RunDesignComparison", kind: "C", method: "POST", route: "/v1/design-comparisons", cli: "design compare" },
  { operation: "GetDesignComparison", kind: "Q", method: "GET", route: "/v1/design-comparisons/<id>", cli: "design get-comparison" },
  { operation: "ListDesignComparisons", kind: "Q", method: "GET", route: "/v1/design-comparisons", cli: "design list-comparisons" },
  { operation: "CreateReviewIssue", kind: "C", method: "POST", route: "/v1/review-issues", cli: "issue create" },
  { operation: "CreateReviewIssueFromDifference", kind: "C", method: "POST", route: "/v1/design-comparisons/<id>/issues", cli: "issue create-from-difference" },
  { operation: "ListReviewIssues", kind: "Q", method: "GET", route: "/v1/review-issues", cli: "issue list" },
  { operation: "GetReviewIssue", kind: "Q", method: "GET", route: "/v1/review-issues/<id>", cli: "issue get" },
  { operation: "TransitionReviewIssue", kind: "C", method: "POST", route: "/v1/review-issues/<id>/transitions", cli: "issue transition" },
  { operation: "VerifyReviewIssue", kind: "C", method: "POST", route: "/v1/review-issues/<id>/verifications", cli: "issue verify" },
  { operation: "RecaptureAndVerifyIssue", kind: "C", method: "POST", route: "/v1/review-issues/<id>/recapture-verifications", cli: "issue recapture-verify" },

  { operation: "CreateTuningPatch", kind: "C", method: "POST", route: "/v1/tuning-patches", cli: "tuning create-patch" },
  { operation: "GetTuningPatch", kind: "Q", method: "GET", route: "/v1/tuning-patches/<id>", cli: "tuning get-patch" },
  { operation: "GenerateTuningSourceSuggestions", kind: "Q", method: "GET", route: "/v1/tuning-patches/<id>/source-suggestions", cli: "tuning source-suggestions" },
  { operation: "ApplyTuningPatch", kind: "C", method: "POST", route: "/v1/tuning-applications", cli: "tuning apply" },
  { operation: "RevertTuningApplication", kind: "C", method: "POST", route: "/v1/tuning-applications/<id>/revert", cli: "tuning revert" },
  { operation: "GetTuningApplication", kind: "Q", method: "GET", route: "/v1/tuning-applications/<id>", cli: "tuning get-application" },
  { operation: "ListActiveTuning", kind: "Q", method: "GET", route: "/v1/tuning-applications/active", cli: "tuning list-active" },

  { operation: "RecordStateObservation", kind: "C", method: "POST", route: "/v1/screen-graph/state-observations", cli: "graph observe-state" },
  { operation: "RecordTransitionObservation", kind: "C", method: "POST", route: "/v1/screen-graph/transition-observations", cli: "graph observe-transition" },
  { operation: "GetScreenGraph", kind: "Q", method: "GET", route: "/v1/screen-graph", cli: "graph show" },
  { operation: "GetScreenState", kind: "Q", method: "GET", route: "/v1/screen-states/<id>", cli: "graph get-state" },
  { operation: "MergeScreenStates", kind: "C", method: "POST", route: "/v1/screen-graph/state-merges", cli: "screen merge" },
  { operation: "SplitScreenState", kind: "C", method: "POST", route: "/v1/screen-graph/state-splits", cli: "screen split" },
  { operation: "AnnotateScreenState", kind: "C", method: "POST", route: "/v1/screen-graph/state-annotations", cli: "screen annotate" },
  { operation: "TagGraphVersion", kind: "C", method: "POST", route: "/v1/screen-graph/version-tags", cli: "graph tag" },
  { operation: "FindScreenPath", kind: "Q", method: "GET", route: "/v1/screen-graph/paths", cli: "graph find-path" },
  { operation: "RunExploration", kind: "C", method: "POST", route: "/v1/exploration/operations", cli: "explore run" },
  { operation: "GetExplorationOperation", kind: "Q", method: "GET", route: "/v1/exploration/operations/<id>", cli: "explore get" },
  { operation: "CancelExploration", kind: "C", method: "POST", route: "/v1/exploration/operations/<id>/cancel", cli: "explore cancel" },

  { operation: "CreateWikiNode", kind: "C", method: "POST", route: "/v1/wiki/nodes", cli: "wiki create" },
  { operation: "UpdateWikiNode", kind: "C", method: "POST", route: "/v1/wiki/nodes/<id>/revisions", cli: "wiki update" },
  { operation: "GetWikiNode", kind: "Q", method: "GET", route: "/v1/wiki/nodes/<id>", cli: "wiki get" },
  { operation: "ListWikiNodes", kind: "Q", method: "GET", route: "/v1/wiki/nodes", cli: "wiki search" },
  { operation: "LinkWikiNode", kind: "C", method: "POST", route: "/v1/wiki/links", cli: "wiki link" },
  { operation: "UnlinkWikiNode", kind: "C", method: "POST", route: "/v1/wiki/links/<id>/unlink", cli: "wiki unlink" },
  { operation: "GetWikiBacklinks", kind: "Q", method: "GET", route: "/v1/wiki/nodes/<id>/backlinks", cli: "wiki backlinks" },
  { operation: "GetRelatedWikiNodes", kind: "Q", method: "GET", route: "/v1/wiki/related", cli: "wiki related" },
  { operation: "CreateKnowledgeCollection", kind: "C", method: "POST", route: "/v1/knowledge-collections", cli: "collection create" },
  { operation: "UpdateKnowledgeCollection", kind: "C", method: "POST", route: "/v1/knowledge-collections/<id>/revisions", cli: "collection update" },
  { operation: "GetKnowledgeCollection", kind: "Q", method: "GET", route: "/v1/knowledge-collections/<id>", cli: "collection get" },
  { operation: "ListKnowledgeCollections", kind: "Q", method: "GET", route: "/v1/knowledge-collections", cli: "collection list" },
  { operation: "PublishKnowledgeCollection", kind: "C", method: "POST", route: "/v1/knowledge-collections/<id>/publication", cli: "collection publish" },
  { operation: "ExportKnowledgeCollection", kind: "C", method: "POST", route: "/v1/knowledge-collections/<id>/exports", cli: "collection export" },

  { operation: "ValidateSnapshot", kind: "C", method: "POST", route: "/v1/validation/snapshot-runs", cli: "validate snapshot" },
  { operation: "ValidateScreenGraph", kind: "C", method: "POST", route: "/v1/validation/graph-runs", cli: "validate graph" },
  { operation: "GetValidationRun", kind: "Q", method: "GET", route: "/v1/validation/runs/<id>", cli: "validate get-run" },
  { operation: "ListValidationFindings", kind: "Q", method: "GET", route: "/v1/validation/findings", cli: "validate findings" },
  { operation: "GetValidationFinding", kind: "Q", method: "GET", route: "/v1/validation/findings/<id>", cli: "validate get-finding" },
  { operation: "SuppressValidationFinding", kind: "C", method: "POST", route: "/v1/validation/findings/<id>/suppress", cli: "validate suppress" },
  { operation: "CompareBuilds", kind: "C", method: "POST", route: "/v1/validation/build-diffs", cli: "validate build-diff" },
  { operation: "GetBuildDiff", kind: "Q", method: "GET", route: "/v1/validation/build-diffs/<id>", cli: "validate get-build-diff" },

  { operation: "GetSyncStatus", kind: "Q", method: "POST", route: "/v1/sync/status", cli: "sync status" },
  { operation: "FetchWorkspace", kind: "C", method: "POST", route: "/v1/sync/fetch", cli: "sync fetch" },
  { operation: "PushWorkspace", kind: "C", method: "POST", route: "/v1/sync/push", cli: "sync push" },
  { operation: "GetSyncActivity", kind: "Q", method: "POST", route: "/v1/sync/activity", cli: "sync activity" },

  { operation: "ExportPack", kind: "C", method: "POST", route: "/v1/exchange/exports", cli: "pack export" },
  { operation: "ImportPack", kind: "C", method: "POST", route: "/v1/exchange/imports", cli: "pack import" },
  { operation: "GetObject", kind: "Q", method: "GET", route: "/v1/objects/<hash>", cli: "object get" },
] as const satisfies readonly HostOperationDescriptor[];

export type ImplementedHostOperation = (typeof HOST_OPERATION_MANIFEST)[number]["operation"];

export const IMPLEMENTED_HOST_OPERATIONS: readonly ImplementedHostOperation[] =
  HOST_OPERATION_MANIFEST.map(({ operation }) => operation);
