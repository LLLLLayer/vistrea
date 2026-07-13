import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

private let stateOneID = "screenstate_019f0000-0000-7000-8000-000000000001"
private let stateTwoID = "screenstate_019f0000-0000-7000-8000-000000000002"
private let stateThreeID = "screenstate_019f0000-0000-7000-8000-000000000003"

@MainActor
final class IdentityCurationModelTests: XCTestCase {
    private static func fixtureGraph() -> CanvasGraph {
        CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-000000000001",
            revision: 1,
            entryStateIDs: [stateOneID],
            states: [
                CanvasStateSummary(
                    screenStateID: stateOneID,
                    title: "Home",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation-a1", "observation-a2"]
                ),
                CanvasStateSummary(
                    screenStateID: stateTwoID,
                    title: "Catalog",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation-b1"]
                ),
                CanvasStateSummary(
                    screenStateID: stateThreeID,
                    title: "Settings",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation-c1"]
                ),
            ],
            transitions: [
                CanvasTransitionSummary(
                    transitionID: "transition_019f0000-0000-7000-8000-000000000001",
                    sourceStateID: stateOneID,
                    targetStateID: stateTwoID,
                    occurrenceCount: 2
                ),
            ]
        )
    }

    private func makeModel() async throws -> (SnapshotWorkspaceModel, FixtureHostClient) {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        XCTAssertEqual(model.canvasPhase, .content)
        XCTAssertEqual(model.canvasGraph?.revision, 1)
        return (model, client)
    }

    func testMergeFlowTombstonesAbsorbedStatesAndReloadsGraph() async throws {
        let (model, _) = try await makeModel()

        model.toggleMergeSelection(stateID: stateOneID)
        model.toggleMergeSelection(stateID: stateTwoID)
        XCTAssertEqual(model.mergeSelectionStateIDs, [stateOneID, stateTwoID])

        let merged = await model.mergeSelectedStates(into: nil, justification: "One product screen")
        XCTAssertTrue(merged)
        XCTAssertNil(model.curationError)
        XCTAssertNil(model.graphConflictNote)
        XCTAssertTrue(model.mergeSelectionStateIDs.isEmpty)

        let graph = try XCTUnwrap(model.canvasGraph)
        XCTAssertEqual(graph.revision, 2)
        let survivor = try XCTUnwrap(graph.states.first(where: { $0.id == stateOneID }))
        XCTAssertEqual(survivor.status, "active")
        XCTAssertEqual(
            survivor.observationIDs,
            ["observation-a1", "observation-a2", "observation-b1"]
        )
        let tombstone = try XCTUnwrap(graph.states.first(where: { $0.id == stateTwoID }))
        XCTAssertEqual(tombstone.status, "merged")
        XCTAssertFalse(tombstone.isActive)
        // The observed transition now points at the survivor.
        XCTAssertEqual(graph.transitions.first?.sourceStateID, stateOneID)
        XCTAssertEqual(graph.transitions.first?.targetStateID, stateOneID)

        // Tombstones are excluded from a new merge selection.
        model.toggleMergeSelection(stateID: stateTwoID)
        XCTAssertTrue(model.mergeSelectionStateIDs.isEmpty)
    }

    func testMergeConflictReloadsGraphAndLeavesNote() async throws {
        let (model, client) = try await makeModel()

        // Another actor curates the graph after the Canvas loaded it.
        _ = try await client.splitScreenState(
            SplitScreenStateCommand(
                projectID: "project_019f0000-0000-7000-8000-000000000001",
                applicationID: "dev.vistrea.demo",
                stateID: stateOneID,
                observationIDs: ["observation-a2"],
                expectedGraphRevision: 1,
                splitBy: .studio
            )
        )

        model.toggleMergeSelection(stateID: stateTwoID)
        model.toggleMergeSelection(stateID: stateThreeID)
        let merged = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertFalse(merged)
        XCTAssertNotNil(model.graphConflictNote)
        XCTAssertNil(model.curationError)
        // The conflict reloaded the latest graph, including the new revision
        // and the state the concurrent split created.
        XCTAssertEqual(model.canvasGraph?.revision, 2)
        XCTAssertEqual(model.canvasGraph?.states.count, 4)

        // Retrying against the reloaded revision succeeds.
        let retried = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertTrue(retried)
        XCTAssertEqual(model.canvasGraph?.revision, 3)
    }

    func testSplitFlowCreatesNewActiveStateAndKeepsSource() async throws {
        let (model, _) = try await makeModel()

        await model.selectCanvasState(id: stateOneID)
        XCTAssertEqual(
            model.selectedCanvasStateObservationIDs,
            ["observation-a1", "observation-a2"]
        )

        let split = await model.splitSelectedState(
            observationIDs: ["observation-a2"],
            title: "Home variant",
            justification: "Different modal state"
        )
        XCTAssertTrue(split)
        XCTAssertNil(model.curationError)

        let graph = try XCTUnwrap(model.canvasGraph)
        XCTAssertEqual(graph.revision, 2)
        XCTAssertEqual(graph.states.count, 4)
        let source = try XCTUnwrap(graph.states.first(where: { $0.id == stateOneID }))
        XCTAssertEqual(source.status, "active")
        XCTAssertEqual(source.observationIDs, ["observation-a1"])
        let created = try XCTUnwrap(graph.states.first(where: { $0.title == "Home variant" }))
        XCTAssertEqual(created.status, "active")
        XCTAssertEqual(created.observationIDs, ["observation-a2"])
        // The state details panel reloaded the source state.
        XCTAssertEqual(model.selectedCanvasStateID, stateOneID)
        XCTAssertEqual(model.canvasStatePhase, .content)
    }

    func testSplitRequiresAStrictObservationSubset() async throws {
        let (model, _) = try await makeModel()
        await model.selectCanvasState(id: stateOneID)

        // Moving every observation would leave the source state empty.
        let movedAll = await model.splitSelectedState(
            observationIDs: ["observation-a1", "observation-a2"],
            title: nil,
            justification: nil
        )
        XCTAssertFalse(movedAll)
        XCTAssertNotNil(model.curationError)
        XCTAssertEqual(model.canvasGraph?.revision, 1)

        // Moving nothing is equally rejected before any write.
        model.dismissCurationError()
        let movedNone = await model.splitSelectedState(
            observationIDs: [],
            title: nil,
            justification: nil
        )
        XCTAssertFalse(movedNone)
        XCTAssertNotNil(model.curationError)
        XCTAssertEqual(model.canvasGraph?.revision, 1)
    }
}
