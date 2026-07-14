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
    /// Snapshot named by the canonical runtime target. Studio does not render
    /// the rest of the node target here, but fixture mode uses this identity
    /// to preserve Screen State-scoped list semantics.
    public let targetSnapshotID: String?

    public var id: String { issueID }

    public init(
        issueID: String,
        revision: UInt64,
        title: String,
        category: String,
        severity: String,
        state: String,
        updatedAt: String,
        targetSnapshotID: String? = nil
    ) {
        self.issueID = issueID
        self.revision = revision
        self.title = title
        self.category = category
        self.severity = severity
        self.state = state
        self.updatedAt = updatedAt
        self.targetSnapshotID = targetSnapshotID
    }

    private enum CodingKeys: String, CodingKey {
        case issueID = "issue_id"
        case revision
        case title
        case category
        case severity
        case state
        case updatedAt = "updated_at"
        case runtimeTarget = "runtime_target"
    }

    private enum RuntimeTargetCodingKeys: String, CodingKey {
        case snapshotID = "snapshot_id"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        issueID = try container.decode(String.self, forKey: .issueID)
        revision = try container.decode(UInt64.self, forKey: .revision)
        title = try container.decode(String.self, forKey: .title)
        category = try container.decode(String.self, forKey: .category)
        severity = try container.decode(String.self, forKey: .severity)
        state = try container.decode(String.self, forKey: .state)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        if container.contains(.runtimeTarget) {
            let target = try container.nestedContainer(
                keyedBy: RuntimeTargetCodingKeys.self,
                forKey: .runtimeTarget
            )
            targetSnapshotID = try target.decodeIfPresent(String.self, forKey: .snapshotID)
        } else {
            targetSnapshotID = nil
        }
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

/// A lenient Canvas projection of one persisted Screen State.
public struct CanvasStateSummary: Decodable, Equatable, Sendable, Identifiable {
    public let screenStateID: String
    public let title: String
    public let kind: String
    public let status: String
    /// The observations deduplicated into this state; identity curation
    /// splits move a strict subset of these into a new state.
    public let observationIDs: [String]
    /// The operator- or agent-written annotation labels. Annotations are
    /// knowledge, not identity: a canonical state may omit them entirely.
    public let labels: [String]
    /// The one-sentence annotation summary, at most 280 characters.
    public let summary: String?

    public var id: String { screenStateID }

    /// True while the state represents a live product screen. Merged, split,
    /// and deprecated tombstones stay in the graph for history but are not
    /// curation targets.
    public var isActive: Bool { status == "active" }

    public init(
        screenStateID: String,
        title: String,
        kind: String,
        status: String,
        observationIDs: [String] = [],
        labels: [String] = [],
        summary: String? = nil
    ) {
        self.screenStateID = screenStateID
        self.title = title
        self.kind = kind
        self.status = status
        self.observationIDs = observationIDs
        self.labels = labels
        self.summary = summary
    }

    private enum CodingKeys: String, CodingKey {
        case screenStateID = "screen_state_id"
        case title
        case kind
        case status
        case observationIDs = "observation_ids"
        case labels
        case summary
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        screenStateID = try container.decode(String.self, forKey: .screenStateID)
        title = try container.decode(String.self, forKey: .title)
        kind = try container.decode(String.self, forKey: .kind)
        status = try container.decode(String.self, forKey: .status)
        observationIDs = try container.decodeIfPresent([String].self, forKey: .observationIDs) ?? []
        labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
    }
}

/// A lenient Canvas projection of one observed Transition.
public struct CanvasTransitionSummary: Decodable, Equatable, Sendable, Identifiable {
    public let transitionID: String
    public let sourceStateID: String
    public let targetStateID: String
    public let occurrenceCount: UInt64

    public var id: String { transitionID }

    public init(
        transitionID: String,
        sourceStateID: String,
        targetStateID: String,
        occurrenceCount: UInt64
    ) {
        self.transitionID = transitionID
        self.sourceStateID = sourceStateID
        self.targetStateID = targetStateID
        self.occurrenceCount = occurrenceCount
    }

    private enum CodingKeys: String, CodingKey {
        case transitionID = "transition_id"
        case sourceStateID = "source_state_id"
        case targetStateID = "target_state_id"
        case occurrenceCount = "occurrence_count"
    }
}

/// The exact Application Version + Build projection attached by the Host to
/// an otherwise application-level materialized Screen Graph.
public struct CanvasBuildScope: Decodable, Equatable, Sendable {
    public let buildID: String
    public let applicationVersion: String
    public let screenStateIDs: [String]
    public let transitionIDs: [String]

    private enum CodingKeys: String, CodingKey {
        case buildID = "build_id"
        case applicationVersion = "application_version"
        case screenStateIDs = "screen_state_ids"
        case transitionIDs = "transition_ids"
    }
}

/// The materialized Screen Graph reduced to what the Canvas renders.
public struct CanvasGraph: Decodable, Equatable, Sendable {
    public let screenGraphID: String
    /// The materialized graph revision. Identity curation writes send it as
    /// `expected_graph_revision` so concurrent curation conflicts explicitly.
    public let revision: UInt64
    public let entryStateIDs: [String]
    public let states: [CanvasStateSummary]
    public let transitions: [CanvasTransitionSummary]
    public let buildScope: CanvasBuildScope?

    public init(
        screenGraphID: String,
        revision: UInt64 = 1,
        entryStateIDs: [String],
        states: [CanvasStateSummary],
        transitions: [CanvasTransitionSummary],
        buildScope: CanvasBuildScope? = nil
    ) {
        self.screenGraphID = screenGraphID
        self.revision = revision
        self.entryStateIDs = entryStateIDs
        self.states = states
        self.transitions = transitions
        self.buildScope = buildScope
    }

    private enum CodingKeys: String, CodingKey {
        case screenGraphID = "screen_graph_id"
        case revision
        case entryStateIDs = "entry_state_ids"
        case states
        case transitions
        case extensions
    }

    private struct Extensions: Decodable {
        let buildScope: CanvasBuildScope?

        private enum CodingKeys: String, CodingKey {
            case buildScope = "vistrea.build_scope"
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        screenGraphID = try container.decode(String.self, forKey: .screenGraphID)
        revision = try container.decode(UInt64.self, forKey: .revision)
        entryStateIDs = try container.decode([String].self, forKey: .entryStateIDs)
        let allStates = try container.decode([CanvasStateSummary].self, forKey: .states)
        let allTransitions = try container.decode(
            [CanvasTransitionSummary].self,
            forKey: .transitions
        )
        buildScope = try container.decodeIfPresent(Extensions.self, forKey: .extensions)?.buildScope
        if let buildScope {
            let stateIDs = Set(buildScope.screenStateIDs)
            let transitionIDs = Set(buildScope.transitionIDs)
            states = allStates.filter { stateIDs.contains($0.id) }
            transitions = allTransitions.filter { transitionIDs.contains($0.id) }
        } else {
            states = allStates
            transitions = allTransitions
        }
    }
}

/// A lenient projection of one Deep Wiki node.
public struct WikiNodeSummary: Decodable, Equatable, Sendable, Identifiable {
    public let wikiNodeID: String
    public let kind: String
    public let title: String
    public let summary: String?
    public let status: String
    public let labels: [String]

    public var id: String { wikiNodeID }

    public init(
        wikiNodeID: String,
        kind: String,
        title: String,
        summary: String?,
        status: String,
        labels: [String]
    ) {
        self.wikiNodeID = wikiNodeID
        self.kind = kind
        self.title = title
        self.summary = summary
        self.status = status
        self.labels = labels
    }

    private enum CodingKeys: String, CodingKey {
        case wikiNodeID = "wiki_node_id"
        case kind
        case title
        case summary
        case status
        case labels
    }
}

public struct WikiNodePage: Decodable, Equatable, Sendable {
    public let items: [WikiNodeSummary]
    public let nextCursor: String?

    public init(items: [WikiNodeSummary], nextCursor: String? = nil) {
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
    func listReviewIssues(states: [String]?, screenStateID: String?) async throws -> ReviewIssuePage
    func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph
    func getScreenGraph(
        projectID: String,
        applicationID: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> CanvasGraph
    func searchWikiNodes(text: String?) async throws -> WikiNodePage

    // Tuning preview writes (Debug-only Host capability).
    func createTuningPatch(_ draft: TuningPatchDraft) async throws -> TuningPatchSummary
    func applyTuningPatch(patchID: String, previewTTLMilliseconds: Int?) async throws -> TuningApplicationSummary
    func revertTuningApplication(id: String) async throws -> TuningApplicationSummary
    func listActiveTuningApplications() async throws -> TuningApplicationPage

    // Review Issue lifecycle writes.
    func getReviewIssue(id: String) async throws -> ReviewIssueSummary
    func transitionReviewIssue(
        id: String,
        _ request: ReviewIssueTransitionRequest
    ) async throws -> ReviewIssueSummary
    func createReviewIssueFromDifference(
        comparisonID: String,
        _ request: CreateReviewIssueFromDifferenceRequest
    ) async throws -> ReviewIssueSummary
    func recaptureAndVerifyReviewIssue(
        id: String,
        _ request: RecaptureReviewIssueRequest
    ) async throws -> RecaptureReviewIssueResult

    // Deep Wiki writes.
    func createWikiNode(_ draft: WikiNodeDraft) async throws -> WikiNodeDetail
    func getWikiNode(id: String) async throws -> WikiNodeDetail
    func reviseWikiNode(id: String, _ draft: WikiNodeRevisionDraft) async throws -> WikiNodeDetail

    // Canvas Screen State details and knowledge links.
    func getScreenState(id: String) async throws -> ScreenStateDetail
    func getScreenState(
        id: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> ScreenStateDetail
    func createWikiLink(_ draft: WikiLinkDraft) async throws -> WikiLinkSummary
    func relatedWikiNodes(kind: String, id: String) async throws -> WikiNodePage

    // Canvas identity curation writes, guarded by the graph revision.
    func mergeScreenStates(_ command: MergeScreenStatesCommand) async throws -> IdentityCurationResult
    func splitScreenState(_ command: SplitScreenStateCommand) async throws -> IdentityCurationResult

    // Screen State annotation write, guarded by the same graph revision.
    func annotateScreenState(
        _ command: AnnotateScreenStateCommand
    ) async throws -> ScreenStateAnnotationResult

    // Design comparison workbench.
    func listDesignReferences() async throws -> DesignReferencePage
    func getDesignReference(id: String) async throws -> DesignReferenceDetail
    func listDesignComparisons(
        designReferenceID: String?,
        targetSnapshotID: String?
    ) async throws -> DesignComparisonPage
    func runDesignComparison(_ command: DesignComparisonCommand) async throws -> DesignComparisonDetail

    // Exploration Operations over the configured device automation provider.
    // A Host without an automation provider rejects these routes with
    // HTTP 501 code "unsupported".
    func runExploration(_ command: ExplorationRunCommand) async throws -> ExplorationOperationRef
    func getExplorationOperation(id: String) async throws -> ExplorationOperationRecord
    func cancelExploration(id: String) async throws -> ExplorationOperationRef
}

public extension HostClient {
    func listReviewIssues(
        states: [String]?,
        screenStateID: String?
    ) async throws -> ReviewIssuePage {
        try await listReviewIssues(states: states)
    }

    func getScreenGraph(
        projectID: String,
        applicationID: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> CanvasGraph {
        try await getScreenGraph(projectID: projectID, applicationID: applicationID)
    }

    func getScreenState(
        id: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> ScreenStateDetail {
        try await getScreenState(id: id)
    }
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
