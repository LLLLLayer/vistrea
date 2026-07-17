# Engine Operation Catalog

Status: **Implemented surface plus reserved draft for protocol version 1.0**

This catalog closes the parity gap between Studio, CLI, Skills, CI, Engine modules, and Data ports. Section 1 lists the operations that exist today; section 2 reserves draft names for future phases. Named request and result types become machine-readable schemas as each phase begins.

The executable source of truth is `HOST_OPERATION_MANIFEST` in `integrations/shared/host-operation-manifest.ts`. It defines every implemented operation, kind, Host route, and CLI command. The Host contract suite proves that the Host client switch, CLI dispatch, and the implemented tables below remain exactly aligned with that manifest.

## Legend

- Kind: `C` command, `Q` query, `S` stream.
- Implemented most operations execute synchronously (exploration is the exception: `RunExploration` returns an `OperationRef` that `GetExplorationOperation` polls and `CancelExploration` stops) over the authenticated loopback Host Local API and return their canonical result directly. The asynchronous `OperationRef` lifecycle (`GetOperationResult`, progress, cancellation) remains reserved; adapters must migrate long-running operations to it when it exists without changing behavior privately.
- In the reserved tables, the `Request -> Result` column names the final typed result; `sync` returns that result immediately while `async` immediately returns `OperationRef`.
- Data ports: `W` Workspace, `Sn` Snapshot, `Ob` Observation, `Ev` Runtime Event, `G` Screen Graph, `K` Wiki, `D` Design Review, `Va` Validation, `Op` Operation, `Vr` Version, `Obj` Object Store, `X` Exchange, `Sy` Sync.
- A dash means no durable Data port or CLI command exists for that cell.
- Reserved adapter names are contracts; implementation follows the listed phase.

## 1. Implemented operations

All 72 operations below are implemented end to end through the Host Local API and the strict JSON CLI (ADR-0008 retired the stdio MCP server; the CLI is the single agent adapter). The headless CI gate composes the validation and build-diff operations.

### Workspace, Snapshot, and Runtime events

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `GetWorkspaceStatus` | Q | `GET /v1/status` | `workspace status` |
| `CreateWorkspaceRecoveryPoint` | C | `POST /v1/workspace/recovery-points` | `workspace recovery-point create` |
| `ListWorkspaceRecoveryPoints` | Q | `GET /v1/workspace/recovery-points` | `workspace recovery-point list` |
| `ReleaseWorkspaceRecoveryPoint` | C | `POST /v1/workspace/recovery-points/release` | `workspace recovery-point release` |
| `CaptureSnapshot` | C | `POST /v1/captures` | `snapshot capture` |
| `ListSnapshots` | Q | `GET /v1/snapshots` | `snapshot list` |
| `GetSnapshot` | Q | `GET /v1/snapshots/<id>` | `snapshot get` |
| `GetEventTimeline` | Q | `GET /v1/events` | `events list` |

### Design review

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `AddDesignAsset` | C | `POST /v1/design-assets` | `design upload-asset` |
| `AddDesignReference` | C | `POST /v1/design-references` | `design add-reference` |
| `PromoteVisualBaseline` | C | `POST /v1/design-baselines` | `design promote-baseline` |
| `GetDesignReference` | Q | `GET /v1/design-references/<id>` | `design get-reference` |
| `ListDesignReferences` | Q | `GET /v1/design-references` | `design list-references` |
| `MapDesignRegion` | C | `POST /v1/design-mappings` | `design map` |
| `RunDesignComparison` | C | `POST /v1/design-comparisons` | `design compare` |
| `GetDesignComparison` | Q | `GET /v1/design-comparisons/<id>` | `design get-comparison` |
| `ListDesignComparisons` | Q | `GET /v1/design-comparisons` | `design list-comparisons` |
| `CreateReviewIssue` | C | `POST /v1/review-issues` | `issue create` |
| `CreateReviewIssueFromDifference` | C | `POST /v1/design-comparisons/<id>/issues` | `issue create-from-difference` |
| `ListReviewIssues` | Q | `GET /v1/review-issues` | `issue list` |
| `GetReviewIssue` | Q | `GET /v1/review-issues/<id>` | `issue get` |
| `TransitionReviewIssue` | C | `POST /v1/review-issues/<id>/transitions` | `issue transition` |
| `VerifyReviewIssue` | C | `POST /v1/review-issues/<id>/verifications` | `issue verify` |
| `RecaptureAndVerifyIssue` | C | `POST /v1/review-issues/<id>/recapture-verifications` | `issue recapture-verify` |

