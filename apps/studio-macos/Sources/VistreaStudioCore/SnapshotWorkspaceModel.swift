import Combine
import Foundation
import VistreaRuntimeModels

public enum WorkspaceContentPhase: Equatable, Sendable {
    case idle
    case loading
    case content
    case empty
    case failure(String)
}

public enum ConnectionPhase: Equatable, Sendable {
    case idle
    case checking
    case available(HostStatus)
    case unavailable(String)
}

public enum SnapshotDetailPhase: Equatable, Sendable {
    case idle
    case loading
    case content
    case failure(String)
}

public enum ScreenshotEvidencePhase: Equatable, Sendable {
    case none
    case loading
    case available
    case unavailable(String)
}

public enum EventTimelinePhase: Equatable, Sendable {
    case idle
    case loading
    case content
    case empty
    case failure(String)
}

@MainActor
public final class SnapshotWorkspaceModel: ObservableObject {
    @Published public private(set) var contentPhase: WorkspaceContentPhase = .idle
    @Published public private(set) var connectionPhase: ConnectionPhase = .idle
    @Published public private(set) var detailPhase: SnapshotDetailPhase = .idle
    @Published public private(set) var screenshotPhase: ScreenshotEvidencePhase = .none
    @Published public private(set) var snapshots: [SnapshotListItem] = []
    // The Application + Version scopes derived from the Workspace contents.
    // The context bar picks one; the Canvas and the Evidence library follow.
    @Published public private(set) var availableScopes: [WorkspaceScope] = []
    @Published public private(set) var selectedScope: WorkspaceScope?
    @Published public private(set) var selectedSnapshotID: String?
    @Published public private(set) var selectedSnapshot: SnapshotPresentation?
    @Published public private(set) var selectedNodeID: String?
    @Published public private(set) var selectedNode: NodePresentation?
    @Published public private(set) var screenshotData: Data?
    @Published public private(set) var eventsPhase: EventTimelinePhase = .idle
    @Published public private(set) var events: [EventListItem] = []
    @Published public private(set) var reportedEventGaps: [EventSequenceGap] = []
    @Published public private(set) var issuesPhase: EventTimelinePhase = .idle
    @Published public private(set) var reviewIssues: [ReviewIssueSummary] = []
    @Published public private(set) var canvasPhase: EventTimelinePhase = .idle
    @Published public private(set) var canvasGraph: CanvasGraph?
    @Published public private(set) var canvasStates: [CanvasLayout.PositionedState] = []
    @Published public private(set) var wikiPhase: EventTimelinePhase = .idle
    @Published public private(set) var wikiNodes: [WikiNodeSummary] = []
    @Published public private(set) var layerBoxes: [LayerBox3D] = []
    @Published public private(set) var isRefreshing = false
    @Published public private(set) var isCapturing = false
    @Published public private(set) var operationError: String?

    // Tuning preview state. The Host rejects these routes without an
    // authorized Debug Runtime; Studio itself ships no build-time guard.
    @Published public private(set) var tuningPhase: EventTimelinePhase = .idle
    @Published public private(set) var activeTuning: [TuningApplicationSummary] = []
    @Published public private(set) var lastTuningApplication: TuningApplicationSummary?
    @Published public private(set) var tuningError: String?
    @Published public private(set) var isApplyingTuning = false
    @Published public private(set) var revertingTuningIDs: Set<String> = []

    // Review Issue lifecycle state.
    @Published public private(set) var selectedIssueID: String?
    @Published public private(set) var selectedIssue: ReviewIssueSummary?
    @Published public private(set) var issueDetailPhase: SnapshotDetailPhase = .idle
    @Published public private(set) var isTransitioningIssue = false
    @Published public private(set) var issueTransitionError: String?
    @Published public private(set) var issueConflictNote: String?

    // Deep Wiki editing state.
    @Published public private(set) var isSavingWikiNode = false
    @Published public private(set) var wikiEditingNode: WikiNodeDetail?
    @Published public private(set) var wikiEditPhase: SnapshotDetailPhase = .idle
    @Published public private(set) var wikiWriteError: String?
    @Published public private(set) var wikiConflictNote: String?

    // Canvas Screen State details and knowledge links.
    @Published public private(set) var selectedCanvasStateID: String?
    @Published public private(set) var canvasStateDetail: ScreenStateDetail?
    @Published public private(set) var canvasStatePhase: SnapshotDetailPhase = .idle
    @Published public private(set) var relatedWikiNodes: [WikiNodeSummary] = []
    @Published public private(set) var isLinkingWikiNode = false
    @Published public private(set) var canvasLinkError: String?

    // Canvas identity curation state.
    @Published public private(set) var mergeSelectionStateIDs: [String] = []
    @Published public private(set) var isMergingStates = false
    @Published public private(set) var isSplittingState = false
    @Published public private(set) var curationError: String?
    @Published public private(set) var graphConflictNote: String?
    // The Screen Graph revision each open curation decision was taken
    // against. A background reload advances `canvasGraph.revision`, so the
    // submitted `expected_graph_revision` must come from here, never from the
    // graph loaded at submit time.
    @Published public private(set) var mergeDecisionRevision: UInt64?
    @Published public private(set) var splitDecisionRevision: UInt64?
    @Published public private(set) var splitDecisionStateID: String?

    // Design comparison workbench state.
    @Published public private(set) var designReferencesPhase: EventTimelinePhase = .idle
    @Published public private(set) var designReferences: [DesignReferenceDetail] = []
    @Published public private(set) var selectedDesignReferenceID: String?
    @Published public private(set) var selectedDesignReference: DesignReferenceDetail?
    @Published public private(set) var designReferencePhase: SnapshotDetailPhase = .idle
    @Published public private(set) var designAssetData: Data?
    @Published public private(set) var designAssetPhase: ScreenshotEvidencePhase = .none
    @Published public private(set) var designComparisons: [DesignComparisonDetail] = []
    @Published public private(set) var designComparisonsPhase: EventTimelinePhase = .idle
    @Published public private(set) var designComparison: DesignComparisonDetail?
    @Published public private(set) var isComparingDesign = false
    @Published public private(set) var designComparisonError: String?
    @Published public private(set) var selectedDifferenceID: String?

    // Exploration Operation state (device automation Host capability).
    @Published public private(set) var explorationOperationID: String?
    @Published public private(set) var explorationState: String?
    @Published public private(set) var explorationProgress: ExplorationProgressSummary?
    @Published public private(set) var explorationLastEventMessage: String?
    @Published public private(set) var explorationReport: ExplorationReportSummary?
    @Published public private(set) var explorationError: String?
    @Published public private(set) var isExploring = false
    @Published public private(set) var isCancellingExploration = false

