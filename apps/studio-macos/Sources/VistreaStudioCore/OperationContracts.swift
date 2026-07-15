import Foundation
import VistreaRuntimeModels

// MARK: - Shared write actor

/// The canonical ActorRef Studio stamps on every Host write.
///
/// The protocol actor kinds are `human`, `agent`, and `service`; interactive
/// Studio operations are performed by the human at the keyboard.
public struct StudioActorRef: Encodable, Equatable, Sendable {
    public let kind: String
    public let id: String

    public init(kind: String, id: String) {
        self.kind = kind
        self.id = id
    }

    /// The default interactive Studio user actor.
    public static let studio = StudioActorRef(kind: "human", id: "studio")

    private enum CodingKeys: String, CodingKey {
        case kind
        case id
        case extensions
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encode([String: String](), forKey: .extensions)
    }
}

// MARK: - Tuning preview commands

/// One canonical Runtime node target for a tuning change.
public struct TuningNodeTargetDraft: Encodable, Equatable, Sendable {
    public let snapshotID: String
    public let treeID: String
    public let nodeID: String
    public let stableID: String?

    public init(snapshotID: String, treeID: String, nodeID: String, stableID: String? = nil) {
        self.snapshotID = snapshotID
        self.treeID = treeID
        self.nodeID = nodeID
        self.stableID = stableID
    }

    private enum CodingKeys: String, CodingKey {
        case snapshotID = "snapshot_id"
        case treeID = "tree_id"
        case nodeID = "node_id"
        case stableID = "stable_id"
    }
}

/// A canonical number PropertyValue used by ratio and logical-point tuning.
public struct TuningNumberValueDraft: Encodable, Equatable, Sendable {
    public let value: Double
    public let unit: String

    public init(value: Double, unit: String = "ratio") {
        self.value = value
        self.unit = unit
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case value
        case unit
        case extensions
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("number", forKey: .kind)
        try container.encode(value, forKey: .value)
        try container.encode(unit, forKey: .unit)
        try container.encode([String: String](), forKey: .extensions)
    }
}

/// The reversible PropertyValue vocabulary Studio can submit to the protected
/// Runtime tuning boundary.
public enum TuningPropertyValueDraft: Encodable, Equatable, Sendable {
    case number(value: Double, unit: String)
    case color(red: Double, green: Double, blue: Double, alpha: Double)
    case font(family: String, size: Double, weight: Int, style: String)
    case insets(top: Double, leading: Double, bottom: Double, trailing: Double)

    private enum CodingKeys: String, CodingKey {
        case kind
        case value
        case unit
        case colorSpace = "color_space"
        case extensions
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .number(value, unit):
            try container.encode("number", forKey: .kind)
            try container.encode(value, forKey: .value)
            try container.encode(unit, forKey: .unit)
        case let .color(red, green, blue, alpha):
            try container.encode("color_rgba", forKey: .kind)
            try container.encode(
                ["red": red, "green": green, "blue": blue, "alpha": alpha],
                forKey: .value
            )
            try container.encode("srgb", forKey: .colorSpace)
        case let .font(family, size, weight, style):
            try container.encode("font", forKey: .kind)
            try container.encode(
                FontPayload(family: family, size: size, weight: weight, style: style),
                forKey: .value
            )
        case let .insets(top, leading, bottom, trailing):
            try container.encode("insets", forKey: .kind)
            try container.encode(
                ["top": top, "leading": leading, "bottom": bottom, "trailing": trailing],
                forKey: .value
            )
        }
        try container.encode([String: String](), forKey: .extensions)
    }

    private struct FontPayload: Encodable {
        let family: String
        let size: Double
        let weight: Int
        let style: String
    }
}

/// One reversible property change inside a Tuning Patch draft.
public struct TuningChangeDraft: Encodable, Equatable, Sendable {
    public let target: TuningNodeTargetDraft
    public let property: String
    public let originalValue: TuningPropertyValueDraft
    public let previewValue: TuningPropertyValueDraft

    public init(
        target: TuningNodeTargetDraft,
        property: String,
        originalValue: TuningPropertyValueDraft,
        previewValue: TuningPropertyValueDraft
    ) {
        self.target = target
        self.property = property
        self.originalValue = originalValue
        self.previewValue = previewValue
    }

    public init(
        target: TuningNodeTargetDraft,
        property: String,
        originalValue: TuningNumberValueDraft,
        previewValue: TuningNumberValueDraft
    ) {
        self.init(
            target: target,
            property: property,
            originalValue: .number(value: originalValue.value, unit: originalValue.unit),
            previewValue: .number(value: previewValue.value, unit: previewValue.unit)
        )
    }

