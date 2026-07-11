# Engine Operation Catalog

Status: **Draft for protocol version 1.0**

This catalog closes the parity gap between Studio, CLI, MCP, Skills, CI, Engine modules, and Data ports. Named request and result types become machine-readable schemas as each phase begins.

## Legend

- Kind: `C` command, `Q` query, `S` stream.
- The `Request -> Result` column names the final typed result.
- Execution: `sync` returns that result immediately; `async` immediately returns `OperationRef`, then exposes the listed completion result through `GetOperationResult` after success.
- Data ports: `W` Workspace, `Sn` Snapshot, `Ob` Observation, `Ev` Runtime Event, `G` Screen Graph, `K` Wiki, `D` Design Review, `Va` Validation, `Op` Operation, `Vr` Version, `Obj` Object Store, `X` Exchange, `Sy` Sync.
- A dash means no durable Data port is required for the operation itself.
- Adapter names are reserved contracts; implementation follows the listed phase.

## Workspace

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `CreateWorkspace` | C | `CreateWorkspaceCommand -> WorkspaceDescriptor` | sync | Workspace / W,Vr | atomic genesis Commit/default-ref bootstrap | `workspace create` / `vistrea_create_workspace` | 0B |
| `OpenWorkspace` | C | `OpenWorkspaceCommand -> WorkspaceDescriptor` | sync | Workspace / W | compatible version | `workspace open` / `vistrea_open_workspace` | 0B |
| `CloseWorkspace` | C | `CloseWorkspaceCommand -> Empty` | sync | Workspace / W | no active write UoW | `workspace close` / — | 0B |
| `UpgradeWorkspace` | C | `UpgradeWorkspaceCommand -> MigrationResult` | async | Workspace / W,Op | backup policy | `workspace upgrade` / — | 0B |
| `ImportWorkspacePack` | C | `ImportPackCommand -> ImportPackResult` | async | Workspace / W,X,Obj,Vr,Op | import policy | `workspace import` / — | 0B |
| `ExportWorkspacePack` | C | `ExportPackCommand -> ObjectRef` | async | Workspace / X,Obj,Vr,Op | export/redaction policy | `workspace export` / — | 0B |
| `CollectWorkspaceGarbage` | C | `CollectGarbageCommand -> GarbageCollectionResult` | async | Workspace / W,Vr,Obj,Op | retention policy | `workspace gc` / — | 0B |
| `GetWorkspaceStatus` | Q | `WorkspaceStatusQuery -> WorkspaceStatus` | sync | Workspace / W | workspace open | `workspace status` / `vistrea_get_workspace_status` | 0B |
| `ListWorkspaceRefs` | Q | `ListRefsQuery -> Page<Ref>` | sync | Versioning / Vr | workspace open | `version ref-list` / — | 0B |
| `GetStorageUsage` | Q | `StorageUsageQuery -> StorageUsage` | sync | Workspace / W,Obj | workspace open | `workspace usage` / — | 0B |
| `CheckWorkspaceHealth` | Q | `WorkspaceHealthQuery -> WorkspaceHealth` | sync | Workspace / W,Obj,Vr | workspace available | `workspace health` / — | 0B |

