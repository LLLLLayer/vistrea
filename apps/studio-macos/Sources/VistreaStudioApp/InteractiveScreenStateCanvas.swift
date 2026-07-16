import AppKit
import SwiftUI
import VistreaStudioCore

/// A local presentation surface over the materialized Screen Graph. Panning,
/// zooming, and node offsets are intentionally session UI state: moving a
/// card never rewrites Screen State identity or persisted graph evidence.
struct InteractiveScreenStateCanvas: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @Environment(\.displayScale) private var displayScale

    @State private var viewportOffset = CGSize.zero
    @State private var zoom: CGFloat = 1
    @State private var panOrigin: CGSize?
    @State private var nodeOffsets: [String: CGSize] = [:]
    @State private var draggingNodeID: String?
    @State private var nodeDragOrigin = CGSize.zero
    @State private var selectedRouteIndex = 0
    @State private var didFitInitialGraph = false
    @State private var hoveredNodeID: String?

    private static let minimumZoom: CGFloat = 0.45
    private static let maximumZoom: CGFloat = 1.8
    private static let overflowInset: CGFloat = 600
    private static let fitPadding: CGFloat = 52

    private var graph: CanvasGraph {
        // This view is rendered only for CanvasPhase.content. Keep a defensive
        // empty graph so the View remains total during asynchronous refreshes.
        model.canvasGraph ?? CanvasGraph(
            screenGraphID: "graph_unavailable",
            entryStateIDs: [],
            states: [],
            transitions: []
        )
    }

    private var entryStateIDs: Set<String> {
        Set(graph.entryStateIDs)
    }

    private var selectedRoutes: [CanvasRoute] {
        guard let targetStateID = model.selectedCanvasStateID else { return [] }
        return CanvasPathPlanner.paths(to: targetStateID, in: graph)
    }

    private var selectedRoute: CanvasRoute? {
        guard !selectedRoutes.isEmpty else { return nil }
        return selectedRoutes[min(selectedRouteIndex, selectedRoutes.count - 1)]
    }

    private var routeStateIDs: Set<String> {
        Set(selectedRoute?.stateIDs ?? [])
    }

    private var routeTransitionIDs: Set<String> {
        Set(selectedRoute?.transitionIDs ?? [])
    }

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { proxy in
                ZStack(alignment: .topLeading) {
                    CanvasGrid()
                        .contentShape(Rectangle())
                        .gesture(panGesture)

                    graphContent(in: proxy.size)
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                .overlay(alignment: .topTrailing) {
                    viewportControls(in: proxy.size)
                }
                .clipped()
                .background(Color(nsColor: .textBackgroundColor))
                .background {
                    CanvasTrackpadInputBridge(
                        onScroll: { delta in
                            viewportOffset = CGSize(
                                width: viewportOffset.width + delta.width,
                                height: viewportOffset.height + delta.height
                            )
                        },
                        onMagnify: { magnification, anchor in
                            let targetZoom = clampedZoom(zoom * (1 + magnification))
                            applyZoom(targetZoom, around: anchor)
                        }
                    )
                }
                .onAppear {
                    fitInitialGraphIfReady(in: proxy.size)
                }
                .onChange(of: proxy.size) { _, size in
                    fitInitialGraphIfReady(in: size)
                }
                .onChange(of: model.selectedCanvasStateID) { _, _ in
                    selectedRouteIndex = 0
                }
            }
            .frame(minHeight: 260)

            Divider()
            pathSelectionBar
        }
    }

    private func graphContent(in viewportSize: CGSize) -> some View {
        let centers = projectedStateCenters
        let metrics = CanvasCardRenderMetrics(zoom: zoom)
        return ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                drawTransitions(
                    context: &context,
                    centers: centers,
                    cardSize: metrics.size
                )
            }
            .allowsHitTesting(false)

            ForEach(model.canvasStates) { positioned in
                let stateID = positioned.id
                let isSelected = stateID == model.selectedCanvasStateID
                let isOnRoute = routeStateIDs.contains(stateID)
                let hasSelectedRoute = selectedRoute != nil
                CanvasStateCard(
                    state: positioned.state,
                    isEntry: entryStateIDs.contains(stateID),
                    isSelected: isSelected,
                    isOnRoute: isOnRoute,
                    isDimmed: hasSelectedRoute && !isOnRoute,
                    isMergeSelected: model.mergeSelectionStateIDs.contains(stateID),
                    isLinked: isSelected && !model.relatedWikiNodes.isEmpty,
                    isHovered: hoveredNodeID == stateID,
                    isDragging: draggingNodeID == stateID,
                    metrics: metrics
                )
                .position(centers[stateID] ?? .zero)
                .onHover { isHovering in
                    hoveredNodeID = isHovering ? stateID : nil
                }
                .highPriorityGesture(
                    TapGesture().modifiers(.command).onEnded {
                        model.toggleMergeSelection(stateID: stateID)
                    }
                )
                .simultaneousGesture(nodeDragGesture(for: stateID))
                .onTapGesture {
                    selectedRouteIndex = 0
                    Task { await model.selectCanvasState(id: stateID) }
                }
                .accessibilityLabel(
                    "Screen state \(CanvasStatePresentation.displayTitle(for: positioned.state)), "
                        + positioned.state.status
                )
                .accessibilityHint("Select to inspect and show entry paths. Command-select to merge.")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction {
                    selectedRouteIndex = 0
                    Task { await model.selectCanvasState(id: stateID) }
                }
            }
        }
        .frame(width: viewportSize.width, height: viewportSize.height, alignment: .topLeading)
    }

    private var stateCenters: [String: CGPoint] {
        Dictionary(uniqueKeysWithValues: model.canvasStates.map { positioned in
            let offset = nodeOffsets[positioned.id] ?? .zero
            return (
                positioned.id,
                CGPoint(
                    x: Self.overflowInset
                        + CGFloat(positioned.column) * StudioLayoutMetrics.canvasColumnWidth
                        + StudioLayoutMetrics.canvasCardWidth / 2
                        + offset.width,
                    y: Self.overflowInset
                        + CGFloat(positioned.row) * StudioLayoutMetrics.canvasRowHeight
                        + StudioLayoutMetrics.canvasCardHeight / 2
                        + offset.height
                )
            )
        })
    }

    private var projectedStateCenters: [String: CGPoint] {
        Dictionary(uniqueKeysWithValues: stateCenters.map { stateID, logicalPoint in
            (
                stateID,
                CanvasViewportProjection.point(
                    logicalPoint,
                    zoom: zoom,
                    offset: viewportOffset,
                    displayScale: displayScale
                )
            )
        })
    }

    private var graphDrawingBounds: CGRect {
        let halfWidth = StudioLayoutMetrics.canvasCardWidth / 2
        let halfHeight = StudioLayoutMetrics.canvasCardHeight / 2
        return stateCenters.values.reduce(CGRect.null) { bounds, center in
            bounds.union(
                CGRect(
                    x: center.x - halfWidth,
                    y: center.y - halfHeight,
                    width: StudioLayoutMetrics.canvasCardWidth,
                    height: StudioLayoutMetrics.canvasCardHeight
                )
            )
        }
    }

    private var panGesture: some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                let origin = panOrigin ?? viewportOffset
                if panOrigin == nil { panOrigin = origin }
                viewportOffset = CGSize(
                    width: origin.width + value.translation.width,
                    height: origin.height + value.translation.height
                )
            }
            .onEnded { _ in panOrigin = nil }
    }

    private func nodeDragGesture(for stateID: String) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                if draggingNodeID != stateID {
                    draggingNodeID = stateID
                    nodeDragOrigin = nodeOffsets[stateID] ?? .zero
                }
                nodeOffsets[stateID] = CGSize(
                    width: nodeDragOrigin.width + value.translation.width / zoom,
                    height: nodeDragOrigin.height + value.translation.height / zoom
                )
            }
            .onEnded { _ in
                draggingNodeID = nil
                nodeDragOrigin = .zero
            }
    }

    @ViewBuilder
    private func viewportControls(in viewportSize: CGSize) -> some View {
        HStack(spacing: 5) {
            Button {
                applyZoom(
                    clampedZoom(zoom - 0.1),
                    around: CGPoint(x: viewportSize.width / 2, y: viewportSize.height / 2)
                )
            } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            .help("Zoom out")

            Text("\(Int((zoom * 100).rounded()))%")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 42)

            Button {
                applyZoom(
                    clampedZoom(zoom + 0.1),
                    around: CGPoint(x: viewportSize.width / 2, y: viewportSize.height / 2)
                )
            } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            .help("Zoom in")

            Divider().frame(height: 16)

            Button {
                nodeOffsets.removeAll()
                fitGraph(in: viewportSize)
            } label: {
                Label("Fit", systemImage: "arrow.up.left.and.arrow.down.right")
            }
            .help("Reset node positions and fit the graph")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
        .padding(12)
    }

    @ViewBuilder
    private var pathSelectionBar: some View {
        if let targetStateID = model.selectedCanvasStateID,
           let target = graph.states.first(where: { $0.id == targetStateID }) {
            HStack(spacing: 10) {
                Label("Path to \(CanvasStatePresentation.displayTitle(for: target))", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)

                if selectedRoutes.isEmpty {
                    Text("No entry path is recorded in this build.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    routeMenu
                    Divider().frame(height: 16)
                    routeBreadcrumb
                }

                Spacer(minLength: 0)
                Button {
                    Task { await model.selectCanvasState(id: nil) }
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Clear the selected path")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(nsColor: .controlBackgroundColor))
        } else {
            HStack(spacing: 8) {
                Image(systemName: "cursorarrow.motionlines")
                Text("Two-finger scroll to pan, pinch to zoom, drag cards to arrange, and select a state to reveal its entry paths.")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
        }
    }

    private var routeMenu: some View {
        Menu {
            ForEach(Array(selectedRoutes.enumerated()), id: \.element.id) { index, route in
                Button {
                    selectedRouteIndex = index
                } label: {
                    if index == min(selectedRouteIndex, selectedRoutes.count - 1) {
                        Label(routeDescription(route, index: index), systemImage: "checkmark")
                    } else {
                        Text(routeDescription(route, index: index))
                    }
                }
            }
        } label: {
            Text("Route \(min(selectedRouteIndex, selectedRoutes.count - 1) + 1) of \(selectedRoutes.count)")
                .font(.caption.monospacedDigit())
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var routeBreadcrumb: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                if let route = selectedRoute {
                    ForEach(Array(route.stateIDs.enumerated()), id: \.element) { index, stateID in
                        if index > 0 {
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        Text(displayTitle(for: stateID))
                            .font(.caption)
                            .lineLimit(1)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(
                                Capsule().fill(
                                    stateID == route.targetStateID
                                        ? Color.accentColor.opacity(0.16)
                                        : Color.primary.opacity(0.06)
                                )
                            )
                    }
                }
            }
        }
        .frame(maxWidth: 520, alignment: .leading)
    }

    private func routeDescription(_ route: CanvasRoute, index: Int) -> String {
        let stepCount = route.transitionIDs.count
        return "Route \(index + 1) · \(stepCount) step\(stepCount == 1 ? "" : "s") · \(displayTitle(for: route.entryStateID))"
    }

    private func displayTitle(for stateID: String) -> String {
        guard let state = graph.states.first(where: { $0.id == stateID }) else { return stateID }
        return CanvasStatePresentation.displayTitle(for: state)
    }

    private func fitGraph(in viewportSize: CGSize) {
        let fit = CanvasViewportProjection.fit(
            bounds: graphDrawingBounds,
            viewportSize: viewportSize,
            padding: Self.fitPadding,
            minimumZoom: Self.minimumZoom,
            maximumZoom: 1,
            displayScale: displayScale
        )
        zoom = fit.zoom
        viewportOffset = fit.offset
    }

    private func fitInitialGraphIfReady(in viewportSize: CGSize) {
        guard !didFitInitialGraph,
              viewportSize.width >= 320,
              viewportSize.height >= 240
        else {
            return
        }
        didFitInitialGraph = true
        fitGraph(in: viewportSize)
    }

    private func clampedZoom(_ value: CGFloat) -> CGFloat {
        min(max(value, Self.minimumZoom), Self.maximumZoom)
    }

    private func applyZoom(_ targetZoom: CGFloat, around anchor: CGPoint) {
        let viewport = CanvasViewportProjection.zoom(
            from: zoom,
            to: targetZoom,
            offset: viewportOffset,
            anchor: anchor,
            displayScale: displayScale
        )
        zoom = viewport.zoom
        viewportOffset = viewport.offset
    }

    private func drawTransitions(
        context: inout GraphicsContext,
        centers: [String: CGPoint],
        cardSize: CGSize
    ) {
        for transition in graph.transitions {
            guard let sourceCenter = centers[transition.sourceStateID],
                  let targetCenter = centers[transition.targetStateID],
                  transition.sourceStateID != transition.targetStateID
            else {
                continue
            }
            let isOnRoute = routeTransitionIDs.contains(transition.id)
            let isDimmed = selectedRoute != nil && !isOnRoute
            let color = isOnRoute
                ? Color.accentColor
                : Color.secondary.opacity(isDimmed ? 0.18 : 0.42)
            let lineWidth: CGFloat = isOnRoute ? 3 : 1.25
            drawTransition(
                context: &context,
                source: sourceCenter,
                target: targetCenter,
                cardSize: cardSize,
                color: color,
                lineWidth: lineWidth
            )
        }
    }

    private func drawTransition(
        context: inout GraphicsContext,
        source: CGPoint,
        target: CGPoint,
        cardSize: CGSize,
        color: Color,
        lineWidth: CGFloat
    ) {
        let endpoints = cardEdgeEndpoints(
            source: source,
            target: target,
            cardSize: cardSize
        )
        let deltaX = endpoints.end.x - endpoints.start.x
        let deltaY = endpoints.end.y - endpoints.start.y
        let control1: CGPoint
        let control2: CGPoint
        if abs(deltaX) >= abs(deltaY) {
            let bend = max(abs(deltaX) * 0.46, 44)
            let direction: CGFloat = deltaX >= 0 ? 1 : -1
            control1 = CGPoint(x: endpoints.start.x + bend * direction, y: endpoints.start.y)
            control2 = CGPoint(x: endpoints.end.x - bend * direction, y: endpoints.end.y)
        } else {
            let bend = max(abs(deltaY) * 0.46, 44)
            let direction: CGFloat = deltaY >= 0 ? 1 : -1
            control1 = CGPoint(x: endpoints.start.x, y: endpoints.start.y + bend * direction)
            control2 = CGPoint(x: endpoints.end.x, y: endpoints.end.y - bend * direction)
        }

        var path = Path()
        path.move(to: endpoints.start)
        path.addCurve(to: endpoints.end, control1: control1, control2: control2)
        context.stroke(path, with: .color(color), lineWidth: lineWidth)
        drawArrowhead(context: &context, tip: endpoints.end, tangentFrom: control2, color: color)
    }

    private func cardEdgeEndpoints(
        source: CGPoint,
        target: CGPoint,
        cardSize: CGSize
    ) -> (start: CGPoint, end: CGPoint) {
        let delta = CGVector(dx: target.x - source.x, dy: target.y - source.y)
        let halfWidth = cardSize.width / 2
        let halfHeight = cardSize.height / 2

        func intersectionDistance(dx: CGFloat, dy: CGFloat) -> CGFloat {
            let horizontal = abs(dx) > 0.001 ? halfWidth / abs(dx) : .greatestFiniteMagnitude
            let vertical = abs(dy) > 0.001 ? halfHeight / abs(dy) : .greatestFiniteMagnitude
            return min(horizontal, vertical)
        }

        let sourceDistance = intersectionDistance(dx: delta.dx, dy: delta.dy)
        let targetDistance = intersectionDistance(dx: -delta.dx, dy: -delta.dy)
        return (
            CGPoint(
                x: source.x + delta.dx * sourceDistance,
                y: source.y + delta.dy * sourceDistance
            ),
            CGPoint(
                x: target.x - delta.dx * targetDistance,
                y: target.y - delta.dy * targetDistance
            )
        )
    }

    private func drawArrowhead(
        context: inout GraphicsContext,
        tip: CGPoint,
        tangentFrom: CGPoint,
        color: Color
    ) {
        let angle = atan2(tip.y - tangentFrom.y, tip.x - tangentFrom.x)
        let length: CGFloat = 9
        let spread: CGFloat = .pi / 7
        var arrow = Path()
        arrow.move(to: tip)
        arrow.addLine(
            to: CGPoint(
                x: tip.x - length * cos(angle - spread),
                y: tip.y - length * sin(angle - spread)
            )
        )
        arrow.addLine(
            to: CGPoint(
                x: tip.x - length * cos(angle + spread),
                y: tip.y - length * sin(angle + spread)
            )
        )
        arrow.closeSubpath()
        context.fill(arrow, with: .color(color))
    }
}

/// A transparent AppKit event bridge for native macOS trackpad navigation.
/// It observes only events inside its Canvas bounds and never participates in
/// hit testing, so card selection and mouse dragging remain SwiftUI-owned.
private struct CanvasTrackpadInputBridge: NSViewRepresentable {
    let onScroll: (CGSize) -> Void
    let onMagnify: (CGFloat, CGPoint) -> Void

    func makeNSView(context: Context) -> CanvasTrackpadTrackingView {
        let view = CanvasTrackpadTrackingView()
        view.onScroll = onScroll
        view.onMagnify = onMagnify
        return view
    }

    func updateNSView(_ nsView: CanvasTrackpadTrackingView, context: Context) {
        nsView.onScroll = onScroll
        nsView.onMagnify = onMagnify
    }

    static func dismantleNSView(_ nsView: CanvasTrackpadTrackingView, coordinator: ()) {
        nsView.stopMonitoring()
    }
}

@MainActor
private final class CanvasTrackpadTrackingView: NSView {
    var onScroll: (CGSize) -> Void = { _ in }
    var onMagnify: (CGFloat, CGPoint) -> Void = { _, _ in }

    private var eventMonitor: Any?

    override var isFlipped: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            stopMonitoring()
        } else {
            startMonitoringIfNeeded()
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    func stopMonitoring() {
        guard let eventMonitor else { return }
        NSEvent.removeMonitor(eventMonitor)
        self.eventMonitor = nil
    }

    private func startMonitoringIfNeeded() {
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.scrollWheel, .magnify]
        ) { [weak self] event in
            guard let self,
                  let window = self.window,
                  event.window === window
            else {
                return event
            }

            let location = self.convert(event.locationInWindow, from: nil)
            guard self.bounds.contains(location) else { return event }

            switch event.type {
            case .scrollWheel:
                // Precise deltas already include the user's macOS scrolling
                // direction preference and naturally carry momentum phases.
                let multiplier: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 12
                self.onScroll(
                    CGSize(
                        width: event.scrollingDeltaX * multiplier,
                        height: event.scrollingDeltaY * multiplier
                    )
                )
                return nil
            case .magnify:
                self.onMagnify(event.magnification, location)
                return nil
            default:
                return event
            }
        }
    }
}

private struct CanvasGrid: View {
    var body: some View {
        Canvas { context, size in
            let spacing: CGFloat = 24
            var dots = Path()
            var x: CGFloat = spacing
            while x < size.width {
                var y: CGFloat = spacing
                while y < size.height {
                    dots.addEllipse(in: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5))
                    y += spacing
                }
                x += spacing
            }
            context.fill(dots, with: .color(Color.secondary.opacity(0.18)))
        }
    }
}

