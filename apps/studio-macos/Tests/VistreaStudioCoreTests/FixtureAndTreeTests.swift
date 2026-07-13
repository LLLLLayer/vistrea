import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

final class FixtureAndTreeTests: XCTestCase {
    func testStrictCanonicalDecoderReadsIOSFixture() throws {
        let snapshot = try StudioTestFixtures.snapshot()

        XCTAssertEqual(snapshot.snapshotID.rawValue, "snapshot_019f0000-0000-7000-8000-000000000002")
        XCTAssertEqual(snapshot.runtimeContext.platform, .ios)
        XCTAssertEqual(snapshot.trees.first?.payload.inlineNodes?.count, 2)
        XCTAssertEqual(snapshot.screenshot?.object.logicalName, "ios-home.png")
    }

    func testStrictCanonicalDecoderRejectsUnknownCoreFieldFixture() throws {
        let data = try StudioTestFixtures.data(
            "protocol/fixtures/v1/runtime-snapshot/invalid/unknown-core-field.json"
        )

        XCTAssertThrowsError(try RuntimeSnapshotCodec.decode(data))
    }

    func testReconstructsCanonicalFlatTreeWithoutChangingNodeIdentity() throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let projection = try UiTreeProjector.preferredProjection(from: snapshot)

        XCTAssertEqual(projection.kind, "view")
        XCTAssertEqual(projection.roots.count, 1)
        XCTAssertEqual(projection.roots[0].presentation.stableID, "demo.home.root")
        XCTAssertEqual(projection.roots[0].children.count, 1)
        XCTAssertEqual(projection.roots[0].children[0].presentation.stableID, "demo.home.open_catalog")
        XCTAssertEqual(projection.nodesByID.count, 2)
    }

    func testTreeProjectionRejectsSemanticDanglingChildFixture() throws {
        let snapshot = try StudioTestFixtures.snapshot(
            "protocol/fixtures/v1/runtime-snapshot/invalid/dangling-child-reference.json"
        )

        XCTAssertThrowsError(try UiTreeProjector.preferredProjection(from: snapshot)) { error in
            guard case UiTreeProjectionError.danglingChild = error else {
                return XCTFail("Expected danglingChild, received \(error)")
            }
        }
    }

    /// The shipped fixture development mode must exercise the surfaces the
    /// README claims: a Snapshot alone leaves the Canvas answering 404 and
    /// identity curation unreachable.
    @MainActor
    func testFixtureDevelopmentModeExercisesTheCanvasAndCuration() async throws {
        let model = SnapshotWorkspaceModel(
            client: FixtureWorkspace.makeClient(snapshot: try StudioTestFixtures.snapshot())
        )

        await model.refresh()

        XCTAssertEqual(model.contentPhase, .content)
        XCTAssertEqual(model.canvasPhase, .content, "The fixture Canvas is not a 404.")
        XCTAssertEqual(model.canvasStates.count, 3)
        XCTAssertEqual(model.wikiPhase, .content)
        XCTAssertEqual(model.issuesPhase, .content)

        // Merge is reachable: two active states can be selected and merged.
        let stateIDs = model.canvasStates.map(\.id)
        model.toggleMergeSelection(stateID: stateIDs[1])
        model.toggleMergeSelection(stateID: stateIDs[2])
        XCTAssertEqual(model.mergeSelectionStateIDs.count, 2)
        model.beginMergeDecision()
        let merged = await model.mergeSelectedStates(into: nil, justification: nil)
        XCTAssertTrue(merged)
        XCTAssertEqual(model.canvasGraph?.revision, 2)

        // Split is reachable: the entry state carries two observations.
        let entryID = try XCTUnwrap(model.canvasGraph?.entryStateIDs.first)
        await model.selectCanvasState(id: entryID)
        XCTAssertEqual(model.selectedCanvasStateObservationIDs.count, 2)
        model.beginSplitDecision()
        let split = await model.splitSelectedState(
            observationIDs: [model.selectedCanvasStateObservationIDs[1]],
            title: "Home variant",
            justification: nil
        )
        XCTAssertTrue(split)
        XCTAssertEqual(model.canvasGraph?.revision, 3)
    }

    func testPresentationExposesCanonicalScenarioExtension() throws {
        let source = try StudioTestFixtures.data(
            "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
        )
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: source) as? [String: Any]
        )
        object["extensions"] = ["vistrea.scenario_id": "demo.navigation.basic"]
        let snapshot = try RuntimeSnapshotCodec.decode(
            JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )

        let presentation = try SnapshotPresentation(snapshot: snapshot)

        XCTAssertEqual(presentation.id, snapshot.snapshotID.rawValue)
        XCTAssertEqual(presentation.scenarioID, "demo.navigation.basic")
    }
}
