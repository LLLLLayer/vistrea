import UIKit
import XCTest

/// Shared UIKit hierarchy probes for the dedicated scenario controllers.
/// The semantic signature captures the structure the Runtime capture would
/// observe — classes and stable IDs — while skipping the private internals
/// of leaf controls, whose subtrees UIKit populates lazily.
@MainActor
enum ViewHierarchy {
    static func find(_ accessibilityIdentifier: String, in root: UIView) -> UIView? {
        if root.accessibilityIdentifier == accessibilityIdentifier {
            return root
        }
        for subview in root.subviews {
            if let match = find(accessibilityIdentifier, in: subview) {
                return match
            }
        }
        return nil
    }

    static func nodeIDs(in root: UIView) -> Set<String> {
        var ids: Set<String> = []
        collectNodeIDs(in: root, into: &ids)
        return ids
    }

    static func semanticSignature(of view: UIView, depth: Int = 0) -> [String] {
        if String(describing: type(of: view)).hasPrefix("_") {
            return []
        }
        var lines = [
            "\(depth)|\(String(describing: type(of: view)))|\(view.accessibilityIdentifier ?? "-")",
        ]
        if isLeafControl(view) {
            return lines
        }
        for subview in view.subviews {
            lines.append(contentsOf: semanticSignature(of: subview, depth: depth + 1))
        }
        return lines
    }

    static func labelTexts(in root: UIView) -> [String] {
        var texts: [String] = []
        collectLabelTexts(in: root, into: &texts)
        return texts
    }

    private static func collectNodeIDs(in view: UIView, into ids: inout Set<String>) {
        if let id = view.accessibilityIdentifier {
            ids.insert(id)
        }
        for subview in view.subviews {
            collectNodeIDs(in: subview, into: &ids)
        }
    }

    private static func collectLabelTexts(in view: UIView, into texts: inout [String]) {
        if let label = view as? UILabel, let text = label.text {
            texts.append(text)
        }
        for subview in view.subviews {
            collectLabelTexts(in: subview, into: &texts)
        }
    }

    private static func isLeafControl(_ view: UIView) -> Bool {
        view is UIButton
            || view is UILabel
            || view is UITextField
            || view is UIActivityIndicatorView
    }
}
