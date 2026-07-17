import Foundation

public struct StudioCoreAcceptanceRequest: Equatable, Sendable {
    public let expectedSnapshotID: String
    public let requireConnectedRuntime: Bool
    public let requireCanvasState: Bool
    public let exerciseReversibleTuningAndQuality: Bool
    public let expectedCollectionID: String?
    public let expectedTuningPatchID: String?
    public let leftBuildID: String?
    public let rightBuildID: String?

    public init(
        expectedSnapshotID: String,
        requireConnectedRuntime: Bool = true,
        requireCanvasState: Bool = true,
        exerciseReversibleTuningAndQuality: Bool = false,
        expectedCollectionID: String? = nil,
        expectedTuningPatchID: String? = nil,
        leftBuildID: String? = nil,
        rightBuildID: String? = nil
    ) {
        self.expectedSnapshotID = expectedSnapshotID
        self.requireConnectedRuntime = requireConnectedRuntime
        self.requireCanvasState = requireCanvasState
        self.exerciseReversibleTuningAndQuality = exerciseReversibleTuningAndQuality
        self.expectedCollectionID = expectedCollectionID
        self.expectedTuningPatchID = expectedTuningPatchID
        self.leftBuildID = leftBuildID
        self.rightBuildID = rightBuildID
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
    public let tuningPreviewReverted: Bool
    public let collectionLoaded: Bool
    public let sourceHandoffActionable: Bool
    public let validationCompleted: Bool
    public let buildDiffCompleted: Bool
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
        case tuningPreviewReverted = "tuning_preview_reverted"
        case collectionLoaded = "collection_loaded"
        case sourceHandoffActionable = "source_handoff_actionable"
        case validationCompleted = "validation_completed"
        case buildDiffCompleted = "build_diff_completed"
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

/// Runs the product workflow used by packaged, device, and CI acceptance. It
/// deliberately drives `SnapshotWorkspaceModel`, so a passing probe proves
/// Studio orchestration rather than only HTTP decoding. The default path is
/// read-only; the explicit tuning-and-quality option uses a bounded,
/// reversible Runtime preview.
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
        // A persisted local Workspace remains inspectable with no Runtime
        // connected. In that mode the Host intentionally rejects the active
        // tuning query, while events, Wiki, source handoff, and Quality must
        // remain available. Device acceptance still requires the tuning pane.
        guard accepted(model.eventsPhase),
              accepted(model.wikiPhase),
              (!request.requireConnectedRuntime || accepted(model.tuningPhase))
        else {
            throw failure("A supporting Studio pane did not load.")
        }

        var collectionLoaded = false
        if let expectedCollectionID = request.expectedCollectionID {
            guard accepted(model.knowledgeCollectionsPhase),
                  model.knowledgeCollections.contains(where: { $0.id == expectedCollectionID })
            else {
                throw failure("The expected Knowledge Collection did not load.")
            }
            await model.selectKnowledgeCollection(id: expectedCollectionID)
            guard model.knowledgeCollectionDetailPhase == .content,
                  model.selectedKnowledgeCollection?.id == expectedCollectionID
            else {
                throw failure("The expected Knowledge Collection did not open.")
            }
            collectionLoaded = true
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
                selectedScreenStateID: nil,
                tuningPreviewReverted: false,
                collectionLoaded: collectionLoaded,
                sourceHandoffActionable: false,
                validationCompleted: false,
                buildDiffCompleted: false
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

        var tuningPreviewReverted = false
        var validationCompleted = false
        var sourceHandoffActionable = false
        var buildDiffCompleted = false
        if request.exerciseReversibleTuningAndQuality {
            guard let selectedNode = model.selectedNode,
                  selectedNode.stableID != nil
            else {
                throw failure("The Inspector did not expose a tunable stable node.")
            }
            let originalApplicationIDs = Set(model.activeTuning.map(\.id))
            let previewAlpha = selectedNode.alpha == 0.82 ? 0.73 : 0.82
            var pendingApplicationID: String?
            do {
                // Acceptance must never leave an unbounded Runtime override.
                // The TTL is the final safety net if best-effort cleanup also
                // loses its connection to the Host.
                await model.previewAlpha(
                    previewAlpha,
                    previewTTLMilliseconds: 30_000
                )
                if let application = model.lastTuningApplication,
                   (application.status == "active" || application.status == "partially_active"),
                   !originalApplicationIDs.contains(application.id)
                {
                    pendingApplicationID = application.id
                }
                guard model.tuningError == nil,
                      let application = model.lastTuningApplication,
                      application.status == "active",
                      !originalApplicationIDs.contains(application.id),
                      model.activeTuning.contains(where: { $0.id == application.id })
                else {
                    throw failure("The reversible tuning preview did not become active.")
                }
                await model.revertTuning(id: application.id)
                if model.lastTuningApplication?.id == application.id,
                   model.lastTuningApplication?.status == "reverted"
                {
                    pendingApplicationID = nil
                }
                guard model.tuningError == nil,
                      model.lastTuningApplication?.status == "reverted",
                      !model.activeTuning.contains(where: { $0.id == application.id })
                else {
                    throw failure("The tuning preview was not reverted cleanly.")
                }
                tuningPreviewReverted = true

                await model.validateSelectedSnapshot()
                guard accepted(model.validationPhase),
                      model.lastValidationRun != nil,
                      model.validationError == nil
                else {
                    throw failure("The selected Snapshot did not complete local validation.")
                }
                validationCompleted = true
            } catch {
                if let pendingApplicationID {
                    await model.revertTuning(id: pendingApplicationID)
                }
                throw error
            }
        }

        if let patchID = request.expectedTuningPatchID {
            let handoff = try await client.getTuningSourceSuggestions(patchID: patchID)
            guard handoff.patchID == patchID,
                  handoff.targetSnapshotID == request.expectedSnapshotID,
                  !handoff.suggestions.isEmpty,
                  handoff.suggestions.allSatisfy({
                      $0.status == "actionable"
                          && $0.sourceContext != nil
                          && !$0.codingAgentInstructions.isEmpty
                  })
            else {
                throw failure("The persisted tuning patch did not produce an actionable source handoff.")
            }
            sourceHandoffActionable = true
        }

        if request.expectedCollectionID != nil
            || request.expectedTuningPatchID != nil
            || request.leftBuildID != nil
            || request.rightBuildID != nil
        {
            await model.validateSelectedSnapshot()
            guard accepted(model.validationPhase),
                  model.lastValidationRun != nil,
                  model.validationError == nil
            else {
                throw failure("The persisted Snapshot did not complete local validation.")
            }
            validationCompleted = true
        }

        switch (request.leftBuildID, request.rightBuildID) {
        case let (.some(leftBuildID), .some(rightBuildID)):
            await model.compareBuilds(leftBuildID: leftBuildID, rightBuildID: rightBuildID)
            guard model.buildDiffPhase == .content,
                  let diff = model.lastBuildDiff,
                  diff.leftBuild.id == leftBuildID,
                  diff.rightBuild.id == rightBuildID,
                  diff.summary.total > 0,
                  !diff.entries.isEmpty,
                  model.buildDiffError == nil
            else {
                throw failure("The persisted build pair did not produce a non-empty Build Diff.")
            }
            buildDiffCompleted = true
        case (.none, .none):
            break
        default:
            throw failure("Build Diff acceptance requires both build identifiers.")
        }

        return result(
            model: model,
            status: status,
            snapshot: snapshot,
            screenshotByteCount: screenshotByteCount,
            graph: graph,
            selectedScreenStateID: stateID,
            tuningPreviewReverted: tuningPreviewReverted,
            collectionLoaded: collectionLoaded,
            sourceHandoffActionable: sourceHandoffActionable,
            validationCompleted: validationCompleted,
            buildDiffCompleted: buildDiffCompleted
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
        selectedScreenStateID: String?,
        tuningPreviewReverted: Bool,
        collectionLoaded: Bool,
        sourceHandoffActionable: Bool,
        validationCompleted: Bool,
        buildDiffCompleted: Bool
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
            tuningPreviewReverted: tuningPreviewReverted,
            collectionLoaded: collectionLoaded,
            sourceHandoffActionable: sourceHandoffActionable,
            validationCompleted: validationCompleted,
            buildDiffCompleted: buildDiffCompleted,
            coreWorkflowCompleted: true
        )
    }

    private static func failure(_ message: String) -> StudioCoreAcceptanceError {
        .failed(message)
    }
}
