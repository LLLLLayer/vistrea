import Foundation

/// One rectangle in unit coordinates of the screenshot image: `x`, `y`,
/// `width`, and `height` are fractions of the image size, so any fitted
/// on-screen rendering scales them by its own displayed image frame.
public struct UnitRect: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// One difference region resolved onto the target screenshot.
public struct DifferenceRegion: Equatable, Sendable, Identifiable {
    public let differenceID: String
    public let category: String
    public let severity: String
    /// Where the difference actually is on the screenshot.
    public let unitRect: UnitRect
    /// For frame differences: where the design expected the region instead.
    public let expectedUnitRect: UnitRect?

    public var id: String { differenceID }

    public init(
        differenceID: String,
        category: String,
        severity: String,
        unitRect: UnitRect,
        expectedUnitRect: UnitRect? = nil
    ) {
        self.differenceID = differenceID
        self.category = category
        self.severity = severity
        self.unitRect = unitRect
        self.expectedUnitRect = expectedUnitRect
    }
}

/// Where one design reference's logical canvas lands in the screenshot's unit
/// frame — the same frame the difference rectangles use — plus the honest
/// caption to show when the design cannot be laid over the screenshot without
/// distorting it.
public struct DesignOverlayPlacement: Equatable, Sendable {
    /// The design `canvas_size` rect mapped through the screenshot coverage.
    public let unitRect: UnitRect
    /// True when the design asset's own pixel aspect ratio survives the
    /// mapping, so the overlay fills the placement rect exactly.
    public let preservesAspectRatio: Bool
    /// Non-nil when the design cannot be reconciled with the screenshot: the
    /// asset is then aspect-fitted inside the placement rect and this text
    /// explains why, instead of silently stretching the image.
    public let reconciliationCaption: String?

    public init(
        unitRect: UnitRect,
        preservesAspectRatio: Bool,
        reconciliationCaption: String? = nil
    ) {
        self.unitRect = unitRect
        self.preservesAspectRatio = preservesAspectRatio
        self.reconciliationCaption = reconciliationCaption
    }
}

/// Projects canonical DesignDifference values into screenshot-relative
/// regions. Logical points convert through the screenshot's logical
/// coverage rect; the displayed pixel scale never leaks in here because the
/// unit rects are resolution-independent.
public enum DesignOverlayProjection {
    /// The tolerated relative aspect-ratio drift before the overlay stops
    /// claiming a faithful placement.
    private static let aspectTolerance = 0.01

    /// Places the design reference in the screenshot's unit frame. The design
    /// canvas is a logical-point rect anchored at the coverage origin's
    /// coordinate space, so it maps through exactly the same coverage
    /// transform the difference rectangles use: a coverage that is not the
    /// whole canvas offsets and scales the overlay instead of pinning it to
    /// the fitted screenshot rect.
    public static func placement(
        for reference: DesignReferenceDetail,
        screenshot: ScreenshotPresentation?
    ) -> DesignOverlayPlacement? {
        guard let screenshot else {
            return nil
        }
        let coverage = screenshot.coverage
        let canvas = reference.canvasSize
        guard coverage.width > 0, coverage.height > 0, canvas.width > 0, canvas.height > 0 else {
            return nil
        }
        let rect = unitRect(
            x: 0,
            y: 0,
            width: canvas.width,
            height: canvas.height,
            coverage: coverage
        )
        var captions: [String] = []
        // The design declares both a logical canvas and the asset's pixel
        // size. When they disagree the asset cannot fill the canvas rect
        // without a non-uniform stretch.
        let assetWidth = Double(reference.pixelSize.width)
        let assetHeight = Double(reference.pixelSize.height)
        var preservesAspectRatio = true
        if assetWidth > 0, assetHeight > 0 {
            let assetAspect = assetWidth / assetHeight
            let canvasAspect = canvas.width / canvas.height
            if relativeDrift(assetAspect, canvasAspect) > aspectTolerance {
                preservesAspectRatio = false
                captions.append(
                    "The design asset is \(reference.pixelSize.width) × \(reference.pixelSize.height) px but declares a \(format(canvas.width)) × \(format(canvas.height)) pt canvas. The overlay keeps the asset's aspect ratio inside the design canvas region instead of stretching it."
                )
            }
        }
        // The screenshot itself must scale logical points to pixels uniformly,
        // otherwise the unit frame the differences live in is already skewed.
        let scaleX = Double(screenshot.pixelWidth) / coverage.width
        let scaleY = Double(screenshot.pixelHeight) / coverage.height
        if scaleX > 0, scaleY > 0, relativeDrift(scaleX, scaleY) > aspectTolerance {
            preservesAspectRatio = false
            captions.append(
                "The screenshot scales logical points to pixels non-uniformly (\(format(scaleX))× horizontally, \(format(scaleY))× vertically). The design overlay follows the screenshot coverage and may not align exactly."
            )
        }
        return DesignOverlayPlacement(
            unitRect: rect,
            preservesAspectRatio: preservesAspectRatio,
            reconciliationCaption: captions.isEmpty ? nil : captions.joined(separator: " ")
        )
    }