## Runtime connection and device

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `ConnectRuntime` | C | `ConnectRuntimeCommand -> RuntimeConnection` | async | Connection / Op | authorized internal build | `device connect` / `vistrea_connect_runtime` | 1 |
| `DisconnectRuntime` | C | `DisconnectRuntimeCommand -> Empty` | sync | Connection / — | active connection | `device disconnect` / — | 1 |
| `OpenAutomationSession` | C | `OpenAutomationSessionCommand -> AutomationSession` | async | Automation / Op | provider and safety policy | `device automation-open` / — | 3 |
| `CloseAutomationSession` | C | `CloseAutomationSessionCommand -> Empty` | sync | Automation / — | active session | `device automation-close` / — | 3 |
| `LaunchApplication` | C | `LaunchApplicationCommand -> ActionResult` | async | Automation / Op | action policy | `device launch` / — | 3 |
| `TerminateApplication` | C | `TerminateApplicationCommand -> ActionResult` | async | Automation / Op | action policy | `device terminate` / — | 3 |
| `ListDevices` | Q | `DeviceQuery -> Page<DeviceDescriptor>` | sync | Automation / — | provider available | `device list` / `vistrea_list_devices` | 1 |
| `ListDiscoveredRuntimes` | Q | `RuntimeDiscoveryQuery -> Page<RuntimeDescriptor>` | sync | Connection / — | discovery available | `device runtime-list` / — | 1 |
| `GetConnectionStatus` | Q | `ConnectionStatusQuery -> ConnectionStatus` | sync | Connection / — | — | `device status` / — | 1 |
| `GetRuntimeCapabilities` | Q | `RuntimeCapabilitiesQuery -> CapabilitySet` | sync | Connection / — | active connection | `device capabilities` / — | 1 |

## Snapshot and inspection

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `CaptureSnapshot` | C | `CaptureSnapshotCommand -> CaptureSnapshotResult` | async | Connection / Sn,Ob,Ev,Obj,Op | `runtime.snapshot` | `snapshot capture` / `vistrea_capture_snapshot` | 1 |
| `PinSnapshot` | C | `PinSnapshotCommand -> SnapshotSummary` | sync | Workspace / Sn,Vr | retention policy | `snapshot pin` / — | 1 |
| `AttachArtifact` | C | `AttachArtifactCommand -> ArtifactLink` | sync | Knowledge / Sn,K,Obj | artifact policy | `snapshot attach` / — | 1 |
| `GetSnapshot` | Q | `GetSnapshotQuery -> RuntimeSnapshot` | sync | Connection/Knowledge / Sn,Obj | authorized artifact access | `snapshot get` / — | 1 |
| `ListSnapshots` | Q | `SnapshotQuery -> Page<SnapshotSummary>` | sync | Knowledge / Sn | workspace and query scope | `snapshot list` / — | 1 |
| `GetUiNode` | Q | `GetUiNodeQuery -> UiNode` | sync | Knowledge / Sn,Obj | snapshot available | `node get` / — | 1 |
| `QueryUiNodes` | Q | `UiNodeQuery -> Page<UiNodeSummary>` | sync | Knowledge / Sn | snapshot available | `node query` / `vistrea_query_ui_nodes` | 1 |
| `GetEventTimeline` | Q | `EventTimelineQuery -> EventTimeline` | sync | Knowledge / Ev | session/snapshot scope | `snapshot events` / — | 1 |
| `CompareSnapshots` | Q | `CompareSnapshotsQuery -> SnapshotDiff` | sync | Validation / Sn,Obj | both snapshots visible | `snapshot compare` / — | 4 |

