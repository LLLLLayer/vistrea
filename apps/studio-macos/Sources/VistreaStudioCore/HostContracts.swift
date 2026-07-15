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

public enum HubSyncRole: String, Decodable, Equatable, Sendable {
    case viewer
    case contributor
    case reviewer
    case maintainer
    case admin
}

public enum HubSyncCredentialScope: String, Decodable, Equatable, Sendable {
    case project
    case team
}

public enum HubSyncRefRelation: String, Decodable, Equatable, Sendable {
    case synced
    case localOnly = "local_only"
    case remoteOnly = "remote_only"
    case localAhead = "local_ahead"
    case remoteAhead = "remote_ahead"
    case diverged
    case unknown
}

public struct HubSyncRemote: Encodable, Equatable, Sendable {
    public let baseURL: String
    public let projectID: String
    public let bearerToken: String

    public init(baseURL: String, projectID: String, bearerToken: String) {
        self.baseURL = baseURL
        self.projectID = projectID
        self.bearerToken = bearerToken
    }

    private enum CodingKeys: String, CodingKey {
        case baseURL = "base_url"
        case projectID = "project_id"
        case bearerToken = "bearer_token"
    }
}

public struct HubSyncActor: Encodable, Equatable, Sendable {
    public let kind: String
    public let id: String
    public let extensions: [String: String]

    public init(kind: String = "human", id: String = "vistrea-studio") {
        self.kind = kind
        self.id = id
        extensions = [:]
    }
}

public struct HubSyncPermissionSource: Decodable, Equatable, Sendable {
    public let scope: HubSyncCredentialScope
    public let role: HubSyncRole
    public let organizationID: String?
    public let teamID: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case scope
        case role
        case organizationID = "organization_id"
        case teamID = "team_id"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        scope = try container.decode(HubSyncCredentialScope.self, forKey: .scope)
        role = try container.decode(HubSyncRole.self, forKey: .role)
        organizationID = try container.decodeIfPresent(String.self, forKey: .organizationID)
        teamID = try container.decodeIfPresent(String.self, forKey: .teamID)
    }
}

public struct HubSyncIdentity: Decodable, Equatable, Sendable {
    public let principalID: String
    public let role: HubSyncRole
    public let capabilities: [String]
    public let credentialScope: HubSyncCredentialScope
    public let permissionSources: [HubSyncPermissionSource]
    public let organizationID: String?
    public let teamID: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case principalID = "principal_id"
        case role
        case capabilities
        case credentialScope = "credential_scope"
        case permissionSources = "permission_sources"
        case organizationID = "organization_id"
        case teamID = "team_id"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        principalID = try container.decode(String.self, forKey: .principalID)
        role = try container.decode(HubSyncRole.self, forKey: .role)
        capabilities = try container.decode([String].self, forKey: .capabilities)
        credentialScope = try container.decode(HubSyncCredentialScope.self, forKey: .credentialScope)
        permissionSources = try container.decode([HubSyncPermissionSource].self, forKey: .permissionSources)
        organizationID = try container.decodeIfPresent(String.self, forKey: .organizationID)
        teamID = try container.decodeIfPresent(String.self, forKey: .teamID)
    }
}

public struct HubSyncProjectAccess: Decodable, Equatable, Sendable, Identifiable {
    public let projectID: String
    public let organizationID: String?
    public let teamID: String?
    public let role: HubSyncRole
    public let capabilities: [String]

    public var id: String { projectID }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case projectID = "project_id"
        case organizationID = "organization_id"
        case teamID = "team_id"
        case role
        case capabilities
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projectID = try container.decode(String.self, forKey: .projectID)
        organizationID = try container.decodeIfPresent(String.self, forKey: .organizationID)
        teamID = try container.decodeIfPresent(String.self, forKey: .teamID)
        role = try container.decode(HubSyncRole.self, forKey: .role)
        capabilities = try container.decode([String].self, forKey: .capabilities)
    }
}

public struct HubSyncRefStatus: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let localCommitID: String?
    public let remoteCommitID: String?
    public let relation: HubSyncRefRelation

    public var id: String { name }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case name
        case localCommitID = "local_commit_id"
        case remoteCommitID = "remote_commit_id"
        case relation
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        localCommitID = try container.decodeIfPresent(String.self, forKey: .localCommitID)
        remoteCommitID = try container.decodeIfPresent(String.self, forKey: .remoteCommitID)
        relation = try container.decode(HubSyncRefRelation.self, forKey: .relation)
    }
}

