import CoreGraphics
import VistreaStudioCore

/// The stable identity of one materialized Canvas projection. The graph
/// revision is authoritative; scope and counts keep build-scoped projections
/// distinct without comparing every state during viewport interaction.
struct CanvasGraphSpatialIndexKey: Equatable {
    let screenGraphID: String
    let revision: UInt64
    let applicationVersion: String?
    let buildID: String?
    let stateCount: Int
    let transitionCount: Int

    init(graph: CanvasGraph) {
        screenGraphID = graph.screenGraphID
        revision = graph.revision
        applicationVersion = graph.buildScope?.applicationVersion
        buildID = graph.buildScope?.buildID
        stateCount = graph.states.count
        transitionCount = graph.transitions.count
    }
}

/// A graph-revision-scoped spatial index for Canvas interaction. Static node
/// positions and edge bounds live in balanced AABB trees. Session-only node
/// offsets are intentionally not baked in: moved nodes and their adjacent
/// transitions form a small dynamic supplement to each viewport query.
struct CanvasGraphSpatialIndex {
    let key: CanvasGraphSpatialIndexKey
    let baseDrawingBounds: CGRect

    private let statesByID: [String: CanvasLayout.PositionedState]
    private let entryStateIDs: Set<String>
    private let stateOrderByID: [String: Int]
    private let baseCenters: [String: CGPoint]
    private let transitionsByID: [String: CanvasTransitionSummary]
    private let transitionOrderByID: [String: Int]
    private let transitionIDsByStateID: [String: [String]]
    private let stateTree: CanvasAABBTree
    private let transitionTree: CanvasAABBTree

    init(
        key: CanvasGraphSpatialIndexKey,
        states: [CanvasLayout.PositionedState],
        entryStateIDs: [String],
        transitions: [CanvasTransitionSummary],
        originInset: CGFloat
    ) {
        self.key = key

        var indexedStates: [String: CanvasLayout.PositionedState] = [:]
        var indexedStateOrder: [String: Int] = [:]
        var centers: [String: CGPoint] = [:]
        var stateItems: [CanvasAABBTree.Item] = []
        var drawingBounds = CGRect.null

        for (index, positioned) in states.enumerated() {
            let center = CGPoint(
                x: originInset
                    + CGFloat(positioned.column) * StudioLayoutMetrics.canvasColumnWidth
                    + StudioLayoutMetrics.canvasCardWidth / 2,
                y: originInset
                    + CGFloat(positioned.row) * StudioLayoutMetrics.canvasRowHeight
                    + StudioLayoutMetrics.canvasCardHeight / 2
            )
            let cardBounds = CGRect(
                x: center.x - StudioLayoutMetrics.canvasCardWidth / 2,
                y: center.y - StudioLayoutMetrics.canvasCardHeight / 2,
                width: StudioLayoutMetrics.canvasCardWidth,
                height: StudioLayoutMetrics.canvasCardHeight
            )
            indexedStates[positioned.id] = positioned
            indexedStateOrder[positioned.id] = index
            centers[positioned.id] = center
            stateItems.append(
                CanvasAABBTree.Item(
                    id: positioned.id,
                    bounds: CGRect(x: center.x - 0.5, y: center.y - 0.5, width: 1, height: 1)
                )
            )
            drawingBounds = drawingBounds.union(cardBounds)
        }

        var indexedTransitions: [String: CanvasTransitionSummary] = [:]
        var indexedTransitionOrder: [String: Int] = [:]
        var adjacentTransitionIDs: [String: [String]] = [:]
        var transitionItems: [CanvasAABBTree.Item] = []
        for (index, transition) in transitions.enumerated() {
            guard transition.sourceStateID != transition.targetStateID,
                  let source = centers[transition.sourceStateID],
                  let target = centers[transition.targetStateID]
            else {
                continue
            }
            indexedTransitions[transition.id] = transition
            indexedTransitionOrder[transition.id] = index
            adjacentTransitionIDs[transition.sourceStateID, default: []].append(transition.id)
            adjacentTransitionIDs[transition.targetStateID, default: []].append(transition.id)
            transitionItems.append(
                CanvasAABBTree.Item(
                    id: transition.id,
                    bounds: Self.segmentBounds(source: source, target: target)
                )
            )
        }

        statesByID = indexedStates
        self.entryStateIDs = Set(entryStateIDs)
        stateOrderByID = indexedStateOrder
        baseCenters = centers
        transitionsByID = indexedTransitions
        transitionOrderByID = indexedTransitionOrder
        transitionIDsByStateID = adjacentTransitionIDs
        stateTree = CanvasAABBTree(items: stateItems)
        transitionTree = CanvasAABBTree(items: transitionItems)
        baseDrawingBounds = drawingBounds
    }

