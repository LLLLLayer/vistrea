import Foundation

/// One deterministic storefront catalog entry. Item text is content, not
/// identity: rows derived from these items never carry stable node IDs.
struct StoreCatalogItem: Equatable, Sendable {
    let name: String
    let price: String
}

/// The deterministic catalog shared by `demo.store.navigation` (the snapping
/// shop list) and `demo.store.search` (the filterable result list). The data
/// is a pure function of fixed word tables, so every launch, capture, and
/// platform observes the same fifty items in the same order.
enum StoreCatalog {
    static let itemCount = 50

    private static let families = [
        "Aurora", "Basalt", "Cedar", "Drift", "Ember",
        "Fjord", "Glacier", "Harbor", "Iris", "Juniper",
    ]
    private static let kinds = ["Lamp", "Chair", "Kettle", "Rug", "Vase"]

    /// The featured item pinned above the scrolling shop catalog.
    static var featuredItem: StoreCatalogItem {
        items[0]
    }

    static let items: [StoreCatalogItem] = (0..<itemCount).map { index in
        StoreCatalogItem(
            name: "\(families[index % families.count]) \(kinds[(index / families.count) % kinds.count])",
            price: "$\(19 + (index * 7) % 80).00"
        )
    }

    /// Case-insensitive substring filter over item names. A blank query is
    /// treated as no query and returns the complete catalog.
    static func matches(query: String) -> [StoreCatalogItem] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return items
        }
        return items.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    }
}

/// Deterministic text values behind the shared fixtures' `input_alias`
/// entries. Automation resolves an alias to the exact string it types, so the
/// mapping must stay stable across platforms and launches.
enum ScenarioInputAliases {
    static func text(for alias: String) -> String? {
        switch alias {
        case "VALID_NAME":
            "Ada Lovelace"
        case "QUERY_MATCHING":
            "Aurora"
        case "QUERY_UNMATCHED":
            "Obsidian"
        default:
            nil
        }
    }
}
