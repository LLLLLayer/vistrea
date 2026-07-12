#if canImport(UIKit)
import UIKit
import VistreaRuntimeConnection
import VistreaRuntimeUIKit

/// Main-actor bridge from real UIKit observation to the transport capture port.
///
/// Window discovery and hierarchy capture remain inside the authorized app
/// process. The bridge never invokes application business methods.
@MainActor
public final class UIKitRuntimeSnapshotCaptureProvider: RuntimeSnapshotCaptureProvider {
    public typealias WindowProvider = @MainActor @Sendable () -> [UIWindow]
    public typealias ScenarioIDProvider = @MainActor @Sendable () -> String?

    private let adapter: UIKitRuntimeCaptureAdapter
    private let windowProvider: WindowProvider
    private let scenarioIDProvider: ScenarioIDProvider

    public init(
        adapter: UIKitRuntimeCaptureAdapter,
        windowProvider: @escaping WindowProvider,
        scenarioIDProvider: @escaping ScenarioIDProvider = { nil }
    ) {
        self.adapter = adapter
        self.windowProvider = windowProvider
        self.scenarioIDProvider = scenarioIDProvider
    }

    public func capture(
        _ request: RuntimeCaptureRequest
    ) async throws -> RuntimeSnapshotCapturePayload {
        try Task.checkCancellation()
        let requestedFields = Set(request.includePaths)
        let supportedFields: Set<String> = request.screenshot == .reference
            ? ["trees", "screenshot"]
            : ["trees"]
        guard request.includePaths.count == supportedFields.count,
              requestedFields == supportedFields
        else {
            // This first adapter always emits the required canonical tree and
            // can optionally attach one screenshot. Never silently broaden or
            // ignore a field mask that the current slice cannot satisfy.
            throw RuntimeConnectionError.protocolViolation
        }
        let result = try adapter.capture(
            windows: windowProvider(),
            scenarioID: scenarioIDProvider(),
            includeScreenshot: request.screenshot == .reference
        )
        try Task.checkCancellation()
        return RuntimeSnapshotCapturePayload(
            snapshot: result.snapshot,
            objects: result.objects.map {
                RuntimeObjectPayload(reference: $0.reference, bytes: $0.bytes)
            }
        )
    }
}
#endif
