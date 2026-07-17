import Foundation
import VistreaRuntimeModels

public struct StudioResourceRef: Codable, Equatable, Sendable {
    public let kind: String
    public let id: String
    public let version: String?

    public init(kind: String, id: String, version: String? = nil) {
        self.kind = kind
        self.id = id
        self.version = version
    }
}

public struct ValidationSeverityCounts: Decodable, Equatable, Sendable {
    public let info: UInt64
    public let warning: UInt64
    public let error: UInt64
    public let critical: UInt64

    public init(info: UInt64, warning: UInt64, error: UInt64, critical: UInt64) {
        self.info = info
        self.warning = warning
        self.error = error
        self.critical = critical
    }
}

public struct ValidationFindingCounts: Decodable, Equatable, Sendable {
    public let total: UInt64
    public let open: UInt64
    public let suppressed: UInt64
    public let resolved: UInt64
    public let bySeverity: ValidationSeverityCounts

    public init(
        total: UInt64,
        open: UInt64,
        suppressed: UInt64,
        resolved: UInt64,
        bySeverity: ValidationSeverityCounts
    ) {
        self.total = total
        self.open = open
        self.suppressed = suppressed
        self.resolved = resolved
        self.bySeverity = bySeverity
    }

    private enum CodingKeys: String, CodingKey {
        case total
        case open
        case suppressed
        case resolved
        case bySeverity = "by_severity"
    }
}

public struct ValidationRunSummary: Decodable, Equatable, Sendable, Identifiable {
    public let validationRunID: String
    public let operationID: String
    public let target: StudioResourceRef
    public let state: String
    public let revision: UInt64
    public let findingCounts: ValidationFindingCounts

    public var id: String { validationRunID }

    public init(
        validationRunID: String,
        operationID: String,
        target: StudioResourceRef,
        state: String,
        revision: UInt64,
        findingCounts: ValidationFindingCounts
    ) {
        self.validationRunID = validationRunID
        self.operationID = operationID
        self.target = target
        self.state = state
        self.revision = revision
        self.findingCounts = findingCounts
    }

    private enum CodingKeys: String, CodingKey {
        case validationRunID = "validation_run_id"
        case operationID = "operation_id"
        case target
        case state
        case revision
        case findingCounts = "finding_counts"
    }
}

public struct ValidationFindingSummary: Decodable, Equatable, Sendable, Identifiable {
    public let findingID: String
    public let validationRunID: String
    public let revision: UInt64
    public let ruleID: String
    public let category: String
    public let severity: String
    public let status: String
    public let message: String
    public let subject: StudioResourceRef
    public let expected: JSONValue?
    public let actual: JSONValue?

    public var id: String { findingID }
    public var expectedPresentation: String? { expected.map(Self.compactJSON) }
    public var actualPresentation: String? { actual.map(Self.compactJSON) }

    public init(
        findingID: String,
        validationRunID: String,
        revision: UInt64,
        ruleID: String,
        category: String,
        severity: String,
        status: String,
        message: String,
        subject: StudioResourceRef,
        expected: JSONValue? = nil,
        actual: JSONValue? = nil
    ) {
        self.findingID = findingID
        self.validationRunID = validationRunID
        self.revision = revision
        self.ruleID = ruleID
        self.category = category
        self.severity = severity
        self.status = status
        self.message = message
        self.subject = subject
        self.expected = expected
        self.actual = actual
    }

    private enum CodingKeys: String, CodingKey {
        case findingID = "finding_id"
        case validationRunID = "validation_run_id"
        case revision
        case ruleID = "rule_id"
        case category
        case severity
        case status
        case message
        case subject
        case expected
        case actual
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

public struct ValidationOutcomeSummary: Decodable, Equatable, Sendable {
    public let run: ValidationRunSummary
    public let findings: [ValidationFindingSummary]

    public init(run: ValidationRunSummary, findings: [ValidationFindingSummary]) {
        self.run = run
        self.findings = findings
    }
}

public struct ValidationFindingPage: Decodable, Equatable, Sendable {
    public let items: [ValidationFindingSummary]
    public let nextCursor: String?

    public init(items: [ValidationFindingSummary], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}

public struct ValidationConfigurationDraft: Encodable, Equatable, Sendable {
    public let disabledRules: [String]?
    public let minimumTouchTargetPoints: Double?

    public init(disabledRules: [String]? = nil, minimumTouchTargetPoints: Double? = nil) {
        self.disabledRules = disabledRules
        self.minimumTouchTargetPoints = minimumTouchTargetPoints
    }

    private enum CodingKeys: String, CodingKey {
        case disabledRules = "disabled_rules"
        case minimumTouchTargetPoints = "minimum_touch_target_points"
    }
}

public struct ValidateSnapshotDraft: Encodable, Equatable, Sendable {
    public let snapshotID: String
    public let categories: [String]?
    public let configuration: ValidationConfigurationDraft?