    private enum CodingKeys: String, CodingKey {
        case target = "runtime_target"
        case property
        case originalValue = "original_value"
        case previewValue = "preview_value"
    }
}

/// The `POST /v1/tuning-patches` command body.
public struct TuningPatchDraft: Encodable, Equatable, Sendable {
    public let title: String
    public let description: String?
    public let targetSnapshotID: String
    public let changes: [TuningChangeDraft]
    public let createdBy: StudioActorRef

    public init(
        title: String,
        description: String? = nil,
        targetSnapshotID: String,
        changes: [TuningChangeDraft],
        createdBy: StudioActorRef
    ) {
        self.title = title
        self.description = description
        self.targetSnapshotID = targetSnapshotID
        self.changes = changes
        self.createdBy = createdBy
    }

    private enum CodingKeys: String, CodingKey {
        case title
        case description
        case targetSnapshotID = "target_snapshot_id"
        case changes
        case createdBy = "created_by"
    }
}

// MARK: - Tuning preview projections

/// A lenient projection of one persisted Tuning Patch.
public struct TuningPatchSummary: Decodable, Equatable, Sendable, Identifiable {
    public let patchID: String
    public let revision: UInt64
    public let title: String
    public let status: String
    public let targetSnapshotID: String

    public var id: String { patchID }

    public init(
        patchID: String,
        revision: UInt64,
        title: String,
        status: String,
        targetSnapshotID: String
    ) {
        self.patchID = patchID
        self.revision = revision
        self.title = title
        self.status = status
        self.targetSnapshotID = targetSnapshotID
    }

    private enum CodingKeys: String, CodingKey {
        case patchID = "patch_id"
        case revision
        case title
        case status
        case targetSnapshotID = "target_snapshot_id"
    }
}

/// One change the Runtime applied.
public struct AppliedTuningChangeSummary: Decodable, Equatable, Sendable, Identifiable {
    public let tuningChangeID: String

    public var id: String { tuningChangeID }

    public init(tuningChangeID: String) {
        self.tuningChangeID = tuningChangeID
    }

    private enum CodingKeys: String, CodingKey {
        case tuningChangeID = "tuning_change_id"
    }
}

/// One change the Runtime rejected, with its canonical reason code verbatim.
public struct RejectedTuningChangeSummary: Decodable, Equatable, Sendable, Identifiable {
    public let tuningChangeID: String
    public let reasonCode: String
    public let message: String

    public var id: String { tuningChangeID }

    public init(tuningChangeID: String, reasonCode: String, message: String) {
        self.tuningChangeID = tuningChangeID
        self.reasonCode = reasonCode
        self.message = message
    }

    private enum CodingKeys: String, CodingKey {
        case tuningChangeID = "tuning_change_id"
        case reasonCode = "reason_code"
        case message
    }
}

/// A lenient projection of one canonical Tuning Application.
public struct TuningApplicationSummary: Decodable, Equatable, Sendable, Identifiable {
    public let tuningApplicationID: String
    public let revision: UInt64
    public let patchID: String
    public let status: String
    public let expectedSnapshotID: String
    public let appliedChanges: [AppliedTuningChangeSummary]
    public let rejectedChanges: [RejectedTuningChangeSummary]

    public var id: String { tuningApplicationID }

    public init(
        tuningApplicationID: String,
        revision: UInt64,
        patchID: String,
        status: String,
        expectedSnapshotID: String,
        appliedChanges: [AppliedTuningChangeSummary],
        rejectedChanges: [RejectedTuningChangeSummary]
    ) {
        self.tuningApplicationID = tuningApplicationID
        self.revision = revision
        self.patchID = patchID
        self.status = status
        self.expectedSnapshotID = expectedSnapshotID
        self.appliedChanges = appliedChanges
        self.rejectedChanges = rejectedChanges
    }

    private enum CodingKeys: String, CodingKey {
        case tuningApplicationID = "tuning_application_id"
        case revision
        case patchID = "patch_id"
        case status
        case expectedSnapshotID = "expected_snapshot_id"
        case appliedChanges = "applied_changes"
        case rejectedChanges = "rejected_changes"
    }
}

public struct TuningApplicationPage: Decodable, Equatable, Sendable {
    public let items: [TuningApplicationSummary]

    public init(items: [TuningApplicationSummary]) {
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case items
    }
}

