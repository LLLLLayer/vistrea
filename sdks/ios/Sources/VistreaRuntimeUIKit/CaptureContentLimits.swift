import Foundation
import VistreaRuntimeModels

/// Bounds observed values against canonical model limits instead of failing
/// the whole capture, reporting each loss as an explicit Capture Limitation.
enum CaptureContentLimits {
    static let textScalarLimit = 65_536
    static let placeholderScalarLimit = 4_096

    struct BoundedValue {
        let value: String?
        let limitation: CaptureLimitation?
    }

    /// Truncates an over-limit value on a Unicode scalar boundary and records
    /// a node-scoped limitation; in-limit values pass through untouched.
    static func bounded(
        _ value: String?,
        limit: Int,
        field: String,
        treeID: TreeID,
        nodeID: NodeID
    ) throws -> BoundedValue {
        guard let value, value.unicodeScalars.count > limit else {
            return BoundedValue(value: value, limitation: nil)
        }
        let truncated = String(String.UnicodeScalarView(value.unicodeScalars.prefix(limit)))
        let limitation = try CaptureLimitation(
            code: "ios.capture.text-truncated",
            severity: .warning,
            message: "The observed text exceeds the canonical field limit and was truncated to \(limit) Unicode scalar values.",
            scope: CaptureLimitationScope(treeID: treeID, nodeID: nodeID, field: field),
            retryable: false
        )
        return BoundedValue(value: truncated, limitation: limitation)
    }

    /// Reports an accessibilityIdentifier that cannot become a canonical
    /// `stable_id`, so vanished stable identity remains diagnosable.
    static func invalidStableIdentifier(
        treeID: TreeID,
        nodeID: NodeID
    ) throws -> CaptureLimitation {
        try CaptureLimitation(
            code: "ios.capture.stable-id-invalid",
            severity: .warning,
            message: "The accessibilityIdentifier is not a canonical stable_id and was omitted from this node.",
            scope: CaptureLimitationScope(treeID: treeID, nodeID: nodeID, field: "stable_id"),
            retryable: false
        )
    }
}
