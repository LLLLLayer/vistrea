#if canImport(UIKit)
import UIKit
import VistreaRuntimeConnection

/// Resolves stable identifiers to live views and previews only their alpha.
///
/// The controller mutates exactly the allowlisted property on the main actor
/// and never invokes application business methods.
public final class UIKitRuntimeTuningController: RuntimeTuningApplying {
    public typealias WindowProvider = @MainActor @Sendable () -> [UIWindow]

    private let windowProvider: WindowProvider

    public init(windowProvider: @escaping WindowProvider) {
        self.windowProvider = windowProvider
    }

    public func currentAlpha(stableID: String) async -> Double? {
        await MainActor.run {
            findView(stableID: stableID).map { Double($0.alpha) }
        }
    }

    public func setAlpha(stableID: String, value: Double) async {
        await MainActor.run {
            findView(stableID: stableID)?.alpha = CGFloat(value)
        }
    }

    @MainActor
    private func findView(stableID: String) -> UIView? {
        for window in windowProvider() {
            if let match = findView(stableID: stableID, in: window) {
                return match
            }
        }
        return nil
    }

    @MainActor
    private func findView(stableID: String, in view: UIView) -> UIView? {
        if view.accessibilityIdentifier == stableID {
            return view
        }
        for subview in view.subviews {
            if let match = findView(stableID: stableID, in: subview) {
                return match
            }
        }
        return nil
    }
}
#endif