    private let client: any HostClient
    private var selectionGeneration = 0
    // Per-pane request generations: a slow older response must never
    // overwrite the state a newer request already applied.
    private var canvasGeneration = 0
    private var canvasWatchGeneration = 0
    /// Test hook mirroring `explorationPollSleep`: the watch cadence.
    public var canvasWatchSleep: @Sendable () async throws -> Void = {
        try await Task.sleep(nanoseconds: 2_000_000_000)
    }
    private var wikiGeneration = 0
    private var issuesGeneration = 0
    private var eventsGeneration = 0
    private var tuningGeneration = 0
    private var issueDetailGeneration = 0
    private var wikiEditGeneration = 0
    private var canvasStateGeneration = 0
    private var explorationGeneration = 0
    private var designReferencesGeneration = 0
    private var designReferenceGeneration = 0
    private var designComparisonsGeneration = 0
    // The Screen Graph identity the Canvas last loaded, so a finished
    // exploration can refresh the same graph.
    private var lastCanvasProjectID: String?
    private var lastCanvasApplicationID: String?

    /// Sleeps between exploration polls. Production always waits the fixed
    /// one-second interval — the pane never polls faster — while tests
    /// replace this internal hook to script the loop deterministically. It
    /// rethrows cancellation so the poll loop can honour a cancelled Task
    /// instead of spinning.
    var explorationPollSleep: @Sendable () async throws -> Void = {
        try await Task.sleep(nanoseconds: 1_000_000_000)
    }

    public init(client: any HostClient) {
        self.client = client
    }

