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

        // The Merge sheet opens: the decision is taken against revision 1.
        model.beginMergeDecision()
        XCTAssertEqual(model.mergeDecisionRevision, 1)

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
        model.beginMergeDecision()
        let merged = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertFalse(merged)
        XCTAssertNotNil(model.graphConflictNote)
        XCTAssertNil(model.curationError)
        // The conflict reloaded the latest graph, including the new revision
        // and the state the concurrent split created.
        XCTAssertEqual(model.canvasGraph?.revision, 2)
        XCTAssertEqual(model.canvasGraph?.states.count, 4)
        // The user has now seen the reloaded graph, so the open decision is
        // re-armed against the revision on screen.
        XCTAssertEqual(model.mergeDecisionRevision, 2)

        // Retrying against the reloaded revision succeeds.
        let retried = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertTrue(retried)
        XCTAssertEqual(model.canvasGraph?.revision, 3)
        XCTAssertNil(model.mergeDecisionRevision, "A persisted merge closes its decision.")
    }

    /// The defect: a background reload (a refresh, or the automatic reload
    /// after an exploration succeeds) advances `canvasGraph.revision` while a
    /// merge sheet is open. Submitting the reloaded revision would launder the
    /// concurrent change into the user's decision; the decision must conflict
    /// instead.
    func testGraphReloadUnderAnOpenMergeConflictsInsteadOfSubmitting() async throws {
        let (model, client) = try await makeModel()

        model.toggleMergeSelection(stateID: stateTwoID)
        model.toggleMergeSelection(stateID: stateThreeID)
        // The sheet opens against revision 1.
        model.beginMergeDecision()
        XCTAssertEqual(model.mergeDecisionRevision, 1)

        // Another actor curates the graph, and Studio reloads it in the
        // background while the sheet is still open.
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
        await model.loadCanvas(
            projectID: "project_019f0000-0000-7000-8000-000000000001",
            applicationID: "dev.vistrea.demo"
        )
        XCTAssertEqual(model.canvasGraph?.revision, 2)
        let mergesBeforeSubmit = await client.mergeCount

        let merged = await model.mergeSelectedStates(into: nil, justification: nil)

        XCTAssertFalse(merged)
        XCTAssertNotNil(model.graphConflictNote)
        XCTAssertNil(model.curationError)
        // Nothing was posted: the stale decision never reached the Host.
        let mergesAfterSubmit = await client.mergeCount
        XCTAssertEqual(mergesAfterSubmit, mergesBeforeSubmit)
        XCTAssertEqual(model.canvasGraph?.revision, 2, "The graph is untouched.")
        // The decision is re-armed against the revision the user can now see.
        XCTAssertEqual(model.mergeDecisionRevision, 2)

        // A deliberate retry, after reviewing the reloaded graph, persists.
        let retried = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertTrue(retried)
        XCTAssertEqual(model.canvasGraph?.revision, 3)
    }

    /// The same guard for a split: the state's observations are decided
    /// against one revision and must be submitted against that revision.
    func testGraphReloadUnderAnOpenSplitConflictsInsteadOfSubmitting() async throws {
        let (model, client) = try await makeModel()
        await model.selectCanvasState(id: stateOneID)
        model.beginSplitDecision()
        XCTAssertEqual(model.splitDecisionRevision, 1)
        XCTAssertEqual(model.splitDecisionStateID, stateOneID)

        // A concurrent merge lands and the Canvas reloads underneath the sheet.
        _ = try await client.mergeScreenStates(
            MergeScreenStatesCommand(
                projectID: "project_019f0000-0000-7000-8000-000000000001",
                applicationID: "dev.vistrea.demo",
                stateIDs: [stateTwoID, stateThreeID],
                expectedGraphRevision: 1,
                mergedBy: .studio
            )
        )
        await model.loadCanvas(
            projectID: "project_019f0000-0000-7000-8000-000000000001",
            applicationID: "dev.vistrea.demo"
        )
        XCTAssertEqual(model.canvasGraph?.revision, 2)
        let splitsBeforeSubmit = await client.splitCount

        let split = await model.splitSelectedState(
            observationIDs: ["observation-a2"],
            title: nil,
            justification: nil
        )

        XCTAssertFalse(split)
        XCTAssertNotNil(model.graphConflictNote)
        XCTAssertNil(model.curationError)
        let splitsAfterSubmit = await client.splitCount
        XCTAssertEqual(splitsAfterSubmit, splitsBeforeSubmit)
        XCTAssertEqual(model.canvasGraph?.revision, 2)
        XCTAssertEqual(model.splitDecisionRevision, 2)
    }

    /// A reload can drop the chosen survivor out of the merge selection. The
    /// merge must say so instead of posting an identifier the command cannot
    /// name.
    func testSurvivorDroppedByAReloadIsRevalidatedAtSubmit() async throws {
        let (model, client) = try await makeModel()

        model.toggleMergeSelection(stateID: stateOneID)
        model.toggleMergeSelection(stateID: stateTwoID)
        model.toggleMergeSelection(stateID: stateThreeID)
        model.beginMergeDecision()

        // Another actor merges state three away; the reload prunes it from the
        // selection, but the sheet's survivor picker still names it.
        _ = try await client.mergeScreenStates(
            MergeScreenStatesCommand(
                projectID: "project_019f0000-0000-7000-8000-000000000001",
                applicationID: "dev.vistrea.demo",
                stateIDs: [stateOneID, stateThreeID],
                intoStateID: stateOneID,
                expectedGraphRevision: 1,
                mergedBy: .studio
            )
        )
        await model.loadCanvas(
            projectID: "project_019f0000-0000-7000-8000-000000000001",
            applicationID: "dev.vistrea.demo"
        )
        XCTAssertEqual(model.mergeSelectionStateIDs, [stateOneID, stateTwoID])
        let mergesBeforeSubmit = await client.mergeCount

        let merged = await model.mergeSelectedStates(into: stateThreeID, justification: nil)

        XCTAssertFalse(merged)
        // The survivor guard reports the real reason, and nothing is posted.
        let error = try XCTUnwrap(model.curationError)
        XCTAssertTrue(error.contains("surviving state"))
        let mergesAfterSubmit = await client.mergeCount
        XCTAssertEqual(mergesAfterSubmit, mergesBeforeSubmit)
    }

    /// Splitting a tombstone is a distinguishable reason, not a graph that
    /// changed elsewhere.
    func testSplittingANonActiveStateReportsTheRealReason() async throws {
        let (model, client) = try await makeModel()

        model.toggleMergeSelection(stateID: stateOneID)
        model.toggleMergeSelection(stateID: stateTwoID)
        model.beginMergeDecision()
        let merged = await model.mergeSelectedStates(into: stateOneID, justification: nil)
        XCTAssertTrue(merged)
        // State two is now a merged tombstone with observations.
        let tombstone = try XCTUnwrap(model.canvasGraph?.states.first(where: { $0.id == stateTwoID }))
        XCTAssertEqual(tombstone.status, "merged")

        await model.selectCanvasState(id: stateTwoID)
        model.beginSplitDecision()
        let splitsBeforeSubmit = await client.splitCount

        let split = await model.splitSelectedState(
            observationIDs: ["observation-b1"],
            title: nil,
            justification: nil
        )

        XCTAssertFalse(split)
        XCTAssertNil(model.graphConflictNote, "A tombstone is not a concurrent change.")
        let error = try XCTUnwrap(model.curationError)
        XCTAssertTrue(error.contains("merged"), "The real reason names the tombstone status.")
        let splitsAfterSubmit = await client.splitCount
        XCTAssertEqual(splitsAfterSubmit, splitsBeforeSubmit)
    }

    /// A guard that refuses a merge must always say why.
    func testMergeGuardFailuresSurfaceAMessage() async throws {
        let (model, _) = try await makeModel()

        model.toggleMergeSelection(stateID: stateOneID)
        model.beginMergeDecision()
        let tooFew = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertFalse(tooFew)
        XCTAssertNotNil(model.curationError)

        model.dismissCurationError()
        model.toggleMergeSelection(stateID: stateTwoID)
        model.endMergeDecision()
        let withoutDecision = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertFalse(withoutDecision)
        XCTAssertNotNil(model.curationError)
    }

    func testSplitFlowCreatesNewActiveStateAndKeepsSource() async throws {
        let (model, _) = try await makeModel()

        await model.selectCanvasState(id: stateOneID)
        XCTAssertEqual(
            model.selectedCanvasStateObservationIDs,
            ["observation-a1", "observation-a2"]
        )
        model.beginSplitDecision()

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
        model.beginSplitDecision()

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
