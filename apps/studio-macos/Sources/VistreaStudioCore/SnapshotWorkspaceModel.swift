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
    @Published public private(set) var isRefreshing = false
    @Published public private(set) var isCapturing = false
    @Published public private(set) var operationError: String?

    private let client: any HostClient
    private var selectionGeneration = 0

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

        do {
            let page = try await client.listSnapshots()
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

    /// Reloads the persisted Review Issues, most recently updated first.
    public func loadReviewIssues() async {
        issuesPhase = .loading
        do {
            let page = try await client.listReviewIssues(states: nil)
            reviewIssues = page.items.sorted { $0.updatedAt > $1.updatedAt }
            issuesPhase = reviewIssues.isEmpty ? .empty : .content
        } catch {
            reviewIssues = []
            issuesPhase = .failure(Self.message(for: error))
        }
    }

    /// Reloads the persisted Runtime event timeline, newest events first.
    public func loadEventTimeline() async {
        eventsPhase = .loading
        do {
            let timeline = try await client.getEventTimeline(eventEpochID: nil)
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
            events = []
            reportedEventGaps = []
            eventsPhase = .failure(Self.message(for: error))
        }
    }

    private func apply(snapshot: RuntimeSnapshot) throws {
        let presentation = try SnapshotPresentation(snapshot: snapshot)
        apply(presentation: presentation)
    }

    private func apply(presentation: SnapshotPresentation) {
        selectedSnapshot = presentation
        detailPhase = .content
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
        detailPhase = .idle
        screenshotPhase = .none
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