    public func refresh() async {
        guard !isRefreshing, !isCapturing else {
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        contentPhase = .loading
        connectionPhase = .checking
        operationError = nil

        do {
            connectionPhase = .available(try await client.getStatus())
        } catch {
            connectionPhase = .unavailable(Self.message(for: error))
        }

        await loadEventTimeline()
        await loadReviewIssues()
        await loadWiki(text: nil)
        await loadActiveTuning()

        do {
            let page = try await client.listSnapshots()
            snapshots = page.items.map(SnapshotListItem.init(summary:))
            applyDerivedScopes()
            if let scope = selectedScope {
                // The Canvas is the landing surface for the selected scope:
                // it loads with the scope, before any Snapshot is selected.
                await loadCanvas(projectID: scope.projectID, applicationID: scope.applicationID)
            } else {
                canvasPhase = .empty
                canvasGraph = nil
                canvasStates = []
            }
            guard !snapshots.isEmpty else {
                clearSelection()
                contentPhase = .empty
                return
            }
            contentPhase = .content
            let targetID = selectedSnapshotID.flatMap { selectedID in
                snapshots.contains(where: { $0.id == selectedID }) ? selectedID : nil
            } ?? scopedSnapshots.first?.id ?? snapshots[0].id
            await selectSnapshot(id: targetID)
        } catch {
            clearSelection()
            contentPhase = .failure(Self.message(for: error))
        }
    }

    // MARK: - Application + Version scope

    /// The Evidence library: the Snapshots captured in the selected scope.
    public var scopedSnapshots: [SnapshotListItem] {
        guard let scope = selectedScope else {
            return snapshots
        }
        return snapshots.filter { $0.scope == scope }
    }

    /// Selects one Application + Version scope from the context bar. The
    /// Canvas reloads for the scope's Screen Graph and the state selection is
    /// reset; nothing else about the Workspace is touched.
    public func selectScope(_ scope: WorkspaceScope) async {
        guard availableScopes.contains(scope), scope != selectedScope else {
            return
        }
        selectedScope = scope
        await selectCanvasState(id: nil)
        await loadCanvas(projectID: scope.projectID, applicationID: scope.applicationID)
    }

    /// Re-derives the scopes from the current Snapshot list. A still-available
    /// selection survives — a capture in another scope must never yank the
    /// user's context — otherwise the scope of the most recent Snapshot is
    /// selected (with exactly one scope, the common case, that is simply it).
    private func applyDerivedScopes() {
        availableScopes = WorkspaceScopeDerivation.scopes(from: snapshots)
        if let current = selectedScope, availableScopes.contains(current) {
            return
        }
        selectedScope = availableScopes.first
    }

    public func selectSnapshot(id: String) async {
        guard snapshots.contains(where: { $0.id == id }) else {
            return
        }
        await loadInspectorSnapshot(id: id)
    }

    /// Loads one Snapshot into the single-screen Inspector panes. The two
    /// selection paths converge here: a Screen State resolving its canonical
    /// observation Snapshot, and the Evidence library picking a capture.
    private func loadInspectorSnapshot(id: String) async {
        selectionGeneration += 1
        let generation = selectionGeneration
        selectedSnapshotID = id
        selectedSnapshot = nil
        selectedNodeID = nil
        selectedNode = nil
        screenshotData = nil
        screenshotPhase = .none
        detailPhase = .loading

        do {
            let snapshot = try await client.getSnapshot(id: id)
            guard generation == selectionGeneration, selectedSnapshotID == id else {
                return
            }
            try apply(snapshot: snapshot)
            await loadScreenshot(for: snapshot, generation: generation)
        } catch {
            guard generation == selectionGeneration else {
                return
            }
            detailPhase = .failure(Self.message(for: error))
        }
    }

    public func selectNode(id: String?) {
        selectedNodeID = id
        selectedNode = id.flatMap { selectedSnapshot?.tree.nodesByID[$0] }
    }

    public func capture() async {
        guard !isCapturing, !isRefreshing else {
            return
        }
        isCapturing = true
        operationError = nil
        defer { isCapturing = false }

        do {
            let snapshot = try await client.capture(CaptureRequest())
            let presentation = try SnapshotPresentation(snapshot: snapshot)
            let item = SnapshotListItem(snapshot: snapshot)
            selectionGeneration += 1
            let generation = selectionGeneration
            snapshots.removeAll(where: { $0.id == item.id })
            snapshots.insert(item, at: 0)
            applyDerivedScopes()
            contentPhase = .content
            selectedSnapshotID = snapshot.snapshotID.rawValue
            apply(presentation: presentation)
            await loadScreenshot(for: snapshot, generation: generation)
        } catch {
            operationError = Self.message(for: error)
        }
    }

    public func dismissOperationError() {
        operationError = nil
    }

    /// Reloads the materialized Screen Graph for the Canvas.
    public func loadCanvas(projectID: String, applicationID: String) async {
        lastCanvasProjectID = projectID
        lastCanvasApplicationID = applicationID
        canvasGeneration += 1
        let generation = canvasGeneration
        canvasPhase = .loading
        do {
            let graph = try await client.getScreenGraph(
                projectID: projectID,
                applicationID: applicationID
            )
            guard generation == canvasGeneration else {
                return
            }
            applyCanvasGraph(graph)
        } catch {
            guard generation == canvasGeneration else {
                return
            }
            canvasGraph = nil
            canvasStates = []
            // A missing graph is an empty Canvas, not a failure banner.
            if let clientError = error as? HostClientError,
               case let .server(statusCode, _, _, _, _) = clientError,
               statusCode == 404 {
                canvasPhase = .empty
            } else {
                canvasPhase = .failure(Self.message(for: error))
            }
        }
    }

    private func applyCanvasGraph(_ graph: CanvasGraph) {
        canvasGraph = graph
        canvasStates = CanvasLayout.positions(for: graph)
        canvasPhase = graph.states.isEmpty ? .empty : .content
        // Only states that are still active can stay merge-selected
        // after a reload.
        mergeSelectionStateIDs = mergeSelectionStateIDs.filter { stateID in
            graph.states.contains(where: { $0.id == stateID && $0.isActive })
        }
    }

    /// The Canvas mirrors a shared Workspace this Studio does not own: an
    /// agent, the CLI, or another Studio may be growing the graph while the
    /// pane is on screen, so a visible Canvas quietly follows the graph
    /// revision instead of waiting for a local action to reload it. Applying
    /// only on a revision change keeps unchanged ticks from disturbing the
    /// pane, and the curation revision guard keeps a concurrent change from
    /// being rubber-stamped into an open merge or split decision.
    public func startCanvasWatch() {
        canvasWatchGeneration += 1
        let generation = canvasWatchGeneration
        Task { [weak self] in
            await self?.watchCanvas(generation: generation)
        }
    }

    /// Stops the visible-pane watch; the loaded graph stays on screen.
    public func stopCanvasWatch() {
        canvasWatchGeneration += 1
    }

    private func watchCanvas(generation: Int) async {
        while generation == canvasWatchGeneration {
            if Task.isCancelled {
                return
            }
            do {
                try await canvasWatchSleep()
            } catch {
                return
            }
            guard !Task.isCancelled, generation == canvasWatchGeneration else {
                return
            }
            guard let projectID = lastCanvasProjectID,
                  let applicationID = lastCanvasApplicationID else {
                continue
            }
            guard let current = try? await client.getScreenGraph(
                projectID: projectID,
                applicationID: applicationID
            ) else {
                // A transient read failure must not tear the visible pane down.
                continue
            }
            guard generation == canvasWatchGeneration else {
                return
            }
            if current.revision != canvasGraph?.revision {
                applyCanvasGraph(current)
            }
        }
    }

    /// Reloads the Deep Wiki nodes shown in the knowledge pane.
    public func loadWiki(text: String?) async {
        wikiGeneration += 1
        let generation = wikiGeneration
        wikiPhase = .loading
        do {
            let page = try await client.searchWikiNodes(text: text)
            guard generation == wikiGeneration else {
                return
            }
            wikiNodes = page.items
            wikiPhase = wikiNodes.isEmpty ? .empty : .content
        } catch {
            guard generation == wikiGeneration else {
                return
            }
            wikiNodes = []
            wikiPhase = .failure(Self.message(for: error))
        }
    }

    /// Reloads the persisted Review Issues, most recently updated first.
    public func loadReviewIssues() async {
        issuesGeneration += 1
        let generation = issuesGeneration
        issuesPhase = .loading
        do {
            let page = try await client.listReviewIssues(states: nil)
            guard generation == issuesGeneration else {
                return
            }
            reviewIssues = page.items.sorted { $0.updatedAt > $1.updatedAt }
            issuesPhase = reviewIssues.isEmpty ? .empty : .content
        } catch {
            guard generation == issuesGeneration else {
                return
            }
            reviewIssues = []
            issuesPhase = .failure(Self.message(for: error))
        }
    }

    /// Reloads the persisted Runtime event timeline, newest events first.
    public func loadEventTimeline() async {
        eventsGeneration += 1
        let generation = eventsGeneration
        eventsPhase = .loading
        do {
            let timeline = try await client.getEventTimeline(eventEpochID: nil)
            guard generation == eventsGeneration else {
                return
            }
            let ordered = timeline.events.sorted { left, right in
                if left.eventEpochID.rawValue != right.eventEpochID.rawValue {
                    return left.eventEpochID.rawValue > right.eventEpochID.rawValue
                }
                return left.sequence.rawValue > right.sequence.rawValue
            }
            events = ordered.map(EventListItem.init(event:))
            reportedEventGaps = timeline.reportedGaps
            eventsPhase = events.isEmpty ? .empty : .content
        } catch {
            guard generation == eventsGeneration else {
                return
            }
            events = []
            reportedEventGaps = []
            eventsPhase = .failure(Self.message(for: error))
        }
    }

    // MARK: - Tuning preview (Debug-only Host capability)

    /// Reloads the active tuning previews. A Host without an authorized
    /// Runtime rejects this route; the failure text is shown inline.
    public func loadActiveTuning() async {
        tuningGeneration += 1
        let generation = tuningGeneration
        tuningPhase = .loading
        do {
            let page = try await client.listActiveTuningApplications()
            guard generation == tuningGeneration else {
                return
            }
            activeTuning = page.items
            tuningPhase = activeTuning.isEmpty ? .empty : .content
        } catch {
            guard generation == tuningGeneration else {
                return
            }
            activeTuning = []
            tuningPhase = .failure(Self.message(for: error))
        }
    }

    /// Creates a single-change alpha Tuning Patch bound to the selected node
    /// and applies it with the selected Snapshot as the expected Snapshot.
    public func previewAlpha(_ value: Double) async {
        guard !isApplyingTuning else {
            return
        }
        guard let snapshot = selectedSnapshot,
              let node = selectedNode,
              let stableID = node.stableID
        else {
            tuningError = "Select a node with a stable ID to preview tuning."
            return
        }
        isApplyingTuning = true
        tuningError = nil
        defer { isApplyingTuning = false }
        let draft = TuningPatchDraft(
            title: "Studio alpha preview for \(stableID)",
            targetSnapshotID: snapshot.id,
            changes: [
                TuningChangeDraft(
                    target: TuningNodeTargetDraft(
                        snapshotID: snapshot.id,
                        treeID: snapshot.tree.treeID,
                        nodeID: node.id,
                        stableID: stableID
                    ),
                    property: "alpha",
                    originalValue: TuningNumberValueDraft(value: node.alpha ?? 1),
                    previewValue: TuningNumberValueDraft(value: value)
                ),
            ],
            createdBy: .studio
        )
        do {
            let patch = try await client.createTuningPatch(draft)
            lastTuningApplication = try await client.applyTuningPatch(
                patchID: patch.patchID,
                previewTTLMilliseconds: nil
            )
        } catch {
            tuningError = Self.message(for: error)
            return
        }
        await loadActiveTuning()
    }

    /// Reverts one active tuning preview and refreshes the active list.
    public func revertTuning(id: String) async {
        guard !revertingTuningIDs.contains(id) else {
            return
        }
        revertingTuningIDs.insert(id)
        tuningError = nil
        defer { revertingTuningIDs.remove(id) }
        do {
            let reverted = try await client.revertTuningApplication(id: id)
            if lastTuningApplication?.tuningApplicationID == reverted.tuningApplicationID {
                lastTuningApplication = reverted
            }
        } catch {
            tuningError = Self.message(for: error)
            return
        }
        await loadActiveTuning()
    }

    // MARK: - Review Issue lifecycle

    /// The legal target states for the selected issue, from the canonical
    /// Review Issue lifecycle.
    public var legalIssueTransitions: [String] {
        guard let state = selectedIssue?.state else {
            return []
        }
        return ReviewIssueLifecycle.legalTargets(from: state)
    }

    /// Selects one Review Issue and loads its current persisted revision.
    public func selectReviewIssue(id: String?) async {
        issueDetailGeneration += 1
        let generation = issueDetailGeneration
        selectedIssueID = id
        issueTransitionError = nil
        issueConflictNote = nil
        guard let id else {
            selectedIssue = nil
            issueDetailPhase = .idle
            return
        }
        selectedIssue = nil
        issueDetailPhase = .loading
        do {
            let issue = try await client.getReviewIssue(id: id)
            guard generation == issueDetailGeneration else {
                return
            }
            selectedIssue = issue
            issueDetailPhase = .content
        } catch {
            guard generation == issueDetailGeneration else {
                return
            }
            issueDetailPhase = .failure(Self.message(for: error))
        }
    }

    /// Applies one lifecycle transition to the selected issue. An
    /// optimistic-concurrency conflict reloads the issue and leaves a note.
    public func transitionSelectedIssue(to state: String, reason: String?) async {
        guard !isTransitioningIssue, let issue = selectedIssue else {
            return
        }
        isTransitioningIssue = true
        issueTransitionError = nil
        issueConflictNote = nil
        defer { isTransitioningIssue = false }
        do {
            let updated = try await client.transitionReviewIssue(
                id: issue.issueID,
                ReviewIssueTransitionRequest(
                    expectedRevision: issue.revision,
                    toState: state,
                    reason: reason,
                    changedBy: .studio
                )
            )
            selectedIssue = updated
            issueDetailPhase = .content
            applyIssueToList(updated)
        } catch {
            if Self.isConflict(error) {
                issueConflictNote =
                    "This issue changed elsewhere. The latest revision is shown; review it before retrying."
                await reloadIssueAfterConflict(issueID: issue.issueID)
            } else {
                issueTransitionError = Self.message(for: error)
            }
        }
    }

    // MARK: - Deep Wiki editing

    /// Creates one Deep Wiki node and refreshes the knowledge pane.
    /// Returns true when the node was persisted.
    public func createWikiNode(
        kind: String,
        title: String,
        summary: String?,
        markdown: String
    ) async -> Bool {
        guard !isSavingWikiNode else {
            return false
        }
        isSavingWikiNode = true
        wikiWriteError = nil
        defer { isSavingWikiNode = false }
        do {
            _ = try await client.createWikiNode(
                WikiNodeDraft(
                    kind: kind,
                    title: title,
                    summary: summary,
                    markdown: markdown,
                    createdBy: .studio
                )
            )
        } catch {
            wikiWriteError = Self.message(for: error)
            return false
        }
        await loadWiki(text: nil)
        return true
    }

    /// Loads one full Wiki node for editing.
    public func beginWikiEdit(nodeID: String) async {
        wikiEditGeneration += 1
        let generation = wikiEditGeneration
        wikiEditingNode = nil
        wikiConflictNote = nil
        wikiWriteError = nil
        wikiEditPhase = .loading
        do {
            let node = try await client.getWikiNode(id: nodeID)
            guard generation == wikiEditGeneration else {
                return
            }
            wikiEditingNode = node
            wikiEditPhase = .content
        } catch {
            guard generation == wikiEditGeneration else {
                return
            }
            wikiEditPhase = .failure(Self.message(for: error))
        }
    }

    /// Ends the Wiki editing session without saving.
    public func endWikiEdit() {
        wikiEditGeneration += 1
        wikiEditingNode = nil
        wikiEditPhase = .idle
        wikiConflictNote = nil
        wikiWriteError = nil
    }

    /// Saves one Wiki node revision guarded by the loaded revision. An
    /// optimistic-concurrency conflict reloads the node and leaves a note.
    /// Returns true when the revision was persisted.
    public func saveWikiEdit(
        title: String?,
        summary: String?,
        markdown: String?,
        toStatus: String?
    ) async -> Bool {
        guard !isSavingWikiNode, let node = wikiEditingNode else {
            return false
        }
        isSavingWikiNode = true
        wikiWriteError = nil
        wikiConflictNote = nil
        defer { isSavingWikiNode = false }
        do {
            let updated = try await client.reviseWikiNode(
                id: node.wikiNodeID,
                WikiNodeRevisionDraft(
                    expectedRevision: node.revision,
                    title: title,
                    summary: summary,
                    markdown: markdown,
                    toStatus: toStatus,
                    updatedBy: .studio
                )
            )
            wikiEditingNode = updated
            wikiEditPhase = .content
        } catch {
            if Self.isConflict(error) {
                wikiConflictNote =
                    "This node changed elsewhere. The latest revision has been reloaded; reapply your edits."
                await reloadWikiEditAfterConflict(nodeID: node.wikiNodeID)
            } else {
                wikiWriteError = Self.message(for: error)
            }
            return false
        }
        await loadWiki(text: nil)
        return true
    }

    // MARK: - Canvas Screen State details and knowledge links

    /// Selects one Canvas Screen State and loads its persisted detail plus
    /// the Wiki nodes already linked to it.
    public func selectCanvasState(id: String?) async {
        canvasStateGeneration += 1
        let generation = canvasStateGeneration
        selectedCanvasStateID = id
        canvasLinkError = nil
        relatedWikiNodes = []
        canvasStateDetail = nil
        guard let id else {
            canvasStatePhase = .idle
            return
        }
        canvasStatePhase = .loading
        let detail: ScreenStateDetail
        do {
            detail = try await client.getScreenState(id: id)
            guard generation == canvasStateGeneration else {
                return
            }
            canvasStateDetail = detail
            canvasStatePhase = .content
        } catch {
            guard generation == canvasStateGeneration else {
                return
            }
            canvasStatePhase = .failure(Self.message(for: error))
            return
        }
        // The single-screen Inspector follows the STATE: its canonical
        // observation Snapshot drives the screenshot, the 2D tree, the node
        // properties, and the 3D layers — not whichever capture the Evidence
        // library last selected. An already-loaded matching Snapshot is kept
        // so reselecting the state does not reset the node selection.
        if selectedSnapshotID != detail.canonicalSnapshotID || detailPhase != .content {
            await loadInspectorSnapshot(id: detail.canonicalSnapshotID)
        }
        await loadRelatedWikiNodes(stateID: id, generation: generation)
    }

    /// Links one Wiki node to the selected Screen State with a `relates_to`
    /// relation, then refreshes the linked-node list.
    public func linkSelectedCanvasState(toWikiNode nodeID: String) async {
        guard !isLinkingWikiNode, let stateID = selectedCanvasStateID else {
            return
        }
        isLinkingWikiNode = true
        canvasLinkError = nil
        defer { isLinkingWikiNode = false }
        do {
            _ = try await client.createWikiLink(
                WikiLinkDraft(
                    sourceNodeID: nodeID,
                    target: ResourceTargetDraft(kind: "screen_state", id: stateID),
                    relation: "relates_to",
                    createdBy: .studio
                )
            )
        } catch {
            canvasLinkError = Self.message(for: error)
            return
        }
        await loadRelatedWikiNodes(stateID: stateID, generation: canvasStateGeneration)
    }

    // MARK: - Canvas identity curation

    /// The observation IDs of the selected Canvas state, from the loaded
    /// graph document. A split moves a strict subset of these.
    public var selectedCanvasStateObservationIDs: [String] {
        guard let stateID = selectedCanvasStateID,
              let state = canvasGraph?.states.first(where: { $0.id == stateID })
        else {
            return []
        }
        return state.observationIDs
    }

    /// Toggles one active state in or out of the merge selection. Merged,
    /// split, and deprecated tombstones are never selectable.
    public func toggleMergeSelection(stateID: String) {
        guard let state = canvasGraph?.states.first(where: { $0.id == stateID }), state.isActive else {
            return
        }
        if let index = mergeSelectionStateIDs.firstIndex(of: stateID) {
            mergeSelectionStateIDs.remove(at: index)
        } else {
            mergeSelectionStateIDs.append(stateID)
        }
    }

    public func clearMergeSelection() {
        mergeSelectionStateIDs = []
    }

    /// Begins one merge decision against the Screen Graph revision that is on
    /// screen right now. The Merge sheet calls this when it opens: a
    /// background reload — a manual refresh, or the automatic reload after an
    /// exploration succeeds — advances `canvasGraph.revision`, and submitting
    /// that newer revision would launder a concurrent change into the user's
    /// decision instead of conflicting with it.
    public func beginMergeDecision() {
        curationError = nil
        graphConflictNote = nil
        guard let graph = canvasGraph else {
            mergeDecisionRevision = nil
            curationError = "The Screen Graph is not loaded. Refresh the Canvas before merging."
            return
        }
        mergeDecisionRevision = graph.revision
    }

    /// Ends the merge decision without submitting it.
    public func endMergeDecision() {
        mergeDecisionRevision = nil
    }

    /// Begins one split decision for the selected Screen State against the
    /// graph revision that is on screen right now.
    public func beginSplitDecision() {
        curationError = nil
        graphConflictNote = nil
        guard let graph = canvasGraph, let stateID = selectedCanvasStateID else {
            splitDecisionRevision = nil
            splitDecisionStateID = nil
            curationError = "Select a Screen State on a loaded Canvas before splitting it."
            return
        }
        splitDecisionRevision = graph.revision
        splitDecisionStateID = stateID
    }

    /// Ends the split decision without submitting it.
    public func endSplitDecision() {
        splitDecisionRevision = nil
        splitDecisionStateID = nil
    }

    /// Merges the selected states into the chosen survivor, guarded by the
    /// revision the decision began against. A stale decision, and a revision
    /// conflict the Host reports, both take the changed-elsewhere path
    /// instead of overwriting concurrent curation. Returns true when the
    /// merge persisted.
    public func mergeSelectedStates(into survivorID: String?, justification: String?) async -> Bool {
        guard !isMergingStates else {
            return false
        }
        guard let graph = canvasGraph,
              let projectID = lastCanvasProjectID,
              let applicationID = lastCanvasApplicationID
        else {
            curationError = "The Screen Graph is not loaded. Refresh the Canvas before merging."
            return false
        }
        let stateIDs = mergeSelectionStateIDs
        guard stateIDs.count >= 2 else {
            curationError = "Select at least two active Screen States to merge."
            return false
        }
        // A reload can drop the chosen survivor out of the selection; posting
        // it would fail with an opaque identifier error instead of telling the
        // user what changed.
        if let survivorID, !stateIDs.contains(survivorID) {
            curationError =
                "The surviving state is no longer part of the selection. Choose a survivor from the current selection and merge again."
            return false
        }
        guard let decisionRevision = mergeDecisionRevision else {
            curationError =
                "This merge was not opened against a loaded Screen Graph. Reopen the Merge sheet and try again."
            return false
        }
        guard decisionRevision == graph.revision else {
            // The graph reloaded under the open decision. The user decided
            // against a revision that is no longer the loaded one.
            noteGraphChangedElsewhere()
            rearmOpenCurationDecisions()
            return false
        }
        isMergingStates = true
        curationError = nil
        graphConflictNote = nil
        defer { isMergingStates = false }
        do {
            _ = try await client.mergeScreenStates(
                MergeScreenStatesCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateIDs: stateIDs,
                    intoStateID: survivorID,
                    expectedGraphRevision: decisionRevision,
                    mergedBy: .studio,
                    justification: justification
                )
            )
        } catch {
            await handleCurationFailure(
                error,
                projectID: projectID,
                applicationID: applicationID
            )
            return false
        }
        mergeSelectionStateIDs = []
        mergeDecisionRevision = nil
        await loadCanvas(projectID: projectID, applicationID: applicationID)
        return true
    }

