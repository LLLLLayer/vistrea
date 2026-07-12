#if canImport(SwiftUI)
import SwiftUI

/// The cross-platform semantic role a SwiftUI view declares for capture.
///
/// Raw values match the canonical `UiNode.role` vocabulary so annotated
/// SwiftUI content classifies identically to native UIKit views.
///
/// The bridge has two deliberate limits. `.listItem` and `.container` carry
/// no accessibility traits, so these structural roles do not round-trip
/// through the accessibility bridge: the capture adapter records both as
/// `"container"`. `.textField` maps to the search-field trait — the only
/// trait the adapter can read back as `"text-field"` — and VoiceOver
/// announces that trait as a search field, so annotate production text
/// fields deliberately.
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
    ///
    /// Because `.listItem` and `.container` carry no traits, they are
    /// captured as `"container"`, and `.textField` rides the search-field
    /// trait that VoiceOver announces; see `VistreaSemanticRole` for the
    /// full round-trip limits before annotating production text fields.
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