### Protected tuning

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `CreateTuningPatch` | C | `POST /v1/tuning-patches` | `tuning create-patch` |
| `GetTuningPatch` | Q | `GET /v1/tuning-patches/<id>` | `tuning get-patch` |
| `GenerateTuningSourceSuggestions` | Q | `GET /v1/tuning-patches/<id>/source-suggestions` | `tuning source-suggestions` |
| `ApplyTuningPatch` | C | `POST /v1/tuning-applications` | `tuning apply` |
| `RevertTuningApplication` | C | `POST /v1/tuning-applications/<id>/revert` | `tuning revert` |
| `GetTuningApplication` | Q | `GET /v1/tuning-applications/<id>` | `tuning get-application` |
| `ListActiveTuning` | Q | `GET /v1/tuning-applications/active` | `tuning list-active` |

### Screen graph

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `RecordStateObservation` | C | `POST /v1/screen-graph/state-observations` | `graph observe-state` |
| `RecordTransitionObservation` | C | `POST /v1/screen-graph/transition-observations` | `graph observe-transition` |
| `GetScreenGraph` | Q | `GET /v1/screen-graph` | `graph show` |
| `GetScreenState` | Q | `GET /v1/screen-states/<id>` | `graph get-state` |
| `MergeScreenStates` | C | `POST /v1/screen-graph/state-merges` | `screen merge` |
| `SplitScreenState` | C | `POST /v1/screen-graph/state-splits` | `screen split` |
| `AnnotateScreenState` | C | `POST /v1/screen-graph/state-annotations` | `screen annotate` |
| `TagGraphVersion` | C | `POST /v1/screen-graph/version-tags` | `graph tag` |
| `FindScreenPath` | Q | `GET /v1/screen-graph/paths` | `graph find-path` |
| `RunExploration` | C | `POST /v1/exploration/operations` | `explore run` |
| `GetExplorationOperation` | Q | `GET /v1/exploration/operations/<id>` | `explore get` |
| `CancelExploration` | C | `POST /v1/exploration/operations/<id>/cancel` | `explore cancel` |

### Deep Wiki

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `CreateWikiNode` | C | `POST /v1/wiki/nodes` | `wiki create` |
| `UpdateWikiNode` | C | `POST /v1/wiki/nodes/<id>/revisions` | `wiki update` |
| `GetWikiNode` | Q | `GET /v1/wiki/nodes/<id>` | `wiki get` |
| `ListWikiNodes` | Q | `GET /v1/wiki/nodes` | `wiki search` |
| `LinkWikiNode` | C | `POST /v1/wiki/links` | `wiki link` |
| `UnlinkWikiNode` | C | `POST /v1/wiki/links/<id>/unlink` | `wiki unlink` |
| `GetWikiBacklinks` | Q | `GET /v1/wiki/nodes/<id>/backlinks` | `wiki backlinks` |
| `GetRelatedWikiNodes` | Q | `GET /v1/wiki/related` | `wiki related` |
| `CreateKnowledgeCollection` | C | `POST /v1/knowledge-collections` | `collection create` |
| `UpdateKnowledgeCollection` | C | `POST /v1/knowledge-collections/<id>/revisions` | `collection update` |
| `GetKnowledgeCollection` | Q | `GET /v1/knowledge-collections/<id>` | `collection get` |
| `ListKnowledgeCollections` | Q | `GET /v1/knowledge-collections` | `collection list` |
| `PublishKnowledgeCollection` | C | `POST /v1/knowledge-collections/<id>/publication` | `collection publish` |
| `ExportKnowledgeCollection` | C | `POST /v1/knowledge-collections/<id>/exports` | `collection export` |

