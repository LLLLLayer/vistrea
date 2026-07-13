import UIKit
import XCTest
@testable import VistreaDemoApp

@MainActor
final class StoreNavigationSceneTests: XCTestCase {
    private func makeShopController() throws -> StoreShopViewController {
        let catalog = try ScenarioCatalog.load()
        let scenario = try XCTUnwrap(catalog.scenario(id: "demo.store.navigation"))
        return StoreShopViewController(scenario: scenario, profile: "baseline")
    }

    private func layout(_ controller: UIViewController) {
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        // The catalog viewport converges to a whole-row height across passes.
        for _ in 0..<3 {
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        }
    }

    private func catalogView(in controller: UIViewController) throws -> SnapCatalogView {
        try XCTUnwrap(
            ViewHierarchy.find("demo.store.catalog_list", in: controller.view) as? SnapCatalogView
        )
    }

    func testShopPinsTheFeaturedCardAboveTheCatalogAndTabBar() throws {
        let controller = try makeShopController()
        layout(controller)
        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(ids.contains("demo.store.catalog_item_primary"))
        XCTAssertTrue(ids.contains("demo.store.catalog_list"))
        XCTAssertTrue(ids.contains("demo.store.tab_shop"))
        XCTAssertTrue(ids.contains("demo.store.tab_profile"))
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.store-shop.root")

        let featured = try XCTUnwrap(
            ViewHierarchy.find("demo.store.catalog_item_primary", in: controller.view)
        )
        let catalog = try catalogView(in: controller)
        XCTAssertLessThanOrEqual(featured.frame.maxY, catalog.frame.minY)
    }

    func testCatalogViewportIsAWholeNumberOfFixedHeightRows() throws {
        let controller = try makeShopController()
        layout(controller)
        let catalog = try catalogView(in: controller)
        let rowHeight = catalog.snapLayout.rowHeight

        XCTAssertGreaterThan(catalog.bounds.height, 0)
        XCTAssertEqual(
            catalog.bounds.height.truncatingRemainder(dividingBy: rowHeight),
            0,
            "the visible window must always be whole rows"
        )

        let rows = catalog.subviews.compactMap { $0 as? SnapCatalogRowView }
        XCTAssertEqual(
            rows.count,
            catalog.snapLayout.windowLength(viewportHeight: catalog.bounds.height)
        )
        XCTAssertTrue(
            rows.allSatisfy { $0.accessibilityIdentifier == nil },
            "catalog rows are content, not identity"
        )
        XCTAssertTrue(rows.allSatisfy { $0.bounds.height == rowHeight })
    }

    func testScrolledCatalogKeepsAnIdenticalStructureWithDifferentText() throws {
        let controller = try makeShopController()
        layout(controller)
        let catalog = try catalogView(in: controller)
        let restingSignature = ViewHierarchy.semanticSignature(of: catalog)
        let restingTexts = ViewHierarchy.labelTexts(in: catalog)

        let scrolled = catalog.snapLayout.snappedOffset(
            proposed: catalog.snapLayout.rowHeight * 20,
            viewportHeight: catalog.bounds.height
        )
        catalog.setContentOffset(CGPoint(x: 0, y: scrolled), animated: false)

        XCTAssertEqual(ViewHierarchy.semanticSignature(of: catalog), restingSignature)
        XCTAssertNotEqual(ViewHierarchy.labelTexts(in: catalog), restingTexts)

        let bottom = catalog.snapLayout.maximumOffset(viewportHeight: catalog.bounds.height)
        catalog.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
        XCTAssertEqual(ViewHierarchy.semanticSignature(of: catalog), restingSignature)
    }

    func testStorefrontScreensShareOneNavigationStack() throws {
        let shop = try makeShopController()
        let navigation = UINavigationController(rootViewController: shop)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        layout(shop)

        // Featured card pushes the detail screen.
        let featured = try XCTUnwrap(
            ViewHierarchy.find("demo.store.catalog_item_primary", in: shop.view) as? UIButton
        )
        featured.sendActions(for: .touchUpInside)
        settle()
        let detail = try XCTUnwrap(navigation.viewControllers.last as? StoreDetailViewController)
        layout(detail)
        let addToCart = try XCTUnwrap(
            ViewHierarchy.find("demo.store.detail_add_to_cart", in: detail.view) as? UIButton
        )
        XCTAssertFalse(addToCart.isEnabled, "add-to-cart has no contracted step and stays disabled")

        // Reviews push onto the same stack, then pop back with standard back.
        let openReviews = try XCTUnwrap(
            ViewHierarchy.find("demo.store.detail_open_reviews", in: detail.view) as? UIButton
        )
        openReviews.sendActions(for: .touchUpInside)
        settle()
        XCTAssertTrue(navigation.viewControllers.last is StoreReviewsViewController)
        navigation.popViewController(animated: false)
        navigation.popViewController(animated: false)
        settle()
        XCTAssertTrue(navigation.viewControllers.last is StoreShopViewController)

        // The profile "tab" is a push on the same stack, and the shop tab pops.
        let profileTab = try XCTUnwrap(
            ViewHierarchy.find("demo.store.tab_profile", in: shop.view) as? UIButton
        )
        profileTab.sendActions(for: .touchUpInside)
        settle()
        let profile = try XCTUnwrap(navigation.viewControllers.last as? StoreProfileViewController)
        layout(profile)
        XCTAssertTrue(
            ViewHierarchy.nodeIDs(in: profile.view).contains("demo.store.profile_header")
        )
        let shopTab = try XCTUnwrap(
            ViewHierarchy.find("demo.store.tab_shop", in: profile.view) as? UIButton
        )
        shopTab.sendActions(for: .touchUpInside)
        settle()
        XCTAssertTrue(navigation.viewControllers.last is StoreShopViewController)
    }

    func testEntryShopScreenToleratesAPopAttempt() throws {
        let shop = try makeShopController()
        let navigation = UINavigationController(rootViewController: shop)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        layout(shop)
        settle()

        XCTAssertTrue(shop.navigationItem.hidesBackButton)
        XCTAssertNil(navigation.popViewController(animated: false))
        settle()
        XCTAssertTrue(navigation.viewControllers.last is StoreShopViewController)
    }

    /// Lets in-flight navigation transitions finish on the main run loop.
    private func settle(_ interval: TimeInterval = 0.6) {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: interval))
    }
}
