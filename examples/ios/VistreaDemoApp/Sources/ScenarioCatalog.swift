import Foundation

enum ScenarioCatalogError: Error, CustomStringConvertible {
    case missingResource(String)
    case manifestEntryMismatch(expected: String, actual: String)

    var description: String {
        switch self {
        case let .missingResource(name):
            "Missing bundled scenario resource: \(name)"
        case let .manifestEntryMismatch(expected, actual):
            "Scenario fixture ID \(actual) does not match manifest ID \(expected)."
        }
    }
}
struct ScenarioCatalog: Sendable {
    let suiteID: String
    let scenarios: [ScenarioDefinition]

    static func load(bundle: Bundle = .main) throws -> ScenarioCatalog {
        guard let manifestURL = bundle.url(forResource: "manifest", withExtension: "json") else {
            throw ScenarioCatalogError.missingResource("manifest.json")
        }
        let decoder = JSONDecoder()
        let manifest = try decoder.decode(
            ScenarioManifest.self,
            from: Data(contentsOf: manifestURL)
        )
        let scenarios = try manifest.scenarios.map { entry in
            let filename = URL(fileURLWithPath: entry.file).deletingPathExtension().lastPathComponent
            let subdirectory = URL(fileURLWithPath: entry.file).deletingLastPathComponent().lastPathComponent
            guard let fixtureURL = bundle.url(
                forResource: filename,
                withExtension: "json",
                subdirectory: subdirectory
            ) else {
                throw ScenarioCatalogError.missingResource(entry.file)
            }
            let scenario = try decoder.decode(
                ScenarioDefinition.self,
                from: Data(contentsOf: fixtureURL)
            )
            guard scenario.scenarioID == entry.scenarioID else {
                throw ScenarioCatalogError.manifestEntryMismatch(
                    expected: entry.scenarioID,
                    actual: scenario.scenarioID
                )
            }
            return scenario
        }
        return ScenarioCatalog(suiteID: manifest.suiteID, scenarios: scenarios)
    }

    func scenario(id: String) -> ScenarioDefinition? {
        scenarios.first { $0.scenarioID == id }
    }
}
