import UIKit

/// Routes a scenario ID to its entry view controller. The five storefront and
/// declarative scenarios need dedicated behavior (snap scrolling, filtering,
/// in-tree overlays, structural cart states, hosted SwiftUI); every other
/// scenario renders through the generic data-driven fixture renderer.
@MainActor
enum ScenarioEntryFactory {
    /// Scenario IDs with dedicated controllers. All other required scenarios
    /// are covered by the generic renderer.
    static let dedicatedScenarioIDs: Set<String> = [
        "demo.store.navigation",
        "demo.store.search",
        "demo.store.sheet",
        "demo.store.cart-states",
        "demo.mixed.declarative",
    ]

    static func makeEntryViewController(
        scenario: ScenarioDefinition,
        profile: String
    ) -> UIViewController {
        switch scenario.scenarioID {
        case "demo.store.navigation":
            StoreShopViewController(scenario: scenario, profile: profile)
        case "demo.store.search":
            StoreSearchViewController(scenario: scenario, profile: profile)
        case "demo.store.sheet":
            StoreSheetViewController(scenario: scenario, profile: profile)
        case "demo.store.cart-states":
            StoreCartViewController(scenario: scenario, profile: profile)
        case "demo.mixed.declarative":
            MixedDeclarativeViewController(scenario: scenario, profile: profile)
        default:
            ScenarioStateViewController(
                scenario: scenario,
                stateID: scenario.entryStateID,
                profile: profile
            )
        }
    }
}
