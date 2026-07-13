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

/// Projects canonical DesignDifference values into screenshot-relative
/// regions. Logical points convert through the screenshot's logical
/// coverage rect; the displayed pixel scale never leaks in here because the
/// unit rects are resolution-independent.
public enum DesignOverlayProjection {
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
