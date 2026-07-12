import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

@MainActor
final class CanvasAndWikiTests: XCTestCase {
    private static func fixtureGraph() -> CanvasGraph {
        CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-000000000001",
            entryStateIDs: ["screenstate_019f0000-0000-7000-8000-000000000001"],
            states: [
                CanvasStateSummary(
                    screenStateID: "screenstate_019f0000-0000-7000-8000-000000000001",
                    title: "Home",
                    kind: "screen",
                    status: "active"
                ),
                CanvasStateSummary(
                    screenStateID: "screenstate_019f0000-0000-7000-8000-000000000002",
                    title: "Catalog",
                    kind: "screen",
                    status: "active"
                ),
                CanvasStateSummary(
                    screenStateID: "screenstate_019f0000-0000-7000-8000-000000000003",
                    title: "Orphan",
                    kind: "screen",
                    status: "active"
                ),
            ],
            transitions: [
                CanvasTransitionSummary(
                    transitionID: "transition_019f0000-0000-7000-8000-000000000001",
                    sourceStateID: "screenstate_019f0000-0000-7000-8000-000000000001",
                    targetStateID: "screenstate_019f0000-0000-7000-8000-000000000002",
                    occurrenceCount: 2
                ),
            ]
        )
    }

    func testCanvasGraphDecodesTheFullMaterializedDocumentLeniently() throws {
        let payload = """
        {
          "screen_graph_id": "graph_019f0000-0000-7000-8000-000000000001",
          "protocol_version": {"major": 1, "minor": 0},
          "revision": 3,
          "materialized_at": "2026-07-12T00:00:00Z",
          "context": {"project_id": "project_019f0000-0000-7000-8000-000000000001"},
          "entry_state_ids": ["screenstate_019f0000-0000-7000-8000-000000000001"],
          "states": [
            {
              "screen_state_id": "screenstate_019f0000-0000-7000-8000-000000000001",
              "title": "Home",
              "kind": "screen",
              "status": "active",
              "revision": 2,
              "identity": {"strategy": "structural"},
              "observation_ids": ["observation_019f0000-0000-7000-8000-000000000001"]
            }
          ],
          "transitions": [
            {
              "transition_id": "transition_019f0000-0000-7000-8000-000000000001",
              "source_state_id": "screenstate_019f0000-0000-7000-8000-000000000001",
              "target_state_id": "screenstate_019f0000-0000-7000-8000-000000000001",
              "action_id": "action_019f0000-0000-7000-8000-000000000001",
              "occurrence_count": 4,
              "status": "observed"
            }
          ],
          "actions": [],
          "observations": [],
          "identity_decisions": [],
          "extensions": {}
        }
        """
        let graph = try JSONDecoder().decode(CanvasGraph.self, from: Data(payload.utf8))
        XCTAssertEqual(graph.states.count, 1)
        XCTAssertEqual(graph.states[0].title, "Home")
        XCTAssertEqual(graph.transitions[0].occurrenceCount, 4)
        XCTAssertEqual(graph.entryStateIDs.count, 1)
    }

    func testCanvasLayoutPlacesEntryFirstReachableNextAndOrphansLast() {
        let positions = CanvasLayout.positions(for: Self.fixtureGraph())
        let byID = Dictionary(uniqueKeysWithValues: positions.map { ($0.id, $0) })
        XCTAssertEqual(byID["screenstate_019f0000-0000-7000-8000-000000000001"]?.column, 0)
        XCTAssertEqual(byID["screenstate_019f0000-0000-7000-8000-000000000002"]?.column, 1)
        XCTAssertEqual(byID["screenstate_019f0000-0000-7000-8000-000000000003"]?.column, 2)
        // Deterministic: repeated layout produces identical positions.
        XCTAssertEqual(positions, CanvasLayout.positions(for: Self.fixtureGraph()))
    }

    func testLayerProjectionAssignsHierarchyDepthAndSkipsZeroAreaFrames() throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let presentation = try SnapshotPresentation(snapshot: snapshot)
        let boxes = LayerProjection.boxes(from: presentation.tree)
        XCTAssertFalse(boxes.isEmpty)
        let root = boxes.first(where: { $0.title == "demo.home.root" })
        XCTAssertEqual(root?.depth, 0)
        let button = boxes.first(where: { $0.title == "demo.home.open_catalog" })
        XCTAssertEqual(button?.depth, 1)
        XCTAssertEqual(button?.isInteractive, true)
        XCTAssertEqual(root?.isInteractive, false)
        XCTAssertTrue(boxes.allSatisfy { $0.width > 0 && $0.height > 0 })
    }

    func testModelLoadsCanvasAndWikiPhases() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let wikiNodes = [
            WikiNodeSummary(
                wikiNodeID: "wiki_019f0000-0000-7000-8000-000000000001",
                kind: "screen",
                title: "Home knowledge",
                summary: "Entry screen behavior.",
                status: "published",
                labels: ["demo"]
            ),
        ]
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(
                snapshots: [snapshot],
                canvasGraph: Self.fixtureGraph(),
                wikiNodes: wikiNodes
            )
        )
        await model.refresh()

        XCTAssertEqual(model.canvasPhase, .content)
        XCTAssertEqual(model.canvasStates.count, 3)
        XCTAssertEqual(model.canvasGraph?.transitions.count, 1)
        XCTAssertEqual(model.wikiPhase, .content)
        XCTAssertEqual(model.wikiNodes.first?.title, "Home knowledge")
        XCTAssertFalse(model.layerBoxes.isEmpty)

        // A filtered search narrows the pane and an unmatched search empties it.
        await model.loadWiki(text: "entry screen")
        XCTAssertEqual(model.wikiNodes.count, 1)
        await model.loadWiki(text: "no-such-phrase")
        XCTAssertEqual(model.wikiPhase, .empty)
    }

    func testModelTreatsMissingGraphAsEmptyCanvas() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))
        await model.refresh()
        XCTAssertEqual(model.canvasPhase, .empty)
        XCTAssertNil(model.canvasGraph)
    }
}