public struct HubSyncRemoteSummary: Decodable, Equatable, Sendable {
    public let baseURL: String
    public let projectID: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case baseURL = "base_url"
        case projectID = "project_id"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        baseURL = try container.decode(String.self, forKey: .baseURL)
        projectID = try container.decode(String.self, forKey: .projectID)
    }
}

public struct HubSyncStatus: Decodable, Equatable, Sendable {
    public let remote: HubSyncRemoteSummary
    public let identity: HubSyncIdentity
    public let accessibleProjects: [HubSyncProjectAccess]
    public let refs: [HubSyncRefStatus]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case remote
        case identity
        case accessibleProjects = "accessible_projects"
        case refs
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        remote = try container.decode(HubSyncRemoteSummary.self, forKey: .remote)
        identity = try container.decode(HubSyncIdentity.self, forKey: .identity)
        accessibleProjects = try container.decode([HubSyncProjectAccess].self, forKey: .accessibleProjects)
        refs = try container.decode([HubSyncRefStatus].self, forKey: .refs)
    }
}

public struct HubSyncRef: Decodable, Equatable, Sendable {
    public let name: String
    public let commitID: String
    public let revision: UInt64

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case name
        case commitID = "commit_id"
        case revision
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        commitID = try container.decode(String.self, forKey: .commitID)
        revision = try container.decode(UInt64.self, forKey: .revision)
    }
}

public struct HubSyncConflict: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let packCommitID: String
    public let localCommitID: String

    public var id: String { "\(name):\(packCommitID):\(localCommitID)" }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case name
        case packCommitID = "pack_commit_id"
        case localCommitID = "local_commit_id"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        packCommitID = try container.decode(String.self, forKey: .packCommitID)
        localCommitID = try container.decode(String.self, forKey: .localCommitID)
    }
}

public struct HubSyncImportReport: Decodable, Equatable, Sendable {
    public let mode: String
    public let importedCommitIDs: [String]
    public let existingCommitIDs: [String]
    public let importedObjectHashes: [String]
    public let existingObjectHashes: [String]
    public let createdRefs: [HubSyncRef]
    public let unchangedRefNames: [String]
    public let conflictingRefs: [HubSyncConflict]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case mode
        case importedCommitIDs = "imported_commit_ids"
        case existingCommitIDs = "existing_commit_ids"
        case importedObjectHashes = "imported_object_hashes"
        case existingObjectHashes = "existing_object_hashes"
        case createdRefs = "created_refs"
        case unchangedRefNames = "unchanged_ref_names"
        case conflictingRefs = "conflicting_refs"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decode(String.self, forKey: .mode)
        importedCommitIDs = try container.decode([String].self, forKey: .importedCommitIDs)
        existingCommitIDs = try container.decode([String].self, forKey: .existingCommitIDs)
        importedObjectHashes = try container.decode([String].self, forKey: .importedObjectHashes)
        existingObjectHashes = try container.decode([String].self, forKey: .existingObjectHashes)
        createdRefs = try container.decode([HubSyncRef].self, forKey: .createdRefs)
        unchangedRefNames = try container.decode([String].self, forKey: .unchangedRefNames)
        conflictingRefs = try container.decode([HubSyncConflict].self, forKey: .conflictingRefs)
    }
}

public struct HubSyncTransferResult: Decodable, Equatable, Sendable {
    public let imported: HubSyncImportReport
    public let advancedRefs: [HubSyncRef]
    public let remainingConflicts: [HubSyncConflict]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case imported = "import"
        case advancedRefs = "advanced_refs"
        case remainingConflicts = "remaining_conflicts"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        imported = try container.decode(HubSyncImportReport.self, forKey: .imported)
        advancedRefs = try container.decode([HubSyncRef].self, forKey: .advancedRefs)
        remainingConflicts = try container.decode([HubSyncConflict].self, forKey: .remainingConflicts)
    }
}

public struct HubSyncFetchOutcome: Decodable, Equatable, Sendable {
    public let result: HubSyncTransferResult
    public let status: HubSyncStatus

    private enum CodingKeys: String, CodingKey, CaseIterable { case result, status }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        result = try container.decode(HubSyncTransferResult.self, forKey: .result)
        status = try container.decode(HubSyncStatus.self, forKey: .status)
    }
}

public struct HubSyncPushOutcome: Decodable, Equatable, Sendable {
    public let result: HubSyncTransferResult
    public let status: HubSyncStatus

    private enum CodingKeys: String, CodingKey, CaseIterable { case result, status }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        result = try container.decode(HubSyncTransferResult.self, forKey: .result)
        status = try container.decode(HubSyncStatus.self, forKey: .status)
    }
}

