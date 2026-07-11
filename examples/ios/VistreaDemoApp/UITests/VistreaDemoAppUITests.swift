import XCTest

final class VistreaDemoAppUITests: XCTestCase {
    @MainActor
    func testNavigationScenarioAndRuntimeInspectorCaptureRealUIKitState() throws {
        let app = XCUIApplication()
        app.launchEnvironment["VISTREA_SCENARIO_ID"] = "demo.navigation.basic"
        app.launchEnvironment["VISTREA_SCENARIO_PROFILE"] = "baseline"
        app.launch()

        let openCatalog = app.buttons["demo.home.open_catalog"]
        XCTAssertTrue(openCatalog.waitForExistence(timeout: 5))
        openCatalog.tap()

        let catalogItem = app.buttons["demo.catalog.item_primary"]
        XCTAssertTrue(catalogItem.waitForExistence(timeout: 3))
        catalogItem.tap()

        XCTAssertTrue(app.buttons["demo.detail.open_form"].waitForExistence(timeout: 3))
        let inspect = app.buttons["vistrea.inspector.capture"]
        XCTAssertTrue(inspect.waitForExistence(timeout: 3))
        inspect.tap()

        let nodeList = app.tables["vistrea.inspector.node-list"]
        XCTAssertTrue(nodeList.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Runtime Inspector"].exists)
        XCTAssertTrue(nodeList.cells.count > 3)
    }
}
