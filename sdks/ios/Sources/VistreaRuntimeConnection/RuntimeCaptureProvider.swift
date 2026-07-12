import Foundation
import VistreaRuntimeModels

public enum RuntimeCaptureScreenshotMode: String, Codable, Equatable, Sendable {
    case none
    case reference
}

public enum RuntimeCaptureReason: String, Codable, Equatable, Sendable {
    case manual
    case beforeAction = "before_action"
    case afterAction = "after_action"
    case review
    case validation
}

public struct RuntimeCaptureRequest: Equatable, Sendable {
    public let includePaths: [String]
    public let screenshot: RuntimeCaptureScreenshotMode
    public let reason: RuntimeCaptureReason

    public init(
        includePaths: [String],
        screenshot: RuntimeCaptureScreenshotMode,
        reason: RuntimeCaptureReason
    ) throws {
        guard !includePaths.isEmpty, includePaths.count <= 256 else {
            throw RuntimeConnectionError.protocolViolation
        }
        guard includePaths.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else {
            throw RuntimeConnectionError.protocolViolation
        }
        self.includePaths = includePaths
        self.screenshot = screenshot
        self.reason = reason
    }
}

public struct RuntimeObjectPayload: Equatable, Sendable {
    public let reference: ObjectReference
    public let bytes: Data

    public init(reference: ObjectReference, bytes: Data) {
        self.reference = reference
        // `Data` has copy-on-write value semantics. Force a distinct backing
        // allocation at the untrusted provider boundary as defense in depth
        // against mutable Foundation bridging and later source-buffer changes.
        self.bytes = bytes.withUnsafeBytes { Data($0) }
    }
}

public struct RuntimeSnapshotCapturePayload: Equatable, Sendable {
    public let snapshot: RuntimeSnapshot
    public let objects: [RuntimeObjectPayload]

    public init(snapshot: RuntimeSnapshot, objects: [RuntimeObjectPayload]) {
        self.snapshot = snapshot
        self.objects = objects
    }
}

/// An observation-only capture boundary used by the Runtime transport.
///
/// UIKit, fixture, and future platform adapters return the canonical protocol
/// model through this port. The transport never defines a second Snapshot type.
public protocol RuntimeSnapshotCaptureProvider: Sendable {
    func capture(_ request: RuntimeCaptureRequest) async throws -> RuntimeSnapshotCapturePayload
}
