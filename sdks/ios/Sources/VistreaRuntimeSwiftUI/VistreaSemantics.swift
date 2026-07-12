#if canImport(SwiftUI)
import SwiftUI

/// The cross-platform semantic role a SwiftUI view declares for capture.
///
/// Raw values match the canonical `UiNode.role` vocabulary so annotated
/// SwiftUI content classifies identically to native UIKit views.
public enum VistreaSemanticRole: String, CaseIterable, Sendable {
    case button
    case text
    case image
    case header
    case link
    case textField = "text-field"
    case listItem = "list-item"
    case container

    /// The accessibility traits that carry this role through the hosting
    /// bridge into the UIKit capture adapter.
    public var accessibilityTraits: AccessibilityTraits {
        switch self {
        case .button: .isButton
        case .text: .isStaticText
        case .image: .isImage
        case .header: .isHeader
        case .link: .isLink
        case .textField: .isSearchField
        case .listItem, .container: []
        }
    }
}

extension View {
    /// Declares Vistrea capture semantics on a SwiftUI view.
    ///
    /// SwiftUI renders through private hosting views, so the annotation
    /// travels as standard accessibility facts: the stable identifier becomes
    /// `accessibilityIdentifier` (the cross-platform `stable_id`), the role
    /// becomes accessibility traits the UIKit capture adapter maps back to
    /// the canonical role vocabulary, and the optional label becomes the
    /// accessibility label. The modifier never invokes business logic.
    public func vistreaSemantics(
        stableID: String,
        role: VistreaSemanticRole,
        label: String? = nil
    ) -> some View {
        modifier(VistreaSemanticsModifier(stableID: stableID, role: role, label: label))
    }
}

struct VistreaSemanticsModifier: ViewModifier {
    let stableID: String
    let role: VistreaSemanticRole
    let label: String?

    func body(content: Content) -> some View {
        let annotated = content
            .accessibilityIdentifier(stableID)
            .accessibilityAddTraits(role.accessibilityTraits)
        if let label {
            annotated.accessibilityLabel(Text(label))
        } else {
            annotated
        }
    }
}
#endif
