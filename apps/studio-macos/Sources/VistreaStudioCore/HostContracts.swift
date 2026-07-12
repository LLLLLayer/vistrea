import Foundation
import VistreaRuntimeModels

public enum HostReadiness: String, Codable, Equatable, Sendable {
    case ready
    case degraded
}

public struct HostStatus: Codable, Equatable, Sendable {
    public let status: HostReadiness
    public let runtimeConnected: Bool
    public let message: String?

    public init(status: HostReadiness, runtimeConnected: Bool, message: String? = nil) {
        self.status = status
        self.runtimeConnected = runtimeConnected
        self.message = message
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case status
        case runtimeConnected = "runtime_connected"
        case message
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(HostReadiness.self, forKey: .status)
        runtimeConnected = try container.decode(Bool.self, forKey: .runtimeConnected)
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }
}

public struct SnapshotSummary: Codable, Equatable, Sendable {
    public let snapshotID: SnapshotID
    public let capturedAt: EventTime
    public let runtimeContext: RuntimeContext

    public init(snapshotID: SnapshotID, capturedAt: EventTime, runtimeContext: RuntimeContext) {
        self.snapshotID = snapshotID
        self.capturedAt = capturedAt
        self.runtimeContext = runtimeContext
    }

    public init(snapshot: RuntimeSnapshot) {
        self.init(
            snapshotID: snapshot.snapshotID,
            capturedAt: snapshot.capturedAt,
            runtimeContext: snapshot.runtimeContext
        )
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case snapshotID = "snapshot_id"
        case capturedAt = "captured_at"
        case runtimeContext = "runtime_context"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        snapshotID = try container.decode(SnapshotID.self, forKey: .snapshotID)
        capturedAt = try container.decode(EventTime.self, forKey: .capturedAt)
        runtimeContext = try container.decode(RuntimeContext.self, forKey: .runtimeContext)
    }
}

public struct SnapshotPage: Codable, Equatable, Sendable {
    public let items: [SnapshotSummary]
    public let nextCursor: String?
    public let snapshotVersion: String?

    public init(
        items: [SnapshotSummary],
        nextCursor: String? = nil,
        snapshotVersion: String? = nil
    ) {
        self.items = items
        self.nextCursor = nextCursor
        self.snapshotVersion = snapshotVersion
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case items
        case nextCursor = "next_cursor"
        case snapshotVersion = "snapshot_version"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([SnapshotSummary].self, forKey: .items)
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
        snapshotVersion = try container.decodeIfPresent(String.self, forKey: .snapshotVersion)
    }
}

public struct CaptureInclude: Encodable, Equatable, Sendable {
    public let paths: [String]

    public init(paths: [String]) {
        self.paths = paths
    }
}

public enum CaptureScreenshotMode: String, Encodable, Equatable, Sendable {
    case none
    case reference
}

public enum CaptureReason: String, Encodable, Equatable, Sendable {
    case manual
    case beforeAction = "before_action"
    case afterAction = "after_action"
    case review
    case validation
}

public struct CaptureRequest: Encodable, Equatable, Sendable {
    public let include: CaptureInclude?
    public let screenshot: CaptureScreenshotMode?
    public let reason: CaptureReason?

    public init(
        include: CaptureInclude? = nil,
        screenshot: CaptureScreenshotMode? = nil,
        reason: CaptureReason? = nil
    ) {
        self.include = include
        self.screenshot = screenshot
        self.reason = reason
    }
}

public struct ObjectByteRange: Equatable, Sendable {
    public let lowerBound: UInt64
    public let upperBound: UInt64?

    public init(lowerBound: UInt64, upperBound: UInt64? = nil) throws {
        if let upperBound, upperBound < lowerBound {
            throw HostClientError.invalidRange
        }
        self.lowerBound = lowerBound
        self.upperBound = upperBound
    }

    var headerValue: String {
        if let upperBound {
            return "bytes=\(lowerBound)-\(upperBound)"
        }
        return "bytes=\(lowerBound)-"
    }
}

public protocol HostClient: Sendable {
    func getStatus() async throws -> HostStatus
    func listSnapshots() async throws -> SnapshotPage
    func getSnapshot(id: String) async throws -> RuntimeSnapshot
    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data
    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot
}

public enum HostClientError: Error, Equatable, Sendable {
    case invalidConfiguration(String)
    case invalidIdentifier(String)
    case invalidRange
    case invalidResponse
    case responseTooLarge(limit: Int)
    case decoding(String)
    case integrity(String)
    case transport(String)
    case server(
        statusCode: Int,
        requestID: String?,
        code: String,
        message: String,
        retryable: Bool
    )
    case fixtureUnavailable(String)
}

extension HostClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message):
            return message
        case let .invalidIdentifier(value):
            return "The Host resource identifier is invalid: \(value)"
        case .invalidRange:
            return "The requested Object byte range is invalid."
        case .invalidResponse:
            return "The Host returned a non-HTTP or otherwise invalid response."
        case let .responseTooLarge(limit):
            return "The Host response exceeded the \(limit)-byte client limit."
        case let .decoding(message):
            return "The Host response did not match its contract: \(message)"
        case let .integrity(message):
            return "The Host Object response failed integrity validation: \(message)"
        case let .transport(message):
            return "The Host could not be reached: \(message)"
        case let .server(_, _, _, message, _):
            return message
        case let .fixtureUnavailable(message):
            return message
        }
    }
}

struct HostErrorEnvelope: Decodable {
    let requestID: String
    let error: HostErrorBody

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case requestID = "request_id"
        case error
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestID = try container.decode(String.self, forKey: .requestID)
        error = try container.decode(HostErrorBody.self, forKey: .error)
    }
}

struct HostErrorBody: Decodable {
    let code: String
    let message: String
    let retryable: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case code
        case message
        case retryable
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        retryable = try container.decode(Bool.self, forKey: .retryable)
    }
}

private struct StudioDynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private extension Decoder {
    func rejectStudioUnknownKeys<Keys>(_ keys: Keys.Type) throws
    where Keys: CodingKey & CaseIterable, Keys.AllCases: Collection {
        let container = try self.container(keyedBy: StudioDynamicCodingKey.self)
        let allowed = Set(Keys.allCases.map(\.stringValue))
        let unknown = container.allKeys.map(\.stringValue).filter { !allowed.contains($0) }.sorted()
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: codingPath,
                    debugDescription: "Unknown core fields: \(unknown.joined(separator: ", "))"
                )
            )
        }
    }
}
