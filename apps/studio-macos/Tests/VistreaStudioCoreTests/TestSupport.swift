import Foundation
import VistreaRuntimeModels

enum StudioTestFixtures {
    static var repositoryRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            url.deleteLastPathComponent()
        }
        return url
    }

    static func data(_ relativePath: String) throws -> Data {
        try Data(contentsOf: repositoryRoot.appending(path: relativePath))
    }

    static func snapshot(
        _ relativePath: String = "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
    ) throws -> RuntimeSnapshot {
        try RuntimeSnapshotCodec.decode(try data(relativePath))
    }
}
