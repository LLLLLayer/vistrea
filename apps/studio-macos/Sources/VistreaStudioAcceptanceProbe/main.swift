import Darwin
import Foundation
import VistreaStudioCore

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
            let result = try await StudioCoreAcceptanceWorkflow.run(
                client: client,
                request: StudioCoreAcceptanceRequest(expectedSnapshotID: expectedSnapshotID)
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