/// One source-oriented Coding Agent handoff generated from a persisted
/// Tuning Patch. The Host never fabricates file paths: a missing source
/// mapping is represented explicitly by `needs_source_mapping`.
public struct TuningSourceSuggestionSummary: Decodable, Equatable, Sendable, Identifiable {
    public let tuningChangeID: String
    public let property: String
    public let stableID: String?
    public let sourceContext: [String: JSONValue]?
    public let status: String
    public let originalValue: JSONValue
    public let suggestedValue: JSONValue
    public let codingAgentInstructions: [String]

    public var id: String { tuningChangeID }
    public var sourceContextPresentation: String? {
        sourceContext.map { Self.compactJSON(.object($0)) }
    }
    public var originalValuePresentation: String { Self.compactJSON(originalValue) }
    public var suggestedValuePresentation: String { Self.compactJSON(suggestedValue) }

    public init(
        tuningChangeID: String,
        property: String,
        stableID: String?,
        sourceContext: [String: JSONValue]?,
        status: String,
        originalValue: JSONValue,
        suggestedValue: JSONValue,
        codingAgentInstructions: [String]
    ) {
        self.tuningChangeID = tuningChangeID
        self.property = property
        self.stableID = stableID
        self.sourceContext = sourceContext
        self.status = status
        self.originalValue = originalValue
        self.suggestedValue = suggestedValue
        self.codingAgentInstructions = codingAgentInstructions
    }

    private enum CodingKeys: String, CodingKey {
        case tuningChangeID = "tuning_change_id"
        case property
        case stableID = "stable_id"
        case sourceContext = "source_context"
        case status
        case originalValue = "original_value"
        case suggestedValue = "suggested_value"
        case codingAgentInstructions = "coding_agent_instructions"
    }

    private static func compactJSON(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value),
              let text = String(data: data, encoding: .utf8)
        else { return "Unavailable" }
        return text
    }
}

public struct TuningSourceSuggestionResult: Decodable, Equatable, Sendable {
    public let patchID: String
    public let patchRevision: UInt64
    public let targetSnapshotID: String
    public let suggestions: [TuningSourceSuggestionSummary]

    public init(
        patchID: String,
        patchRevision: UInt64,
        targetSnapshotID: String,
        suggestions: [TuningSourceSuggestionSummary]
    ) {
        self.patchID = patchID
        self.patchRevision = patchRevision
        self.targetSnapshotID = targetSnapshotID
        self.suggestions = suggestions
    }

    private enum CodingKeys: String, CodingKey {
        case patchID = "patch_id"
        case patchRevision = "patch_revision"
        case targetSnapshotID = "target_snapshot_id"
        case suggestions
    }
}

// MARK: - Review Issue lifecycle

/// The canonical Review Issue lifecycle mirrored from the Engine's
/// `REVIEW_ISSUE_TRANSITIONS`; Studio only offers legal target states.
public enum ReviewIssueLifecycle {
    public static let states = [
        "open",
        "in_progress",
        "ready_for_verification",
        "resolved",
        "wont_fix",
    ]

    public static let transitions: [String: [String]] = [
        "open": ["in_progress", "ready_for_verification", "wont_fix"],
        "in_progress": ["open", "ready_for_verification", "wont_fix"],
        "ready_for_verification": ["in_progress", "resolved", "wont_fix"],
        "resolved": ["open"],
        "wont_fix": ["open"],
    ]

    public static func legalTargets(from state: String) -> [String] {
        transitions[state] ?? []
    }
}

/// The `POST /v1/review-issues/:id/transitions` command body.
public struct ReviewIssueTransitionRequest: Encodable, Equatable, Sendable {
    public let expectedRevision: UInt64
    public let toState: String
    public let reason: String?
    public let changedBy: StudioActorRef

    public init(expectedRevision: UInt64, toState: String, reason: String? = nil, changedBy: StudioActorRef) {
        self.expectedRevision = expectedRevision
        self.toState = toState
        self.reason = reason
        self.changedBy = changedBy
    }

    private enum CodingKeys: String, CodingKey {
        case expectedRevision = "expected_revision"
        case toState = "to_state"
        case reason
        case changedBy = "changed_by"
    }
}

/// The `POST /v1/design-comparisons/:id/issues` command body. The Host owns
/// the immutable Difference evidence; Studio only names the Difference and
/// the interactive actor so it cannot accidentally recopy or alter evidence.
public struct CreateReviewIssueFromDifferenceRequest: Encodable, Equatable, Sendable {
    public let differenceID: String
    public let title: String?
    public let description: String?
    public let createdBy: StudioActorRef

