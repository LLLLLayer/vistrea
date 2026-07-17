import Foundation
import VistreaRuntimeModels

public actor FixtureHostClient: HostClient {
    private let status: HostStatus
    private var snapshotsByID: [String: RuntimeSnapshot]
    private let objectsByHash: [String: Data]
    private let eventTimeline: EventTimeline
    private var reviewIssues: [ReviewIssueSummary]
    private var canvasGraph: CanvasGraph?
    private let canvasGraphFailureMessage: String?
    private var wikiDetails: [WikiNodeDetail]
    private var knowledgeCollectionsByID: [String: KnowledgeCollectionSummary] = [:]
    private var validationRunsByID: [String: ValidationRunSummary] = [:]
    private var validationFindingsByID: [String: ValidationFindingSummary] = [:]
    private var buildDiffsByID: [String: BuildDiffSummary] = [:]
    private var designReferences: [DesignReferenceDetail]
    private var designComparisons: [DesignComparisonDetail] = []
    private var recaptureSnapshots: [RuntimeSnapshot]

    private struct PromotedIssueSource {
        let comparisonID: String
        let category: String
        let nodeID: String
        let stableID: String?
    }

    private var promotedIssueSources: [String: PromotedIssueSource] = [:]
    private var promotedDifferenceIssueIDs: [String: String] = [:]

    private struct StoredTuningPatch {
        let summary: TuningPatchSummary
        let changes: [StoredTuningChange]
    }

    private struct StoredTuningChange {
        let id: String
        let draft: TuningChangeDraft
    }

    private struct StoredWikiLink {
        let wikiLinkID: String
        let sourceNodeID: String
        let targetKind: String
        let targetID: String
        let relation: String
    }

    /// The deterministic scripted exploration Operation: it advances one
    /// progress event per poll and succeeds on the fourth poll with a
    /// three-state report; a requested cancellation settles it cancelled on
    /// the next poll instead.
    private struct ScriptedExplorationRun {
        let operationID: String
        let maximumActions: Int
        var pollCount: Int = 0
        var cancelRequested = false
        var settledState: String?
    }

    private var tuningPatchesByID: [String: StoredTuningPatch] = [:]
    private var tuningApplicationsByID: [String: TuningApplicationSummary] = [:]
    private var screenStatesByID: [String: ScreenStateDetail] = [:]
    private var wikiLinks: [StoredWikiLink] = []
    private let automationConfigured: Bool
    private let failActiveTuningReloadWhileApplicationIsActive: Bool
    private var explorationRun: ScriptedExplorationRun?
    /// Captures the most recent preview lifetime so acceptance tests can prove
    /// that automated probes never request an unbounded Runtime override.
    public private(set) var lastTuningPreviewTTLMilliseconds: Int?
    /// How many times the scripted exploration Operation was polled; lets
    /// tests prove the poll loop stopped.
    public private(set) var explorationPollCount = 0
    /// How many times the Screen Graph was requested; lets tests prove the
    /// Canvas refreshed after exploration succeeded.
    public private(set) var screenGraphLoadCount = 0

    /// Replaces the canvas graph mid-test, simulating an external writer
    /// (an agent or the CLI) growing the shared Workspace.
    public func replaceCanvasGraph(_ graph: CanvasGraph) {
        canvasGraph = graph
    }
    /// How many identity curation commands reached this Host, accepted or
    /// rejected; lets tests prove a stale decision was never submitted.
    public private(set) var mergeCount = 0
    public private(set) var splitCount = 0
    /// How many annotation commands reached this Host, accepted or rejected;
    /// lets tests prove a stale annotation decision was never submitted.
    public private(set) var annotateCount = 0
    /// A deterministic counter so fixture-minted identifiers and timestamps
    /// stay reproducible across runs.
    private var mintedCount: UInt64 = 0

    public init(
        snapshots: [RuntimeSnapshot],
        objectsByHash: [String: Data] = [:],
        status: HostStatus = HostStatus(status: .ready, runtimeConnected: true, message: "Canonical fixture"),
        eventTimeline: EventTimeline = EventTimeline(events: [], reportedGaps: []),
        reviewIssues: [ReviewIssueSummary] = [],
        canvasGraph: CanvasGraph? = nil,
        canvasGraphFailureMessage: String? = nil,
        wikiNodes: [WikiNodeSummary] = [],
        designReferences: [DesignReferenceDetail]? = nil,
        recaptureSnapshots: [RuntimeSnapshot] = [],
        automationConfigured: Bool = true,
        failActiveTuningReloadWhileApplicationIsActive: Bool = false
    ) {
        self.status = status
        self.automationConfigured = automationConfigured
        self.failActiveTuningReloadWhileApplicationIsActive =
            failActiveTuningReloadWhileApplicationIsActive
        snapshotsByID = Dictionary(uniqueKeysWithValues: snapshots.map { ($0.snapshotID.rawValue, $0) })
        self.objectsByHash = objectsByHash
        self.eventTimeline = eventTimeline
        self.reviewIssues = reviewIssues
        self.canvasGraph = canvasGraph
        self.canvasGraphFailureMessage = canvasGraphFailureMessage
        self.recaptureSnapshots = recaptureSnapshots
        wikiDetails = wikiNodes.map { node in
            WikiNodeDetail(
                wikiNodeID: node.wikiNodeID,
                revision: 1,
                kind: node.kind,
                title: node.title,
                summary: node.summary,
                markdown: "Fixture knowledge for \(node.title).",
                status: node.status,
                labels: node.labels
            )
        }
        self.designReferences = designReferences
            ?? Self.defaultDesignReferences(snapshots: snapshots)
    }

    /// Mints one deterministic design reference per distinct screenshot so
    /// the fixture-backed workbench has a real baseline. The asset is the
    /// screenshot Object itself: the fixture never invents image bytes.
    private static func defaultDesignReferences(
        snapshots: [RuntimeSnapshot]
    ) -> [DesignReferenceDetail] {
        let latest = snapshots.max(by: {
            $0.capturedAt.wallTime.rawValue < $1.capturedAt.wallTime.rawValue
        })
        guard let latest, let screenshot = latest.screenshot else {
            return []
        }
        return [
            DesignReferenceDetail(
                designReferenceID: "designref_019f0000-0000-7000-8000-0000000000d1",
                revision: 1,
                kind: "design_artifact",
                name: "Fixture design baseline",
                artifact: DesignArtifactSummary(
                    object: DesignObjectSummary(
                        hash: screenshot.object.hash,
                        mediaType: screenshot.object.mediaType
                    )
                ),
                canvasSize: SizeSummary(
                    width: screenshot.coverage.width,
                    height: screenshot.coverage.height
                ),
                pixelSize: PixelSizeSummary(
                    width: screenshot.pixelSize.width.rawValue,
                    height: screenshot.pixelSize.height.rawValue
                )
            ),
        ]
    }

    public func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph {
        screenGraphLoadCount += 1
        if let canvasGraphFailureMessage {
            throw HostClientError.server(
                statusCode: 503,
                requestID: nil,
                code: "fixture_canvas_unavailable",
                message: canvasGraphFailureMessage,
                retryable: true
            )
        }
        guard let canvasGraph else {
            throw HostClientError.server(
                statusCode: 404,
                requestID: nil,
                code: "not_found",
                message: "The fixture Host has no materialized Screen Graph.",
                retryable: false
            )
        }
        return canvasGraph
    }

    public func getScreenGraph(
        projectID: String,
        applicationID: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> CanvasGraph {
        let graph = try await getScreenGraph(projectID: projectID, applicationID: applicationID)
        return CanvasGraph(
            screenGraphID: graph.screenGraphID,
            revision: graph.revision,
            entryStateIDs: graph.entryStateIDs,
            states: graph.states,
            transitions: graph.transitions,
            buildScope: CanvasBuildScope(
                buildID: buildID,
                applicationVersion: applicationVersion,
                screenStateIDs: graph.states.map(\.id),
                transitionIDs: graph.transitions.map(\.id)
            )
        )
    }

    public func searchWikiNodes(text: String?) async throws -> WikiNodePage {
        let summaries = wikiDetails.map(\.summaryProjection)
        guard let text, !text.isEmpty else {
            return WikiNodePage(items: summaries)
        }
        let needle = text.lowercased()
        return WikiNodePage(
            items: summaries.filter { node in
                node.title.lowercased().contains(needle)
                    || (node.summary?.lowercased().contains(needle) ?? false)
                    || node.labels.contains(where: { $0.lowercased().contains(needle) })
            }
        )
    }

    public func listReviewIssues(states: [String]?) async throws -> ReviewIssuePage {
        guard let states else {
            return ReviewIssuePage(items: reviewIssues)
        }
        return ReviewIssuePage(items: reviewIssues.filter { states.contains($0.state) })
    }

    public func validateSnapshot(
        _ draft: ValidateSnapshotDraft
    ) async throws -> ValidationOutcomeSummary {
        guard let snapshot = snapshotsByID[draft.snapshotID] else {
            throw Self.serverError(400, code: "invalid_argument", message: "The Snapshot is not persisted.")
        }
        let nodeID = snapshot.trees.first?.payload.inlineNodes?.first?.nodeID.rawValue
            ?? "node_019f0000-0000-7000-8000-000000000001"
        return makeValidationOutcome(
            target: StudioResourceRef(kind: "runtime_snapshot", id: draft.snapshotID),
            finding: (
                ruleID: "accessibility.minimum-touch-target",
                category: "accessibility",
                severity: "warning",
                message: "Fixture validation demonstrates a reviewable touch-target finding.",
                subject: StudioResourceRef(kind: "ui_node", id: nodeID, version: draft.snapshotID)
            )
        )
    }

    public func validateScreenGraph(
        _ draft: ValidateScreenGraphDraft
    ) async throws -> ValidationOutcomeSummary {
        guard let canvasGraph else {
            throw Self.serverError(400, code: "invalid_argument", message: "The Screen Graph is not persisted.")
        }
        return makeValidationOutcome(
            target: StudioResourceRef(kind: "screen_graph", id: canvasGraph.screenGraphID),
            finding: nil
        )
    }

    public func getValidationRun(id: String) async throws -> ValidationRunSummary {
        guard let run = validationRunsByID[id] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        return run
    }

    public func listValidationFindings(runID: String?) async throws -> ValidationFindingPage {
        let findings = validationFindingsByID.values
            .filter { runID == nil || $0.validationRunID == runID }
            .sorted { $0.findingID < $1.findingID }
        return ValidationFindingPage(items: findings)
    }

    public func suppressValidationFinding(
        id: String,
        _ draft: SuppressValidationFindingDraft
    ) async throws -> ValidationFindingSummary {
        guard let current = validationFindingsByID[id] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        guard current.status == "open", current.revision == draft.expectedFindingRevision else {
            throw Self.serverError(409, code: "conflict", message: "The Finding revision is stale.")
        }
        let updated = ValidationFindingSummary(
            findingID: current.findingID,
            validationRunID: current.validationRunID,
            revision: current.revision + 1,
            ruleID: current.ruleID,
            category: current.category,
            severity: current.severity,
            status: "suppressed",
            message: current.message,
            subject: current.subject,
            expected: current.expected,
            actual: current.actual
        )
        validationFindingsByID[id] = updated
        if let run = validationRunsByID[current.validationRunID] {
            let counts = run.findingCounts
            validationRunsByID[run.id] = ValidationRunSummary(
                validationRunID: run.validationRunID,
                operationID: run.operationID,
                target: run.target,
                state: run.state,
                revision: run.revision + 1,
                findingCounts: ValidationFindingCounts(
                    total: counts.total,
                    open: counts.open > 0 ? counts.open - 1 : 0,
                    suppressed: counts.suppressed + 1,
                    resolved: counts.resolved,
                    bySeverity: counts.bySeverity
                )
            )
        }
        return updated
    }

    public func compareBuilds(_ draft: BuildDiffCommandDraft) async throws -> BuildDiffSummary {
        let observedBuildIDs = Set(snapshotsByID.values.map { $0.runtimeContext.buildID.rawValue })
        guard draft.leftBuildID != draft.rightBuildID,
              observedBuildIDs.contains(draft.leftBuildID),
              observedBuildIDs.contains(draft.rightBuildID)
        else {
            throw Self.serverError(
                400,
                code: "invalid_argument",
                message: "Both distinct builds must be observed in this fixture Workspace."
            )
        }
        let entry = BuildDiffEntrySummary(
            entryID: mintIdentifier("diffentry"),
            kind: "changed",
            domains: ["structural"],
            severity: "info",
            summary: "Fixture comparison demonstrates a build-scoped structural change.",
            leftSubject: StudioResourceRef(
                kind: "build",
                id: draft.leftBuildID
            ),
            rightSubject: StudioResourceRef(
                kind: "build",
                id: draft.rightBuildID
            )
        )
        let diff = BuildDiffSummary(
            buildDiffID: mintIdentifier("builddiff"),
            operationID: mintIdentifier("operation"),
            leftBuild: StudioResourceRef(kind: "build", id: draft.leftBuildID),
            rightBuild: StudioResourceRef(kind: "build", id: draft.rightBuildID),
            summary: BuildDiffCounts(
                total: 1,
                added: 0,
                removed: 0,
                changed: 1,
                regressed: 0,
                improved: 0
            ),
            entries: [entry]
        )
        buildDiffsByID[diff.id] = diff
        return diff
    }

    public func getBuildDiff(id: String) async throws -> BuildDiffSummary {
        guard let diff = buildDiffsByID[id] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        return diff
    }

    public func listReviewIssues(
        states: [String]?,
        screenStateID: String?
    ) async throws -> ReviewIssuePage {
        let stateFiltered: [ReviewIssueSummary]
        if let screenStateID {
            let detail = try await getScreenState(id: screenStateID)
            stateFiltered = reviewIssues.filter {
                $0.targetSnapshotID == detail.canonicalSnapshotID
            }
        } else {
            stateFiltered = reviewIssues
        }
        guard let states else {
            return ReviewIssuePage(items: stateFiltered)
        }
        return ReviewIssuePage(items: stateFiltered.filter { states.contains($0.state) })
    }

    public func getEventTimeline(eventEpochID: String?) async throws -> EventTimeline {
        guard let eventEpochID else {
            return eventTimeline
        }
        return EventTimeline(
            eventEpochID: eventEpochID,
            events: eventTimeline.events.filter { $0.eventEpochID.rawValue == eventEpochID },
            reportedGaps: eventTimeline.reportedGaps
        )
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
        // Materialize the slice so consumers see zero-based offsets, exactly
        // like the bytes HTTPHostClient returns.
        return Data(data[Int(range.lowerBound)...Int(upperBound)])
    }

    public func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        guard let snapshot = latestSnapshot() else {
            throw HostClientError.fixtureUnavailable("The fixture Host has no Runtime Snapshot to capture.")
        }
        snapshotsByID[snapshot.snapshotID.rawValue] = snapshot
        return snapshot
    }

    // MARK: - Tuning preview writes

    public func createTuningPatch(_ draft: TuningPatchDraft) async throws -> TuningPatchSummary {
        guard !draft.title.isEmpty, !draft.changes.isEmpty else {
            throw Self.serverError(400, code: "invalid_argument", message: "The request was rejected as invalid.")
        }
        let tuningAllowlist: Set<String> = [
            "content_insets",
            "spacing",
            "font",
            "foreground_color",
            "background_color",
            "alpha",
            "corner_radius",
        ]
        for change in draft.changes where !tuningAllowlist.contains(change.property) {
            throw Self.serverError(
                422,
                code: "unsupported",
                message: "The tuning property is outside the project allowlist."
            )
        }
        let summary = TuningPatchSummary(
            patchID: mintIdentifier("patch"),
            revision: 1,
            title: draft.title,
            status: "draft",
            targetSnapshotID: draft.targetSnapshotID
        )
        tuningPatchesByID[summary.patchID] = StoredTuningPatch(
            summary: summary,
            changes: draft.changes.map {
                StoredTuningChange(id: mintIdentifier("tuningchange"), draft: $0)
            }
        )
        return summary
    }

    public func getTuningSourceSuggestions(
        patchID: String
    ) async throws -> TuningSourceSuggestionResult {
        guard let stored = tuningPatchesByID[patchID] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        return TuningSourceSuggestionResult(
            patchID: patchID,
            patchRevision: stored.summary.revision,
            targetSnapshotID: stored.summary.targetSnapshotID,
            suggestions: stored.changes.map { change in
                let stableID = change.draft.target.stableID
                return TuningSourceSuggestionSummary(
                    tuningChangeID: change.id,
                    property: change.draft.property,
                    stableID: stableID,
                    sourceContext: nil,
                    status: "needs_source_mapping",
                    originalValue: Self.jsonValue(change.draft.originalValue),
                    suggestedValue: Self.jsonValue(change.draft.previewValue),
                    codingAgentInstructions: [
                        "Locate the source element that emits stable ID \(stableID ?? change.draft.target.nodeID).",
                        "Update \(change.draft.property) to match the verified preview without changing runtime-only instrumentation.",
                    ]
                )
            }
        )
    }

    public func applyTuningPatch(
        patchID: String,
        previewTTLMilliseconds: Int?
    ) async throws -> TuningApplicationSummary {
        lastTuningPreviewTTLMilliseconds = previewTTLMilliseconds
        guard let stored = tuningPatchesByID[patchID] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        try requireConnectedRuntime()
        let latestSnapshotID = latestSnapshot()?.snapshotID.rawValue
        var applied: [AppliedTuningChangeSummary] = []
        var rejected: [RejectedTuningChangeSummary] = []
        for storedChange in stored.changes {
            let change = storedChange.draft
            let changeID = storedChange.id
            if stored.summary.targetSnapshotID != latestSnapshotID {
                rejected.append(
                    RejectedTuningChangeSummary(
                        tuningChangeID: changeID,
                        reasonCode: "stale_snapshot",
                        message: "The preview target Snapshot is no longer the latest capture."
                    )
                )
            } else if !snapshotContainsNode(snapshotID: change.target.snapshotID, nodeID: change.target.nodeID) {
                rejected.append(
                    RejectedTuningChangeSummary(
                        tuningChangeID: changeID,
                        reasonCode: "target_not_found",
                        message: "The Runtime no longer exposes the target node."
                    )
                )
            } else {
                applied.append(AppliedTuningChangeSummary(tuningChangeID: changeID))
            }
        }
        let applicationStatus: String
        if rejected.isEmpty {
            applicationStatus = "active"
        } else if applied.isEmpty {
            applicationStatus = "failed"
        } else {
            applicationStatus = "partially_active"
        }
        let application = TuningApplicationSummary(
            tuningApplicationID: mintIdentifier("tuningapp"),
            revision: 1,
            patchID: patchID,
            status: applicationStatus,
            expectedSnapshotID: stored.summary.targetSnapshotID,
            appliedChanges: applied,
            rejectedChanges: rejected
        )
        tuningApplicationsByID[application.tuningApplicationID] = application
        return application
    }

    public func revertTuningApplication(id: String) async throws -> TuningApplicationSummary {
        guard let current = tuningApplicationsByID[id] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        try requireConnectedRuntime()
        guard current.status == "active" || current.status == "partially_active" else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "Only an active Tuning Application can be reverted."
            )
        }
        let reverted = TuningApplicationSummary(
            tuningApplicationID: current.tuningApplicationID,
            revision: current.revision + 1,
            patchID: current.patchID,
            status: "reverted",
            expectedSnapshotID: current.expectedSnapshotID,
            appliedChanges: current.appliedChanges,
            rejectedChanges: current.rejectedChanges
        )
        tuningApplicationsByID[id] = reverted
        return reverted
    }

    public func listActiveTuningApplications() async throws -> TuningApplicationPage {
        try requireConnectedRuntime()
        let active = tuningApplicationsByID.values
            .filter { $0.status == "active" || $0.status == "partially_active" }
            .sorted { $0.tuningApplicationID < $1.tuningApplicationID }
        if failActiveTuningReloadWhileApplicationIsActive, !active.isEmpty {
            throw Self.serverError(
                503,
                code: "fixture_tuning_reload_failed",
                message: "The fixture rejected the active tuning reload."
            )
        }
        return TuningApplicationPage(items: active)
    }

    // MARK: - Review Issue lifecycle writes

    public func getReviewIssue(id: String) async throws -> ReviewIssueSummary {
        guard let issue = reviewIssues.first(where: { $0.issueID == id }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        return issue
    }

    public func transitionReviewIssue(
        id: String,
        _ request: ReviewIssueTransitionRequest
    ) async throws -> ReviewIssueSummary {
        guard let index = reviewIssues.firstIndex(where: { $0.issueID == id }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        let current = reviewIssues[index]
        guard request.expectedRevision == current.revision else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The request conflicts with the current Workspace state."
            )
        }
        guard ReviewIssueLifecycle.legalTargets(from: current.state).contains(request.toState) else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The Review Issue state transition is not allowed."
            )
        }
        let updated = ReviewIssueSummary(
            issueID: current.issueID,
            revision: current.revision + 1,
            title: current.title,
            category: current.category,
            severity: current.severity,
            state: request.toState,
            updatedAt: mintTimestamp(),
            targetSnapshotID: current.targetSnapshotID
        )
        reviewIssues[index] = updated
        return updated
    }

    public func createReviewIssueFromDifference(
        comparisonID: String,
        _ request: CreateReviewIssueFromDifferenceRequest
    ) async throws -> ReviewIssueSummary {
        guard let comparison = designComparisons.first(where: { $0.comparisonID == comparisonID }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        guard let difference = comparison.differences.first(where: { $0.differenceID == request.differenceID }) else {
            throw Self.serverError(404, code: "not_found", message: "The Design Difference does not exist.")
        }
        let duplicateKey = "\(comparisonID)|\(request.differenceID)"
        if promotedDifferenceIssueIDs[duplicateKey] != nil {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The Design Difference already has a Review Issue."
            )
        }
        guard let runtimeTarget = difference.runtimeTarget else {
            throw Self.serverError(
                409,
                code: "integrity_error",
                message: "The Design Difference has no resolvable Runtime target."
            )
        }
        let targetLabel = runtimeTarget.stableID ?? runtimeTarget.nodeID
        let issue = ReviewIssueSummary(
            issueID: mintIdentifier("issue"),
            revision: 1,
            title: request.title ?? "Design \(difference.category) differs on \(targetLabel)",
            category: difference.category,
            severity: difference.severity,
            state: "open",
            updatedAt: mintTimestamp(),
            targetSnapshotID: comparison.targetSnapshotID
        )
        reviewIssues.append(issue)
        promotedIssueSources[issue.issueID] = PromotedIssueSource(
            comparisonID: comparisonID,
            category: difference.category,
            nodeID: runtimeTarget.nodeID,
            stableID: runtimeTarget.stableID
        )
        promotedDifferenceIssueIDs[duplicateKey] = issue.issueID
        return issue
    }

    public func recaptureAndVerifyReviewIssue(
        id: String,
        _ request: RecaptureReviewIssueRequest
    ) async throws -> RecaptureReviewIssueResult {
        try requireConnectedRuntime()
        guard let issueIndex = reviewIssues.firstIndex(where: { $0.issueID == id }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        let current = reviewIssues[issueIndex]
        guard current.revision == request.expectedRevision else {
            throw Self.serverError(409, code: "conflict", message: "The Review Issue revision is stale.")
        }
        guard current.state == "ready_for_verification" else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "Only a Review Issue that is ready for verification can be recaptured."
            )
        }
        guard let source = promotedIssueSources[id],
              let originalSnapshotID = current.targetSnapshotID,
              let originalSnapshot = snapshotsByID[originalSnapshotID]
        else {
            throw HostClientError.fixtureUnavailable(
                "Fresh-build recapture requires explicit fixture evidence for a promoted Design Difference."
            )
        }
        guard !recaptureSnapshots.isEmpty else {
            throw HostClientError.fixtureUnavailable(
                "Fresh-build recapture requires a connected Runtime; fixture mode does not invent acceptance evidence."
            )
        }
        guard let originalComparison = designComparisons.first(where: {
            $0.comparisonID == source.comparisonID
        }) else {
            throw Self.serverError(
                409,
                code: "integrity_error",
                message: "The promoted Design Comparison no longer exists."
            )
        }
        let captured = recaptureSnapshots.removeFirst()
        guard captured.runtimeContext.buildID != originalSnapshot.runtimeContext.buildID else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "Design acceptance requires a capture from a different real build."
            )
        }
        snapshotsByID[captured.snapshotID.rawValue] = captured
        let comparison = try await runDesignComparison(
            DesignComparisonCommand(
                designReferenceID: originalComparison.designReferenceID,
                targetSnapshotID: captured.snapshotID.rawValue,
                includePixel: true,
                completedBy: request.verifiedBy
            )
        )
        guard let latestIndex = reviewIssues.firstIndex(where: { $0.issueID == id }),
              reviewIssues[latestIndex].revision == request.expectedRevision
        else {
            throw Self.serverError(409, code: "conflict", message: "The Review Issue revision is stale.")
        }
        let matchingDifference = comparison.differences.first { difference in
            guard difference.category == source.category else { return false }
            if let stableID = source.stableID {
                return difference.runtimeTarget?.stableID == stableID
            }
            return difference.runtimeTarget?.nodeID == source.nodeID
        }
        let result = comparison.quality != "complete"
            ? "inconclusive"
            : matchingDifference == nil ? "passed" : "failed"
        let verification = ReviewVerificationSummary(
            verificationRecordID: mintIdentifier("verification"),
            issueID: id,
            issueRevision: request.expectedRevision,
            basis: "real_build",
            result: result,
            verifiedSnapshotID: captured.snapshotID.rawValue,
            verifiedBuildID: captured.runtimeContext.buildID.rawValue,
            verifiedAt: mintTimestamp()
        )
        let updated = ReviewIssueSummary(
            issueID: current.issueID,
            revision: current.revision + 1,
            title: current.title,
            category: current.category,
            severity: current.severity,
            state: result == "passed" ? "resolved" : "in_progress",
            updatedAt: mintTimestamp(),
            targetSnapshotID: current.targetSnapshotID
        )
        reviewIssues[latestIndex] = updated
        return RecaptureReviewIssueResult(
            snapshot: captured,
            comparison: comparison,
            verification: verification,
            issue: updated
        )
    }

    // MARK: - Deep Wiki writes

    public func createWikiNode(_ draft: WikiNodeDraft) async throws -> WikiNodeDetail {
        guard WikiVocabulary.nodeKinds.contains(draft.kind),
              !draft.title.isEmpty,
              !draft.markdown.isEmpty
        else {
            throw Self.serverError(400, code: "invalid_argument", message: "The request was rejected as invalid.")
        }
        let detail = WikiNodeDetail(
            wikiNodeID: mintIdentifier("wiki"),
            revision: 1,
            kind: draft.kind,
            title: draft.title,
            summary: draft.summary,
            markdown: draft.markdown,
            status: "draft",
            labels: draft.labels ?? []
        )
        wikiDetails.insert(detail, at: 0)
        return detail
    }

    public func getWikiNode(id: String) async throws -> WikiNodeDetail {
        guard let detail = wikiDetails.first(where: { $0.wikiNodeID == id }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        return detail
    }

    public func reviseWikiNode(id: String, _ draft: WikiNodeRevisionDraft) async throws -> WikiNodeDetail {
        guard let index = wikiDetails.firstIndex(where: { $0.wikiNodeID == id }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        let current = wikiDetails[index]
        guard draft.expectedRevision == current.revision else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The request conflicts with the current Workspace state."
            )
        }
        if let toStatus = draft.toStatus, toStatus != current.status {
            guard WikiVocabulary.legalStatusTargets(from: current.status).contains(toStatus) else {
                throw Self.serverError(
                    409,
                    code: "conflict",
                    message: "The Wiki node status transition is not allowed."
                )
            }
        }
        if let markdown = draft.markdown, markdown.isEmpty {
            throw Self.serverError(400, code: "invalid_argument", message: "The request was rejected as invalid.")
        }
        let updated = WikiNodeDetail(
            wikiNodeID: current.wikiNodeID,
            revision: current.revision + 1,
            kind: current.kind,
            title: draft.title ?? current.title,
            summary: draft.summary ?? current.summary,
            markdown: draft.markdown ?? current.markdown,
            status: draft.toStatus ?? current.status,
            labels: current.labels
        )
        wikiDetails[index] = updated
        return updated
    }

    public func listKnowledgeCollections(
        text: String?,
        publicationStates: [String]?
    ) async throws -> KnowledgeCollectionPage {
        let needle = text?.lowercased()
        let items = knowledgeCollectionsByID.values
            .filter { collection in
                let matchesText = needle.map {
                    collection.name.lowercased().contains($0)
                        || (collection.summary?.lowercased().contains($0) ?? false)
                } ?? true
                let matchesPublication = publicationStates.map {
                    $0.contains(collection.publication.state)
                } ?? true
                return matchesText && matchesPublication
            }
            .sorted { lhs, rhs in
                if lhs.name == rhs.name { return lhs.collectionID < rhs.collectionID }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
        return KnowledgeCollectionPage(items: items)
    }

    public func getKnowledgeCollection(id: String) async throws -> KnowledgeCollectionSummary {
        guard let collection = knowledgeCollectionsByID[id] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        return collection
    }

    public func createKnowledgeCollection(
        _ draft: KnowledgeCollectionDraft
    ) async throws -> KnowledgeCollectionSummary {
        try validateCollectionMembership(
            name: draft.name,
            nodeIDs: draft.nodeIDs,
            entryNodeIDs: draft.entryNodeIDs
        )
        let collection = KnowledgeCollectionSummary(
            collectionID: mintIdentifier("collection"),
            revision: 1,
            name: draft.name,
            summary: draft.summary,
            nodeIDs: draft.nodeIDs,
            linkIDs: draft.linkIDs,
            entryNodeIDs: draft.entryNodeIDs,
            publication: KnowledgeCollectionPublication(state: "draft")
        )
        knowledgeCollectionsByID[collection.collectionID] = collection
        return collection
    }

    public func reviseKnowledgeCollection(
        id: String,
        _ draft: KnowledgeCollectionRevisionDraft
    ) async throws -> KnowledgeCollectionSummary {
        guard let current = knowledgeCollectionsByID[id] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        guard draft.expectedRevision == current.revision else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The request conflicts with the current Workspace state."
            )
        }
        let nodeIDs = draft.nodeIDs ?? current.nodeIDs
        let entryNodeIDs = draft.entryNodeIDs ?? current.entryNodeIDs
        try validateCollectionMembership(
            name: draft.name ?? current.name,
            nodeIDs: nodeIDs,
            entryNodeIDs: entryNodeIDs
        )
        let updated = KnowledgeCollectionSummary(
            collectionID: current.collectionID,
            revision: current.revision + 1,
            name: draft.name ?? current.name,
            summary: draft.summary ?? current.summary,
            nodeIDs: nodeIDs,
            linkIDs: draft.linkIDs ?? current.linkIDs,
            entryNodeIDs: entryNodeIDs,
            publication: KnowledgeCollectionPublication(state: "draft")
        )
        knowledgeCollectionsByID[id] = updated
        return updated
    }

    // MARK: - Canvas Screen State details and knowledge links

    public func getScreenState(id: String) async throws -> ScreenStateDetail {
        if let existing = screenStatesByID[id] {
            return existing
        }
        guard let state = canvasGraph?.states.first(where: { $0.id == id }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        // Materialize a deterministic detail document for graph states so the
        // fixture Canvas exercises the same selection flow as a real Host.
        let detail = ScreenStateDetail(
            screenStateID: id,
            revision: 1,
            title: state.title,
            kind: state.kind,
            status: state.status,
            canonicalSnapshotID: latestSnapshot()?.snapshotID.rawValue
                ?? "snapshot_019f0000-0000-7000-8000-000000000000",
            firstSeen: "2026-07-12T00:00:00Z",
            lastSeen: "2026-07-12T00:00:05Z",
            labels: state.labels,
            summary: state.summary
        )
        screenStatesByID[id] = detail
        return detail
    }

    public func getScreenState(
        id: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> ScreenStateDetail {
        let detail = try await getScreenState(id: id)
        guard let snapshot = snapshotsByID.values
            .filter({
                $0.runtimeContext.applicationVersion == applicationVersion
                    && $0.runtimeContext.buildID.rawValue == buildID
            })
            .max(by: {
                $0.capturedAt.wallTime.rawValue < $1.capturedAt.wallTime.rawValue
            })
        else {
            throw Self.serverError(
                404,
                code: "not_found",
                message: "The Screen State was not observed in the requested build scope."
            )
        }
        return ScreenStateDetail(
            screenStateID: detail.screenStateID,
            revision: detail.revision,
            title: detail.title,
            kind: detail.kind,
            status: detail.status,
            canonicalSnapshotID: snapshot.snapshotID.rawValue,
            firstSeen: detail.firstSeen,
            lastSeen: detail.lastSeen,
            labels: detail.labels,
            summary: detail.summary
        )
    }

    public func createWikiLink(_ draft: WikiLinkDraft) async throws -> WikiLinkSummary {
        guard wikiDetails.contains(where: { $0.wikiNodeID == draft.sourceNodeID }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        guard WikiVocabulary.linkRelations.contains(draft.relation), !draft.target.id.isEmpty else {
            throw Self.serverError(400, code: "invalid_argument", message: "The request was rejected as invalid.")
        }
        let link = StoredWikiLink(
            wikiLinkID: mintIdentifier("wikilink"),
            sourceNodeID: draft.sourceNodeID,
            targetKind: draft.target.kind,
            targetID: draft.target.id,
            relation: draft.relation
        )
        wikiLinks.append(link)
        return WikiLinkSummary(
            wikiLinkID: link.wikiLinkID,
            sourceNodeID: link.sourceNodeID,
            relation: link.relation
        )
    }

    public func relatedWikiNodes(kind: String, id: String) async throws -> WikiNodePage {
        var seen = Set<String>()
        var related: [WikiNodeSummary] = []
        for link in wikiLinks where link.targetKind == kind && link.targetID == id {
            guard seen.insert(link.sourceNodeID).inserted,
                  let detail = wikiDetails.first(where: { $0.wikiNodeID == link.sourceNodeID })
            else {
                continue
            }
            related.append(detail.summaryProjection)
        }
        return WikiNodePage(items: related)
    }

    // MARK: - Canvas identity curation

    public func mergeScreenStates(_ command: MergeScreenStatesCommand) async throws -> IdentityCurationResult {
        mergeCount += 1
        guard let graph = canvasGraph else {
            throw Self.serverError(404, code: "not_found", message: "The Screen Graph does not exist yet.")
        }
        let stateIDs = command.stateIDs
        guard stateIDs.count >= 2, Set(stateIDs).count == stateIDs.count else {
            throw Self.serverError(400, code: "invalid_argument", message: "A merge names at least two distinct states.")
        }
        let survivorID = command.intoStateID ?? stateIDs[0]
        guard stateIDs.contains(survivorID) else {
            throw Self.serverError(400, code: "invalid_argument", message: "into_state_id must be one of state_ids.")
        }
        guard command.expectedGraphRevision == graph.revision else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The Screen Graph revision does not match.",
                retryable: true
            )
        }
        let named = graph.states.filter { stateIDs.contains($0.id) }
        guard named.count == stateIDs.count, named.allSatisfy(\.isActive) else {
            throw Self.serverError(409, code: "conflict", message: "Every merged state must exist and be active.")
        }
        let absorbedIDs = Set(stateIDs.filter { $0 != survivorID })
        var survivorSummary: CanvasStateSummary?
        let states = graph.states.map { state -> CanvasStateSummary in
            if state.id == survivorID {
                var observationIDs = state.observationIDs
                for absorbed in named where absorbed.id != survivorID {
                    for observationID in absorbed.observationIDs where !observationIDs.contains(observationID) {
                        observationIDs.append(observationID)
                    }
                }
                let updated = CanvasStateSummary(
                    screenStateID: state.screenStateID,
                    title: state.title,
                    kind: state.kind,
                    status: state.status,
                    observationIDs: observationIDs,
                    labels: state.labels,
                    summary: state.summary
                )
                survivorSummary = updated
                return updated
            }
            if absorbedIDs.contains(state.id) {
                return CanvasStateSummary(
                    screenStateID: state.screenStateID,
                    title: state.title,
                    kind: state.kind,
                    status: "merged",
                    observationIDs: state.observationIDs,
                    labels: state.labels,
                    summary: state.summary
                )
            }
            return state
        }
        let transitions = graph.transitions.map { transition -> CanvasTransitionSummary in
            let source = absorbedIDs.contains(transition.sourceStateID) ? survivorID : transition.sourceStateID
            let target = absorbedIDs.contains(transition.targetStateID) ? survivorID : transition.targetStateID
            guard source != transition.sourceStateID || target != transition.targetStateID else {
                return transition
            }
            return CanvasTransitionSummary(
                transitionID: transition.transitionID,
                sourceStateID: source,
                targetStateID: target,
                occurrenceCount: transition.occurrenceCount
            )
        }
        var entryStateIDs: [String] = []
        for entry in graph.entryStateIDs {
            let mapped = absorbedIDs.contains(entry) ? survivorID : entry
            if !entryStateIDs.contains(mapped) {
                entryStateIDs.append(mapped)
            }
        }
        let updatedGraph = CanvasGraph(
            screenGraphID: graph.screenGraphID,
            revision: graph.revision + 1,
            entryStateIDs: entryStateIDs,
            states: states,
            transitions: transitions
        )
        canvasGraph = updatedGraph
        guard let survivorSummary else {
            throw Self.serverError(409, code: "conflict", message: "Every merged state must exist and be active.")
        }
        return IdentityCurationResult(
            screenGraphID: updatedGraph.screenGraphID,
            graphRevision: updatedGraph.revision,
            decision: IdentityDecisionSummary(
                stateIdentityDecisionID: mintIdentifier("identitydecision"),
                kind: "merge"
            ),
            state: survivorSummary
        )
    }

    public func splitScreenState(_ command: SplitScreenStateCommand) async throws -> IdentityCurationResult {
        splitCount += 1
        guard let graph = canvasGraph else {
            throw Self.serverError(404, code: "not_found", message: "The Screen Graph does not exist yet.")
        }
        let movedIDs = command.observationIDs
        guard !movedIDs.isEmpty, Set(movedIDs).count == movedIDs.count else {
            throw Self.serverError(400, code: "invalid_argument", message: "A split names at least one observation once.")
        }
        guard command.expectedGraphRevision == graph.revision else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The Screen Graph revision does not match.",
                retryable: true
            )
        }
        guard let source = graph.states.first(where: { $0.id == command.stateID }), source.isActive else {
            throw Self.serverError(409, code: "conflict", message: "The split state must exist and be active.")
        }
        guard movedIDs.allSatisfy(source.observationIDs.contains) else {
            throw Self.serverError(400, code: "invalid_argument", message: "Every split observation must belong to the state.")
        }
        let remainingIDs = source.observationIDs.filter { !movedIDs.contains($0) }
        guard !remainingIDs.isEmpty else {
            throw Self.serverError(400, code: "invalid_argument", message: "A split must leave at least one observation behind.")
        }
        let newState = CanvasStateSummary(
            screenStateID: mintIdentifier("screenstate"),
            title: command.title ?? "\(source.title) (split)",
            kind: source.kind,
            status: "active",
            observationIDs: movedIDs
        )
        var states = graph.states.map { state -> CanvasStateSummary in
            guard state.id == command.stateID else {
                return state
            }
            return CanvasStateSummary(
                screenStateID: state.screenStateID,
                title: state.title,
                kind: state.kind,
                status: state.status,
                observationIDs: remainingIDs,
                labels: state.labels,
                summary: state.summary
            )
        }
        states.append(newState)
        let updatedGraph = CanvasGraph(
            screenGraphID: graph.screenGraphID,
            revision: graph.revision + 1,
            entryStateIDs: graph.entryStateIDs,
            states: states,
            transitions: graph.transitions
        )
        canvasGraph = updatedGraph
        return IdentityCurationResult(
            screenGraphID: updatedGraph.screenGraphID,
            graphRevision: updatedGraph.revision,
            decision: IdentityDecisionSummary(
                stateIdentityDecisionID: mintIdentifier("identitydecision"),
                kind: "split"
            ),
            state: newState
        )
    }

    // MARK: - Screen State annotation

    public func annotateScreenState(
        _ command: AnnotateScreenStateCommand
    ) async throws -> ScreenStateAnnotationResult {
        annotateCount += 1
        guard let graph = canvasGraph else {
            throw Self.serverError(404, code: "not_found", message: "The Screen Graph does not exist yet.")
        }
        guard command.labels != nil || command.summary != nil else {
            throw Self.serverError(
                400,
                code: "invalid_argument",
                message: "An annotation sets labels, a summary, or both."
            )
        }
        if let labels = command.labels {
            guard Set(labels).count == labels.count,
                  labels.allSatisfy({ !$0.isEmpty && $0.count <= 128 })
            else {
                throw Self.serverError(
                    400,
                    code: "invalid_argument",
                    message: "Labels are unique strings of 1 to 128 characters."
                )
            }
        }
        if let summary = command.summary, summary.count > 280 {
            throw Self.serverError(
                400,
                code: "invalid_argument",
                message: "A summary is at most 280 characters."
            )
        }
        guard command.expectedGraphRevision == graph.revision else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The Screen Graph revision does not match.",
                retryable: true
            )
        }
        guard let state = graph.states.first(where: { $0.id == command.stateID }) else {
            throw Self.serverError(404, code: "not_found", message: "The Screen State does not exist in the graph.")
        }
        guard state.isActive else {
            throw Self.serverError(409, code: "conflict", message: "Only active Screen States can be curated.")
        }
        // An empty array clears the labels; an empty string clears the summary.
        let labels = command.labels.map { $0.isEmpty ? [] : $0 } ?? state.labels
        let summary = command.summary.map { $0.isEmpty ? nil : $0 } ?? state.summary
        let annotated = CanvasStateSummary(
            screenStateID: state.screenStateID,
            title: state.title,
            kind: state.kind,
            status: state.status,
            observationIDs: state.observationIDs,
            labels: labels,
            summary: summary
        )
        let updatedGraph = CanvasGraph(
            screenGraphID: graph.screenGraphID,
            revision: graph.revision + 1,
            entryStateIDs: graph.entryStateIDs,
            states: graph.states.map { $0.id == command.stateID ? annotated : $0 },
            transitions: graph.transitions
        )
        canvasGraph = updatedGraph
        // Drop the cached detail so the next getScreenState re-materializes
        // it with the annotation the graph now carries.
        screenStatesByID.removeValue(forKey: command.stateID)
        return ScreenStateAnnotationResult(
            screenGraphID: updatedGraph.screenGraphID,
            graphRevision: updatedGraph.revision,
            state: annotated
        )
    }

    // MARK: - Design comparison workbench

    public func listDesignReferences() async throws -> DesignReferencePage {
        DesignReferencePage(items: designReferences)
    }

    public func getDesignReference(id: String) async throws -> DesignReferenceDetail {
        guard let reference = designReferences.first(where: { $0.id == id }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        return reference
    }

    public func listDesignComparisons(
        designReferenceID: String?,
        targetSnapshotID: String?
    ) async throws -> DesignComparisonPage {
        var items = designComparisons
        if let designReferenceID {
            items = items.filter { $0.designReferenceID == designReferenceID }
        }
        if let targetSnapshotID {
            items = items.filter { $0.targetSnapshotID == targetSnapshotID }
        }
        return DesignComparisonPage(items: items.reversed())
    }

    /// Produces a deterministic comparison against the fixture Snapshot: one
    /// frame difference on the first interactive stable-ID node, plus one
    /// color difference when the pixel path genuinely has both binaries. A
    /// requested pixel comparison the fixture cannot perform degrades to the
    /// canonical `vistrea.pixel` unavailable verdict and `quality: partial`.
    public func runDesignComparison(
        _ command: DesignComparisonCommand
    ) async throws -> DesignComparisonDetail {
        guard let reference = designReferences.first(where: { $0.id == command.designReferenceID }) else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        guard let snapshot = snapshotsByID[command.targetSnapshotID] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        var quality = "complete"
        var differences: [DesignDifferenceSummary] = []
        let target = Self.comparableNode(in: snapshot)
        if let target {
            differences.append(
                DesignDifferenceSummary(
                    differenceID: mintIdentifier("difference"),
                    category: "frame",
                    severity: "minor",
                    delta: 8,
                    expected: .rect(
                        RectValueSummary(
                            x: target.frame.x + 8,
                            y: target.frame.y,
                            width: target.frame.width,
                            height: target.frame.height
                        )
                    ),
                    actual: .rect(
                        RectValueSummary(
                            x: target.frame.x,
                            y: target.frame.y,
                            width: target.frame.width,
                            height: target.frame.height
                        )
                    ),
                    runtimeTarget: DesignRuntimeTargetSummary(
                        nodeID: target.nodeID,
                        stableID: target.stableID
                    )
                )
            )
        } else {
            quality = "partial"
        }
        var pixel: PixelComparisonStatus?
        if command.includePixel == true {
            let screenshotHash = snapshot.screenshot?.object.hash
            let assetHash = reference.artifact.object.hash
            if snapshot.screenshot == nil {
                pixel = PixelComparisonStatus(
                    status: "unavailable",
                    reason: "The target Snapshot has no screenshot."
                )
                quality = "partial"
            } else if objectsByHash[assetHash] == nil || screenshotHash.flatMap({ objectsByHash[$0] }) == nil {
                pixel = PixelComparisonStatus(
                    status: "unavailable",
                    reason: "The fixture Host does not bundle the design asset or screenshot bytes."
                )
                quality = "partial"
            } else {
                pixel = PixelComparisonStatus(status: "compared")
                if let target {
                    differences.append(
                        DesignDifferenceSummary(
                            differenceID: mintIdentifier("difference"),
                            category: "color",
                            severity: "minor",
                            delta: 0.05,
                            expected: .colorRGBA(
                                ColorRGBAValueSummary(red: 0.2, green: 0.4, blue: 0.9, alpha: 1)
                            ),
                            actual: .colorRGBA(
                                ColorRGBAValueSummary(red: 0.25, green: 0.45, blue: 0.85, alpha: 1)
                            ),
                            runtimeTarget: DesignRuntimeTargetSummary(
                                nodeID: target.nodeID,
                                stableID: target.stableID
                            )
                        )
                    )
                }
            }
        }
        let comparison = DesignComparisonDetail(
            comparisonID: mintIdentifier("comparison"),
            revision: 1,
            designReferenceID: reference.designReferenceID,
            targetSnapshotID: command.targetSnapshotID,
            quality: quality,
            differences: differences,
            completedAt: mintTimestamp(),
            pixel: pixel
        )
        designComparisons.append(comparison)
        return comparison
    }

    /// The first non-root inline node that carries both a stable ID and a
    /// frame; the deterministic difference target.
    private static func comparableNode(
        in snapshot: RuntimeSnapshot
    ) -> (nodeID: String, stableID: String, frame: Rect)? {
        for tree in snapshot.trees {
            for node in tree.payload.inlineNodes ?? [] {
                guard node.parentID != nil,
                      let stableID = node.stableID?.rawValue,
                      let frame = node.frame
                else {
                    continue
                }
                return (node.nodeID.rawValue, stableID, frame)
            }
        }
        return nil
    }

    // MARK: - Exploration Operations

    public func runExploration(_ command: ExplorationRunCommand) async throws -> ExplorationOperationRef {
        try requireAutomationProvider()
        guard (1...500).contains(command.maximumActions) else {
            throw Self.serverError(400, code: "invalid_argument", message: "The request was rejected as invalid.")
        }
        if let run = explorationRun, run.settledState == nil {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "An exploration operation is already running."
            )
        }
        let run = ScriptedExplorationRun(
            operationID: mintIdentifier("operation"),
            maximumActions: command.maximumActions
        )
        explorationRun = run
        return explorationRecord(for: run).operation
    }

    public func getExplorationOperation(id: String) async throws -> ExplorationOperationRecord {
        try requireAutomationProvider()
        guard var run = explorationRun, run.operationID == id else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        explorationPollCount += 1
        if run.settledState == nil {
            if run.cancelRequested {
                run.settledState = "cancelled"
            } else {
                run.pollCount += 1
                if run.pollCount >= 4 {
                    run.settledState = "succeeded"
                }
            }
            explorationRun = run
        }
        return explorationRecord(for: run)
    }

    public func cancelExploration(id: String) async throws -> ExplorationOperationRef {
        try requireAutomationProvider()
        guard var run = explorationRun, run.operationID == id else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        guard run.settledState == nil else {
            throw Self.serverError(
                409,
                code: "conflict",
                message: "The exploration operation is not running."
            )
        }
        run.cancelRequested = true
        explorationRun = run
        return explorationRecord(for: run).operation
    }

    /// Mirrors the live Host: exploration routes require a configured device
    /// automation provider.
    private func requireAutomationProvider() throws {
        guard automationConfigured else {
            throw Self.serverError(
                501,
                code: "unsupported",
                message: "No device automation provider is configured on this Host."
            )
        }
    }

    /// Materializes the scripted run into a deterministic OperationRecord.
    private func explorationRecord(for run: ScriptedExplorationRun) -> ExplorationOperationRecord {
        func time(_ sequence: Int) -> String {
            String(format: "2026-07-12T02:00:%02dZ", sequence)
        }
        var events: [ExplorationOperationEventSummary] = [
            ExplorationOperationEventSummary(sequence: 1, time: time(1), kind: "created", state: "queued"),
            ExplorationOperationEventSummary(sequence: 2, time: time(2), kind: "started", state: "running"),
        ]
        let progressCount = min(run.pollCount, 3)
        for index in 0..<progressCount {
            let sequence = 3 + index
            events.append(
                ExplorationOperationEventSummary(
                    sequence: UInt64(sequence),
                    time: time(sequence),
                    kind: "progressed",
                    state: "running",
                    progress: ExplorationProgressSummary(
                        phase: "exploration.walk",
                        completedUnits: UInt64(index + 1),
                        totalUnits: UInt64(run.maximumActions),
                        unit: "action",
                        message: "Tapped demo.explore.step\(index + 1) and discovered a new state"
                    )
                )
            )
        }
        var operationError: ExplorationOperationError?
        var report: ExplorationReportSummary?
        switch run.settledState {
        case "succeeded":
            let sequence = events.count + 1
            events.append(
                ExplorationOperationEventSummary(
                    sequence: UInt64(sequence),
                    time: time(sequence),
                    kind: "succeeded",
                    state: "succeeded"
                )
            )
            report = ExplorationReportSummary(
                discoveredStateIDs: [
                    "screenstate_019f0000-0000-7000-8000-0000000000a1",
                    "screenstate_019f0000-0000-7000-8000-0000000000a2",
                    "screenstate_019f0000-0000-7000-8000-0000000000a3",
                ],
                actionCount: 3,
                stoppedReason: "frontier_exhausted"
            )
        case "cancelled":
            operationError = ExplorationOperationError(
                code: "cancelled",
                message: "The exploration run was cancelled by the caller."
            )
            let sequence = events.count + 1
            events.append(
                ExplorationOperationEventSummary(
                    sequence: UInt64(sequence),
                    time: time(sequence),
                    kind: "cancelled",
                    state: "cancelled",
                    error: operationError
                )
            )
        default:
            break
        }
        let state = run.settledState ?? "running"
        return ExplorationOperationRecord(
            operation: ExplorationOperationRef(
                operationID: run.operationID,
                kind: "RunExploration",
                state: state,
                createdAt: time(1),
                updatedAt: time(events.count),
                error: operationError
            ),
            revision: UInt64(events.count),
            events: events,
            report: report
        )
    }

    // MARK: - Fixture helpers

    private func latestSnapshot() -> RuntimeSnapshot? {
        snapshotsByID.values.max(by: {
            $0.capturedAt.wallTime.rawValue < $1.capturedAt.wallTime.rawValue
        })
    }

    private static func jsonValue(_ value: TuningPropertyValueDraft) -> JSONValue {
        let emptyExtensions: JSONValue = .object([:])
        switch value {
        case let .number(number, unit):
            return .object([
                "kind": .string("number"),
                "value": .number(number),
                "unit": .string(unit),
                "extensions": emptyExtensions,
            ])
        case let .color(red, green, blue, alpha):
            return .object([
                "kind": .string("color_rgba"),
                "value": .object([
                    "red": .number(red),
                    "green": .number(green),
                    "blue": .number(blue),
                    "alpha": .number(alpha),
                ]),
                "color_space": .string("srgb"),
                "extensions": emptyExtensions,
            ])
        case let .font(family, size, weight, style):
            return .object([
                "kind": .string("font"),
                "value": .object([
                    "family": .string(family),
                    "size": .number(size),
                    "weight": .integer(Int64(weight)),
                    "style": .string(style),
                ]),
                "extensions": emptyExtensions,
            ])
        case let .insets(top, leading, bottom, trailing):
            return .object([
                "kind": .string("insets"),
                "value": .object([
                    "top": .number(top),
                    "leading": .number(leading),
                    "bottom": .number(bottom),
                    "trailing": .number(trailing),
                ]),
                "extensions": emptyExtensions,
            ])
        }
    }

    private func snapshotContainsNode(snapshotID: String, nodeID: String) -> Bool {
        guard let snapshot = snapshotsByID[snapshotID] else {
            return false
        }
        return snapshot.trees.contains { tree in
            tree.payload.inlineNodes?.contains(where: { $0.nodeID.rawValue == nodeID }) ?? false
        }
    }

    private func validateCollectionMembership(
        name: String,
        nodeIDs: [String],
        entryNodeIDs: [String]
    ) throws {
        let nodeSet = Set(nodeIDs)
        let entrySet = Set(entryNodeIDs)
        guard !name.isEmpty,
              !nodeSet.isEmpty,
              nodeSet.count == nodeIDs.count,
              !entrySet.isEmpty,
              entrySet.count == entryNodeIDs.count,
              entrySet.isSubset(of: nodeSet),
              nodeSet.allSatisfy({ id in wikiDetails.contains(where: { $0.wikiNodeID == id }) })
        else {
            throw Self.serverError(
                400,
                code: "invalid_argument",
                message: "The Knowledge Collection membership is invalid."
            )
        }
    }

    private func makeValidationOutcome(
        target: StudioResourceRef,
        finding: (
            ruleID: String,
            category: String,
            severity: String,
            message: String,
            subject: StudioResourceRef
        )?
    ) -> ValidationOutcomeSummary {
        let runID = mintIdentifier("validationrun")
        let findings: [ValidationFindingSummary]
        if let finding {
            findings = [
                ValidationFindingSummary(
                    findingID: mintIdentifier("finding"),
                    validationRunID: runID,
                    revision: 1,
                    ruleID: finding.ruleID,
                    category: finding.category,
                    severity: finding.severity,
                    status: "open",
                    message: finding.message,
                    subject: finding.subject,
                    expected: .object(["minimum": .number(44)]),
                    actual: .object(["measured": .number(32)])
                ),
            ]
        } else {
            findings = []
        }
        let warningCount: UInt64 = findings.contains(where: { $0.severity == "warning" }) ? 1 : 0
        let errorCount: UInt64 = findings.contains(where: { $0.severity == "error" }) ? 1 : 0
        let criticalCount: UInt64 = findings.contains(where: { $0.severity == "critical" }) ? 1 : 0
        let infoCount = UInt64(findings.count) - warningCount - errorCount - criticalCount
        let run = ValidationRunSummary(
            validationRunID: runID,
            operationID: mintIdentifier("operation"),
            target: target,
            state: "succeeded",
            revision: 2,
            findingCounts: ValidationFindingCounts(
                total: UInt64(findings.count),
                open: UInt64(findings.count),
                suppressed: 0,
                resolved: 0,
                bySeverity: ValidationSeverityCounts(
                    info: infoCount,
                    warning: warningCount,
                    error: errorCount,
                    critical: criticalCount
                )
            )
        )
        validationRunsByID[run.id] = run
        for finding in findings {
            validationFindingsByID[finding.id] = finding
        }
        return ValidationOutcomeSummary(run: run, findings: findings)
    }

    /// Mirrors the live Host: tuning routes require an authorized Runtime.
    private func requireConnectedRuntime() throws {
        guard status.runtimeConnected else {
            throw Self.serverError(
                503,
                code: "unavailable",
                message: "An authorized Runtime connection is not available.",
                retryable: true
            )
        }
    }

    private func mintIdentifier(_ prefix: String) -> String {
        mintedCount += 1
        return String(format: "%@_019f0000-0000-7000-8000-%012llx", prefix, mintedCount)
    }

    private func mintTimestamp() -> String {
        mintedCount += 1
        return String(
            format: "2026-07-12T01:%02llu:%02lluZ",
            (mintedCount / 60) % 60,
            mintedCount % 60
        )
    }

    private static func serverError(
        _ statusCode: Int,
        code: String,
        message: String,
        retryable: Bool = false
    ) -> HostClientError {
        .server(
            statusCode: statusCode,
            requestID: nil,
            code: code,
            message: message,
            retryable: retryable
        )
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
    public func getEventTimeline(eventEpochID: String?) async throws -> EventTimeline { throw error }
    public func listReviewIssues(states: [String]?) async throws -> ReviewIssuePage { throw error }
    public func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph { throw error }
    public func searchWikiNodes(text: String?) async throws -> WikiNodePage { throw error }
    public func createTuningPatch(_ draft: TuningPatchDraft) async throws -> TuningPatchSummary { throw error }
    public func applyTuningPatch(
        patchID: String,
        previewTTLMilliseconds: Int?
    ) async throws -> TuningApplicationSummary { throw error }
    public func revertTuningApplication(id: String) async throws -> TuningApplicationSummary { throw error }
    public func listActiveTuningApplications() async throws -> TuningApplicationPage { throw error }
    public func getReviewIssue(id: String) async throws -> ReviewIssueSummary { throw error }
    public func transitionReviewIssue(
        id: String,
        _ request: ReviewIssueTransitionRequest
    ) async throws -> ReviewIssueSummary { throw error }
    public func createReviewIssueFromDifference(
        comparisonID: String,
        _ request: CreateReviewIssueFromDifferenceRequest
    ) async throws -> ReviewIssueSummary { throw error }
    public func recaptureAndVerifyReviewIssue(
        id: String,
        _ request: RecaptureReviewIssueRequest
    ) async throws -> RecaptureReviewIssueResult { throw error }
    public func createWikiNode(_ draft: WikiNodeDraft) async throws -> WikiNodeDetail { throw error }
    public func getWikiNode(id: String) async throws -> WikiNodeDetail { throw error }
    public func reviseWikiNode(id: String, _ draft: WikiNodeRevisionDraft) async throws -> WikiNodeDetail {
        throw error
    }
    public func getScreenState(id: String) async throws -> ScreenStateDetail { throw error }
    public func createWikiLink(_ draft: WikiLinkDraft) async throws -> WikiLinkSummary { throw error }
    public func relatedWikiNodes(kind: String, id: String) async throws -> WikiNodePage { throw error }
    public func mergeScreenStates(
        _ command: MergeScreenStatesCommand
    ) async throws -> IdentityCurationResult { throw error }
    public func splitScreenState(
        _ command: SplitScreenStateCommand
    ) async throws -> IdentityCurationResult { throw error }
    public func annotateScreenState(
        _ command: AnnotateScreenStateCommand
    ) async throws -> ScreenStateAnnotationResult { throw error }
    public func listDesignReferences() async throws -> DesignReferencePage { throw error }
    public func getDesignReference(id: String) async throws -> DesignReferenceDetail { throw error }
    public func listDesignComparisons(
        designReferenceID: String?,
        targetSnapshotID: String?
    ) async throws -> DesignComparisonPage { throw error }
    public func runDesignComparison(
        _ command: DesignComparisonCommand
    ) async throws -> DesignComparisonDetail { throw error }
    public func runExploration(_ command: ExplorationRunCommand) async throws -> ExplorationOperationRef {
        throw error
    }
    public func getExplorationOperation(id: String) async throws -> ExplorationOperationRecord {
        throw error
    }
    public func cancelExploration(id: String) async throws -> ExplorationOperationRef { throw error }
}

