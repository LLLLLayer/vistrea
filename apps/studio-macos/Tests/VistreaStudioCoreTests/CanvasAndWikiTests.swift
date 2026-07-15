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

    func testCanvasViewportProjectionCapsFitAndSnapsToRetinaPixels() {
        let projected = CanvasViewportProjection.point(
            CGPoint(x: 10.1, y: 20.2),
            zoom: 1.15,
            offset: CGSize(width: 0.12, height: 0.26),
            displayScale: 2
        )
        XCTAssertEqual(projected, CGPoint(x: 11.5, y: 23.5))

        let smallGraph = CanvasViewportProjection.fit(
            bounds: CGRect(x: 10, y: 20, width: 200, height: 128),
            viewportSize: CGSize(width: 1_000, height: 1_000),
            padding: 52,
            minimumZoom: 0.45,
            maximumZoom: 1,
            displayScale: 2
        )
        XCTAssertEqual(smallGraph.zoom, 1)
        XCTAssertEqual(smallGraph.offset, CGSize(width: 390, height: 416))

        let largeGraph = CanvasViewportProjection.fit(
            bounds: CGRect(x: 0, y: 0, width: 2_000, height: 1_000),
            viewportSize: CGSize(width: 1_000, height: 600),
            padding: 52,
            minimumZoom: 0.45,
            maximumZoom: 1,
            displayScale: 2
        )
        XCTAssertEqual(largeGraph.zoom, 0.45)
        XCTAssertEqual(largeGraph.offset, CGSize(width: 50, height: 75))
    }

    func testCanvasPathPlannerEnumeratesEntryRoutesDeterministicallyAndAvoidsCycles() {
        let stateIDs = ["entry-a", "entry-b", "middle-a", "middle-b", "target"]
        let graph = CanvasGraph(
            screenGraphID: "graph-paths",
            entryStateIDs: ["entry-b", "entry-a"],
            states: stateIDs.map {
                CanvasStateSummary(
                    screenStateID: $0,
                    title: $0,
                    kind: "screen",
                    status: "active"
                )
            },
            transitions: [
                CanvasTransitionSummary(
                    transitionID: "a-middle-a",
                    sourceStateID: "entry-a",
                    targetStateID: "middle-a",
                    occurrenceCount: 1
                ),
                CanvasTransitionSummary(
                    transitionID: "a-middle-b",
                    sourceStateID: "entry-a",
                    targetStateID: "middle-b",
                    occurrenceCount: 1
                ),
                CanvasTransitionSummary(
                    transitionID: "middle-a-target",
                    sourceStateID: "middle-a",
                    targetStateID: "target",
                    occurrenceCount: 1
                ),
                CanvasTransitionSummary(
                    transitionID: "middle-b-target",
                    sourceStateID: "middle-b",
                    targetStateID: "target",
                    occurrenceCount: 1
                ),
                CanvasTransitionSummary(
                    transitionID: "middle-b-cycle",
                    sourceStateID: "middle-b",
                    targetStateID: "entry-a",
                    occurrenceCount: 1
                ),
                CanvasTransitionSummary(
                    transitionID: "b-target",
                    sourceStateID: "entry-b",
                    targetStateID: "target",
                    occurrenceCount: 1
                ),
            ]
        )

        let routes = CanvasPathPlanner.paths(to: "target", in: graph)
        XCTAssertEqual(routes.count, 3)
        XCTAssertEqual(routes.map(\.entryStateID), ["entry-a", "entry-a", "entry-b"])
        XCTAssertEqual(routes[0].stateIDs, ["entry-a", "middle-a", "target"])
        XCTAssertEqual(routes[1].stateIDs, ["entry-a", "middle-b", "target"])
        XCTAssertEqual(routes[2].stateIDs, ["entry-b", "target"])
        XCTAssertTrue(routes.allSatisfy { Set($0.stateIDs).count == $0.stateIDs.count })
        XCTAssertEqual(
            CanvasPathPlanner.paths(to: "target", in: graph, maximumPaths: 2).count,
            2
        )

        let entryRoute = CanvasPathPlanner.paths(to: "entry-a", in: graph)
        XCTAssertEqual(entryRoute.first?.stateIDs, ["entry-a"])
        XCTAssertEqual(entryRoute.first?.transitionIDs, [])
    }

    func testCanvasStatePresentationReplacesInstrumentationTitlesWithSemanticLabels() {
        let generated = CanvasStateSummary(
            screenStateID: "product-detail",
            title: "android.debug.inspector.open",
            kind: "screen",
            status: "active",
            labels: ["storefront", "product-detail"]
        )
        XCTAssertEqual(CanvasStatePresentation.displayTitle(for: generated), "Product Detail")

        let cart = CanvasStateSummary(
            screenStateID: "cart-empty",
            title: "android.debug.inspector.open",
            kind: "screen",
            status: "active",
            labels: ["cart", "empty-state"]
        )
        XCTAssertEqual(CanvasStatePresentation.displayTitle(for: cart), "Cart · Empty State")

        let authored = CanvasStateSummary(
            screenStateID: "shop",
            title: "Shop",
            kind: "screen",
            status: "active",
            labels: ["storefront"]
        )
        XCTAssertEqual(CanvasStatePresentation.displayTitle(for: authored), "Shop")
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

    func testStaleWikiSearchResultIsDiscardedByANewerRequest() async throws {
        let client = GatedWikiHostClient()
        let model = SnapshotWorkspaceModel(client: client)

        await client.blockNextSearch()
        let staleTask = Task { await model.loadWiki(text: "stale") }
        while !(await client.isSearchWaiting()) {
            await Task.yield()
        }

        // The newer request completes first and owns the pane state.
        await model.loadWiki(text: "fresh")
        XCTAssertEqual(model.wikiNodes.map(\.title), ["fresh"])
        XCTAssertEqual(model.wikiPhase, .content)

        // Releasing the older request afterwards must not overwrite it.
        await client.releaseSearch()
        await staleTask.value
        XCTAssertEqual(model.wikiNodes.map(\.title), ["fresh"])
        XCTAssertEqual(model.wikiPhase, .content)
    }
}

