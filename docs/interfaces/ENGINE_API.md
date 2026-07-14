# Host Engine Use Cases

## 1. Purpose

The Host Engine is the single application-use-case layer shared by Studio, CLI, Skills, CI, and tests. Product behavior must not be reimplemented in an adapter.

The examples below define semantic operation names, not a programming-language API.

## 2. Workspace use cases

### Commands

- `CreateWorkspace`
- `OpenWorkspace`
- `CloseWorkspace`
- `UpgradeWorkspace`
- `ImportPack`
- `ExportPack`
- `CollectWorkspaceGarbage`

`CreateWorkspace` returns a descriptor containing the genesis Commit ID and resolved default Ref only after the manifest, Commit, and Ref have been initialized atomically.

### Queries

- `GetWorkspaceStatus`
- `ListWorkspaceRefs`
- `GetStorageUsage`
- `CheckWorkspaceHealth`

## 3. Device and connection use cases

### Commands

- `ConnectRuntime`
- `DisconnectRuntime`
- `OpenAutomationSession`
- `CloseAutomationSession`
- `LaunchApplication`
- `TerminateApplication`

### Queries

- `ListDevices`
- `ListDiscoveredRuntimes`
- `GetConnectionStatus`
- `GetRuntimeCapabilities`

## 4. Snapshot and inspection use cases

### Commands

- `CaptureSnapshot`
- `PinSnapshot`
- `AttachArtifact`

### Queries

- `GetSnapshot`
- `ListSnapshots`
- `GetUiNode`
- `QueryUiNodes`
- `GetEventTimeline`
- `CompareSnapshots`

## 5. Screen graph and exploration use cases

### Commands

- `RunExploration`
- `PauseExploration`
- `ResumeExploration`
- `CancelExploration`
- `RecordManualTransition`
- `MergeScreenStates`
- `SplitScreenState`
- `MarkTransitionStatus`

### Queries

- `GetExplorationOperation`
- `GetScreenGraph`
- `GetScreenState`
- `FindScreenPath`
- `CompareScreenGraphs`
- `ExplainStateIdentity`

`RunExploration` is asynchronous and returns `OperationRef`. Progress events report graph steps while the terminal `ExplorationReport` accounts for every provider action. `maximum_recovery_attempts` (zero through five, default two) bounds relaunch-and-restore recovery after a lost Runtime capture; `application_id` may override the captured launch identity. Recovery relaunches the app, replays the known stable-ID path from the entry state, validates every restored structural Screen State, and counts launch/replay actions against `maximum_actions`.

`GetScreenGraph` accepts either application identity alone or an exact `build_id` + `application_version` pair. The stored graph remains the application-level fact base; a scoped query attaches `extensions["vistrea.build_scope"]` with the visible Screen State and Transition IDs for that build. `GetScreenState` accepts the same pair and resolves `canonical_snapshot_id` from evidence in that build, failing `not_found` when the state was not observed there.

## 6. Design review and tuning use cases

### Commands

- `AddDesignReference`
- `PromoteVisualBaseline`
- `MapDesignRegion`
- `CreateReviewIssue`
- `CreateReviewIssueFromDifference`
- `UpdateReviewIssue`
- `VerifyReviewIssue`
- `RecaptureAndVerifyIssue`
- `CreateTuningPatch`
- `RunDesignComparison`
- `ApplyTuningPatch`
- `RevertTuningApplication`
- `ExportTuningPatch`

### Queries

- `GetDesignReference`
- `ListReviewIssues`
- `GetReviewIssue`
- `GetTuningPatch`
- `GenerateTuningSourceSuggestions`
- `ListActiveTuning`

Every tuning command preserves original value, target Snapshot, project policy, and actor. The implemented allowlist covers alpha, foreground/background color, font, spacing, content insets, and corner radius. A preview never marks an issue fixed until `RecaptureAndVerifyIssue` captures and compares a later real build with complete evidence.

`ListReviewIssues.screen_state_id` is evaluated by the Data API against persisted Observation-to-Snapshot membership. Product UI must use it for a selected Screen State instead of loading every issue and filtering by presentation state.

