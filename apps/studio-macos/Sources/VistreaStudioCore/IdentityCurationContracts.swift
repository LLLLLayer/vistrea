import Foundation

// MARK: - Canvas identity curation commands

/// The `POST /v1/screen-graph/state-merges` command body.
///
/// A merge declares that at least two active Screen States are one product
/// screen. The write is guarded by the materialized graph revision so a
/// concurrent curation surfaces as an explicit conflict, never a silent
/// overwrite.
public struct MergeScreenStatesCommand: Encodable, Equatable, Sendable {
    public let projectID: String
    public let applicationID: String
    public let stateIDs: [String]
    public let intoStateID: String?
    public let expectedGraphRevision: UInt64
    public let mergedBy: StudioActorRef
    public let justification: String?

    public init(
        projectID: String,
        applicationID: String,
        stateIDs: [String],
        intoStateID: String? = nil,
        expectedGraphRevision: UInt64,
        mergedBy: StudioActorRef,
        justification: String? = nil
    ) {
        self.projectID = projectID
        self.applicationID = applicationID
        self.stateIDs = stateIDs
        self.intoStateID = intoStateID
        self.expectedGraphRevision = expectedGraphRevision
        self.mergedBy = mergedBy
        self.justification = justification
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case applicationID = "application_id"
        case stateIDs = "state_ids"
        case intoStateID = "into_state_id"
        case expectedGraphRevision = "expected_graph_revision"
        case mergedBy = "merged_by"
        case justification
    }
}

/// The `POST /v1/screen-graph/state-splits` command body.
///
/// A split separates wrongly deduplicated observations out of one active
/// Screen State into a new manually identified state. The moved observation
/// set must be a strict subset: at least one observation moves and at least
/// one stays behind.
public struct SplitScreenStateCommand: Encodable, Equatable, Sendable {
    public let projectID: String
    public let applicationID: String
    public let stateID: String
    public let observationIDs: [String]
    public let title: String?
    public let expectedGraphRevision: UInt64
    public let splitBy: StudioActorRef
    public let justification: String?

    public init(
        projectID: String,
        applicationID: String,
        stateID: String,
        observationIDs: [String],
        title: String? = nil,
        expectedGraphRevision: UInt64,
        splitBy: StudioActorRef,
        justification: String? = nil
    ) {
        self.projectID = projectID
        self.applicationID = applicationID
        self.stateID = stateID
        self.observationIDs = observationIDs
        self.title = title
        self.expectedGraphRevision = expectedGraphRevision
        self.splitBy = splitBy
        self.justification = justification
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case applicationID = "application_id"
        case stateID = "state_id"
        case observationIDs = "observation_ids"
        case title
        case expectedGraphRevision = "expected_graph_revision"
        case splitBy = "split_by"
        case justification
    }
}

// MARK: - Screen State annotation command

/// The `POST /v1/screen-graph/state-annotations` command body.
///
/// An annotation sets or clears a state's labels and one-sentence summary.
/// Annotations are knowledge, not identity: they never move observations or
/// change what a state matches, but they are guarded by the same materialized
/// graph revision as curation so a concurrent write conflicts explicitly. An
/// empty `labels` array or empty `summary` string clears that field; at least
/// one of the two must be set.
public struct AnnotateScreenStateCommand: Encodable, Equatable, Sendable {
    public let projectID: String
    public let applicationID: String
    public let stateID: String
    public let labels: [String]?
    public let summary: String?
    public let expectedGraphRevision: UInt64
    public let annotatedBy: StudioActorRef

    public init(
        projectID: String,
        applicationID: String,
        stateID: String,
        labels: [String]? = nil,
        summary: String? = nil,
        expectedGraphRevision: UInt64,
        annotatedBy: StudioActorRef
    ) {
        self.projectID = projectID
        self.applicationID = applicationID
        self.stateID = stateID
        self.labels = labels
        self.summary = summary
        self.expectedGraphRevision = expectedGraphRevision
        self.annotatedBy = annotatedBy
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case applicationID = "application_id"
        case stateID = "state_id"
        case labels
        case summary
        case expectedGraphRevision = "expected_graph_revision"
        case annotatedBy = "annotated_by"
    }
}

/// The frozen `{screen_graph_id, graph_revision, state}` result of one
/// annotation write. `state` is the full updated Screen State.
public struct ScreenStateAnnotationResult: Decodable, Equatable, Sendable {
    public let screenGraphID: String
    public let graphRevision: UInt64
    public let state: CanvasStateSummary

    public init(screenGraphID: String, graphRevision: UInt64, state: CanvasStateSummary) {
        self.screenGraphID = screenGraphID
        self.graphRevision = graphRevision
        self.state = state
    }

    private enum CodingKeys: String, CodingKey {
        case screenGraphID = "screen_graph_id"
        case graphRevision = "graph_revision"
        case state
    }
}

// MARK: - Identity curation result

/// A lenient projection of the recorded StateIdentityDecision.
public struct IdentityDecisionSummary: Decodable, Equatable, Sendable {
    public let stateIdentityDecisionID: String?
    public let kind: String?

    public init(stateIdentityDecisionID: String? = nil, kind: String? = nil) {
        self.stateIdentityDecisionID = stateIdentityDecisionID
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
        case stateIdentityDecisionID = "state_identity_decision_id"
        case kind
    }
}

/// The frozen `{screen_graph_id, graph_revision, decision, state}` result of
/// one merge or split. `state` is the surviving state for a merge and the
/// newly created state for a split.
public struct IdentityCurationResult: Decodable, Equatable, Sendable {
    public let screenGraphID: String
    public let graphRevision: UInt64
    public let decision: IdentityDecisionSummary
    public let state: CanvasStateSummary

    public init(
        screenGraphID: String,
        graphRevision: UInt64,
        decision: IdentityDecisionSummary,
        state: CanvasStateSummary
    ) {
        self.screenGraphID = screenGraphID
        self.graphRevision = graphRevision
        self.decision = decision
        self.state = state
    }

    private enum CodingKeys: String, CodingKey {
        case screenGraphID = "screen_graph_id"
        case graphRevision = "graph_revision"
        case decision
        case state
    }
}
