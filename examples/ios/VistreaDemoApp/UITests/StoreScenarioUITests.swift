import XCTest

final class StoreScenarioUITests: XCTestCase {
    @MainActor
    private func launch(scenarioID: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["VISTREA_SCENARIO_ID"] = scenarioID
        app.launchEnvironment["VISTREA_SCENARIO_PROFILE"] = "baseline"
        app.launch()
        return app
    }

    @MainActor
    func testStorefrontDeepNavigationAndTabReturn() throws {
        let app = launch(scenarioID: "demo.store.navigation")

        let featured = app.buttons["demo.store.catalog_item_primary"]
        XCTAssertTrue(featured.waitForExistence(timeout: 5))
        let catalog = app.scrollViews["demo.store.catalog_list"]
        XCTAssertTrue(catalog.exists)

        // The featured card is pinned above the scrolling catalog.
        catalog.swipeUp()
        XCTAssertTrue(featured.exists)

        featured.tap()
        let openReviews = app.buttons["demo.store.detail_open_reviews"]
        XCTAssertTrue(openReviews.waitForExistence(timeout: 3))
        let addToCart = app.buttons["demo.store.detail_add_to_cart"]
        XCTAssertTrue(addToCart.exists)
        XCTAssertFalse(addToCart.isEnabled)

        openReviews.tap()
        XCTAssertTrue(app.staticTexts["demo.store.review_item_primary"].waitForExistence(timeout: 3))

        // Standard back pops reviews -> detail -> shop on one stack.
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(openReviews.waitForExistence(timeout: 3))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(featured.waitForExistence(timeout: 3))

        // The profile "tab" pushes; the shop tab returns.
        app.buttons["demo.store.tab_profile"].tap()
        XCTAssertTrue(app.staticTexts["demo.store.profile_header"].waitForExistence(timeout: 3))
        app.buttons["demo.store.tab_shop"].tap()
        XCTAssertTrue(featured.waitForExistence(timeout: 3))
    }

    @MainActor
    func testSheetPresentsChoosesAndDismissesInTree() throws {
        let app = launch(scenarioID: "demo.store.sheet")

        let open = app.buttons["demo.sheet.open"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        let container = app.otherElements["demo.sheet.container"]
        XCTAssertFalse(container.exists)

        open.tap()
        XCTAssertTrue(container.waitForExistence(timeout: 3))
        app.buttons["demo.sheet.option_primary"].tap()
        XCTAssertTrue(app.staticTexts["Sort: Price low to high"].waitForExistence(timeout: 3))
        XCTAssertFalse(container.exists)

        open.tap()
        XCTAssertTrue(container.waitForExistence(timeout: 3))
        app.buttons["demo.sheet.dismiss"].tap()
        XCTAssertFalse(container.exists)
        XCTAssertTrue(open.exists)
    }

    @MainActor
    func testCartTogglesBetweenEmptyAndPopulatedStructures() throws {
        let app = launch(scenarioID: "demo.store.cart-states")

        let emptyNotice = app.staticTexts["demo.cart.empty_notice"]
        XCTAssertTrue(emptyNotice.waitForExistence(timeout: 5))

        app.buttons["demo.cart.add_sample"].tap()
        let itemPrimary = app.buttons["demo.cart.item_primary"]
        XCTAssertTrue(itemPrimary.waitForExistence(timeout: 3))
        let checkout = app.buttons["demo.cart.checkout"]
        XCTAssertTrue(checkout.exists)
        XCTAssertFalse(checkout.isEnabled)
        XCTAssertFalse(emptyNotice.exists)

        itemPrimary.tap()
        XCTAssertTrue(emptyNotice.waitForExistence(timeout: 3))
        XCTAssertFalse(itemPrimary.exists)
    }

    @MainActor
    func testMixedDeclarativeExposesStableNodesAndTogglesStatus() throws {
        let app = launch(scenarioID: "demo.mixed.declarative")

        let header = app.staticTexts["demo.mixed.header"]
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertTrue(app.otherElements["demo.mixed.featured_card"].exists)

        let status = app.staticTexts["demo.mixed.status"]
        XCTAssertTrue(status.exists)
        XCTAssertEqual(status.label, "Status: ready")

        app.buttons["demo.mixed.action"].tap()
        XCTAssertTrue(
            app.staticTexts["Status: engaged"].waitForExistence(timeout: 3),
            "tapping the action must toggle the status text without changing structure"
        )
        XCTAssertTrue(header.exists)
    }
}