### Validation and build diff

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `ValidateSnapshot` | C | `POST /v1/validation/snapshot-runs` | `validate snapshot` |
| `ValidateScreenGraph` | C | `POST /v1/validation/graph-runs` | `validate graph` |
| `GetValidationRun` | Q | `GET /v1/validation/runs/<id>` | `validate get-run` |
| `ListValidationFindings` | Q | `GET /v1/validation/findings` | `validate findings` |
| `GetValidationFinding` | Q | `GET /v1/validation/findings/<id>` | `validate get-finding` |
| `SuppressValidationFinding` | C | `POST /v1/validation/findings/<id>/suppress` | `validate suppress` |
| `CompareBuilds` | C | `POST /v1/validation/build-diffs` | `validate build-diff` |
| `GetBuildDiff` | Q | `GET /v1/validation/build-diffs/<id>` | `validate get-build-diff` |

### Hub synchronization

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `GetSyncStatus` | Q | `POST /v1/sync/status` | `sync status` |
| `FetchWorkspace` | C | `POST /v1/sync/fetch` | `sync fetch` |
| `PushWorkspace` | C | `POST /v1/sync/push` | `sync push` |
| `GetSyncActivity` | Q | `POST /v1/sync/activity` | `sync activity` |

These routes use `POST` even for the two queries because the Hub credential
travels in an authenticated local request body, never in a URL, argv, log, or
response. Status returns the effective identity and permission sources,
team-visible projects, and a local/remote relation for each selected ref.
Fetch and push serialize per Host, transfer immutable packs, return a fresh
status, and surface conflicts without force. Activity is the Hub's token-free,
project-local collaboration projection.

### Portable exchange

| Operation | Kind | Host route | CLI |
|---|---|---|---|
| `ExportPack` | C | `POST /v1/exchange/exports` | `pack export` |
| `ImportPack` | C | `POST /v1/exchange/imports` | `pack import` |
| `GetObject` | Q | `GET /v1/objects/<hash>` | `object get` |

### Renamed or superseded draft names

Earlier drafts of this catalog used different names for some implemented operations. The implemented names above are canonical; do not reintroduce the draft names:

| Draft name | Implemented as |
|---|---|
| `FindPath` | `FindScreenPath` |
| `LinkWikiNodes` / `UnlinkWikiNodes` | `LinkWikiNode` / `UnlinkWikiNode` |
| `GetBacklinks` | `GetWikiBacklinks` |
| `GetRelatedRuntimeContext` | `GetRelatedWikiNodes` |
| `SearchWiki` | `ListWikiNodes` (the CLI command remains `wiki search`) |
| `ExportWiki` | `ExportKnowledgeCollection` |
| `RunValidation` | `ValidateSnapshot` and `ValidateScreenGraph` |
| `GetValidationOperation` | `GetValidationRun` |
| `RunBuildComparison` | `CompareBuilds` |
| `ExportWorkspacePack` / `ImportWorkspacePack` | `ExportPack` / `ImportPack` |
| `RecordManualTransition` | `RecordTransitionObservation` with `capture_source: "manual"` |

## 2. Reserved / future operations

The operations below are reserved draft contracts. They are not implemented; the names, types, gates, and adapter cells describe intended semantics for their listed phase.

This status describes the public Engine/Host/CLI parity surface. The local Data
Layer and packaged Studio already use a strict offline maintenance adapter for
restore, plan-bound garbage collection, interrupted-restore recovery, and
stale-lock recovery. `CollectWorkspaceGarbage` remains reserved here until that
capability is intentionally promoted as an Agent-facing operation.

### Workspace

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `CreateWorkspace` | C | `CreateWorkspaceCommand -> WorkspaceDescriptor` | sync | Workspace / W,Vr | atomic genesis Commit/default-ref bootstrap | `workspace create` | 0B |
| `OpenWorkspace` | C | `OpenWorkspaceCommand -> WorkspaceDescriptor` | sync | Workspace / W | compatible version | `workspace open` | 0B |
| `CloseWorkspace` | C | `CloseWorkspaceCommand -> Empty` | sync | Workspace / W | no active write UoW | `workspace close` / — | 0B |
| `UpgradeWorkspace` | C | `UpgradeWorkspaceCommand -> MigrationResult` | async | Workspace / W,Op | backup policy | `workspace upgrade` / — | 0B |
| `CollectWorkspaceGarbage` | C | `CollectGarbageCommand -> GarbageCollectionResult` | async | Workspace / W,Vr,Obj,Op | retention policy | `workspace gc` / — | 0B |
| `ListWorkspaceRefs` | Q | `ListRefsQuery -> Page<Ref>` | sync | Versioning / Vr | workspace open | `version ref-list` / — | 0B |
| `GetStorageUsage` | Q | `StorageUsageQuery -> StorageUsage` | sync | Workspace / W,Obj | workspace open | `workspace usage` / — | 0B |
| `CheckWorkspaceHealth` | Q | `WorkspaceHealthQuery -> WorkspaceHealth` | sync | Workspace / W,Obj,Vr | workspace available | `workspace health` / — | 0B |

