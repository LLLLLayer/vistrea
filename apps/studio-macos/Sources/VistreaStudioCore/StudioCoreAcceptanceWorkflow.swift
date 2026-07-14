import Foundation

public struct StudioCoreAcceptanceRequest: Equatable, Sendable {
    public let expectedSnapshotID: String
    public let requireConnectedRuntime: Bool
    public let requireCanvasState: Bool

    public init(
        expectedSnapshotID: String,
        requireConnectedRuntime: Bool = true,
        requireCanvasState: Bool = true
    ) {
        self.expectedSnapshotID = expectedSnapshotID
        self.requireConnectedRuntime = requireConnectedRuntime
        self.requireCanvasState = requireCanvasState
    }
}

public struct StudioCoreAcceptanceResult: Codable, Equatable, Sendable {
    public let snapshotID: String
    public let scenarioID: String?
    public let nodeCount: Int
    public let screenshotHash: String?
    public let screenshotByteCount: Int?
    public let runtimeConnected: Bool
    public let workspaceSnapshotCount: Int
    public let scopeCount: Int
    public let canvasStateCount: Int
    public let canvasTransitionCount: Int
    public let selectedScreenStateID: String?
    public let layerBoxCount: Int
    public let eventCount: Int
    public let reviewIssueCount: Int
    public let wikiNodeCount: Int
    public let designReferenceCount: Int
    public let coreWorkflowCompleted: Bool

    private enum CodingKeys: String, CodingKey {
        case snapshotID = "snapshot_id"
        case scenarioID = "scenario_id"
        case nodeCount = "node_count"
        case screenshotHash = "screenshot_hash"
        case screenshotByteCount = "screenshot_byte_count"
        case runtimeConnected = "runtime_connected"
        case workspaceSnapshotCount = "workspace_snapshot_count"
        case scopeCount = "scope_count"
        case canvasStateCount = "canvas_state_count"
        case canvasTransitionCount = "canvas_transition_count"
        case selectedScreenStateID = "selected_screen_state_id"
        case layerBoxCount = "layer_box_count"
        case eventCount = "event_count"
        case reviewIssueCount = "review_issue_count"
        case wikiNodeCount = "wiki_node_count"
        case designReferenceCount = "design_reference_count"
        case coreWorkflowCompleted = "core_workflow_completed"
    }
}

public enum StudioCoreAcceptanceError: Error, Equatable, Sendable {
    case failed(String)
}

extension StudioCoreAcceptanceError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .failed(message):
            message
        }
    }
}