## Screen graph and exploration

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `RunExploration` | C | `RunExplorationCommand -> ExplorationResult` | async | Exploration / Sn,Ob,Ev,G,Op,Vr | automation and safety policy | `explore run` / `vistrea_run_exploration` | 3 |
| `PauseExploration` | C | `PauseExplorationCommand -> OperationRef` | sync | Exploration / Op | running operation | `explore pause` / — | 3 |
| `ResumeExploration` | C | `ResumeExplorationCommand -> OperationRef` | sync | Exploration / Op | paused operation | `explore resume` / — | 3 |
| `CancelExploration` | C | `CancelExplorationCommand -> OperationRef` | sync | Exploration / Op | cancellable operation | `explore cancel` / — | 3 |
| `RecordManualTransition` | C | `RecordManualTransitionCommand -> Transition` | sync | Exploration / Ob,G | capture context | `screen transition-record` / — | 3 |
| `MergeScreenStates` | C | `MergeScreenStatesCommand -> StateIdentityDecision` | sync | Exploration / G,Vr | expected graph revision | `screen merge` / — | 3 |
| `SplitScreenState` | C | `SplitScreenStateCommand -> StateIdentityDecision` | sync | Exploration / G,Vr | expected graph revision | `screen split` / — | 3 |
| `MarkTransitionStatus` | C | `MarkTransitionStatusCommand -> Transition` | sync | Exploration / G,Vr | expected revision | `screen transition-mark` / — | 3 |
| `GetExplorationOperation` | Q | `GetOperationQuery -> ExplorationOperation` | sync | Operations / Op | operation visible | `explore status` / — | 3 |
| `GetScreenGraph` | Q | `ScreenGraphQuery -> ScreenGraph` | sync | Knowledge / G | graph context | `screen list` / `vistrea_get_screen_graph` | 3 |
| `GetScreenState` | Q | `GetScreenStateQuery -> ScreenState` | sync | Knowledge / G | state visible | `screen get` / — | 3 |
| `FindPath` | Q | `PathQuery -> PathResult[]` | sync | Knowledge / G | graph context | `screen path` / `vistrea_find_path` | 3 |
| `CompareScreenGraphs` | Q | `CompareGraphsQuery -> GraphDiff` | sync | Validation / G | both versions visible | `screen compare` / — | 4 |
| `ExplainStateIdentity` | Q | `StateIdentityQuery -> StateIdentityExplanation` | sync | Exploration / G | identity evidence | `screen identity-explain` / — | 3 |

## Design review and tuning

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `AddDesignReference` | C | `AddDesignReferenceCommand -> DesignReference` | async | Design / D,Obj,Op | artifact policy | `design reference-add` / — | 2 |
| `MapDesignRegion` | C | `MapDesignRegionCommand -> DesignRegionMapping` | sync | Design / D | expected revision | `design map` / — | 2 |
| `CreateReviewIssue` | C | `CreateReviewIssueCommand -> ReviewIssue` | sync | Design / D,Vr | issue policy | `design issue-create` / `vistrea_create_review_issue` | 2 |
| `UpdateReviewIssue` | C | `UpdateReviewIssueCommand -> ReviewIssue` | sync | Design / D,Vr | expected revision | `design issue-update` / — | 2 |
| `VerifyReviewIssue` | C | `VerifyReviewIssueCommand -> ReviewVerificationRecord` | sync | Design / D,Sn,Vr | real build evidence | `design issue-verify` / — | 2 |
| `CreateTuningPatch` | C | `CreateTuningPatchCommand -> TuningPatch` | sync | Design / D,Vr | allowlist policy | `design tune-create` / `vistrea_create_tuning_patch` | 2 |
| `ApplyTuningPatch` | C | `ApplyTuningPatchCommand -> TuningApplication` | async | Design/Connection / D,Sn,Op | `design.tuning` and policy | `design tune-apply` / `vistrea_apply_tuning_patch` | 2 |
| `RevertTuningApplication` | C | `RevertTuningApplicationCommand -> TuningApplication` | sync | Design/Connection / D | active application | `design tune-revert` / `vistrea_revert_tuning_application` | 2 |
| `ExportTuningPatch` | C | `ExportTuningPatchCommand -> ObjectRef` | sync | Design / D,Obj,X | export policy | `design tune-export` / — | 2 |
| `PromoteDesignBaseline` | C | `PromoteDesignBaselineCommand -> CommitAndRefResult` | sync | Design/Versioning / D,Vr | reviewer and ref CAS | `design baseline-promote` / — | 2 |
| `GetDesignReference` | Q | `GetDesignReferenceQuery -> DesignReference` | sync | Design / D,Obj | artifact access | `design reference-get` / — | 2 |
| `RunDesignComparison` | C | `RunDesignComparisonCommand -> DesignComparison` | async | Design / D,Sn,Obj,Op | evidence available | `design compare` / `vistrea_compare_design` | 2 |
| `ListReviewIssues` | Q | `ReviewIssueQuery -> Page<ReviewIssue>` | sync | Design / D | issue scope | `design issue-list` / — | 2 |
| `GetReviewIssue` | Q | `GetReviewIssueQuery -> ReviewIssue` | sync | Design / D | issue visible | `design issue-get` / — | 2 |
| `GetTuningPatch` | Q | `GetTuningPatchQuery -> TuningPatch` | sync | Design / D | patch visible | `design tune-get` / — | 2 |
| `ListActiveTuning` | Q | `ActiveTuningQuery -> TuningApplication[]` | sync | Design/Connection / D | active runtime | `design tune-active` / — | 2 |