public struct HubSyncActivityActor: Decodable, Equatable, Sendable {
    public let principalID: String
    public let role: HubSyncRole

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case principalID = "principal_id"
        case role
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        principalID = try container.decode(String.self, forKey: .principalID)
        role = try container.decode(HubSyncRole.self, forKey: .role)
    }
}

public struct HubSyncActivityEvent: Decodable, Equatable, Sendable, Identifiable {
    public let eventID: String
    public let sequence: UInt64
    public let occurredAt: String
    public let kind: String
    public let actor: HubSyncActivityActor
    public let resource: String

    public var id: String { eventID }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case eventID = "event_id"
        case sequence
        case occurredAt = "occurred_at"
        case kind
        case actor
        case resource
        case details
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventID = try container.decode(String.self, forKey: .eventID)
        sequence = try container.decode(UInt64.self, forKey: .sequence)
        occurredAt = try container.decode(String.self, forKey: .occurredAt)
        kind = try container.decode(String.self, forKey: .kind)
        actor = try container.decode(HubSyncActivityActor.self, forKey: .actor)
        resource = try container.decode(String.self, forKey: .resource)
        _ = try container.decode(StudioDiscardedJSONValue.self, forKey: .details)
    }
}

public struct HubSyncActivityPage: Decodable, Equatable, Sendable {
    public let items: [HubSyncActivityEvent]
    public let nextCursor: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case items
        case nextCursor = "next_cursor"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectStudioUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([HubSyncActivityEvent].self, forKey: .items)
        nextCursor = try container.decode(String.self, forKey: .nextCursor)
    }
}

private enum StudioDiscardedJSONValue: Decodable {
    case discarded

    init(from decoder: Decoder) throws {
        if var array = try? decoder.unkeyedContainer() {
            while !array.isAtEnd { _ = try array.decode(StudioDiscardedJSONValue.self) }
            self = .discarded
            return
        }
        if let object = try? decoder.container(keyedBy: StudioDynamicCodingKey.self) {
            for key in object.allKeys { _ = try object.decode(StudioDiscardedJSONValue.self, forKey: key) }
            self = .discarded
            return
        }
        let value = try decoder.singleValueContainer()
        if value.decodeNil() || (try? value.decode(Bool.self)) != nil
            || (try? value.decode(Double.self)) != nil || (try? value.decode(String.self)) != nil {
            self = .discarded
            return
        }
        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid JSON value"))
    }
}

struct HubSyncStatusRequest: Encodable {
    let remote: HubSyncRemote
    let refNames: [String]?

    private enum CodingKeys: String, CodingKey {
        case remote
        case refNames = "ref_names"
    }
}

struct HubSyncTransferRequest: Encodable {
    let remote: HubSyncRemote
    let refNames: [String]
    let createdBy: HubSyncActor
    let message: String?

    private enum CodingKeys: String, CodingKey {
        case remote
        case refNames = "ref_names"
        case createdBy = "created_by"
        case message
    }
}

struct HubSyncActivityRequest: Encodable {
    let remote: HubSyncRemote
    let afterSequence: UInt64?
    let limit: Int?

    private enum CodingKeys: String, CodingKey {
        case remote
        case afterSequence = "after_sequence"
        case limit
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
    func listKnowledgeCollections(
        text: String?,
        publicationStates: [String]?
    ) async throws -> KnowledgeCollectionPage
    func getKnowledgeCollection(id: String) async throws -> KnowledgeCollectionSummary
    func createKnowledgeCollection(
        _ draft: KnowledgeCollectionDraft
    ) async throws -> KnowledgeCollectionSummary
    func reviseKnowledgeCollection(
        id: String,
        _ draft: KnowledgeCollectionRevisionDraft
    ) async throws -> KnowledgeCollectionSummary

    // Tuning preview writes (Debug-only Host capability).
    func createTuningPatch(_ draft: TuningPatchDraft) async throws -> TuningPatchSummary
    func getTuningSourceSuggestions(patchID: String) async throws -> TuningSourceSuggestionResult
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

    // Local quality workflows over persisted Snapshot and Screen Graph truth.
    func validateSnapshot(_ draft: ValidateSnapshotDraft) async throws -> ValidationOutcomeSummary
    func validateScreenGraph(
        _ draft: ValidateScreenGraphDraft
    ) async throws -> ValidationOutcomeSummary
    func getValidationRun(id: String) async throws -> ValidationRunSummary
    func listValidationFindings(runID: String?) async throws -> ValidationFindingPage
    func suppressValidationFinding(
        id: String,
        _ draft: SuppressValidationFindingDraft
    ) async throws -> ValidationFindingSummary
    func compareBuilds(_ draft: BuildDiffCommandDraft) async throws -> BuildDiffSummary
    func getBuildDiff(id: String) async throws -> BuildDiffSummary