    func state(id: String) -> CanvasLayout.PositionedState? {
        statesByID[id]
    }

    func isEntryState(id: String) -> Bool {
        entryStateIDs.contains(id)
    }

    func logicalCenter(
        for stateID: String,
        nodeOffsets: [String: CGSize]
    ) -> CGPoint? {
        guard let baseCenter = baseCenters[stateID] else { return nil }
        let offset = nodeOffsets[stateID] ?? .zero
        return CGPoint(x: baseCenter.x + offset.width, y: baseCenter.y + offset.height)
    }

    func visibleStates(
        viewportSize: CGSize,
        zoom: CGFloat,
        viewportOffset: CGSize,
        cardSize: CGSize,
        displayScale: CGFloat,
        nodeOffsets: [String: CGSize],
        pinnedStateIDs: Set<String>,
        overscan: CGFloat = 120
    ) -> [CanvasLayout.PositionedState] {
        guard let logicalBounds = Self.logicalViewportBounds(
            viewportSize: viewportSize,
            zoom: zoom,
            viewportOffset: viewportOffset,
            screenExpansionX: cardSize.width / 2 + overscan + 1,
            screenExpansionY: cardSize.height / 2 + overscan + 1
        ) else {
            return pinnedStateIDs.compactMap { statesByID[$0] }
        }

        var candidateIDs = Set(stateTree.query(intersecting: logicalBounds))
        candidateIDs.formUnion(nodeOffsets.keys)
        candidateIDs.formUnion(pinnedStateIDs)

        let renderBounds = CGRect(origin: .zero, size: viewportSize)
            .insetBy(
                dx: -(cardSize.width / 2 + overscan + 1),
                dy: -(cardSize.height / 2 + overscan + 1)
            )
        return candidateIDs.compactMap { stateID -> CanvasLayout.PositionedState? in
            guard let state = statesByID[stateID],
                  let logicalCenter = logicalCenter(for: stateID, nodeOffsets: nodeOffsets)
            else {
                return nil
            }
            if pinnedStateIDs.contains(stateID) {
                return state
            }
            let projected = CanvasViewportProjection.point(
                logicalCenter,
                zoom: zoom,
                offset: viewportOffset,
                displayScale: displayScale
            )
            return renderBounds.contains(projected) ? state : nil
        }
        .sorted {
            stateOrderByID[$0.id, default: .max] < stateOrderByID[$1.id, default: .max]
        }
    }

    func transitionCandidates(
        viewportSize: CGSize,
        zoom: CGFloat,
        viewportOffset: CGSize,
        movedStateIDs: Dictionary<String, CGSize>.Keys,
        overscan: CGFloat = 120
    ) -> [CanvasTransitionSummary] {
        guard let logicalBounds = Self.logicalViewportBounds(
            viewportSize: viewportSize,
            zoom: zoom,
            viewportOffset: viewportOffset,
            screenExpansionX: overscan + 1,
            screenExpansionY: overscan + 1
        ) else {
            return []
        }

        var candidateIDs = Set(transitionTree.query(intersecting: logicalBounds))
        for stateID in movedStateIDs {
            candidateIDs.formUnion(transitionIDsByStateID[stateID] ?? [])
        }
        return candidateIDs.compactMap { transitionsByID[$0] }
            .sorted {
                transitionOrderByID[$0.id, default: .max]
                    < transitionOrderByID[$1.id, default: .max]
            }
    }

    func projectedCenters(
        for stateIDs: Set<String>,
        zoom: CGFloat,
        viewportOffset: CGSize,
        displayScale: CGFloat,
        nodeOffsets: [String: CGSize]
    ) -> [String: CGPoint] {
        var result: [String: CGPoint] = [:]
        result.reserveCapacity(stateIDs.count)
        for stateID in stateIDs {
            guard let center = logicalCenter(for: stateID, nodeOffsets: nodeOffsets) else {
                continue
            }
            result[stateID] = CanvasViewportProjection.point(
                center,
                zoom: zoom,
                offset: viewportOffset,
                displayScale: displayScale
            )
        }
        return result
    }