## Validation

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `RunValidation` | C | `RunValidationCommand -> ValidationRun` | async | Validation / Va,Sn,G,D,Obj,Op | rule-set policy | `verify run` / `vistrea_run_validation` | 4 |
| `CancelValidation` | C | `CancelOperationCommand -> OperationRef` | sync | Operations / Op | cancellable operation | `verify cancel` / — | 4 |
| `AcceptValidationBaseline` | C | `AcceptValidationBaselineCommand -> CommitAndRefResult` | sync | Validation/Versioning / Va,Vr | reviewer and ref CAS | `verify baseline-accept` / — | 4 |
| `SuppressValidationFinding` | C | `SuppressFindingCommand -> ValidationSuppression` | sync | Validation / Va,Vr | suppression policy | `verify suppress` / — | 4 |
| `GetValidationOperation` | Q | `GetOperationQuery -> ValidationOperation` | sync | Operations / Op | operation visible | `verify status` / — | 4 |
| `ListValidationFindings` | Q | `ValidationFindingQuery -> Page<ValidationFinding>` | sync | Validation / Va | finding scope | `verify findings` / — | 4 |
| `GetValidationFinding` | Q | `GetValidationFindingQuery -> ValidationFinding` | sync | Validation / Va | finding visible | `verify finding-get` / — | 4 |
| `RunBuildComparison` | C | `RunBuildComparisonCommand -> BuildDiff` | async | Validation / Va,Sn,G,D,Obj,Op | both builds visible | `verify compare-builds` / `vistrea_compare_builds` | 4 |

## Deep Wiki

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `CreateWikiNode` | C | `CreateWikiNodeCommand -> WikiNode` | sync | Knowledge / K,Vr | write access | `wiki create` / — | 3 |
| `UpdateWikiNode` | C | `UpdateWikiNodeCommand -> WikiNode` | sync | Knowledge / K,Vr | expected revision | `wiki update` / — | 3 |
| `LinkWikiNodes` | C | `LinkWikiNodesCommand -> WikiLink` | sync | Knowledge / K,Vr | write access | `wiki link` / — | 3 |
| `UnlinkWikiNodes` | C | `UnlinkWikiNodesCommand -> Empty` | sync | Knowledge / K,Vr | expected revision | `wiki unlink` / — | 3 |
| `AttachRuntimeEvidence` | C | `AttachRuntimeEvidenceCommand -> WikiLink` | sync | Knowledge / K,Sn,Obj,Vr | evidence access | `wiki attach` / — | 3 |
| `ExportWiki` | C | `ExportWikiCommand -> ObjectRef` | async | Knowledge / K,Obj,X,Op | export/redaction policy | `wiki export` / — | 3 |
| `PublishKnowledgeCollection` | C | `PublishKnowledgeCollectionCommand -> PublishResult` | async | Knowledge/Sync / K,Vr,Sy,Op | publication policy | `wiki publish` / — | 5 |
| `GetWikiNode` | Q | `GetWikiNodeQuery -> WikiNode` | sync | Knowledge / K | node visible | `wiki get` / — | 3 |
| `GetBacklinks` | Q | `BacklinksQuery -> Page<WikiLink>` | sync | Knowledge / K | node visible | `wiki backlinks` / — | 3 |
| `SearchWiki` | Q | `WikiSearchQuery -> Page<SearchResult>` | sync | Knowledge / K | search scope | `wiki search` / `vistrea_search_wiki` | 3 |
| `GetRelatedRuntimeContext` | Q | `RelatedContextQuery -> RelatedRuntimeContext` | sync | Knowledge / K,Sn,G | resource visible | `wiki related` / — | 3 |
| `GetKnowledgeGraph` | Q | `KnowledgeGraphQuery -> KnowledgeGraph` | sync | Knowledge / K | graph scope | `wiki graph` / — | 3 |

