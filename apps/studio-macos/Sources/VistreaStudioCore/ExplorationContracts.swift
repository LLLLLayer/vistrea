import Foundation

// MARK: - Exploration run command

/// The `POST /v1/exploration/operations` command body.
///
/// Exploration runs as a background Host Operation over the configured
/// device automation provider; Studio only submits the bounded walk budget.
public struct ExplorationRunCommand: Encodable, Equatable, Sendable {
    public let maximumActions: Int
    public let maximumDepth: Int?
    public let settleMilliseconds: Int?
    public let excludedStableIDs: [String]?
    public let actorID: String?

    public init(
        maximumActions: Int,
        maximumDepth: Int? = nil,
        settleMilliseconds: Int? = nil,
        excludedStableIDs: [String]? = nil,
        actorID: String? = nil
    ) {
        self.maximumActions = maximumActions
        self.maximumDepth = maximumDepth
        self.settleMilliseconds = settleMilliseconds
        self.excludedStableIDs = excludedStableIDs
        self.actorID = actorID
    }

    private enum CodingKeys: String, CodingKey {
        case maximumActions = "maximum_actions"
        case maximumDepth = "maximum_depth"
        case settleMilliseconds = "settle_milliseconds"
        case excludedStableIDs = "excluded_stable_ids"
        case actorID = "actor_id"
    }
}

// MARK: - Exploration operation projections

/// A lenient projection of one canonical Operation error.
public struct ExplorationOperationError: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    private enum CodingKeys: String, CodingKey {
        case code
        case message
    }
}

/// A lenient projection of one canonical OperationRef.
public struct ExplorationOperationRef: Decodable, Equatable, Sendable, Identifiable {
    public let operationID: String
    public let kind: String
    public let state: String
    public let createdAt: String
    public let updatedAt: String
    public let error: ExplorationOperationError?

    public var id: String { operationID }

    /// True once the Operation reached a terminal state.
    public var isTerminal: Bool {
        state == "succeeded" || state == "failed" || state == "cancelled"
    }

    public init(
        operationID: String,
        kind: String,
        state: String,
        createdAt: String,
        updatedAt: String,
        error: ExplorationOperationError? = nil
    ) {
        self.operationID = operationID
        self.kind = kind
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case operationID = "operation_id"
        case kind
        case state
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case error
    }
}

/// A lenient projection of one canonical OperationProgress value.
public struct ExplorationProgressSummary: Decodable, Equatable, Sendable {
    public let phase: String?
    public let completedUnits: UInt64?
    public let totalUnits: UInt64?
    public let unit: String?
    public let message: String?

    public init(
        phase: String? = nil,
        completedUnits: UInt64? = nil,
        totalUnits: UInt64? = nil,
        unit: String? = nil,
        message: String? = nil
    ) {
        self.phase = phase
        self.completedUnits = completedUnits
        self.totalUnits = totalUnits
        self.unit = unit
        self.message = message
    }

    private enum CodingKeys: String, CodingKey {
        case phase
        case completedUnits = "completed_units"
        case totalUnits = "total_units"
        case unit
        case message
    }
}

/// A lenient projection of one canonical OperationEvent.
public struct ExplorationOperationEventSummary: Decodable, Equatable, Sendable, Identifiable {
    public let sequence: UInt64
    public let time: String
    public let kind: String
    public let state: String
    public let progress: ExplorationProgressSummary?
    public let message: String?
    public let error: ExplorationOperationError?

    public var id: UInt64 { sequence }

    public init(
        sequence: UInt64,
        time: String,
        kind: String,
        state: String,
        progress: ExplorationProgressSummary? = nil,
        message: String? = nil,
        error: ExplorationOperationError? = nil
    ) {
        self.sequence = sequence
        self.time = time
        self.kind = kind
        self.state = state
        self.progress = progress
        self.message = message
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case sequence
        case time
        case kind
        case state
        case progress
        case message
        case error
    }
}

/// A lenient summary of the ExplorationReport an exploration Operation
/// produces when it succeeds: how many states it discovered, how many real
/// actions it executed, and why the walk stopped.
public struct ExplorationReportSummary: Decodable, Equatable, Sendable {
    public let discoveredStateIDs: [String]
    public let actionCount: Int
    public let stoppedReason: String

    public init(discoveredStateIDs: [String], actionCount: Int, stoppedReason: String) {
        self.discoveredStateIDs = discoveredStateIDs
        self.actionCount = actionCount
        self.stoppedReason = stoppedReason
    }

    private enum CodingKeys: String, CodingKey {
        case discoveredStateIDs = "discovered_state_ids"
        case actionCount = "action_count"
        case stoppedReason = "stopped_reason"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        discoveredStateIDs =
            try container.decodeIfPresent([String].self, forKey: .discoveredStateIDs) ?? []
        actionCount = try container.decodeIfPresent(Int.self, forKey: .actionCount) ?? 0
        stoppedReason =
            try container.decodeIfPresent(String.self, forKey: .stoppedReason) ?? "unknown"
    }
}

/// A lenient projection of one canonical OperationRecord for exploration:
/// the current ref, the persisted event history, and the inline
/// ExplorationReport summary once the run succeeded.
public struct ExplorationOperationRecord: Decodable, Equatable, Sendable {
    public let operation: ExplorationOperationRef
    public let revision: UInt64
    public let events: [ExplorationOperationEventSummary]
    public let report: ExplorationReportSummary?

    public init(
        operation: ExplorationOperationRef,
        revision: UInt64,
        events: [ExplorationOperationEventSummary],
        report: ExplorationReportSummary? = nil
    ) {
        self.operation = operation
        self.revision = revision
        self.events = events
        self.report = report
    }

    /// The most recent progress any event reported.
    public var latestProgress: ExplorationProgressSummary? {
        events.reversed().first(where: { $0.progress != nil })?.progress
    }

    /// The most recent human-readable event message, preferring the event's
    /// own message and falling back to its progress message.
    public var latestEventMessage: String? {
        events.reversed().compactMap { $0.message ?? $0.progress?.message }.first
    }

    private enum CodingKeys: String, CodingKey {
        case operation
        case revision
        case events
        case result
    }

    /// The inline OperationResult reduced to the exploration report.
    private struct ResultProjection: Decodable {
        let resultType: String?
        let report: ExplorationReportSummary?

        private enum CodingKeys: String, CodingKey {
            case resultType = "result_type"
            case value
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            resultType = try container.decodeIfPresent(String.self, forKey: .resultType)
            report = resultType == "ExplorationReport"
                ? try container.decodeIfPresent(ExplorationReportSummary.self, forKey: .value)
                : nil
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        operation = try container.decode(ExplorationOperationRef.self, forKey: .operation)
        revision = try container.decode(UInt64.self, forKey: .revision)
        events = try container.decode([ExplorationOperationEventSummary].self, forKey: .events)
        report = try container.decodeIfPresent(ResultProjection.self, forKey: .result)?.report
    }
}
