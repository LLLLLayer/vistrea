import CoreGraphics
import VistreaStudioCore
import XCTest
@testable import VistreaStudioApp

final class CanvasGraphSpatialIndexTests: XCTestCase {
    func testFitUsesTheActualScaleWhenGraphExceedsInteractiveZoomFloor() {
        let states = [
            Self.positionedState(id: "first", column: 0, row: 0),
            Self.positionedState(id: "last", column: 200, row: 0),
        ]
        let graph = Self.graph(states: states, transitions: [])
        let index = Self.index(graph: graph, states: states)
        let viewportSize = CGSize(width: 1_000, height: 600)
        let padding: CGFloat = 52

        XCTAssertTrue(index.isEntryState(id: "first"))
        XCTAssertFalse(index.isEntryState(id: "last"))
        let minimumZoom = CanvasFitZoomPolicy.minimumZoom(
            bounds: index.baseDrawingBounds,
            viewportSize: viewportSize,
            padding: padding,
            interactiveMinimum: 0.04
        )
        let fit = CanvasViewportProjection.fit(
            bounds: index.baseDrawingBounds,
            viewportSize: viewportSize,
            padding: padding,
            minimumZoom: minimumZoom,
            maximumZoom: 1,
            displayScale: 2
        )
        let topLeft = CanvasViewportProjection.point(
            index.baseDrawingBounds.origin,
            zoom: fit.zoom,
            offset: fit.offset,
            displayScale: 2
        )
        let bottomRight = CanvasViewportProjection.point(
            CGPoint(x: index.baseDrawingBounds.maxX, y: index.baseDrawingBounds.maxY),
            zoom: fit.zoom,
            offset: fit.offset,
            displayScale: 2
        )

        XCTAssertLessThan(minimumZoom, 0.04)
        XCTAssertGreaterThanOrEqual(topLeft.x, padding - 0.5)
        XCTAssertGreaterThanOrEqual(topLeft.y, padding - 0.5)
        XCTAssertLessThanOrEqual(bottomRight.x, viewportSize.width - padding + 0.5)
        XCTAssertLessThanOrEqual(bottomRight.y, viewportSize.height - padding + 0.5)
    }

    func testViewportQueryReturnsLocalCandidatesFromTenThousandStateGraph() {
        let stateCount = 10_000
        let states = (0..<stateCount).map {
            Self.positionedState(id: "state-\($0)", column: $0, row: 0)
        }
        let transitions = (0..<(stateCount - 1)).map {
            CanvasTransitionSummary(
                transitionID: "transition-\($0)",
                sourceStateID: "state-\($0)",
                targetStateID: "state-\($0 + 1)",
                occurrenceCount: 1
            )
        }
        let graph = Self.graph(states: states, transitions: transitions)
        let index = Self.index(graph: graph, states: states)
        let viewportSize = CGSize(width: 1_200, height: 800)
        let viewportOffset = CGSize(width: -500, height: -500)
        let offsets: [String: CGSize] = [:]

        let visible = index.visibleStates(
            viewportSize: viewportSize,
            zoom: 1,
            viewportOffset: viewportOffset,
            cardSize: CGSize(width: 200, height: 128),
            displayScale: 2,
            nodeOffsets: offsets,
            pinnedStateIDs: []
        )
        let transitionCandidates = index.transitionCandidates(
            viewportSize: viewportSize,
            zoom: 1,
            viewportOffset: viewportOffset,
            movedStateIDs: offsets.keys
        )

        XCTAssertTrue(visible.contains(where: { $0.id == "state-0" }))
        XCTAssertLessThan(visible.count, 10)
        XCTAssertTrue(transitionCandidates.contains(where: { $0.id == "transition-0" }))
        XCTAssertLessThan(transitionCandidates.count, 10)
    }

