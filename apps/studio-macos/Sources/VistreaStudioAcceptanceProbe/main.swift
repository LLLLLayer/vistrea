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
            let persistedAcceptance = try persistedAcceptanceValues(environment)
            let result = try await StudioCoreAcceptanceWorkflow.run(
                client: client,
                request: StudioCoreAcceptanceRequest(
                    expectedSnapshotID: expectedSnapshotID,
                    requireConnectedRuntime: persistedAcceptance == nil,
                    expectedCollectionID: persistedAcceptance?.collectionID,
                    expectedTuningPatchID: persistedAcceptance?.tuningPatchID,
                    leftBuildID: persistedAcceptance?.leftBuildID,
                    rightBuildID: persistedAcceptance?.rightBuildID
                )
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

    private struct PersistedAcceptanceValues {
        let collectionID: String
        let tuningPatchID: String
        let leftBuildID: String
        let rightBuildID: String
    }

    private static func persistedAcceptanceValues(
        _ environment: [String: String]
    ) throws -> PersistedAcceptanceValues? {
        let values = [
            environment["VISTREA_COLLECTION_ID"],
            environment["VISTREA_TUNING_PATCH_ID"],
            environment["VISTREA_LEFT_BUILD_ID"],
            environment["VISTREA_RIGHT_BUILD_ID"],
        ]
        if values.allSatisfy({ $0 == nil }) {
            return nil
        }
        guard let collectionID = values[0], !collectionID.isEmpty,
              let tuningPatchID = values[1], !tuningPatchID.isEmpty,
              let leftBuildID = values[2], !leftBuildID.isEmpty,
              let rightBuildID = values[3], !rightBuildID.isEmpty
        else {
            throw HostClientError.invalidConfiguration(
                "Persisted acceptance requires Collection, tuning patch, and both Build IDs."
            )
        }
        return PersistedAcceptanceValues(
            collectionID: collectionID,
            tuningPatchID: tuningPatchID,
            leftBuildID: leftBuildID,
            rightBuildID: rightBuildID
        )
    }
}