    /// Splits the given observations out of the selected state, guarded by
    /// the revision the decision began against. The moved set must be a
    /// strict subset. Returns true when the split persisted.
    public func splitSelectedState(
        observationIDs: [String],
        title: String?,
        justification: String?
    ) async -> Bool {
        guard !isSplittingState else {
            return false
        }
        guard let graph = canvasGraph,
              let projectID = lastCanvasProjectID,
              let applicationID = lastCanvasApplicationID
        else {
            curationError = "The Screen Graph is not loaded. Refresh the Canvas before splitting a state."
            return false
        }
        guard let stateID = selectedCanvasStateID else {
            curationError = "Select a Screen State to split."
            return false
        }
        guard let state = graph.states.first(where: { $0.id == stateID }) else {
            curationError = "The selected Screen State is no longer part of the loaded Screen Graph."
            return false
        }
        // A tombstone is a real, distinguishable reason — not a graph that
        // changed elsewhere.
        guard state.isActive else {
            curationError =
                "This Screen State was \(state.status) by identity curation. Only an active state can be split."
            return false
        }
        let available = state.observationIDs
        guard !observationIDs.isEmpty,
              observationIDs.count < available.count,
              observationIDs.allSatisfy(available.contains)
        else {
            curationError = "Select at least one observation and leave at least one behind."
            return false
        }
        guard let decisionRevision = splitDecisionRevision, splitDecisionStateID == stateID else {
            curationError =
                "This split was not opened for the selected Screen State. Reopen the Split sheet and try again."
            return false
        }
        guard decisionRevision == graph.revision else {
            noteGraphChangedElsewhere()
            rearmOpenCurationDecisions()
            return false
        }
        isSplittingState = true
        curationError = nil
        graphConflictNote = nil
        defer { isSplittingState = false }
        do {
            _ = try await client.splitScreenState(
                SplitScreenStateCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateID: stateID,
                    observationIDs: observationIDs,
                    title: title,
                    expectedGraphRevision: decisionRevision,
                    splitBy: .studio,
                    justification: justification
                )
            )
        } catch {
            await handleCurationFailure(
                error,
                projectID: projectID,
                applicationID: applicationID
            )
            return false
        }
        splitDecisionRevision = nil
        splitDecisionStateID = nil
        await loadCanvas(projectID: projectID, applicationID: applicationID)
        await selectCanvasState(id: stateID)
        return true
    }

    public func dismissCurationError() {
        curationError = nil
        graphConflictNote = nil
    }

    private func handleCurationFailure(
        _ error: Error,
        projectID: String,
        applicationID: String
    ) async {
        if Self.isConflict(error) {
            noteGraphChangedElsewhere()
            await loadCanvas(projectID: projectID, applicationID: applicationID)
            rearmOpenCurationDecisions()
        } else {
            curationError = Self.message(for: error)
        }
    }

    private func noteGraphChangedElsewhere() {
        graphConflictNote =
            "The Screen Graph changed elsewhere. The latest graph is shown; review it before retrying."
    }

    /// The user has now been shown the latest graph together with the
    /// changed-elsewhere note, so a deliberate retry decides against the
    /// revision that is on screen. A decision that was never opened stays
    /// closed.
    private func rearmOpenCurationDecisions() {
        guard let revision = canvasGraph?.revision else {
            mergeDecisionRevision = nil
            splitDecisionRevision = nil
            splitDecisionStateID = nil
            return
        }
        if mergeDecisionRevision != nil {
            mergeDecisionRevision = revision
        }
        if splitDecisionRevision != nil {
            splitDecisionRevision = revision
        }
    }

    // MARK: - Design comparison workbench

    /// The drawable overlay regions of the shown comparison, resolved
    /// against the selected Snapshot. Empty when the Snapshot changed since
    /// the comparison ran or carries no screenshot.
    public var differenceRegions: [DifferenceRegion] {
        guard let comparison = designComparison,
              let snapshot = selectedSnapshot,
              comparison.targetSnapshotID == snapshot.id
        else {
            return []
        }
        return DesignOverlayProjection.regions(
            for: comparison,
            tree: snapshot.tree,
            screenshot: snapshot.screenshot
        )
    }

    /// Where the selected design reference's canvas lands on the selected
    /// Snapshot's screenshot, in the same unit frame `differenceRegions` uses.
    /// Nil when there is nothing to overlay.
    public var designOverlayPlacement: DesignOverlayPlacement? {
        guard let reference = selectedDesignReference, let snapshot = selectedSnapshot else {
            return nil
        }
        return DesignOverlayProjection.placement(
            for: reference,
            screenshot: snapshot.screenshot
        )
    }

    /// Reloads the persisted design references.
    public func loadDesignReferences() async {
        designReferencesGeneration += 1
        let generation = designReferencesGeneration
        designReferencesPhase = .loading
        do {
            let page = try await client.listDesignReferences()
            guard generation == designReferencesGeneration else {
                return
            }
            designReferences = page.items
            designReferencesPhase = designReferences.isEmpty ? .empty : .content
        } catch {
            guard generation == designReferencesGeneration else {
                return
            }
            designReferences = []
            designReferencesPhase = .failure(Self.message(for: error))
        }
    }

    /// Selects one design reference, loads its persisted document, then its
    /// asset bytes, then the past comparisons against the selected Snapshot.
    public func selectDesignReference(id: String?) async {
        designReferenceGeneration += 1
        let generation = designReferenceGeneration
        selectedDesignReferenceID = id
        selectedDesignReference = nil
        designAssetData = nil
        designAssetPhase = .none
        designComparison = nil
        selectedDifferenceID = nil
        designComparisonError = nil
        guard let id else {
            designReferencePhase = .idle
            designComparisons = []
            designComparisonsPhase = .idle
            return
        }
        designReferencePhase = .loading
        do {
            let reference = try await client.getDesignReference(id: id)
            guard generation == designReferenceGeneration else {
                return
            }
            selectedDesignReference = reference
            designReferencePhase = .content
        } catch {
            guard generation == designReferenceGeneration else {
                return
            }
            designReferencePhase = .failure(Self.message(for: error))
            return
        }
        await loadDesignAsset(generation: generation)
        await loadDesignComparisons()
    }

    /// Reloads the persisted comparisons for the selected reference and
    /// Snapshot.
    public func loadDesignComparisons() async {
        designComparisonsGeneration += 1
        let generation = designComparisonsGeneration
        designComparisonsPhase = .loading
        do {
            let page = try await client.listDesignComparisons(
                designReferenceID: selectedDesignReferenceID,
                targetSnapshotID: selectedSnapshotID
            )
            guard generation == designComparisonsGeneration else {
                return
            }
            designComparisons = page.items
            designComparisonsPhase = designComparisons.isEmpty ? .empty : .content
        } catch {
            guard generation == designComparisonsGeneration else {
                return
            }
            designComparisons = []
            designComparisonsPhase = .failure(Self.message(for: error))
        }
    }

    /// Runs one design comparison of the selected reference against the
    /// selected Snapshot and shows the persisted result.
    public func runDesignComparison(includePixel: Bool) async {
        guard !isComparingDesign else {
            return
        }
        guard let referenceID = selectedDesignReferenceID, let snapshotID = selectedSnapshotID else {
            designComparisonError = "Select a design reference and a Runtime Snapshot to compare."
            return
        }
        isComparingDesign = true
        designComparisonError = nil
        defer { isComparingDesign = false }
        do {
            let comparison = try await client.runDesignComparison(
                DesignComparisonCommand(
                    designReferenceID: referenceID,
                    targetSnapshotID: snapshotID,
                    includePixel: includePixel ? true : nil,
                    completedBy: .studio
                )
            )
            designComparison = comparison
            selectedDifferenceID = nil
        } catch {
            designComparisonError = Self.message(for: error)
            return
        }
        await loadDesignComparisons()
    }

    /// Shows one previously persisted comparison from the list.
    public func selectDesignComparison(id: String) {
        guard let comparison = designComparisons.first(where: { $0.id == id }) else {
            return
        }
        designComparison = comparison
        selectedDifferenceID = nil
    }

    /// Highlights one difference of the shown comparison.
    public func selectDifference(id: String?) {
        guard let id else {
            selectedDifferenceID = nil
            return
        }
        guard designComparison?.differences.contains(where: { $0.id == id }) == true else {
            return
        }
        selectedDifferenceID = id
    }

    /// Steps the difference selection for review mode, wrapping at both
    /// ends. Without a current selection the first (or last) difference is
    /// selected.
    public func advanceDifferenceSelection(by step: Int) {
        guard let comparison = designComparison, !comparison.differences.isEmpty else {
            return
        }
        let ids = comparison.differences.map(\.differenceID)
        guard let current = selectedDifferenceID, let index = ids.firstIndex(of: current) else {
            selectedDifferenceID = step >= 0 ? ids.first : ids.last
            return
        }
        let count = ids.count
        let next = ((index + step) % count + count) % count
        selectedDifferenceID = ids[next]
    }

    // MARK: - Exploration Operations (device automation Host capability)

    /// The canonical terminal Operation states. A run that reached one of
    /// them is no longer addressable for cancellation.
    private static let terminalExplorationStates: Set<String> = ["succeeded", "failed", "cancelled"]

    /// True while an exploration Operation this Studio started is still
    /// addressable on the Host: Cancel must stay reachable even when the poll
    /// loop is no longer running (a superseded start, a torn-down model), so
    /// the run can never be orphaned.
    public var isExplorationRunAddressable: Bool {
        guard explorationOperationID != nil else {
            return false
        }
        guard let state = explorationState else {
            return true
        }
        return !Self.terminalExplorationStates.contains(state)
    }

    /// Starts one background exploration Operation and polls it to a
    /// terminal state. The poll loop is bound to the Operation, not to the
    /// Canvas pane: switching tabs never stops it. A Host without a
    /// configured automation provider rejects the run with HTTP 501 code
    /// `unsupported`; the message is shown inline and the controls stay
    /// usable.
    public func startExploration(
        maximumActions: Int,
        maximumDepth: Int? = nil,
        settleMilliseconds: Int? = nil,
        excludedStableIDs: [String] = []
    ) async {
        guard !isExploring else {
            return
        }
        explorationGeneration += 1
        let generation = explorationGeneration
        isExploring = true
        explorationError = nil
        explorationReport = nil
        explorationProgress = nil
        explorationLastEventMessage = nil
        let command = ExplorationRunCommand(
            maximumActions: maximumActions,
            maximumDepth: maximumDepth,
            settleMilliseconds: settleMilliseconds,
            excludedStableIDs: excludedStableIDs.isEmpty ? nil : excludedStableIDs
        )
        let reference: ExplorationOperationRef
        do {
            reference = try await client.runExploration(command)
            guard generation == explorationGeneration else {
                return
            }
        } catch {
            guard generation == explorationGeneration else {
                return
            }
            explorationError = Self.explorationMessage(for: error)
            isExploring = false
            // The previous Operation identity survives a rejected start: a
            // Host that rejects the run because one is already active must
            // leave that run cancellable, not orphaned.
            return
        }
        // Only an accepted run replaces the previous Operation identity.
        explorationOperationID = reference.operationID
        explorationState = reference.state
        await pollExploration(operationID: reference.operationID, generation: generation)
    }

    /// Requests cancellation of the addressable exploration. The Operation
    /// stays running until the walk observes the request; the poll loop then
    /// shows the terminal `cancelled` state.
    public func cancelExploration() async {
        guard !isCancellingExploration,
              isExplorationRunAddressable,
              let operationID = explorationOperationID
        else {
            return
        }
        isCancellingExploration = true
        defer { isCancellingExploration = false }
        do {
            let ref = try await client.cancelExploration(id: operationID)
            if explorationOperationID == operationID {
                explorationState = ref.state
            }
        } catch {
            if explorationOperationID == operationID {
                explorationError = Self.explorationMessage(for: error)
            }
        }
    }

    /// Tears down the exploration poll loop without cancelling the Host-side
    /// run, when the model itself is discarded or a newer request supersedes
    /// it. The Canvas pane must never call this: a tab switch keeps the run
    /// polling. The Operation identity survives so Cancel stays reachable.
    public func stopExplorationPolling() {
        explorationGeneration += 1
        isExploring = false
    }

    /// Polls the exploration Operation once per interval until it reaches a
    /// terminal state, the generation guard supersedes the loop, or the
    /// enclosing Task is cancelled.
    private func pollExploration(operationID: String, generation: Int) async {
        while generation == explorationGeneration {
            if Task.isCancelled {
                return
            }
            do {
                try await explorationPollSleep()
            } catch {
                // The only failure a sleep reports is cancellation: stop the
                // loop instead of spinning through it.
                return
            }
            guard !Task.isCancelled, generation == explorationGeneration else {
                return
            }
            let record: ExplorationOperationRecord
            do {
                record = try await client.getExplorationOperation(id: operationID)
            } catch {
                guard generation == explorationGeneration else {
                    return
                }
                explorationError = Self.explorationMessage(for: error)
                isExploring = false
                return
            }
            guard generation == explorationGeneration else {
                return
            }
            explorationState = record.operation.state
            let previousCompletedUnits = explorationProgress?.completedUnits
            explorationProgress = record.latestProgress
            explorationLastEventMessage = record.latestEventMessage
            switch record.operation.state {
            case "succeeded":
                explorationReport = record.report
                isExploring = false
                await refreshCanvasAfterExploration()
                return
            case "failed", "cancelled":
                explorationError = Self.terminalExplorationMessage(for: record.operation)
                isExploring = false
                return
            default:
                // The walk records observations as it goes, so the Canvas
                // grows while the device is still walking: every executed
                // action may have discovered a state, and waiting for the
                // run to settle would hide exactly the live picture an
                // operator watches an exploration for.
                if record.latestProgress?.completedUnits != previousCompletedUnits {
                    await refreshCanvasAfterExploration()
                }
                continue
            }
        }
    }

    /// Discovered states belong on the Canvas immediately — during the walk
    /// after every executed action, and once more when the run settles — so
    /// this reloads the same Screen Graph the Canvas last showed.
    private func refreshCanvasAfterExploration() async {
        guard let projectID = lastCanvasProjectID, let applicationID = lastCanvasApplicationID else {
            return
        }
        await loadCanvas(projectID: projectID, applicationID: applicationID)
    }

    /// Surfaces the canonical error code and message verbatim.
    private static func explorationMessage(for error: Error) -> String {
        if let hostError = error as? HostClientError,
           case let .server(_, _, code, message, _) = hostError {
            return "\(code): \(message)"
        }
        return message(for: error)
    }

    private static func terminalExplorationMessage(for operation: ExplorationOperationRef) -> String {
        guard let error = operation.error else {
            return "The exploration operation ended as \(operation.state)."
        }
        return "\(error.code): \(error.message)"
    }

    private func loadRelatedWikiNodes(stateID: String, generation: Int) async {
        do {
            let page = try await client.relatedWikiNodes(kind: "screen_state", id: stateID)
            guard generation == canvasStateGeneration else {
                return
            }
            relatedWikiNodes = page.items
        } catch {
            guard generation == canvasStateGeneration else {
                return
            }
            relatedWikiNodes = []
            canvasLinkError = Self.message(for: error)
        }
    }

    private func reloadIssueAfterConflict(issueID: String) async {
        issueDetailGeneration += 1
        let generation = issueDetailGeneration
        do {
            let latest = try await client.getReviewIssue(id: issueID)
            guard generation == issueDetailGeneration, selectedIssueID == issueID else {
                return
            }
            selectedIssue = latest
            issueDetailPhase = .content
            applyIssueToList(latest)
        } catch {
            guard generation == issueDetailGeneration, selectedIssueID == issueID else {
                return
            }
            issueDetailPhase = .failure(Self.message(for: error))
        }
    }

    private func reloadWikiEditAfterConflict(nodeID: String) async {
        wikiEditGeneration += 1
        let generation = wikiEditGeneration
        do {
            let node = try await client.getWikiNode(id: nodeID)
            guard generation == wikiEditGeneration else {
                return
            }
            wikiEditingNode = node
            wikiEditPhase = .content
        } catch {
            guard generation == wikiEditGeneration else {
                return
            }
            wikiEditPhase = .failure(Self.message(for: error))
        }
    }

    private func applyIssueToList(_ issue: ReviewIssueSummary) {
        guard let index = reviewIssues.firstIndex(where: { $0.issueID == issue.issueID }) else {
            return
        }
        reviewIssues[index] = issue
        reviewIssues.sort { $0.updatedAt > $1.updatedAt }
    }

    private static func isConflict(_ error: Error) -> Bool {
        guard let hostError = error as? HostClientError,
              case let .server(statusCode, _, code, _, _) = hostError
        else {
            return false
        }
        return statusCode == 409 || code == "conflict"
    }

    private func apply(snapshot: RuntimeSnapshot) throws {
        let presentation = try SnapshotPresentation(snapshot: snapshot)
        apply(presentation: presentation)
    }

    private func apply(presentation: SnapshotPresentation) {
        selectedSnapshot = presentation
        detailPhase = .content
        layerBoxes = LayerProjection.boxes(from: presentation.tree)
        let initialNodeID = presentation.tree.roots.first?.id
        selectedNodeID = initialNodeID
        selectedNode = initialNodeID.flatMap { presentation.tree.nodesByID[$0] }
    }

    private func loadScreenshot(for snapshot: RuntimeSnapshot, generation: Int) async {
        guard let screenshot = snapshot.screenshot else {
            screenshotData = nil
            screenshotPhase = .none
            return
        }
        screenshotPhase = .loading
        do {
            let data = try await client.getObject(hash: screenshot.object.hash, range: nil)
            guard generation == selectionGeneration else {
                return
            }
            guard !data.isEmpty else {
                screenshotData = nil
                screenshotPhase = .unavailable("The screenshot Object is empty.")
                return
            }
            screenshotData = data
            screenshotPhase = .available
        } catch {
            guard generation == selectionGeneration else {
                return
            }
            screenshotData = nil
            screenshotPhase = .unavailable(Self.message(for: error))
        }
    }

    /// Loads the selected design reference's asset bytes through the Object
    /// route. Failures degrade to inline text; the workbench never invents
    /// image bytes.
    private func loadDesignAsset(generation: Int) async {
        guard let reference = selectedDesignReference else {
            return
        }
        designAssetPhase = .loading
        do {
            let data = try await client.getObject(hash: reference.artifact.object.hash, range: nil)
            guard generation == designReferenceGeneration else {
                return
            }
            guard !data.isEmpty else {
                designAssetData = nil
                designAssetPhase = .unavailable("The design asset Object is empty.")
                return
            }
            designAssetData = data
            designAssetPhase = .available
        } catch {
            guard generation == designReferenceGeneration else {
                return
            }
            designAssetData = nil
            designAssetPhase = .unavailable(Self.message(for: error))
        }
    }

    private func clearSelection() {
        selectionGeneration += 1
        selectedSnapshotID = nil
        selectedSnapshot = nil
        selectedNodeID = nil
        selectedNode = nil
        screenshotData = nil
        layerBoxes = []
        detailPhase = .idle
        screenshotPhase = .none
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