    func testMovedNodeAndAdjacentTransitionSupplementTheStaticIndex() throws {
        let states = [
            Self.positionedState(id: "source", column: 100, row: 0),
            Self.positionedState(id: "target", column: 101, row: 0),
        ]
        let transition = CanvasTransitionSummary(
            transitionID: "source-target",
            sourceStateID: "source",
            targetStateID: "target",
            occurrenceCount: 1
        )
        let graph = Self.graph(states: states, transitions: [transition])
        let index = Self.index(graph: graph, states: states)
        let viewportSize = CGSize(width: 1_000, height: 600)
        let viewportOffset = CGSize(width: -500, height: -500)
        let targetBaseCenter = try XCTUnwrap(
            index.logicalCenter(for: "target", nodeOffsets: [:])
        )
        let targetDesiredCenter = CGPoint(x: 1_100, y: 664)
        let offsets = [
            "target": CGSize(
                width: targetDesiredCenter.x - targetBaseCenter.x,
                height: targetDesiredCenter.y - targetBaseCenter.y
            ),
        ]

        let visible = index.visibleStates(
            viewportSize: viewportSize,
            zoom: 1,
            viewportOffset: viewportOffset,
            cardSize: CGSize(width: 200, height: 128),
            displayScale: 2,
            nodeOffsets: offsets,
            pinnedStateIDs: []
        )
        let transitions = index.transitionCandidates(
            viewportSize: viewportSize,
            zoom: 1,
            viewportOffset: viewportOffset,
            movedStateIDs: offsets.keys
        )
        let projected = index.projectedCenters(
            for: ["source", "target"],
            zoom: 1,
            viewportOffset: viewportOffset,
            displayScale: 2,
            nodeOffsets: offsets
        )

        XCTAssertTrue(visible.contains(where: { $0.id == "target" }))
        XCTAssertEqual(transitions.map(\.id), ["source-target"])
        XCTAssertEqual(projected["target"], CGPoint(x: 600, y: 164))
    }

    func testTransitionCrossingViewportRemainsAQueryCandidate() {
        let states = [
            Self.positionedState(id: "left", column: 0, row: 0),
            Self.positionedState(id: "right", column: 20, row: 0),
        ]
        let transition = CanvasTransitionSummary(
            transitionID: "crossing",
            sourceStateID: "left",
            targetStateID: "right",
            occurrenceCount: 1
        )
        let graph = Self.graph(states: states, transitions: [transition])
        let index = Self.index(graph: graph, states: states)
        let offsets: [String: CGSize] = [:]

        let candidates = index.transitionCandidates(
            viewportSize: CGSize(width: 800, height: 400),
            zoom: 1,
            viewportOffset: CGSize(width: -2_200, height: -500),
            movedStateIDs: offsets.keys
        )

        XCTAssertEqual(candidates.map(\.id), ["crossing"])
    }

    private static func positionedState(
        id: String,
        column: Int,
        row: Int
    ) -> CanvasLayout.PositionedState {
        CanvasLayout.PositionedState(
            state: CanvasStateSummary(
                screenStateID: id,
                title: id,
                kind: "screen",
                status: "active"
            ),
            column: column,
            row: row
        )
    }

    private static func graph(
        states: [CanvasLayout.PositionedState],
        transitions: [CanvasTransitionSummary]
    ) -> CanvasGraph {
        CanvasGraph(
            screenGraphID: "graph-spatial-index",
            revision: 7,
            entryStateIDs: states.first.map { [$0.id] } ?? [],
            states: states.map(\.state),
            transitions: transitions
        )
    }

    private static func index(
        graph: CanvasGraph,
        states: [CanvasLayout.PositionedState]
    ) -> CanvasGraphSpatialIndex {
        CanvasGraphSpatialIndex(
            key: CanvasGraphSpatialIndexKey(graph: graph),
            states: states,
            entryStateIDs: graph.entryStateIDs,
            transitions: graph.transitions,
            originInset: 600
        )
    }
}
