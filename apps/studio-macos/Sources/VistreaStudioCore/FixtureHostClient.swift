import Foundation
import VistreaRuntimeModels

public actor FixtureHostClient: HostClient {
    private let status: HostStatus
    private var snapshotsByID: [String: RuntimeSnapshot]
    private let objectsByHash: [String: Data]

    public init(
        snapshots: [RuntimeSnapshot],
        objectsByHash: [String: Data] = [:],
        status: HostStatus = HostStatus(status: .ready, runtimeConnected: true, message: "Canonical fixture")
    ) {
        self.status = status
        snapshotsByID = Dictionary(uniqueKeysWithValues: snapshots.map { ($0.snapshotID.rawValue, $0) })
        self.objectsByHash = objectsByHash
    }

    public func getStatus() async throws -> HostStatus {
        status
    }

    public func listSnapshots() async throws -> SnapshotPage {
        let items = snapshotsByID.values
            .sorted { $0.capturedAt.wallTime.rawValue > $1.capturedAt.wallTime.rawValue }
            .map(SnapshotSummary.init(snapshot:))
        return SnapshotPage(items: items, snapshotVersion: "fixture-v1")
    }

    public func getSnapshot(id: String) async throws -> RuntimeSnapshot {
        guard let snapshot = snapshotsByID[id] else {
            throw HostClientError.server(
                statusCode: 404,
                requestID: nil,
                code: "snapshot.not_found",
                message: "The fixture Snapshot does not exist.",
                retryable: false
            )
        }
        return snapshot
    }

    public func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        guard let data = objectsByHash[hash] else {
            throw HostClientError.server(
                statusCode: 404,
                requestID: nil,
                code: "object.not_found",
                message: "This canonical fixture references Object metadata but does not bundle the binary.",
                retryable: false
            )
        }
        guard let range else {
            return data
        }
        guard range.lowerBound < UInt64(data.count) else {
            throw HostClientError.invalidRange
        }
        let upperBound = min(range.upperBound ?? UInt64(data.count - 1), UInt64(data.count - 1))
        return data[Int(range.lowerBound)...Int(upperBound)]
    }

    public func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        guard let snapshot = snapshotsByID.values.max(by: {
            $0.capturedAt.wallTime.rawValue < $1.capturedAt.wallTime.rawValue
        }) else {
            throw HostClientError.fixtureUnavailable("The fixture Host has no Runtime Snapshot to capture.")
        }
        snapshotsByID[snapshot.snapshotID.rawValue] = snapshot
        return snapshot
    }
}

public struct UnavailableHostClient: HostClient {
    private let error: HostClientError

    public init(message: String) {
        error = .fixtureUnavailable(message)
    }

    public func getStatus() async throws -> HostStatus { throw error }
    public func listSnapshots() async throws -> SnapshotPage { throw error }
    public func getSnapshot(id: String) async throws -> RuntimeSnapshot { throw error }
    public func getObject(hash: String, range: ObjectByteRange?) async throws -> Data { throw error }
    public func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot { throw error }
}

public enum CanonicalFixtureLoader {
    public static let defaultRelativePath = "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"

    public static func loadSnapshot(at url: URL) throws -> RuntimeSnapshot {
        try RuntimeSnapshotCodec.decode(Data(contentsOf: url))
    }

    public static func loadDefaultSnapshot() throws -> RuntimeSnapshot {
        let fileManager = FileManager.default
        for candidate in defaultCandidates() where fileManager.fileExists(atPath: candidate.path) {
            return try loadSnapshot(at: candidate)
        }
        throw HostClientError.fixtureUnavailable(
            "The canonical Runtime Snapshot fixture could not be located. Set VISTREA_FIXTURE_PATH to an absolute fixture path."
        )
    }

    private static func defaultCandidates() -> [URL] {
        var candidates: [URL] = []
        if let override = ProcessInfo.processInfo.environment["VISTREA_FIXTURE_PATH"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override))
        }

        candidates.append(
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
                .appending(path: defaultRelativePath)
        )

        var repositoryRoot = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            repositoryRoot.deleteLastPathComponent()
        }
        candidates.append(repositoryRoot.appending(path: defaultRelativePath))
        return candidates
    }
}
