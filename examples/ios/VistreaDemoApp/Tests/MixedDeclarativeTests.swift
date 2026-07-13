import SwiftUI
import UIKit
import XCTest
@testable import VistreaDemoApp

/// Unit coverage stays on the UIKit shell and the deterministic model.
/// Captured SwiftUI content is only observable while an accessibility
/// runtime is active (the UI test covers that path), so these tests never
/// assert synthesized SwiftUI nodes.
@MainActor
final class MixedDeclarativeTests: XCTestCase {
    func testStatusTextTogglesDeterministically() {
        let model = MixedDeclarativeModel()
        XCTAssertEqual(model.statusText, "Status: ready")
        model.toggle()
        XCTAssertEqual(model.statusText, "Status: engaged")
        model.toggle()
        XCTAssertEqual(model.statusText, "Status: ready")
    }

    func testControllerHostsTheSwiftUIScreenInsideTheScenarioContainer() throws {
        let catalog = try ScenarioCatalog.load()
        let scenario = try XCTUnwrap(catalog.scenario(id: "demo.mixed.declarative"))
        let controller = MixedDeclarativeViewController(scenario: scenario, profile: "baseline")
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.view.layoutIfNeeded()

        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.mixed.root")
        let hosting = try XCTUnwrap(
            controller.children.first as? UIHostingController<MixedDeclarativeScreen>
        )
        XCTAssertTrue(hosting.view.isDescendant(of: controller.view))
    }
}
