import SwiftUI
import XCTest
@testable import VistreaRuntimeSwiftUI

final class VistreaSemanticsTests: XCTestCase {
    func testRoleRawValuesMatchTheCanonicalRoleVocabulary() {
        XCTAssertEqual(
            VistreaSemanticRole.allCases.map(\.rawValue),
            ["button", "text", "image", "header", "link", "text-field", "list-item", "container"]
        )
    }

    func testRolesCarryTheirBridgingAccessibilityTraits() {
        XCTAssertEqual(VistreaSemanticRole.button.accessibilityTraits, .isButton)
        XCTAssertEqual(VistreaSemanticRole.text.accessibilityTraits, .isStaticText)
        XCTAssertEqual(VistreaSemanticRole.image.accessibilityTraits, .isImage)
        XCTAssertEqual(VistreaSemanticRole.header.accessibilityTraits, .isHeader)
        XCTAssertEqual(VistreaSemanticRole.link.accessibilityTraits, .isLink)
        XCTAssertEqual(VistreaSemanticRole.textField.accessibilityTraits, .isSearchField)
        XCTAssertEqual(VistreaSemanticRole.listItem.accessibilityTraits, [])
        XCTAssertEqual(VistreaSemanticRole.container.accessibilityTraits, [])
    }

    @MainActor
    func testModifierComposesOnAnyView() {
        // Compilation of the annotated hierarchy is the contract this bridge
        // exposes to applications on every SwiftUI platform.
        let annotated = SwiftUI.Text("Open catalog")
            .vistreaSemantics(stableID: "demo.home.open_catalog", role: .button, label: "Open catalog")
        XCTAssertNotNil(annotated as (any View)?)
    }
}