    public init(
        differenceID: String,
        title: String? = nil,
        description: String? = nil,
        createdBy: StudioActorRef = .studio
    ) {
        self.differenceID = differenceID
        self.title = title
        self.description = description
        self.createdBy = createdBy
    }

    private enum CodingKeys: String, CodingKey {
        case differenceID = "difference_id"
        case title
        case description
        case createdBy = "created_by"
    }
}

/// The `POST /v1/review-issues/:id/recapture-verifications` command body.
/// The Host captures the configured Runtime, requires a different real build,
/// reruns the design comparison, and appends immutable verification evidence.
public struct RecaptureReviewIssueRequest: Encodable, Equatable, Sendable {
    public let expectedRevision: UInt64
    public let verifiedBy: StudioActorRef

    public init(expectedRevision: UInt64, verifiedBy: StudioActorRef = .studio) {
        self.expectedRevision = expectedRevision
        self.verifiedBy = verifiedBy
    }

    private enum CodingKeys: String, CodingKey {
        case expectedRevision = "expected_revision"
        case verifiedBy = "verified_by"
    }
}

// MARK: - Deep Wiki vocabulary and commands

/// The canonical Deep Wiki enums mirrored from the knowledge schema.
public enum WikiVocabulary {
    public static let nodeKinds = [
        "screen",
        "component",
        "path",
        "requirement",
        "test",
        "design",
        "concept",
        "note",
    ]

    public static let nodeStatuses = ["draft", "published", "archived"]

    /// The persistent Wiki lifecycle mirrored from the Knowledge Engine.
    public static let statusTransitions: [String: [String]] = [
        "draft": ["published", "archived"],
        "published": ["archived"],
        "archived": ["published"],
    ]

    public static func legalStatusTargets(from status: String) -> [String] {
        statusTransitions[status] ?? []
    }

    public static let linkRelations = [
        "relates_to",
        "documents",
        "evidence_for",
        "implements",
        "tests",
        "depends_on",
        "supersedes",
    ]
}

/// The `POST /v1/wiki/nodes` command body.
public struct WikiNodeDraft: Encodable, Equatable, Sendable {
    public let kind: String
    public let title: String
    public let summary: String?
    public let markdown: String
    public let labels: [String]?
    public let createdBy: StudioActorRef

    public init(
        kind: String,
        title: String,
        summary: String? = nil,
        markdown: String,
        labels: [String]? = nil,
        createdBy: StudioActorRef
    ) {
        self.kind = kind
        self.title = title
        self.summary = summary
        self.markdown = markdown
        self.labels = labels
        self.createdBy = createdBy
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case title
        case summary
        case markdown
        case labels
        case createdBy = "created_by"
    }
}

/// The `POST /v1/wiki/nodes/:id/revisions` command body.
public struct WikiNodeRevisionDraft: Encodable, Equatable, Sendable {
    public let expectedRevision: UInt64
    public let title: String?
    public let summary: String?
    public let markdown: String?
    public let toStatus: String?
    public let updatedBy: StudioActorRef

    public init(
        expectedRevision: UInt64,
        title: String? = nil,
        summary: String? = nil,
        markdown: String? = nil,
        toStatus: String? = nil,
        updatedBy: StudioActorRef
    ) {
        self.expectedRevision = expectedRevision
        self.title = title
        self.summary = summary
        self.markdown = markdown
        self.toStatus = toStatus
        self.updatedBy = updatedBy
    }

    private enum CodingKeys: String, CodingKey {
        case expectedRevision = "expected_revision"
        case title
        case summary
        case markdown
        case toStatus = "to_status"
        case updatedBy = "updated_by"
    }
}

/// A lenient projection of one full Deep Wiki node, including its inline
/// Markdown when the canonical content is stored inline.
public struct WikiNodeDetail: Decodable, Equatable, Sendable, Identifiable {
    public let wikiNodeID: String
    public let revision: UInt64
    public let kind: String
    public let title: String
    public let summary: String?
    public let markdown: String?
    public let status: String
    public let labels: [String]

    public var id: String { wikiNodeID }

    public init(
        wikiNodeID: String,
        revision: UInt64,
        kind: String,
        title: String,
        summary: String?,
        markdown: String?,
        status: String,
        labels: [String]
    ) {
        self.wikiNodeID = wikiNodeID
        self.revision = revision
        self.kind = kind
        self.title = title
        self.summary = summary
        self.markdown = markdown
        self.status = status
        self.labels = labels
    }

    public var summaryProjection: WikiNodeSummary {
        WikiNodeSummary(
            wikiNodeID: wikiNodeID,
            kind: kind,
            title: title,
            summary: summary,
            status: status,
            labels: labels
        )
    }

