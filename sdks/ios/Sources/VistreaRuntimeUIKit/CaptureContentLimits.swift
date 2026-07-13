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

    /// Reports synthesized accessibility-element children omitted by the
    /// cycle guard or by the depth or breadth bounds of the element walk, so
    /// missing nodes remain diagnosable instead of silently vanishing.
    static func accessibilityElementsOmitted(
        message: String,
        treeID: TreeID,
        nodeID: NodeID
    ) throws -> CaptureLimitation {
        try CaptureLimitation(
            code: "ios.capture.accessibility-elements-omitted",
            severity: .warning,
            message: message,
            scope: CaptureLimitationScope(treeID: treeID, nodeID: nodeID, field: "child_ids"),
            retryable: false
        )
    }

    /// Reports a view that hosts content the capture cannot observe: it
    /// declares an accessibility container yet exposes no elements, which is
    /// how a SwiftUI hosting view presents itself while no app-level
    /// accessibility runtime is active.
    ///
    /// Without this limitation the node would serialize as a childless leaf
    /// with no recorded loss, so a consumer could not distinguish an empty
    /// screen from an unobserved one, and the same screen would hash to two
    /// different structural identities depending on whether an accessibility
    /// runtime happened to be running.
    static func contentNotObservable(
        treeID: TreeID,
        nodeID: NodeID
    ) throws -> CaptureLimitation {
        try CaptureLimitation(
            code: "ios.capture.content-not-observable",
            severity: .warning,
            message: "This view declares an accessibility container but exposes no elements, so its hosted content (SwiftUI in particular) is only observable while an app-level accessibility runtime is active. The node is reported without children because its content was not observed, not because it is empty.",
            scope: CaptureLimitationScope(treeID: treeID, nodeID: nodeID, field: "child_ids"),
            // An identical re-capture cannot recover the content: it becomes
            // observable only under a different capture condition, an active
            // accessibility runtime, so a plain retry would loop.
            retryable: false
        )
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