/// The canonical fixture-backed development Workspace.
///
/// A `FixtureHostClient` built from Snapshots alone has no materialized Screen
/// Graph, so the Canvas answers 404 and identity curation is unreachable. This
/// composition adds the deterministic Screen Graph, Deep Wiki, and Review Issue
/// documents the panes need, so fixture mode exercises every read and write
/// flow the product claims — without a Host and without inventing Runtime
/// evidence: the Snapshot, its screenshot Object metadata, and the design
/// baseline still come from the canonical fixture.
public enum FixtureWorkspace {
    public static let projectID = "project_019f0000-0000-7000-8000-000000000001"

    public static func makeClient(snapshot: RuntimeSnapshot) -> FixtureHostClient {
        FixtureHostClient(
            snapshots: [snapshot],
            reviewIssues: reviewIssues(),
            canvasGraph: canvasGraph(),
            wikiNodes: wikiNodes()
        )
    }

    /// Three observed Screen States: the entry state carries two observations
    /// so a split is possible, and two active siblings make a merge possible.
    public static func canvasGraph() -> CanvasGraph {
        let home = "screenstate_019f0000-0000-7000-8000-0000000000c1"
        let catalog = "screenstate_019f0000-0000-7000-8000-0000000000c2"
        let catalogVariant = "screenstate_019f0000-0000-7000-8000-0000000000c3"
        return CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-0000000000c0",
            revision: 1,
            entryStateIDs: [home],
            states: [
                CanvasStateSummary(
                    screenStateID: home,
                    title: "Home",
                    kind: "screen",
                    status: "active",
                    observationIDs: [
                        "observation_019f0000-0000-7000-8000-0000000000d1",
                        "observation_019f0000-0000-7000-8000-0000000000d2",
                    ]
                ),
                CanvasStateSummary(
                    screenStateID: catalog,
                    title: "Catalog",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation_019f0000-0000-7000-8000-0000000000d3"]
                ),
                CanvasStateSummary(
                    screenStateID: catalogVariant,
                    title: "Catalog (loading)",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation_019f0000-0000-7000-8000-0000000000d4"]
                ),
            ],
            transitions: [
                CanvasTransitionSummary(
                    transitionID: "transition_019f0000-0000-7000-8000-0000000000e1",
                    sourceStateID: home,
                    targetStateID: catalog,
                    occurrenceCount: 3
                ),
                CanvasTransitionSummary(
                    transitionID: "transition_019f0000-0000-7000-8000-0000000000e2",
                    sourceStateID: home,
                    targetStateID: catalogVariant,
                    occurrenceCount: 1
                ),
            ]
        )
    }

    public static func wikiNodes() -> [WikiNodeSummary] {
        [
            WikiNodeSummary(
                wikiNodeID: "wiki_019f0000-0000-7000-8000-0000000000f1",
                kind: "screen",
                title: "Home screen",
                summary: "The entry screen of the Demo application.",
                status: "published",
                labels: ["demo", "entry"]
            ),
            WikiNodeSummary(
                wikiNodeID: "wiki_019f0000-0000-7000-8000-0000000000f2",
                kind: "component",
                title: "Primary action button",
                summary: "The shared call-to-action component.",
                status: "draft",
                labels: ["component"]
            ),
        ]
    }

    public static func reviewIssues() -> [ReviewIssueSummary] {
        [
            ReviewIssueSummary(
                issueID: "issue_019f0000-0000-7000-8000-0000000000a1",
                revision: 1,
                title: "Primary action is 8 pt left of the design baseline",
                category: "layout",
                severity: "minor",
                state: "open",
                updatedAt: "2026-07-12T00:00:00Z",
                targetSnapshotID: "snapshot_019f0000-0000-7000-8000-000000000002"
            ),
        ]
    }
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