/// Runs the read-only product workflow used by packaged, device, and CI
/// acceptance. It deliberately drives `SnapshotWorkspaceModel`, so a passing
/// probe proves Studio orchestration rather than only HTTP decoding.
@MainActor
public enum StudioCoreAcceptanceWorkflow {
    public static func run(
        client: any HostClient,
        request: StudioCoreAcceptanceRequest
    ) async throws -> StudioCoreAcceptanceResult {
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()

        let status = try acceptedStatus(model.connectionPhase)
        guard status.status == .ready else {
            throw failure("The Host is not ready.")
        }
        if request.requireConnectedRuntime, !status.runtimeConnected {
            throw failure("The Runtime is not connected.")
        }
        guard model.contentPhase == .content else {
            throw failure("The Workspace Snapshot library did not load.")
        }
        guard model.snapshots.contains(where: { $0.id == request.expectedSnapshotID }) else {
            throw failure("The expected Snapshot is not present in the Workspace.")
        }
        guard accepted(model.eventsPhase), accepted(model.wikiPhase), accepted(model.tuningPhase) else {
            throw failure("A supporting Studio pane did not load.")
        }

        await model.selectSnapshot(id: request.expectedSnapshotID)
        guard model.detailPhase == .content,
              let snapshot = model.selectedSnapshot,
              snapshot.id == request.expectedSnapshotID
        else {
            throw failure("The expected Snapshot did not open in the Inspector.")
        }

        let screenshotByteCount: Int?
        if let screenshot = snapshot.screenshot {
            guard model.screenshotPhase == .available, let bytes = model.screenshotData else {
                throw failure("The Snapshot screenshot evidence did not load.")
            }
            guard UInt64(bytes.count) == screenshot.byteSize else {
                throw failure("The Snapshot screenshot byte count does not match its ObjectRef.")
            }
            screenshotByteCount = bytes.count
        } else {
            guard model.screenshotPhase == .none, model.screenshotData == nil else {
                throw failure("Studio exposed screenshot bytes for a Snapshot without screenshot evidence.")
            }
            screenshotByteCount = nil
        }

        guard let scope = model.selectedScope,
              model.availableScopes.contains(scope),
              model.canvasPhase == .content,
              let graph = model.canvasGraph
        else {
            if request.requireCanvasState {
                throw failure("The selected build Canvas did not load.")
            }
            return result(
                model: model,
                status: status,
                snapshot: snapshot,
                screenshotByteCount: screenshotByteCount,
                graph: nil,
                selectedScreenStateID: nil
            )
        }
        guard graph.buildScope?.applicationVersion == scope.applicationVersion,
              graph.buildScope?.buildID == scope.buildID
        else {
            throw failure("The Canvas build scope does not match the selected Workspace scope.")
        }

        let stateID = graph.entryStateIDs.first(where: { entryID in
            graph.states.contains(where: { $0.id == entryID && $0.isActive })
        }) ?? graph.states.first(where: \.isActive)?.id
        if request.requireCanvasState, stateID == nil {
            throw failure("The selected build Canvas has no active Screen State.")
        }
        if let stateID {
            await model.selectCanvasState(id: stateID)
            guard model.canvasStatePhase == .content,
                  model.canvasStateDetail?.screenStateID == stateID,
                  accepted(model.issuesPhase)
            else {
                throw failure("The Canvas Screen State workflow did not load.")
            }
        }

        await model.loadDesignReferences()
        guard accepted(model.designReferencesPhase) else {
            throw failure("The design reference library did not load.")
        }

        return result(
            model: model,
            status: status,
            snapshot: snapshot,
            screenshotByteCount: screenshotByteCount,
            graph: graph,
            selectedScreenStateID: stateID
        )
    }

    private static func acceptedStatus(_ phase: ConnectionPhase) throws -> HostStatus {
        guard case let .available(status) = phase else {
            throw failure("Studio could not establish Host readiness.")
        }
        return status
    }

    private static func accepted(_ phase: EventTimelinePhase) -> Bool {
        phase == .content || phase == .empty
    }

    private static func result(
        model: SnapshotWorkspaceModel,
        status: HostStatus,
        snapshot: SnapshotPresentation,
        screenshotByteCount: Int?,
        graph: CanvasGraph?,
        selectedScreenStateID: String?
    ) -> StudioCoreAcceptanceResult {
        StudioCoreAcceptanceResult(
            snapshotID: snapshot.id,
            scenarioID: snapshot.scenarioID,
            nodeCount: snapshot.tree.nodesByID.count,
            screenshotHash: snapshot.screenshot?.hash,
            screenshotByteCount: screenshotByteCount,
            runtimeConnected: status.runtimeConnected,
            workspaceSnapshotCount: model.snapshots.count,
            scopeCount: model.availableScopes.count,
            canvasStateCount: graph?.states.count ?? 0,
            canvasTransitionCount: graph?.transitions.count ?? 0,
            selectedScreenStateID: selectedScreenStateID,
            layerBoxCount: model.layerBoxes.count,
            eventCount: model.events.count,
            reviewIssueCount: model.reviewIssues.count,
            wikiNodeCount: model.wikiNodes.count,
            designReferenceCount: model.designReferences.count,
            coreWorkflowCompleted: true
        )
    }

    private static func failure(_ message: String) -> StudioCoreAcceptanceError {
        .failed(message)
    }
}
