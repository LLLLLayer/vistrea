import XCTest
@testable import VistreaDemoApp

/// Freezes the shared scenario contract on iOS, mirroring the Android
/// `ScenarioContractTest`. Adding, removing, or reordering a required
/// scenario must fail here until the iOS Demo App implements it.
final class ScenarioContractTests: XCTestCase {
    private static let requiredScenarioIDs = [
        "demo.navigation.basic",
        "demo.form.validation",
        "demo.transient.success",
        "demo.loading.outcomes",
        "demo.modal.dialog",
        "demo.layout.occlusion",
        "demo.accessibility.defects",
        "demo.design.tuning",
        "demo.dynamic.normalization",
        "demo.safety.dangerous",
        "demo.version.new-feature",
        "demo.version.regression",
        "demo.store.navigation",
        "demo.store.search",
        "demo.store.sheet",
        "demo.store.cart-states",
        "demo.mixed.declarative",
    ]

    func testAllSeventeenRequiredScenarioIDsDecodeFromBundledFixtures() throws {
        let catalog = try ScenarioCatalog.load()
        XCTAssertEqual(catalog.suiteID, "vistrea.demo.shared")
        XCTAssertEqual(catalog.scenarios.map(\.scenarioID), Self.requiredScenarioIDs)

        let manifestURL = try XCTUnwrap(
            Bundle.main.url(forResource: "manifest", withExtension: "json")
        )
        let manifest = try JSONDecoder().decode(
            ScenarioManifest.self,
            from: Data(contentsOf: manifestURL)
        )
        XCTAssertEqual(manifest.scenarios.map(\.scenarioID), Self.requiredScenarioIDs)
        XCTAssertTrue(manifest.scenarios.allSatisfy(\.required))
    }

    func testEveryScenarioDefinesItsEntryStateAndLaunchStep() throws {
        let catalog = try ScenarioCatalog.load()
        for scenario in catalog.scenarios {
            XCTAssertNotNil(
                scenario.state(id: scenario.entryStateID),
                "\(scenario.scenarioID) is missing its entry state"
            )
            XCTAssertTrue(
                scenario.steps.contains { $0.action.kind == "launch" },
                "\(scenario.scenarioID) is missing a launch step"
            )
        }
    }

    @MainActor
    func testEveryRequiredScenarioResolvesToAnEntryController() throws {
        let catalog = try ScenarioCatalog.load()
        for scenario in catalog.scenarios {
            let controller = ScenarioEntryFactory.makeEntryViewController(
                scenario: scenario,
                profile: "baseline"
            )
            if ScenarioEntryFactory.dedicatedScenarioIDs.contains(scenario.scenarioID) {
                XCTAssertFalse(
                    controller is ScenarioStateViewController,
                    "\(scenario.scenarioID) must use its dedicated controller"
                )
            } else {
                XCTAssertTrue(
                    controller is ScenarioStateViewController,
                    "\(scenario.scenarioID) must use the generic fixture renderer"
                )
            }
        }
    }

    @MainActor
    func testDedicatedScenarioIDsAllExistInTheSharedManifest() throws {
        let catalog = try ScenarioCatalog.load()
        let knownIDs = Set(catalog.scenarios.map(\.scenarioID))
        XCTAssertTrue(ScenarioEntryFactory.dedicatedScenarioIDs.isSubset(of: knownIDs))
    }
}
