import Foundation

// MARK: - Shared geometry projections

/// A logical-point size, the design reference `canvas_size` shape.
public struct SizeSummary: Decodable, Equatable, Sendable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

/// A physical pixel size, the design reference `pixel_size` shape.
public struct PixelSizeSummary: Decodable, Equatable, Sendable {
    public let width: UInt64
    public let height: UInt64

    public init(width: UInt64, height: UInt64) {
        self.width = width
        self.height = height
    }
}

/// A canonical Rect PropertyValue payload in logical points.
public struct RectValueSummary: Decodable, Equatable, Sendable {
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

    public var summaryText: String {
        "(\(Self.format(x)), \(Self.format(y)), \(Self.format(width)) × \(Self.format(height)))"
    }

    private static func format(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2)))
    }
}

/// A canonical ColorRgba PropertyValue payload with 0...1 channels.
public struct ColorRGBAValueSummary: Decodable, Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    public var summaryText: String {
        "rgba(\(Self.format(red)), \(Self.format(green)), \(Self.format(blue)), \(Self.format(alpha)))"
    }

    private static func format(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...3)))
    }
}

/// A lenient projection of one canonical PropertyValue. Only the kinds the
/// workbench renders are modeled; every other canonical kind is preserved as
/// `.other` so the difference list stays honest without failing the decode.
public enum PropertyValueSummary: Equatable, Sendable {
    case rect(RectValueSummary)
    case colorRGBA(ColorRGBAValueSummary)
    case number(value: Double, unit: String?)
    case other(kind: String)

    public var rectValue: RectValueSummary? {
        if case let .rect(value) = self { return value }
        return nil
    }

    public var colorValue: ColorRGBAValueSummary? {
        if case let .colorRGBA(value) = self { return value }
        return nil
    }

    public var summaryText: String {
        switch self {
        case let .rect(value):
            return value.summaryText
        case let .colorRGBA(value):
            return value.summaryText
        case let .number(value, unit):
            let formatted = value.formatted(.number.precision(.fractionLength(0...3)))
            return unit.map { "\(formatted) \($0)" } ?? formatted
        case let .other(kind):
            return kind
        }
    }
}

extension PropertyValueSummary: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind
        case value
        case unit
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "rect":
            self = .rect(try container.decode(RectValueSummary.self, forKey: .value))
        case "color_rgba":
            self = .colorRGBA(try container.decode(ColorRGBAValueSummary.self, forKey: .value))
        case "number":
            self = .number(
                value: try container.decode(Double.self, forKey: .value),
                unit: try container.decodeIfPresent(String.self, forKey: .unit)
            )
        default:
            self = .other(kind: kind)
        }
    }
}

// MARK: - Design references

/// A lenient projection of the design reference artifact Object reference:
/// the content hash the asset bytes load through `GET /v1/objects/:hash`.
public struct DesignObjectSummary: Decodable, Equatable, Sendable {
    public let hash: String
    public let mediaType: String?

    public init(hash: String, mediaType: String? = nil) {
        self.hash = hash
        self.mediaType = mediaType
    }

    private enum CodingKeys: String, CodingKey {
        case hash
        case mediaType = "media_type"
    }
}

/// A lenient projection of the design reference Artifact envelope.
public struct DesignArtifactSummary: Decodable, Equatable, Sendable {
    public let object: DesignObjectSummary

    public init(object: DesignObjectSummary) {
        self.object = object
    }

    private enum CodingKeys: String, CodingKey {
        case object
    }
}

/// A lenient projection of one persisted Design Reference document.
public struct DesignReferenceDetail: Decodable, Equatable, Sendable, Identifiable {
    public let designReferenceID: String
    public let revision: UInt64
    public let kind: String
    public let name: String
    public let artifact: DesignArtifactSummary
    public let canvasSize: SizeSummary
    public let pixelSize: PixelSizeSummary

    public var id: String { designReferenceID }

    public init(
        designReferenceID: String,
        revision: UInt64,
        kind: String,
        name: String,
        artifact: DesignArtifactSummary,
        canvasSize: SizeSummary,
        pixelSize: PixelSizeSummary
    ) {
        self.designReferenceID = designReferenceID
        self.revision = revision
        self.kind = kind
        self.name = name
        self.artifact = artifact
        self.canvasSize = canvasSize
        self.pixelSize = pixelSize
    }

    private enum CodingKeys: String, CodingKey {
        case designReferenceID = "design_reference_id"
        case revision
        case kind
        case name
        case artifact
        case canvasSize = "canvas_size"
        case pixelSize = "pixel_size"
    }
}

public struct DesignReferencePage: Decodable, Equatable, Sendable {
    public let items: [DesignReferenceDetail]
    public let nextCursor: String?

    public init(items: [DesignReferenceDetail], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}

// MARK: - Design comparisons

/// The `POST /v1/design-comparisons` command body.
public struct DesignComparisonCommand: Encodable, Equatable, Sendable {
    public let designReferenceID: String
    public let targetSnapshotID: String
    public let includePixel: Bool?
    public let completedBy: StudioActorRef