private enum CanvasCardDetailLevel {
    case full
    case compact
    case overview
}

private struct CanvasCardRenderMetrics {
    let zoom: CGFloat

    var size: CGSize {
        CGSize(
            width: StudioLayoutMetrics.canvasCardWidth * zoom,
            height: StudioLayoutMetrics.canvasCardHeight * zoom
        )
    }

    var detailLevel: CanvasCardDetailLevel {
        if zoom >= 0.86 { return .full }
        if zoom >= 0.6 { return .compact }
        return .overview
    }

    var padding: CGFloat { max(5, 12 * zoom) }
    var contentSpacing: CGFloat { max(3, 9 * zoom) }
    var headerSpacing: CGFloat { max(4, 8 * zoom) }
    var iconSize: CGFloat { max(13, 28 * zoom) }
    var iconCornerRadius: CGFloat { max(4, 7 * zoom) }
    var titleFontSize: CGFloat { max(detailLevel == .overview ? 9.5 : 10, 13 * zoom) }
    var kindFontSize: CGFloat { max(8, 10 * zoom) }
    var summaryFontSize: CGFloat { max(8.5, 11 * zoom) }
    var tagFontSize: CGFloat { max(8, 10 * zoom) }
    var tagHorizontalPadding: CGFloat { max(4, 7 * zoom) }
    var tagVerticalPadding: CGFloat { max(1.5, 3 * zoom) }
    var cornerRadius: CGFloat { max(7, 14 * zoom) }
    var topAccentHeight: CGFloat { max(2, 3 * zoom) }
    var topAccentInset: CGFloat { max(7, 14 * zoom) }
}

