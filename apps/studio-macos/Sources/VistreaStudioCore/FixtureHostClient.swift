import Foundation
import VistreaRuntimeModels

public actor FixtureHostClient: HostClient {
    private let status: HostStatus
    private var snapshotsByID: [String: RuntimeSnapshot]
    private let objectsByHash: [String: Data]
    private let eventTimeline: EventTimeline
    private var reviewIssues: [ReviewIssueSummary]
    private let canvasGraph: CanvasGraph?
    private var wikiDetails: [WikiNodeDetail]

    private struct StoredTuningPatch {
        let summary: TuningPatchSummary
        let changes: [TuningChangeDraft]
    }

    private struct StoredWikiLink {
        let wikiLinkID: String
        let sourceNodeID: String
        let targetKind: String
        let targetID: String
        let relation: String
    }

    private var tuningPatchesByID: [String: StoredTuningPatch] = [:]
    private var tuningApplicationsByID: [String: TuningApplicationSummary] = [:]
    private var screenStatesByID: [String: ScreenStateDetail] = [:]
    private var wikiLinks: [StoredWikiLink] = []
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
        wikiNodes: [WikiNodeSummary] = []
    ) {
        self.status = status
        snapshotsByID = Dictionary(uniqueKeysWithValues: snapshots.map { ($0.snapshotID.rawValue, $0) })
        self.objectsByHash = objectsByHash
        self.eventTimeline = eventTimeline
        self.reviewIssues = reviewIssues
        self.canvasGraph = canvasGraph
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
    }

    public func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph {
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
        for change in draft.changes where change.property != "alpha" {
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
        tuningPatchesByID[summary.patchID] = StoredTuningPatch(summary: summary, changes: draft.changes)
        return summary
    }

    public func applyTuningPatch(
        patchID: String,
        previewTTLMilliseconds: Int?
    ) async throws -> TuningApplicationSummary {
        guard let stored = tuningPatchesByID[patchID] else {
            throw Self.serverError(404, code: "not_found", message: "The requested resource does not exist.")
        }
        try requireConnectedRuntime()
        let latestSnapshotID = latestSnapshot()?.snapshotID.rawValue
        var applied: [AppliedTuningChangeSummary] = []
        var rejected: [RejectedTuningChangeSummary] = []
        for change in stored.changes {
            let changeID = mintIdentifier("tuningchange")
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
            updatedAt: mintTimestamp()
        )
        reviewIssues[index] = updated
        return updated
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
            lastSeen: "2026-07-12T00:00:05Z"
        )
        screenStatesByID[id] = detail
        return detail
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

    // MARK: - Fixture helpers

    private func latestSnapshot() -> RuntimeSnapshot? {
        snapshotsByID.values.max(by: {
            $0.capturedAt.wallTime.rawValue < $1.capturedAt.wallTime.rawValue
        })
    }

    private func snapshotContainsNode(snapshotID: String, nodeID: String) -> Bool {
        guard let snapshot = snapshotsByID[snapshotID] else {
            return false
        }
        return snapshot.trees.contains { tree in
            tree.payload.inlineNodes?.contains(where: { $0.nodeID.rawValue == nodeID }) ?? false
        }
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
    public func createWikiNode(_ draft: WikiNodeDraft) async throws -> WikiNodeDetail { throw error }
    public func getWikiNode(id: String) async throws -> WikiNodeDetail { throw error }
    public func reviseWikiNode(id: String, _ draft: WikiNodeRevisionDraft) async throws -> WikiNodeDetail {
        throw error
    }
    public func getScreenState(id: String) async throws -> ScreenStateDetail { throw error }
    public func createWikiLink(_ draft: WikiLinkDraft) async throws -> WikiLinkSummary { throw error }
    public func relatedWikiNodes(kind: String, id: String) async throws -> WikiNodePage { throw error }
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
