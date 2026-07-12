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

    // Tuning preview state (Debug-only Host capability).
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

    private let client: any HostClient
    private var selectionGeneration = 0
    // Per-pane request generations: a slow older response must never
    // overwrite the state a newer request already applied.
    private var canvasGeneration = 0
    private var wikiGeneration = 0
    private var issuesGeneration = 0
    private var eventsGeneration = 0
    private var tuningGeneration = 0
    private var issueDetailGeneration = 0
    private var wikiEditGeneration = 0
    private var canvasStateGeneration = 0

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
            if let first = page.items.first {
                await loadCanvas(
                    projectID: first.runtimeContext.projectID.rawValue,
                    applicationID: first.runtimeContext.applicationID
                )
            } else {
                canvasPhase = .empty
                canvasGraph = nil
                canvasStates = []
            }
            snapshots = page.items.map(SnapshotListItem.init(summary:))
            guard !snapshots.isEmpty else {
                clearSelection()
                contentPhase = .empty
                return
            }
            contentPhase = .content
            let targetID = selectedSnapshotID.flatMap { selectedID in
                snapshots.contains(where: { $0.id == selectedID }) ? selectedID : nil
            } ?? snapshots[0].id
            await selectSnapshot(id: targetID)
        } catch {
            clearSelection()
            contentPhase = .failure(Self.message(for: error))
        }
    }

    public func selectSnapshot(id: String) async {
        guard snapshots.contains(where: { $0.id == id }) else {
            return
        }
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
            canvasGraph = graph
            canvasStates = CanvasLayout.positions(for: graph)
            canvasPhase = graph.states.isEmpty ? .empty : .content
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
        do {
            let detail = try await client.getScreenState(id: id)
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