    private enum CodingKeys: String, CodingKey {
        case wikiNodeID = "wiki_node_id"
        case revision
        case kind
        case title
        case summary
        case content
        case status
        case labels
    }

    private struct KnowledgeContentProjection: Decodable {
        let text: String?

        private enum CodingKeys: String, CodingKey {
            case text
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        wikiNodeID = try container.decode(String.self, forKey: .wikiNodeID)
        revision = try container.decode(UInt64.self, forKey: .revision)
        kind = try container.decode(String.self, forKey: .kind)
        title = try container.decode(String.self, forKey: .title)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        markdown = try container.decodeIfPresent(
            KnowledgeContentProjection.self,
            forKey: .content
        )?.text
        status = try container.decode(String.self, forKey: .status)
        labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
    }
}

// MARK: - Wiki links

/// One canonical resource reference used as a Wiki link target.
public struct ResourceTargetDraft: Encodable, Equatable, Sendable {
    public let kind: String
    public let id: String

    public init(kind: String, id: String) {
        self.kind = kind
        self.id = id
    }
}

/// The `POST /v1/wiki/links` command body.
public struct WikiLinkDraft: Encodable, Equatable, Sendable {
    public let sourceNodeID: String
    public let target: ResourceTargetDraft
    public let relation: String
    public let createdBy: StudioActorRef

    public init(
        sourceNodeID: String,
        target: ResourceTargetDraft,
        relation: String,
        createdBy: StudioActorRef
    ) {
        self.sourceNodeID = sourceNodeID
        self.target = target
        self.relation = relation
        self.createdBy = createdBy
    }

    private enum CodingKeys: String, CodingKey {
        case sourceNodeID = "source_node_id"
        case target
        case relation
        case createdBy = "created_by"
    }
}

/// A lenient projection of one persisted Wiki link.
public struct WikiLinkSummary: Decodable, Equatable, Sendable, Identifiable {
    public let wikiLinkID: String
    public let sourceNodeID: String
    public let relation: String

    public var id: String { wikiLinkID }

    public init(wikiLinkID: String, sourceNodeID: String, relation: String) {
        self.wikiLinkID = wikiLinkID
        self.sourceNodeID = sourceNodeID
        self.relation = relation
    }

    private enum CodingKeys: String, CodingKey {
        case wikiLinkID = "wiki_link_id"
        case sourceNodeID = "source_node_id"
        case relation
    }
}

// MARK: - Screen State details

/// A lenient projection of one persisted Screen State document.
public struct ScreenStateDetail: Decodable, Equatable, Sendable, Identifiable {
    public let screenStateID: String
    public let revision: UInt64
    public let title: String
    public let kind: String
    public let status: String
    public let canonicalSnapshotID: String
    public let firstSeen: String
    public let lastSeen: String
    /// The operator- or agent-written annotation labels; empty when the
    /// canonical document carries none.
    public let labels: [String]
    /// The one-sentence annotation summary, at most 280 characters.
    public let summary: String?

    public var id: String { screenStateID }

    /// True while the state represents a live product screen; only active
    /// states accept curation and annotation writes.
    public var isActive: Bool { status == "active" }

    public init(
        screenStateID: String,
        revision: UInt64,
        title: String,
        kind: String,
        status: String,
        canonicalSnapshotID: String,
        firstSeen: String,
        lastSeen: String,
        labels: [String] = [],
        summary: String? = nil
    ) {
        self.screenStateID = screenStateID
        self.revision = revision
        self.title = title
        self.kind = kind
        self.status = status
        self.canonicalSnapshotID = canonicalSnapshotID
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
        self.labels = labels
        self.summary = summary
    }

    private enum CodingKeys: String, CodingKey {
        case screenStateID = "screen_state_id"
        case revision
        case title
        case kind
        case status
        case canonicalSnapshotID = "canonical_snapshot_id"
        case firstSeen = "first_seen"
        case lastSeen = "last_seen"
        case labels
        case summary
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        screenStateID = try container.decode(String.self, forKey: .screenStateID)
        revision = try container.decode(UInt64.self, forKey: .revision)
        title = try container.decode(String.self, forKey: .title)
        kind = try container.decode(String.self, forKey: .kind)
        status = try container.decode(String.self, forKey: .status)
        canonicalSnapshotID = try container.decode(String.self, forKey: .canonicalSnapshotID)
        firstSeen = try container.decode(String.self, forKey: .firstSeen)
        lastSeen = try container.decode(String.self, forKey: .lastSeen)
        labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
    }
}