    private static func relativeDrift(_ left: Double, _ right: Double) -> Double {
        let scale = max(abs(left), abs(right))
        guard scale > 0 else {
            return 0
        }
        return abs(left - right) / scale
    }

    private static func format(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2)))
    }

    /// Resolves the drawable regions for one comparison. Differences without
    /// resolvable geometry (unknown node, no frame, non-geometric values)
    /// stay in the difference list but produce no region: the overlay never
    /// invents a rectangle.
    public static func regions(
        for comparison: DesignComparisonDetail,
        tree: UiTreeProjection,
        screenshot: ScreenshotPresentation?
    ) -> [DifferenceRegion] {
        guard let screenshot else {
            return []
        }
        let coverage = screenshot.coverage
        guard coverage.width > 0, coverage.height > 0 else {
            return []
        }
        var nodesByStableID: [String: NodePresentation] = [:]
        for node in tree.nodesByID.values {
            if let stableID = node.stableID, nodesByStableID[stableID] == nil {
                nodesByStableID[stableID] = node
            }
        }
        return comparison.differences.compactMap { difference in
            region(
                for: difference,
                coverage: coverage,
                nodesByID: tree.nodesByID,
                nodesByStableID: nodesByStableID
            )
        }
    }

    private static func region(
        for difference: DesignDifferenceSummary,
        coverage: RectPresentation,
        nodesByID: [String: NodePresentation],
        nodesByStableID: [String: NodePresentation]
    ) -> DifferenceRegion? {
        // Frame differences carry their geometry inline as canonical rect
        // PropertyValues in logical points.
        if let actualRect = difference.actual.rectValue {
            return DifferenceRegion(
                differenceID: difference.differenceID,
                category: difference.category,
                severity: difference.severity,
                unitRect: unitRect(
                    x: actualRect.x,
                    y: actualRect.y,
                    width: actualRect.width,
                    height: actualRect.height,
                    coverage: coverage
                ),
                expectedUnitRect: difference.expected.rectValue.map { expected in
                    unitRect(
                        x: expected.x,
                        y: expected.y,
                        width: expected.width,
                        height: expected.height,
                        coverage: coverage
                    )
                }
            )
        }
        // Every other category locates the affected node in the loaded tree,
        // preferring the durable stable ID over the per-capture node ID.
        guard let target = difference.runtimeTarget else {
            return nil
        }
        let node = target.stableID.flatMap { nodesByStableID[$0] } ?? nodesByID[target.nodeID]
        guard let frame = node?.frame else {
            return nil
        }
        return DifferenceRegion(
            differenceID: difference.differenceID,
            category: difference.category,
            severity: difference.severity,
            unitRect: unitRect(
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
                coverage: coverage
            )
        )
    }

    private static func unitRect(
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        coverage: RectPresentation
    ) -> UnitRect {
        UnitRect(
            x: (x - coverage.x) / coverage.width,
            y: (y - coverage.y) / coverage.height,
            width: width / coverage.width,
            height: height / coverage.height
        )
    }
}