private actor GatedWikiHostClient: HostClient {
    private var shouldBlockSearch = false
    private var searchContinuation: CheckedContinuation<Void, Never>?

    func blockNextSearch() {
        shouldBlockSearch = true
    }

    func isSearchWaiting() -> Bool {
        searchContinuation != nil
    }

    func releaseSearch() {
        shouldBlockSearch = false
        searchContinuation?.resume()
        searchContinuation = nil
    }

    func searchWikiNodes(text: String?) async throws -> WikiNodePage {
        if shouldBlockSearch {
            shouldBlockSearch = false
            await withCheckedContinuation { continuation in
                searchContinuation = continuation
            }
        }
        return WikiNodePage(items: [
            WikiNodeSummary(
                wikiNodeID: "wiki_019f0000-0000-7000-8000-000000000001",
                kind: "screen",
                title: text ?? "unfiltered",
                summary: nil,
                status: "published",
                labels: []
            ),
        ])
    }

    func getStatus() async throws -> HostStatus {
        HostStatus(status: .ready, runtimeConnected: true)
    }

    func listSnapshots() async throws -> SnapshotPage {
        SnapshotPage(items: [])
    }

    func getSnapshot(id: String) async throws -> RuntimeSnapshot {
        throw HostClientError.fixtureUnavailable("No Snapshot in this test double.")
    }

    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        throw HostClientError.fixtureUnavailable("No binary fixture.")
    }

    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        throw HostClientError.fixtureUnavailable("No capture in this test double.")
    }

    func getEventTimeline(eventEpochID: String?) async throws -> EventTimeline {
        EventTimeline(events: [], reportedGaps: [])
    }

    func listReviewIssues(states: [String]?) async throws -> ReviewIssuePage {
        ReviewIssuePage(items: [])
    }

    func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph {
        throw HostClientError.fixtureUnavailable("No Screen Graph in this test double.")
    }
}
