import XCTest
@testable import VistreaDemoApp

final class StoreCatalogTests: XCTestCase {
    func testCatalogHasFiftyDeterministicItems() {
        XCTAssertEqual(StoreCatalog.items.count, 50)
        XCTAssertEqual(StoreCatalog.items[0], StoreCatalogItem(name: "Aurora Lamp", price: "$19.00"))
        XCTAssertEqual(StoreCatalog.featuredItem, StoreCatalog.items[0])
        XCTAssertEqual(StoreCatalog.items, StoreCatalog.items)
    }

    func testBlankQueryReturnsTheCompleteCatalog() {
        XCTAssertEqual(StoreCatalog.matches(query: ""), StoreCatalog.items)
        XCTAssertEqual(StoreCatalog.matches(query: "   "), StoreCatalog.items)
    }

    func testMatchingAliasFiltersToAtLeastOneItemIncludingThePrimary() throws {
        let query = try XCTUnwrap(ScenarioInputAliases.text(for: "QUERY_MATCHING"))
        let matches = StoreCatalog.matches(query: query)
        XCTAssertEqual(matches.count, 5)
        XCTAssertEqual(matches.first?.name, "Aurora Lamp")
        XCTAssertEqual(StoreCatalog.matches(query: query.lowercased()), matches)
    }

    func testUnmatchedAliasFiltersToNoItems() throws {
        let query = try XCTUnwrap(ScenarioInputAliases.text(for: "QUERY_UNMATCHED"))
        XCTAssertTrue(StoreCatalog.matches(query: query).isEmpty)
    }

    func testInputAliasesResolveDeterministically() {
        XCTAssertEqual(ScenarioInputAliases.text(for: "VALID_NAME"), "Ada Lovelace")
        XCTAssertEqual(ScenarioInputAliases.text(for: "QUERY_MATCHING"), "Aurora")
        XCTAssertEqual(ScenarioInputAliases.text(for: "QUERY_UNMATCHED"), "Obsidian")
        XCTAssertNil(ScenarioInputAliases.text(for: "UNKNOWN_ALIAS"))
    }
}
