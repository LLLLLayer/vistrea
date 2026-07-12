import Foundation
import VistreaRuntimeModels

public enum HostReadiness: String, Codable, Equatable, Sendable {
    case ready
    case degraded
}

public enum RuntimeEventsPumpState: String, Codable, Equatable, Sendable {
    case idle
    case unsupported
    case running
    case stopped
    case failed
}

public struct RuntimeEventsStatus: Codable, Equatable, Sendable {
    public let state: RuntimeEventsPumpState
    public let eventEpochID: String?
    public let persistedThroughSequence: UInt64?
    public let errorCode: String?

    public init(
        state: RuntimeEventsPumpState,
        eventEpochID: String? = nil,
        persistedThroughSequence: UInt64? = nil,
        errorCode: String? = nil
    ) {
        self.state = state
        self.eventEpochID = eventEpochID
        self.persistedThroughSequence = persistedThroughSequence
        self.errorCode = errorCode
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case state
        case eventEpochID = "event_epoch_id"
        case persistedThroughSequence = "persisted_through_sequence"
        case errorCode = "error_code"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(RuntimeEventsPumpState.self, forKey: .state)
        eventEpochID = try container.decodeIfPresent(String.self, forKey: .eventEpochID)
        persistedThroughSequence = try container.decodeIfPresent(
            UInt64.self,
            forKey: .persistedThroughSequence
        )
        errorCode = try container.decodeIfPresent(String.self, forKey: .errorCode)
    }
}

public struct HostStatus: Codable, Equatable, Sendable {
    public let status: HostReadiness
    public let runtimeConnected: Bool
    public let runtimeEvents: RuntimeEventsStatus?
    public let message: String?

    public init(
        status: HostReadiness,
        runtimeConnected: Bool,
        runtimeEvents: RuntimeEventsStatus? = nil,
        message: String? = nil
    ) {
        self.status = status
        self.runtimeConnected = runtimeConnected
        self.runtimeEvents = runtimeEvents
        self.message = message
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case status
        case runtimeConnected = "runtime_connected"
        case runtimeEvents = "runtime_events"
        case message
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(HostReadiness.self, forKey: .status)
        runtimeConnected = try container.decode(Bool.self, forKey: .runtimeConnected)
        runtimeEvents = try container.decodeIfPresent(RuntimeEventsStatus.self, forKey: .runtimeEvents)
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }
}

public struct EventSequenceGap: Codable, Equatable, Sendable {
    public let firstSequence: UInt64
    public let lastSequence: UInt64

    public init(firstSequence: UInt64, lastSequence: UInt64) {
        self.firstSequence = firstSequence
        self.lastSequence = lastSequence
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case firstSequence = "first_sequence"
        case lastSequence = "last_sequence"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        firstSequence = try container.decode(UInt64.self, forKey: .firstSequence)
        lastSequence = try container.decode(UInt64.self, forKey: .lastSequence)
    }
}

public struct EventTimeline: Codable, Equatable, Sendable {
    public let eventEpochID: String?
    public let events: [RuntimeEvent]
    public let reportedGaps: [EventSequenceGap]

    public init(eventEpochID: String? = nil, events: [RuntimeEvent], reportedGaps: [EventSequenceGap]) {
        self.eventEpochID = eventEpochID
        self.events = events
        self.reportedGaps = reportedGaps
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case eventEpochID = "event_epoch_id"
        case events
        case reportedGaps = "reported_gaps"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventEpochID = try container.decodeIfPresent(String.self, forKey: .eventEpochID)
        events = try container.decode([RuntimeEvent].self, forKey: .events)
        reportedGaps = try container.decode([EventSequenceGap].self, forKey: .reportedGaps)
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

/// A presentation projection of one canonical Review Issue.
///
/// Studio lists issues without re-modeling the full protocol value, so this
/// summary deliberately tolerates additional canonical fields.
public struct ReviewIssueSummary: Decodable, Equatable, Sendable, Identifiable {
    public let issueID: String
    public let revision: UInt64
    public let title: String
    public let category: String
    public let severity: String
    public let state: String
    public let updatedAt: String

    public var id: String { issueID }

    public init(
        issueID: String,
        revision: UInt64,
        title: String,
        category: String,
        severity: String,
        state: String,
        updatedAt: String
    ) {
        self.issueID = issueID
        self.revision = revision
        self.title = title
        self.category = category
        self.severity = severity
        self.state = state
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case issueID = "issue_id"
        case revision
        case title
        case category
        case severity
        case state
        case updatedAt = "updated_at"
    }
}

public struct ReviewIssuePage: Decodable, Equatable, Sendable {
    public let items: [ReviewIssueSummary]
    public let nextCursor: String?

    public init(items: [ReviewIssueSummary], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}

public protocol HostClient: Sendable {
    func getStatus() async throws -> HostStatus
    func listSnapshots() async throws -> SnapshotPage
    func getSnapshot(id: String) async throws -> RuntimeSnapshot
    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data
    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot
    func getEventTimeline(eventEpochID: String?) async throws -> EventTimeline
    func listReviewIssues(states: [String]?) async throws -> ReviewIssuePage
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