private struct CanvasStateCard: View {
    let state: CanvasStateSummary
    let isEntry: Bool
    let isSelected: Bool
    let isOnRoute: Bool
    let isDimmed: Bool
    let isMergeSelected: Bool
    let isLinked: Bool
    let isHovered: Bool
    let isDragging: Bool
    let metrics: CanvasCardRenderMetrics

    private var tint: Color {
        if isMergeSelected { return .orange }
        if isSelected || isOnRoute { return .accentColor }
        if isEntry { return .cyan }
        return .secondary
    }

    private var borderWidth: CGFloat {
        isSelected ? 2.5 : isMergeSelected || isOnRoute || isEntry ? 1.5 : 0.8
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.contentSpacing) {
            cardHeader

            if metrics.detailLevel != .overview {
                summaryText
            }

            Spacer(minLength: 0)
            cardFooter
        }
        .padding(metrics.padding)
        .frame(
            width: metrics.size.width,
            height: metrics.size.height,
            alignment: .topLeading
        )
        .background(
            RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor).opacity(0.98))
        )
        .overlay(alignment: .top) {
            RoundedRectangle(cornerRadius: 2)
                .fill(tint.opacity(isSelected || isOnRoute ? 0.9 : 0.42))
                .frame(height: metrics.topAccentHeight)
                .padding(.horizontal, metrics.topAccentInset)
        }
        .overlay(
            RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .continuous)
                .stroke(tint.opacity(isSelected || isMergeSelected ? 0.95 : 0.5), lineWidth: borderWidth)
        )
        .shadow(
            color: tint.opacity(isDragging ? 0.22 : isSelected || isHovered ? 0.13 : 0.06),
            radius: isDragging ? 18 : isSelected || isHovered ? 12 : 5,
            y: isDragging ? 8 : 3
        )
        .opacity(state.isActive ? (isDimmed ? 0.3 : 1) : 0.38)
        .contentShape(RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .continuous))
        .help(
            "\(state.title)\nDrag to arrange. Click to inspect and reveal paths. Command-click to select for merging."
        )
    }

    private var cardHeader: some View {
        HStack(alignment: .top, spacing: metrics.headerSpacing) {
            ZStack {
                RoundedRectangle(cornerRadius: metrics.iconCornerRadius)
                    .fill(tint.opacity(0.13))
                Image(systemName: isEntry ? "arrow.right.to.line.compact" : "rectangle.on.rectangle")
                    .font(.system(size: max(8, metrics.titleFontSize * 0.86), weight: .semibold))
                    .foregroundStyle(tint)
            }
            .frame(width: metrics.iconSize, height: metrics.iconSize)

            VStack(alignment: .leading, spacing: max(1, 2 * metrics.zoom)) {
                Text(CanvasStatePresentation.displayTitle(for: state))
                    .font(.system(size: metrics.titleFontSize, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if metrics.detailLevel != .overview {
                    Text(state.kind.uppercased())
                        .font(.system(size: metrics.kindFontSize, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .tracking(max(0.3, 0.6 * metrics.zoom))
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 2)
        }
    }

    @ViewBuilder
    private var summaryText: some View {
        if let summary = state.summary, !summary.isEmpty {
            Text(summary)
                .font(.system(size: metrics.summaryFontSize))
                .foregroundStyle(.secondary)
                .lineLimit(metrics.detailLevel == .full ? 2 : 1)
                .truncationMode(.tail)
        } else {
            Text(state.title)
                .font(.system(size: metrics.summaryFontSize))
                .foregroundStyle(.tertiary)
                .lineLimit(metrics.detailLevel == .full ? 2 : 1)
                .truncationMode(.middle)
        }
    }

    private var cardFooter: some View {
        HStack(spacing: max(3, 5 * metrics.zoom)) {
            if metrics.detailLevel == .full {
                ForEach(nonEntryLabels.prefix(2), id: \.self) { label in
                    Text(label.replacingOccurrences(of: "-", with: " "))
                        .font(.system(size: metrics.tagFontSize, weight: .medium))
                        .lineLimit(1)
                        .padding(.horizontal, metrics.tagHorizontalPadding)
                        .padding(.vertical, metrics.tagVerticalPadding)
                        .background(Capsule().fill(Color.primary.opacity(0.055)))
                }
                if nonEntryLabels.count > 2 {
                    Text("+\(nonEntryLabels.count - 2)")
                        .font(.system(size: metrics.tagFontSize))
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
            if isLinked {
                Image(systemName: "book.closed.fill")
                    .foregroundStyle(.purple)
            }
            if isOnRoute {
                Image(systemName: "point.topleft.down.to.point.bottomright.curvepath")
                    .foregroundStyle(Color.accentColor)
            }
            if isMergeSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.orange)
            }
        }
        .font(.system(size: metrics.tagFontSize))
    }

    private var nonEntryLabels: [String] {
        state.labels.filter { $0 != "entry" }
    }
}