    public init(
        designReferenceID: String,
        targetSnapshotID: String,
        includePixel: Bool? = nil,
        completedBy: StudioActorRef
    ) {
        self.designReferenceID = designReferenceID
        self.targetSnapshotID = targetSnapshotID
        self.includePixel = includePixel
        self.completedBy = completedBy
    }

    private enum CodingKeys: String, CodingKey {
        case designReferenceID = "design_reference_id"
        case targetSnapshotID = "target_snapshot_id"
        case includePixel = "include_pixel"
        case completedBy = "completed_by"
    }
}

/// A lenient projection of the difference's canonical RuntimeNodeTarget.
public struct DesignRuntimeTargetSummary: Decodable, Equatable, Sendable {
    public let nodeID: String
    public let stableID: String?

    public init(nodeID: String, stableID: String? = nil) {
        self.nodeID = nodeID
        self.stableID = stableID
    }

    private enum CodingKeys: String, CodingKey {
        case nodeID = "node_id"
        case stableID = "stable_id"
    }
}

/// A lenient projection of one canonical DesignDifference.
public struct DesignDifferenceSummary: Decodable, Equatable, Sendable, Identifiable {
    public let differenceID: String
    public let category: String
    public let severity: String
    public let delta: Double?
    public let expected: PropertyValueSummary
    public let actual: PropertyValueSummary
    public let runtimeTarget: DesignRuntimeTargetSummary?

    public var id: String { differenceID }

    public init(
        differenceID: String,
        category: String,
        severity: String,
        delta: Double? = nil,
        expected: PropertyValueSummary,
        actual: PropertyValueSummary,
        runtimeTarget: DesignRuntimeTargetSummary? = nil
    ) {
        self.differenceID = differenceID
        self.category = category
        self.severity = severity
        self.delta = delta
        self.expected = expected
        self.actual = actual
        self.runtimeTarget = runtimeTarget
    }

    private enum CodingKeys: String, CodingKey {
        case differenceID = "difference_id"
        case category
        case severity
        case delta
        case expected
        case actual
        case runtimeTarget = "runtime_target"
    }
}

/// The canonical `extensions["vistrea.pixel"]` pixel-comparison verdict.
public struct PixelComparisonStatus: Decodable, Equatable, Sendable {
    public let status: String
    public let reason: String?

    public init(status: String, reason: String? = nil) {
        self.status = status
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case reason
    }
}

/// A lenient projection of one persisted DesignComparison, including the
/// honest `quality` verdict and the `vistrea.pixel` extension when the Host
/// attempted a pixel comparison.
public struct DesignComparisonDetail: Decodable, Equatable, Sendable, Identifiable {
    public let comparisonID: String
    public let revision: UInt64
    public let designReferenceID: String
    public let targetSnapshotID: String
    public let quality: String
    public let differences: [DesignDifferenceSummary]
    public let completedAt: String
    public let pixel: PixelComparisonStatus?

    public var id: String { comparisonID }

    public init(
        comparisonID: String,
        revision: UInt64,
        designReferenceID: String,
        targetSnapshotID: String,
        quality: String,
        differences: [DesignDifferenceSummary],
        completedAt: String,
        pixel: PixelComparisonStatus? = nil
    ) {
        self.comparisonID = comparisonID
        self.revision = revision
        self.designReferenceID = designReferenceID
        self.targetSnapshotID = targetSnapshotID
        self.quality = quality
        self.differences = differences
        self.completedAt = completedAt
        self.pixel = pixel
    }

    private enum CodingKeys: String, CodingKey {
        case comparisonID = "comparison_id"
        case revision
        case designReferenceID = "design_reference_id"
        case targetSnapshotID = "target_snapshot_id"
        case quality
        case differences
        case completedAt = "completed_at"
        case extensions
    }

    private struct ExtensionKey: CodingKey {
        let stringValue: String
        let intValue: Int?

        init?(stringValue: String) {
            self.stringValue = stringValue
            intValue = nil
        }

        init?(intValue: Int) {
            stringValue = String(intValue)
            self.intValue = intValue
        }

        static let pixel = ExtensionKey(stringValue: "vistrea.pixel")!
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        comparisonID = try container.decode(String.self, forKey: .comparisonID)
        revision = try container.decode(UInt64.self, forKey: .revision)
        designReferenceID = try container.decode(String.self, forKey: .designReferenceID)
        targetSnapshotID = try container.decode(String.self, forKey: .targetSnapshotID)
        quality = try container.decode(String.self, forKey: .quality)
        differences = try container.decode([DesignDifferenceSummary].self, forKey: .differences)
        completedAt = try container.decode(String.self, forKey: .completedAt)
        if container.contains(.extensions) {
            let extensions = try container.nestedContainer(
                keyedBy: ExtensionKey.self,
                forKey: .extensions
            )
            pixel = try extensions.decodeIfPresent(PixelComparisonStatus.self, forKey: .pixel)
        } else {
            pixel = nil
        }
    }
}

public struct DesignComparisonPage: Decodable, Equatable, Sendable {
    public let items: [DesignComparisonDetail]
    public let nextCursor: String?

    public init(items: [DesignComparisonDetail], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}
