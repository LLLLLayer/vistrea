import UIKit
import XCTest
@testable import VistreaDemoApp

@MainActor
final class StoreSheetViewControllerTests: XCTestCase {
    private let sheetNodeIDs: Set<String> = [
        "demo.sheet.container",
        "demo.sheet.option_primary",
        "demo.sheet.dismiss",
    ]

    private func makeLoadedController() throws -> StoreSheetViewController {
        let catalog = try ScenarioCatalog.load()
        let scenario = try XCTUnwrap(catalog.scenario(id: "demo.store.sheet"))
        let controller = StoreSheetViewController(scenario: scenario, profile: "baseline")
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.view.layoutIfNeeded()
        return controller
    }

    private func tap(_ accessibilityIdentifier: String, in controller: UIViewController) throws {
        let button = try XCTUnwrap(
            ViewHierarchy.find(accessibilityIdentifier, in: controller.view) as? UIButton
        )
        button.sendActions(for: .touchUpInside)
    }

    func testBaseStateIsStructurallyFreeOfSheetNodes() throws {
        let controller = try makeLoadedController()
        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(ids.contains("demo.sheet.open"))
        XCTAssertTrue(ids.isDisjoint(with: sheetNodeIDs))
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.sheet-base.root")
    }

    func testPresentingAddsTheInTreeOverlayNodes() throws {
        let controller = try makeLoadedController()
        try tap("demo.sheet.open", in: controller)

        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(sheetNodeIDs.isSubset(of: ids))
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.sheet-open.root")
    }

    func testChoosingTheOptionClosesTheSheetAndOnlyRewritesText() throws {
        let controller = try makeLoadedController()
        let baseSignature = ViewHierarchy.semanticSignature(of: controller.view)

        try tap("demo.sheet.open", in: controller)
        try tap("demo.sheet.option_primary", in: controller)

        XCTAssertEqual(ViewHierarchy.semanticSignature(of: controller.view), baseSignature)
        XCTAssertTrue(
            ViewHierarchy.labelTexts(in: controller.view).contains("Sort: Price low to high")
        )
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.sheet-base.root")
    }

    func testDismissingRestoresTheExactBaseStructure() throws {
        let controller = try makeLoadedController()
        let baseSignature = ViewHierarchy.semanticSignature(of: controller.view)

        try tap("demo.sheet.open", in: controller)
        try tap("demo.sheet.dismiss", in: controller)

        XCTAssertEqual(ViewHierarchy.semanticSignature(of: controller.view), baseSignature)
        XCTAssertTrue(
            ViewHierarchy.labelTexts(in: controller.view).contains("Sort: Featured"),
            "dismiss must not apply the option"
        )
        XCTAssertTrue(ViewHierarchy.nodeIDs(in: controller.view).isDisjoint(with: sheetNodeIDs))
    }
}