## 7. Validation use cases

### Commands

- `ValidateSnapshot`
- `ValidateScreenGraph`
- `CompareBuilds`
- `CancelValidation`
- `AcceptValidationBaseline`
- `SuppressValidationFinding`

### Queries

- `GetValidationRun`
- `ListValidationFindings`
- `GetValidationFinding`
- `GetBuildDiff`

Validation input may be a Snapshot, Screen State, graph, path, build, design baseline, or selected rule set.

## 8. Deep Wiki use cases

### Commands

- `CreateWikiNode`
- `UpdateWikiNode`
- `LinkWikiNode`
- `UnlinkWikiNode`
- `CreateKnowledgeCollection`
- `UpdateKnowledgeCollection`
- `PublishKnowledgeCollection`
- `ExportKnowledgeCollection`
- `AttachRuntimeEvidence`

### Queries

- `GetWikiNode`
- `GetWikiBacklinks`
- `ListWikiNodes`
- `GetRelatedWikiNodes`
- `GetKnowledgeCollection`
- `ListKnowledgeCollections`
- `GetKnowledgeGraph`

The implemented Collection publication command freezes the exact member nodes and links as a canonical Object Store root, creates a Working Set and Commit, advances the target Ref with the caller's compare-and-set precondition, and updates the live Collection projection in the same metadata transaction. `ExportKnowledgeCollection` reads only that immutable root and returns Markdown and/or safe HTML `ObjectRef`s. `AttachRuntimeEvidence` and a general `GetKnowledgeGraph` projection remain reserved operations.

## 9. Version and synchronization use cases

### Commands

- `CommitWorkingSetAndUpdateRef`
- `CreateTag`
- `FetchWorkspace`
- `PushWorkspace`
- `PullWorkspace`
- `PublishRef`
- `SubscribeRef`
- `ResolveSyncConflict`

`CommitWorkingSetAndUpdateRef` is the public authoring boundary: it creates the canonical Commit and compare-and-set updates the target ref atomically. Low-level Commit insertion and ref movement remain Data/Sync primitives for verified import, replication, and Workspace bootstrap; normal Studio and Agent workflows cannot split the operation.

### Queries

- `GetCommit`
- `GetRef`
- `ListCommits`
- `CompareCommits`
- `GetSyncStatus`
- `ListSyncConflicts`

## 10. Generic operation use cases

### Commands

- `CancelOperation`

### Queries and streams

- `GetOperation`
- `GetOperationResult`
- `SubscribeOperationEvents`

Typed helpers such as `GetExplorationOperation` and `GetValidationRun` may remain, but they resolve through the same generic operation lifecycle and event cursor semantics.

Long-running domains persist operation state through the Operations Engine. Cancellation is best-effort and never rewrites a completed side effect as cancelled.

Every asynchronous use case immediately returns `OperationRef`. Its documented domain result is the completion value returned by `GetOperationResult` after success; progress and cancellation always address the operation ID.

## 11. Interaction events

Studio and integrations may subscribe to Engine events:

- `ConnectionStateChanged`
- `RuntimeEventReceived`
- `SnapshotCaptured`
- `ExplorationProgressed`
- `ScreenGraphChanged`
- `ReviewIssueChanged`
- `TuningStateChanged`
- `ValidationProgressed`
- `CommitCreated`
- `RefChanged`
- `SyncProgressed`
- `OperationFailed`

Events identify the operation and affected resources. UI refreshes from queries rather than treating events as complete authoritative state.

## 12. Operation behavior

- Queries are side-effect free.
- Mutating commands support idempotency where retries are possible.
- Long-running work returns `OperationRef` and supports progress and best-effort cancellation.
- Commands that affect runtime state require an active connection and explicit capability.
- Commands that affect shared refs use optimistic concurrency.
- Every use case propagates request, trace, actor, Workspace, and project context.

## 13. Adapter parity

CLI, Skills, CI, and Studio may expose different interaction shapes, but they must map to the same operation semantics and errors. An adapter must not create a hidden product capability unavailable through public Engine use cases.