### Runtime connection and device

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `ConnectRuntime` | C | `ConnectRuntimeCommand -> RuntimeConnection` | async | Connection / Op | authorized internal build | `device connect` | 1 |
| `DisconnectRuntime` | C | `DisconnectRuntimeCommand -> Empty` | sync | Connection / — | active connection | `device disconnect` / — | 1 |
| `OpenAutomationSession` | C | `OpenAutomationSessionCommand -> AutomationSession` | async | Automation / Op | provider and safety policy | `device automation-open` / — | 3 |
| `CloseAutomationSession` | C | `CloseAutomationSessionCommand -> Empty` | sync | Automation / — | active session | `device automation-close` / — | 3 |
| `LaunchApplication` | C | `LaunchApplicationCommand -> ActionResult` | async | Automation / Op | action policy | `device launch` / — | 3 |
| `TerminateApplication` | C | `TerminateApplicationCommand -> ActionResult` | async | Automation / Op | action policy | `device terminate` / — | 3 |
| `ListDevices` | Q | `DeviceQuery -> Page<DeviceDescriptor>` | sync | Automation / — | provider available | `device list` | 1 |
| `ListDiscoveredRuntimes` | Q | `RuntimeDiscoveryQuery -> Page<RuntimeDescriptor>` | sync | Connection / — | discovery available | `device runtime-list` / — | 1 |
| `GetConnectionStatus` | Q | `ConnectionStatusQuery -> ConnectionStatus` | sync | Connection / — | — | `device status` / — | 1 |
| `GetRuntimeCapabilities` | Q | `RuntimeCapabilitiesQuery -> CapabilitySet` | sync | Connection / — | active connection | `device capabilities` / — | 1 |

### Snapshot and inspection

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `PinSnapshot` | C | `PinSnapshotCommand -> SnapshotSummary` | sync | Workspace / Sn,Vr | retention policy | `snapshot pin` / — | 1 |
| `AttachArtifact` | C | `AttachArtifactCommand -> ArtifactLink` | sync | Knowledge / Sn,K,Obj | artifact policy | `snapshot attach` / — | 1 |
| `GetUiNode` | Q | `GetUiNodeQuery -> UiNode` | sync | Knowledge / Sn,Obj | snapshot available | `node get` / — | 1 |
| `QueryUiNodes` | Q | `UiNodeQuery -> Page<UiNodeSummary>` | sync | Knowledge / Sn | snapshot available | `node query` | 1 |
| `CompareSnapshots` | Q | `CompareSnapshotsQuery -> SnapshotDiff` | sync | Validation / Sn,Obj | both snapshots visible | `snapshot compare` / — | 4 |

### Screen graph and exploration

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `PauseExploration` | C | `PauseExplorationCommand -> OperationRef` | sync | Exploration / Op | running operation | `explore pause` / — | 3 |
| `ResumeExploration` | C | `ResumeExplorationCommand -> OperationRef` | sync | Exploration / Op | paused operation | `explore resume` / — | 3 |
| `MarkTransitionStatus` | C | `MarkTransitionStatusCommand -> Transition` | sync | Exploration / G,Vr | expected revision | `screen transition-mark` / — | 3 |
| `CompareScreenGraphs` | Q | `CompareGraphsQuery -> GraphDiff` | sync | Validation / G | both versions visible | `screen compare` / — | 4 |
| `ExplainStateIdentity` | Q | `StateIdentityQuery -> StateIdentityExplanation` | sync | Exploration / G | identity evidence | `screen identity-explain` / — | 3 |

