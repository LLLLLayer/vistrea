import UIKit
import XCTest
@testable import VistreaDemoApp

@MainActor
final class StoreSearchViewControllerTests: XCTestCase {
    private func makeLoadedController() throws -> (StoreSearchViewController, UITextField) {
        let catalog = try ScenarioCatalog.load()
        let scenario = try XCTUnwrap(catalog.scenario(id: "demo.store.search"))
        let controller = StoreSearchViewController(scenario: scenario, profile: "baseline")
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.view.layoutIfNeeded()
        let field = try XCTUnwrap(
            ViewHierarchy.find("demo.search.field", in: controller.view) as? UITextField
        )
        return (controller, field)
    }

    private func type(_ text: String, into field: UITextField) {
        field.text = text
        field.sendActions(for: .editingChanged)
    }

    func testEntryStateShowsFullCatalogResultsAndBrowseHint() throws {
        let (controller, _) = try makeLoadedController()
        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(ids.contains("demo.search.field"))
        XCTAssertTrue(ids.contains("demo.search.results"))
        XCTAssertTrue(ids.contains("demo.search.result_primary"))
        XCTAssertFalse(ids.contains("demo.search.empty_notice"))
        XCTAssertTrue(
            ViewHierarchy.labelTexts(in: controller.view)
                .contains("Browse all \(StoreCatalog.itemCount) items")
        )
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.search.root")
    }

    func testMatchingQueryFiltersResultsAndRemovesBrowseHint() throws {
        let (controller, field) = try makeLoadedController()
        let query = try XCTUnwrap(ScenarioInputAliases.text(for: "QUERY_MATCHING"))
        type(query, into: field)

        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(ids.contains("demo.search.result_primary"))
        XCTAssertFalse(ids.contains("demo.search.empty_notice"))
        XCTAssertFalse(
            ViewHierarchy.labelTexts(in: controller.view)
                .contains("Browse all \(StoreCatalog.itemCount) items")
        )
        let results = try XCTUnwrap(
            ViewHierarchy.find("demo.search.results", in: controller.view) as? UIScrollView
        )
        let rows = results.subviews
            .flatMap(\.subviews)
            .filter { $0 is SearchResultRowView }
        XCTAssertEqual(rows.count, StoreCatalog.matches(query: query).count)
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.search-filtered.root")
    }

    func testUnmatchedQueryShowsTheEmptyNotice() throws {
        let (controller, field) = try makeLoadedController()
        let query = try XCTUnwrap(ScenarioInputAliases.text(for: "QUERY_UNMATCHED"))
        type(query, into: field)

        let ids = ViewHierarchy.nodeIDs(in: controller.view)
        XCTAssertTrue(ids.contains("demo.search.empty_notice"))
        XCTAssertFalse(ids.contains("demo.search.results"))
        XCTAssertFalse(ids.contains("demo.search.result_primary"))
        XCTAssertEqual(controller.view.accessibilityIdentifier, "demo.state.search-empty.root")
    }

    func testClearingTheQueryRestoresTheExactEntryStructure() throws {
        let (controller, field) = try makeLoadedController()
        let entrySignature = ViewHierarchy.semanticSignature(of: controller.view)

        type(try XCTUnwrap(ScenarioInputAliases.text(for: "QUERY_MATCHING")), into: field)
        XCTAssertNotEqual(ViewHierarchy.semanticSignature(of: controller.view), entrySignature)
        type("", into: field)
        XCTAssertEqual(ViewHierarchy.semanticSignature(of: controller.view), entrySignature)

        type(try XCTUnwrap(ScenarioInputAliases.text(for: "QUERY_UNMATCHED")), into: field)
        XCTAssertNotEqual(ViewHierarchy.semanticSignature(of: controller.view), entrySignature)
        type("", into: field)
        XCTAssertEqual(ViewHierarchy.semanticSignature(of: controller.view), entrySignature)
    }
}
