import UIKit
import XCTest
@testable import VistreaDemoApp

@MainActor
final class StoreCartViewControllerTests: XCTestCase {
    private func makeLoadedController() throws -> StoreCartViewController {
        let catalog = try ScenarioCatalog.load()
        let scenario = try XCTUnwrap(catalog.scenario(id: "demo.store.cart-states"))
        let controller = StoreCartViewController(scenario: scenario, profile: "baseline")
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

    func testEntryStateIsTheEmptyCart() throws {
        let controller = try makeLoadedController()
        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(ids.contains("demo.cart.empty_notice"))
        XCTAssertTrue(ids.contains("demo.cart.add_sample"))
        XCTAssertFalse(ids.contains("demo.cart.item_primary"))
        XCTAssertFalse(ids.contains("demo.cart.checkout"))
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.cart-empty.root")
    }

    func testAddingTheSampleItemProducesThePopulatedStructure() throws {
        let controller = try makeLoadedController()
        try tap("demo.cart.add_sample", in: controller)

        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(ids.contains("demo.cart.item_primary"))
        XCTAssertTrue(ids.contains("demo.cart.checkout"))
        XCTAssertFalse(ids.contains("demo.cart.empty_notice"))
        XCTAssertFalse(ids.contains("demo.cart.add_sample"))
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.cart-populated.root")

        let checkout = try XCTUnwrap(
            ViewHierarchy.find("demo.cart.checkout", in: controller.view) as? UIButton
        )
        XCTAssertFalse(checkout.isEnabled, "checkout has no contracted step and stays disabled")
    }

    func testRemovingTheItemRestoresTheExactEmptyStructure() throws {
        let controller = try makeLoadedController()
        let emptySignature = ViewHierarchy.semanticSignature(of: controller.view)

        try tap("demo.cart.add_sample", in: controller)
        XCTAssertNotEqual(ViewHierarchy.semanticSignature(of: controller.view), emptySignature)

        try tap("demo.cart.item_primary", in: controller)
        XCTAssertEqual(ViewHierarchy.semanticSignature(of: controller.view), emptySignature)
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.cart-empty.root")
    }
}