### Design review and tuning

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `UpdateReviewIssue` | C | `UpdateReviewIssueCommand -> ReviewIssue` | sync | Design / D,Vr | expected revision | `design issue-update` / — | 2 |
| `ExportTuningPatch` | C | `ExportTuningPatchCommand -> ObjectRef` | sync | Design / D,Obj,X | export policy | `design tune-export` / — | 2 |
| `PromoteDesignBaseline` | C | `PromoteDesignBaselineCommand -> CommitAndRefResult` | sync | Design/Versioning / D,Vr | reviewer and ref CAS | `design baseline-promote` / — | 2 |

### Validation

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `CancelValidation` | C | `CancelOperationCommand -> OperationRef` | sync | Operations / Op | cancellable operation | `verify cancel` / — | 4 |
| `AcceptValidationBaseline` | C | `AcceptValidationBaselineCommand -> CommitAndRefResult` | sync | Validation/Versioning / Va,Vr | reviewer and ref CAS | `verify baseline-accept` / — | 4 |

### Deep Wiki

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `AttachRuntimeEvidence` | C | `AttachRuntimeEvidenceCommand -> WikiLink` | sync | Knowledge / K,Sn,Obj,Vr | evidence access | `wiki attach` / — | 3 |
| `GetKnowledgeGraph` | Q | `KnowledgeGraphQuery -> KnowledgeGraph` | sync | Knowledge / K | graph scope | `wiki graph` / — | 3 |

### Versioning and synchronization

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `CommitWorkingSetAndUpdateRef` | C | `CommitWorkingSetCommand -> CommitAndRefResult` | sync | Versioning / Vr,Obj | object integrity and ref CAS | `version commit` / — | 0B |
| `CreateTag` | C | `CreateTagCommand -> Tag` | sync | Versioning / Vr | tag policy | `version tag` / — | 0B |
| `PullWorkspace` | C | `PullWorkspaceCommand -> SyncResult` | async | Sync / Vr,Obj,Sy,Op | conflict policy | `sync pull` / — | 5 |
| `PublishRef` | C | `PublishRefCommand -> PublishResult` | async | Sync / Vr,Sy,Op | publication policy | `sync publish` | 5 |
| `SubscribeRef` | C | `SubscribeRefCommand -> Subscription` | sync | Sync / Sy | read permission | `sync subscribe` / — | 5 |
| `ResolveSyncConflict` | C | `ResolveSyncConflictCommand -> SyncConflictResolution` | sync | Sync / Vr,Sy | actor and expected revision | `sync resolve` / — | 5 |
| `GetCommit` | Q | `GetCommitQuery -> Commit` | sync | Versioning / Vr | commit visible | `version get` / — | 0B |
| `GetRef` | Q | `GetRefQuery -> Ref` | sync | Versioning / Vr | ref visible | `version ref-get` / — | 0B |
| `ListCommits` | Q | `CommitQuery -> Page<Commit>` | sync | Versioning / Vr | history scope | `version log` / — | 0B |
| `CompareCommits` | Q | `CompareCommitsQuery -> CommitDiff` | sync | Versioning / Vr | both commits visible | `version diff` / — | 0B |
| `ListSyncConflicts` | Q | `SyncConflictQuery -> Page<SyncConflict>` | sync | Sync / Sy | remote configured | `sync conflicts` / — | 5 |

### Generic operations

| Operation | Kind | Request -> Result | Exec | Owner / Data ports | Gate | CLI | Phase |
|---|---|---|---|---|---|---|---|
| `GetOperation` | Q | `GetOperationQuery -> OperationRef` | sync | Operations / Op | operation visible | `<domain> status` | 0B |
| `GetOperationResult` | Q | `GetOperationResultQuery -> OperationResult<JsonValue>` | sync | Operations / Op | operation succeeded | `<domain> result` / — | 0B |
| `CancelOperation` | C | `CancelOperationCommand -> OperationRef` | sync | Operations / Op | cancellable operation | `<domain> cancel` / — | 0B |
| `SubscribeOperationEvents` | S | `OperationEventsQuery -> OperationEvent stream` | stream | Operations / Op | operation visible | `--wait --format ndjson` | 0B |

## Parity rule

Adapter implementations may expose only the operations scheduled for their current phase, but exposed operations must preserve the catalog request/result, capability, error, operation, and Data-port semantics. Contract tests derive implemented-operation parity from `HOST_OPERATION_MANIFEST` and verify that this catalog, the Host client, and CLI dispatch remain aligned with it.