## Versioning and synchronization

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `CommitWorkingSetAndUpdateRef` | C | `CommitWorkingSetCommand -> CommitAndRefResult` | sync | Versioning / Vr,Obj | object integrity and ref CAS | `version commit` / — | 0B |
| `CreateTag` | C | `CreateTagCommand -> Tag` | sync | Versioning / Vr | tag policy | `version tag` / — | 0B |
| `FetchWorkspace` | C | `FetchWorkspaceCommand -> SyncResult` | async | Sync / Vr,Obj,Sy,Op | remote read policy | `sync fetch` / — | 5 |
| `PushWorkspace` | C | `PushWorkspaceCommand -> SyncResult` | async | Sync / Vr,Obj,Sy,Op | remote write policy | `sync push` / — | 5 |
| `PullWorkspace` | C | `PullWorkspaceCommand -> SyncResult` | async | Sync / Vr,Obj,Sy,Op | conflict policy | `sync pull` / — | 5 |
| `PublishRef` | C | `PublishRefCommand -> PublishResult` | async | Sync / Vr,Sy,Op | publication policy | `sync publish` / `vistrea_publish_ref` | 5 |
| `SubscribeRef` | C | `SubscribeRefCommand -> Subscription` | sync | Sync / Sy | read permission | `sync subscribe` / — | 5 |
| `ResolveSyncConflict` | C | `ResolveSyncConflictCommand -> SyncConflictResolution` | sync | Sync / Vr,Sy | actor and expected revision | `sync resolve` / — | 5 |
| `GetCommit` | Q | `GetCommitQuery -> Commit` | sync | Versioning / Vr | commit visible | `version get` / — | 0B |
| `GetRef` | Q | `GetRefQuery -> Ref` | sync | Versioning / Vr | ref visible | `version ref-get` / — | 0B |
| `ListCommits` | Q | `CommitQuery -> Page<Commit>` | sync | Versioning / Vr | history scope | `version log` / — | 0B |
| `CompareCommits` | Q | `CompareCommitsQuery -> CommitDiff` | sync | Versioning / Vr | both commits visible | `version diff` / — | 0B |
| `GetSyncStatus` | Q | `SyncStatusQuery -> SyncStatus` | sync | Sync / Vr,Sy | remote configured | `sync status` / `vistrea_get_sync_status` | 5 |
| `ListSyncConflicts` | Q | `SyncConflictQuery -> Page<SyncConflict>` | sync | Sync / Sy | remote configured | `sync conflicts` / — | 5 |

## Generic operations

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI / MCP | Phase |
|---|---|---|---|---|---|---|---|
| `GetOperation` | Q | `GetOperationQuery -> OperationRef` | sync | Operations / Op | operation visible | `<domain> status` / `vistrea_get_operation` | 0B |
| `GetOperationResult` | Q | `GetOperationResultQuery -> OperationResult<JsonValue>` | sync | Operations / Op | operation succeeded | `<domain> result` / — | 0B |
| `CancelOperation` | C | `CancelOperationCommand -> OperationRef` | sync | Operations / Op | cancellable operation | `<domain> cancel` / — | 0B |
| `SubscribeOperationEvents` | S | `OperationEventsQuery -> OperationEvent stream` | stream | Operations / Op | operation visible | `--wait --format ndjson` / MCP progress | 0B |

## Parity rule

Adapter implementations may expose only the operations scheduled for their current phase, but exposed operations must preserve the catalog request/result, capability, error, operation, and Data-port semantics. Contract tests derive their parity matrix from this catalog until a machine-readable operation manifest replaces it.