    private static func logicalViewportBounds(
        viewportSize: CGSize,
        zoom: CGFloat,
        viewportOffset: CGSize,
        screenExpansionX: CGFloat,
        screenExpansionY: CGFloat
    ) -> CGRect? {
        guard viewportSize.width > 0, viewportSize.height > 0,
              zoom.isFinite, zoom > 0,
              viewportOffset.width.isFinite, viewportOffset.height.isFinite,
              screenExpansionX >= 0, screenExpansionY >= 0
        else {
            return nil
        }
        let minX = (-screenExpansionX - viewportOffset.width) / zoom
        let minY = (-screenExpansionY - viewportOffset.height) / zoom
        let maxX = (viewportSize.width + screenExpansionX - viewportOffset.width) / zoom
        let maxY = (viewportSize.height + screenExpansionY - viewportOffset.height) / zoom
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    private static func segmentBounds(source: CGPoint, target: CGPoint) -> CGRect {
        CGRect(
            x: min(source.x, target.x),
            y: min(source.y, target.y),
            width: max(abs(target.x - source.x), 1),
            height: max(abs(target.y - source.y), 1)
        ).insetBy(dx: -0.5, dy: -0.5)
    }
}

/// Fit may go below the ordinary interactive floor when the graph requires it.
/// The returned floor is exactly low enough for `CanvasViewportProjection.fit`
/// to honor its contract instead of clipping an otherwise valid large graph.
enum CanvasFitZoomPolicy {
    static func minimumZoom(
        bounds: CGRect,
        viewportSize: CGSize,
        padding: CGFloat,
        interactiveMinimum: CGFloat
    ) -> CGFloat {
        guard !bounds.isNull, bounds.width > 0, bounds.height > 0,
              viewportSize.width > padding * 2,
              viewportSize.height > padding * 2,
              interactiveMinimum.isFinite, interactiveMinimum > 0
        else {
            return interactiveMinimum
        }
        let fitted = min(
            (viewportSize.width - padding * 2) / bounds.width,
            (viewportSize.height - padding * 2) / bounds.height
        )
        guard fitted.isFinite, fitted > 0 else { return interactiveMinimum }
        return min(interactiveMinimum, fitted)
    }
}

/// A balanced, immutable bounding-box hierarchy. Query cost follows the
/// intersecting branches rather than the total graph size.
private struct CanvasAABBTree {
    struct Item {
        let id: String
        let bounds: CGRect
    }

    private indirect enum Node {
        case leaf(bounds: CGRect, items: [Item])
        case branch(bounds: CGRect, left: Node, right: Node)

        var bounds: CGRect {
            switch self {
            case let .leaf(bounds, _), let .branch(bounds, _, _):
                bounds
            }
        }
    }

    private let root: Node?
    private static let leafCapacity = 12

    init(items: [Item]) {
        root = Self.build(items)
    }

    func query(intersecting bounds: CGRect) -> [String] {
        guard let root, !bounds.isNull, bounds.width >= 0, bounds.height >= 0 else {
            return []
        }
        var result: [String] = []
        Self.query(node: root, intersecting: bounds, result: &result)
        return result
    }

    private static func build(_ items: [Item]) -> Node? {
        guard let first = items.first else { return nil }
        let bounds = items.dropFirst().reduce(first.bounds) { $0.union($1.bounds) }
        guard items.count > leafCapacity else {
            return .leaf(bounds: bounds, items: items)
        }

        let splitHorizontally = bounds.width >= bounds.height
        let ordered = items.sorted { left, right in
            if splitHorizontally {
                return left.bounds.midX < right.bounds.midX
            }
            return left.bounds.midY < right.bounds.midY
        }
        let midpoint = ordered.count / 2
        guard let left = build(Array(ordered[..<midpoint])),
              let right = build(Array(ordered[midpoint...]))
        else {
            return .leaf(bounds: bounds, items: ordered)
        }
        return .branch(bounds: bounds, left: left, right: right)
    }

    private static func query(
        node: Node,
        intersecting queryBounds: CGRect,
        result: inout [String]
    ) {
        guard node.bounds.intersects(queryBounds) else { return }
        switch node {
        case let .leaf(_, items):
            for item in items where item.bounds.intersects(queryBounds) {
                result.append(item.id)
            }
        case let .branch(_, left, right):
            query(node: left, intersecting: queryBounds, result: &result)
            query(node: right, intersecting: queryBounds, result: &result)
        }
    }
}