    // Optional Hub collaboration over the local Host; credentials never go
    // directly from Studio to a remote transport implementation.
    func getSyncStatus(remote: HubSyncRemote, refNames: [String]?) async throws -> HubSyncStatus
    func fetchWorkspace(
        remote: HubSyncRemote,
        refNames: [String],
        actor: HubSyncActor
    ) async throws -> HubSyncFetchOutcome
    func pushWorkspace(
        remote: HubSyncRemote,
        refNames: [String],
        actor: HubSyncActor,
        message: String?
    ) async throws -> HubSyncPushOutcome
    func getSyncActivity(
        remote: HubSyncRemote,
        afterSequence: UInt64?,
        limit: Int?
    ) async throws -> HubSyncActivityPage
}

public extension HostClient {
    func listKnowledgeCollections(
        text: String?,
        publicationStates: [String]?
    ) async throws -> KnowledgeCollectionPage {
        KnowledgeCollectionPage(items: [])
    }

    func getKnowledgeCollection(id: String) async throws -> KnowledgeCollectionSummary {
        throw HostClientError.fixtureUnavailable(
            "Knowledge Collection lookup is unavailable from this Host client."
        )
    }

    func createKnowledgeCollection(
        _ draft: KnowledgeCollectionDraft
    ) async throws -> KnowledgeCollectionSummary {
        throw HostClientError.fixtureUnavailable(
            "Knowledge Collection creation is unavailable from this Host client."
        )
    }

    func reviseKnowledgeCollection(
        id: String,
        _ draft: KnowledgeCollectionRevisionDraft
    ) async throws -> KnowledgeCollectionSummary {
        throw HostClientError.fixtureUnavailable(
            "Knowledge Collection editing is unavailable from this Host client."
        )
    }

    func validateSnapshot(_ draft: ValidateSnapshotDraft) async throws -> ValidationOutcomeSummary {
        throw HostClientError.fixtureUnavailable("Snapshot validation is unavailable from this Host client.")
    }

    func validateScreenGraph(
        _ draft: ValidateScreenGraphDraft
    ) async throws -> ValidationOutcomeSummary {
        throw HostClientError.fixtureUnavailable("Screen Graph validation is unavailable from this Host client.")
    }

    func getValidationRun(id: String) async throws -> ValidationRunSummary {
        throw HostClientError.fixtureUnavailable("Validation Run lookup is unavailable from this Host client.")
    }

    func listValidationFindings(runID: String?) async throws -> ValidationFindingPage {
        ValidationFindingPage(items: [])
    }

    func suppressValidationFinding(
        id: String,
        _ draft: SuppressValidationFindingDraft
    ) async throws -> ValidationFindingSummary {
        throw HostClientError.fixtureUnavailable("Finding suppression is unavailable from this Host client.")
    }

    func compareBuilds(_ draft: BuildDiffCommandDraft) async throws -> BuildDiffSummary {
        throw HostClientError.fixtureUnavailable("Build Diff is unavailable from this Host client.")
    }

    func getBuildDiff(id: String) async throws -> BuildDiffSummary {
        throw HostClientError.fixtureUnavailable("Build Diff lookup is unavailable from this Host client.")
    }

    func getTuningSourceSuggestions(patchID: String) async throws -> TuningSourceSuggestionResult {
        throw HostClientError.fixtureUnavailable(
            "Tuning source suggestions are unavailable from this Host client."
        )
    }

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

    func getSyncStatus(remote: HubSyncRemote, refNames: [String]?) async throws -> HubSyncStatus {
        throw HostClientError.fixtureUnavailable("Hub sync requires a managed production Host.")
    }

    func fetchWorkspace(
        remote: HubSyncRemote,
        refNames: [String],
        actor: HubSyncActor
    ) async throws -> HubSyncFetchOutcome {
        throw HostClientError.fixtureUnavailable("Hub sync requires a managed production Host.")
    }

    func pushWorkspace(
        remote: HubSyncRemote,
        refNames: [String],
        actor: HubSyncActor,
        message: String?
    ) async throws -> HubSyncPushOutcome {
        throw HostClientError.fixtureUnavailable("Hub sync requires a managed production Host.")
    }

    func getSyncActivity(
        remote: HubSyncRemote,
        afterSequence: UInt64?,
        limit: Int?
    ) async throws -> HubSyncActivityPage {
        throw HostClientError.fixtureUnavailable("Hub sync requires a managed production Host.")
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
