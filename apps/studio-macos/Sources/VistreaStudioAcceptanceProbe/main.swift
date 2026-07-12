import Darwin
import Foundation
import VistreaStudioCore

private struct AcceptanceResult: Encodable {
    let snapshotID: String
    let scenarioID: String?
    let nodeCount: Int
    let screenshotHash: String?
    let screenshotByteCount: Int?
    let runtimeConnected: Bool

    private enum CodingKeys: String, CodingKey {
        case snapshotID = "snapshot_id"
        case scenarioID = "scenario_id"
        case nodeCount = "node_count"
        case screenshotHash = "screenshot_hash"
        case screenshotByteCount = "screenshot_byte_count"
        case runtimeConnected = "runtime_connected"
    }
}

@main
private enum VistreaStudioAcceptanceProbe {
    static func main() async {
        do {
            let environment = ProcessInfo.processInfo.environment
            guard let source = environment["VISTREA_HOST_URL"],
                  let url = URL(string: source),
                  let token = environment["VISTREA_HOST_TOKEN"],
                  let expectedSnapshotID = environment["VISTREA_SNAPSHOT_ID"]
            else {
                throw HostClientError.invalidConfiguration(
                    "The acceptance probe requires Host URL, token, and Snapshot ID environment values."
                )
            }
            let client = try HTTPHostClient(baseURL: url, bearerToken: token)
            async let statusValue = client.getStatus()
            async let snapshotValue = client.getSnapshot(id: expectedSnapshotID)
            let (status, snapshot) = try await (statusValue, snapshotValue)
            let presentation = try SnapshotPresentation(snapshot: snapshot)
            let screenshotBytes: Data?
            if let screenshot = snapshot.screenshot {
                screenshotBytes = try await client.getObject(hash: screenshot.object.hash, range: nil)
            } else {
                screenshotBytes = nil
            }
            let result = AcceptanceResult(
                snapshotID: presentation.id,
                scenarioID: presentation.scenarioID,
                nodeCount: presentation.tree.nodesByID.count,
                screenshotHash: presentation.screenshot?.hash,
                screenshotByteCount: screenshotBytes?.count,
                runtimeConnected: status.runtimeConnected
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            FileHandle.standardOutput.write(try encoder.encode(result))
            FileHandle.standardOutput.write(Data([0x0a]))
        } catch {
            // HostClientError descriptions never carry the bearer token; keep
            // the diagnostic on one line for log scraping.
            let reason = String(describing: error)
                .replacingOccurrences(of: "\n", with: " ")
            FileHandle.standardError.write(Data("Studio acceptance probe failed: \(reason)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