    public init(
        snapshotID: String,
        categories: [String]? = nil,
        configuration: ValidationConfigurationDraft? = nil
    ) {
        self.snapshotID = snapshotID
        self.categories = categories
        self.configuration = configuration
    }

    private enum CodingKeys: String, CodingKey {
        case snapshotID = "snapshot_id"
        case categories
        case configuration
    }
}

public struct ValidateScreenGraphDraft: Encodable, Equatable, Sendable {
    public let projectID: String
    public let applicationID: String
    public let configuration: ValidationConfigurationDraft?

    public init(
        projectID: String,
        applicationID: String,
        configuration: ValidationConfigurationDraft? = nil
    ) {
        self.projectID = projectID
        self.applicationID = applicationID
        self.configuration = configuration
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case applicationID = "application_id"
        case configuration
    }
}

public struct SuppressValidationFindingDraft: Encodable, Equatable, Sendable {
    public let expectedFindingRevision: UInt64
    public let reasonCode: String
    public let justification: String
    public let createdBy: StudioActorRef

    public init(
        expectedFindingRevision: UInt64,
        reasonCode: String,
        justification: String,
        createdBy: StudioActorRef = .studio
    ) {
        self.expectedFindingRevision = expectedFindingRevision
        self.reasonCode = reasonCode
        self.justification = justification
        self.createdBy = createdBy
    }

    private enum CodingKeys: String, CodingKey {
        case expectedFindingRevision = "expected_finding_revision"
        case reasonCode = "reason_code"
        case justification
        case createdBy = "created_by"
    }
}

public struct BuildDiffCommandDraft: Encodable, Equatable, Sendable {
    public let projectID: String
    public let applicationID: String
    public let leftBuildID: String
    public let rightBuildID: String
    public let baselineTag: String?

    public init(
        projectID: String,
        applicationID: String,
        leftBuildID: String,
        rightBuildID: String,
        baselineTag: String? = nil
    ) {
        self.projectID = projectID
        self.applicationID = applicationID
        self.leftBuildID = leftBuildID
        self.rightBuildID = rightBuildID
        self.baselineTag = baselineTag
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case applicationID = "application_id"
        case leftBuildID = "left_build_id"
        case rightBuildID = "right_build_id"
        case baselineTag = "baseline_tag"
    }
}

public struct BuildDiffEntrySummary: Decodable, Equatable, Sendable, Identifiable {
    public let entryID: String
    public let kind: String
    public let domains: [String]
    public let severity: String?
    public let summary: String
    public let leftSubject: StudioResourceRef?
    public let rightSubject: StudioResourceRef?

    public var id: String { entryID }

    public init(
        entryID: String,
        kind: String,
        domains: [String],
        severity: String?,
        summary: String,
        leftSubject: StudioResourceRef?,
        rightSubject: StudioResourceRef?
    ) {
        self.entryID = entryID
        self.kind = kind
        self.domains = domains
        self.severity = severity
        self.summary = summary
        self.leftSubject = leftSubject
        self.rightSubject = rightSubject
    }

    private enum CodingKeys: String, CodingKey {
        case entryID = "entry_id"
        case kind
        case domains
        case severity
        case summary
        case leftSubject = "left_subject"
        case rightSubject = "right_subject"
    }
}

public struct BuildDiffCounts: Decodable, Equatable, Sendable {
    public let total: UInt64
    public let added: UInt64
    public let removed: UInt64
    public let changed: UInt64
    public let regressed: UInt64
    public let improved: UInt64

    public init(
        total: UInt64,
        added: UInt64,
        removed: UInt64,
        changed: UInt64,
        regressed: UInt64,
        improved: UInt64
    ) {
        self.total = total
        self.added = added
        self.removed = removed
        self.changed = changed
        self.regressed = regressed
        self.improved = improved
    }
}

public struct BuildDiffSummary: Decodable, Equatable, Sendable, Identifiable {
    public let buildDiffID: String
    public let operationID: String
    public let leftBuild: StudioResourceRef
    public let rightBuild: StudioResourceRef
    public let summary: BuildDiffCounts
    public let entries: [BuildDiffEntrySummary]

    public var id: String { buildDiffID }

    public init(
        buildDiffID: String,
        operationID: String,
        leftBuild: StudioResourceRef,
        rightBuild: StudioResourceRef,
        summary: BuildDiffCounts,
        entries: [BuildDiffEntrySummary]
    ) {
        self.buildDiffID = buildDiffID
        self.operationID = operationID
        self.leftBuild = leftBuild
        self.rightBuild = rightBuild
        self.summary = summary
        self.entries = entries
    }

    private enum CodingKeys: String, CodingKey {
        case buildDiffID = "build_diff_id"
        case operationID = "operation_id"
        case leftBuild = "left_build"
        case rightBuild = "right_build"
        case summary
        case entries
    }
}
