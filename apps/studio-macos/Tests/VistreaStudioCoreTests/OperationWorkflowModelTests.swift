import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

@MainActor
final class OperationWorkflowModelTests: XCTestCase {
    private static func fixtureGraph() -> CanvasGraph {
        CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-000000000001",
            entryStateIDs: ["screenstate_019f0000-0000-7000-8000-000000000001"],
            states: [
                CanvasStateSummary(
                    screenStateID: "screenstate_019f0000-0000-7000-8000-000000000001",
                    title: "Home",
                    kind: "screen",
                    status: "active"
                ),
            ],
            transitions: []
        )
    }

    private static func openIssue() -> ReviewIssueSummary {
        ReviewIssueSummary(
            issueID: "issue_019f0000-0000-7000-8000-000000000001",
            revision: 1,
            title: "Button alpha differs from design",
            category: "alpha",
            severity: "major",
            state: "open",
            updatedAt: "2026-07-12T00:00:00Z",
            targetSnapshotID: "snapshot_019f0000-0000-7000-8000-000000000002"
        )
    }

    /// A second Snapshot with a later capture time, so a patch bound to the
    /// original fixture Snapshot becomes stale.
    private static func laterSnapshot() throws -> RuntimeSnapshot {
        let source = try StudioTestFixtures.data(
            "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
        )
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: source) as? [String: Any])
        object["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-000000000099"
        var capturedAt = try XCTUnwrap(object["captured_at"] as? [String: Any])
        capturedAt["wall_time"] = "2026-07-13T00:00:00Z"
        object["captured_at"] = capturedAt
        return try RuntimeSnapshotCodec.decode(
            JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }

    private static func snapshotForSecondBuild() throws -> RuntimeSnapshot {
        let source = try StudioTestFixtures.data(
            "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
        )
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: source) as? [String: Any])
        object["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-000000000098"
        var capturedAt = try XCTUnwrap(object["captured_at"] as? [String: Any])
        capturedAt["wall_time"] = "2026-07-14T00:00:00Z"
        object["captured_at"] = capturedAt
        var runtimeContext = try XCTUnwrap(object["runtime_context"] as? [String: Any])
        runtimeContext["application_version"] = "2.0.0"
        runtimeContext["build_id"] = "build_019f0000-0000-7000-8000-000000000098"
        object["runtime_context"] = runtimeContext
        return try RuntimeSnapshotCodec.decode(
            JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }

    // MARK: - Tuning preview

    func testPreviewAlphaAppliesPatchAndListsActivePreview() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))
        await model.refresh()
        XCTAssertEqual(model.selectedNode?.stableID, "demo.home.root")

        await model.previewAlpha(0.4)

        XCTAssertNil(model.tuningError)
        let outcome = try XCTUnwrap(model.lastTuningApplication)
        XCTAssertEqual(outcome.status, "active")
        XCTAssertEqual(outcome.appliedChanges.count, 1)
        XCTAssertTrue(outcome.rejectedChanges.isEmpty)
        XCTAssertEqual(outcome.expectedSnapshotID, snapshot.snapshotID.rawValue)
        XCTAssertEqual(model.tuningPhase, .content)
        XCTAssertEqual(model.activeTuning.map(\.id), [outcome.id])
        XCTAssertFalse(model.isApplyingTuning)
    }

    func testLatestTuningPatchProducesAnExplicitSourceHandoff() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))
        await model.refresh()

        await model.previewAlpha(0.4)
        let patch = try XCTUnwrap(model.lastTuningPatch)
        XCTAssertEqual(patch.targetSnapshotID, snapshot.snapshotID.rawValue)
        XCTAssertEqual(model.tuningSourceSuggestionsPhase, .idle)

        await model.loadTuningSourceSuggestions()

        XCTAssertEqual(model.tuningSourceSuggestionsPhase, .content)
        let suggestion = try XCTUnwrap(model.tuningSourceSuggestions.first)
        XCTAssertEqual(suggestion.property, "alpha")
        XCTAssertEqual(suggestion.stableID, "demo.home.root")
        XCTAssertEqual(suggestion.status, "needs_source_mapping")
        XCTAssertEqual(suggestion.originalValue, .object([
            "kind": .string("number"),
            "value": .number(1),
            "unit": .string("ratio"),
            "extensions": .object([:]),
        ]))
        XCTAssertEqual(suggestion.suggestedValue, .object([
            "kind": .string("number"),
            "value": .number(0.4),
            "unit": .string("ratio"),
            "extensions": .object([:]),
        ]))
        XCTAssertEqual(suggestion.codingAgentInstructions.count, 2)
        XCTAssertTrue(suggestion.codingAgentInstructions[0].contains("demo.home.root"))
    }

    func testPreviewAlphaSurfacesRejectionReasonCodesVerbatim() async throws {
        let original = try StudioTestFixtures.snapshot()
        let later = try Self.laterSnapshot()
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(snapshots: [original, later])
        )
        await model.refresh()
        // Bind the preview to the older Snapshot so the Runtime rejects it.
        await model.selectSnapshot(id: original.snapshotID.rawValue)

        await model.previewAlpha(0.4)

        XCTAssertNil(model.tuningError)
        let outcome = try XCTUnwrap(model.lastTuningApplication)
        XCTAssertEqual(outcome.status, "failed")
        XCTAssertTrue(outcome.appliedChanges.isEmpty)
        XCTAssertEqual(outcome.rejectedChanges.map(\.reasonCode), ["stale_snapshot"])
        XCTAssertFalse(outcome.rejectedChanges[0].message.isEmpty)
        // A fully rejected preview never becomes an active preview.
        XCTAssertEqual(model.tuningPhase, .empty)
        XCTAssertTrue(model.activeTuning.isEmpty)
    }

    func testPreviewAlphaWithoutRuntimeShowsInlineErrorAndDegradesHonestly() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(
                snapshots: [snapshot],
                status: HostStatus(status: .degraded, runtimeConnected: false)
            )
        )
        await model.refresh()

        // The active-previews pane degrades to the Host's inline error.
        guard case .failure = model.tuningPhase else {
            return XCTFail("Expected the active-tuning pane to surface the Runtime outage.")
        }

        await model.previewAlpha(0.4)

        let message = try XCTUnwrap(model.tuningError)
        XCTAssertTrue(message.contains("Runtime connection"), "Unexpected message: \(message)")
        XCTAssertNil(model.lastTuningApplication)
        XCTAssertFalse(model.isApplyingTuning)
    }

    func testRevertRemovesActivePreview() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))
        await model.refresh()
        await model.previewAlpha(0.2)
        let applicationID = try XCTUnwrap(model.lastTuningApplication?.id)

        await model.revertTuning(id: applicationID)

        XCTAssertNil(model.tuningError)
        XCTAssertEqual(model.lastTuningApplication?.status, "reverted")
        XCTAssertEqual(model.lastTuningApplication?.revision, 2)
        XCTAssertEqual(model.tuningPhase, .empty)
        XCTAssertTrue(model.activeTuning.isEmpty)
        XCTAssertTrue(model.revertingTuningIDs.isEmpty)
    }

    // MARK: - Review Issue lifecycle

    func testIssueSelectionOffersOnlyLegalTransitionsAndAppliesOne() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let issue = Self.openIssue()
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(
                snapshots: [snapshot],
                reviewIssues: [issue],
                canvasGraph: Self.fixtureGraph()
            )
        )
        await model.refresh()
        await model.selectCanvasState(id: Self.fixtureGraph().states[0].id)

        XCTAssertEqual(model.reviewIssues.map(\.id), [issue.id])

        await model.selectReviewIssue(id: issue.issueID)
        XCTAssertEqual(model.issueDetailPhase, .content)
        XCTAssertEqual(model.selectedIssue?.revision, 1)
        XCTAssertEqual(
            model.legalIssueTransitions,
            ["in_progress", "ready_for_verification", "wont_fix"]
        )

        await model.transitionSelectedIssue(to: "in_progress", reason: "Taking this")

        XCTAssertNil(model.issueTransitionError)
        XCTAssertNil(model.issueConflictNote)
        XCTAssertEqual(model.selectedIssue?.state, "in_progress")
        XCTAssertEqual(model.selectedIssue?.revision, 2)
        XCTAssertEqual(model.reviewIssues.first?.state, "in_progress")
        XCTAssertEqual(
            model.legalIssueTransitions,
            ["open", "ready_for_verification", "wont_fix"]
        )
    }

    func testIssueTransitionConflictReloadsIssueAndLeavesNote() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let issue = Self.openIssue()
        let client = FixtureHostClient(
            snapshots: [snapshot],
            reviewIssues: [issue],
            canvasGraph: Self.fixtureGraph()
        )
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        await model.selectCanvasState(id: Self.fixtureGraph().states[0].id)
        await model.selectReviewIssue(id: issue.issueID)
        XCTAssertEqual(model.selectedIssue?.revision, 1)

        // Another actor transitions the issue first.
        _ = try await client.transitionReviewIssue(
            id: issue.issueID,
            ReviewIssueTransitionRequest(expectedRevision: 1, toState: "in_progress", changedBy: .studio)
        )

        await model.transitionSelectedIssue(to: "wont_fix", reason: nil)

        XCTAssertNotNil(model.issueConflictNote)
        XCTAssertNil(model.issueTransitionError)
        // The conflicting write was not applied; the latest revision loaded.
        XCTAssertEqual(model.selectedIssue?.state, "in_progress")
        XCTAssertEqual(model.selectedIssue?.revision, 2)
        XCTAssertEqual(model.issueDetailPhase, .content)
        XCTAssertFalse(model.isTransitioningIssue)
    }

    // MARK: - Deep Wiki editing

    func testWikiCreateEditAndPublishFlowPersistsRevisions() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))
        await model.refresh()

        let created = await model.createWikiNode(
            kind: "note",
            title: "Alpha rules",
            summary: "Preview rules.",
            markdown: "# Alpha"
        )
        XCTAssertTrue(created)
        XCTAssertNil(model.wikiWriteError)
        XCTAssertEqual(model.wikiPhase, .content)
        let listed = try XCTUnwrap(model.wikiNodes.first)
        XCTAssertEqual(listed.title, "Alpha rules")
        XCTAssertEqual(listed.status, "draft")

        await model.beginWikiEdit(nodeID: listed.id)
        XCTAssertEqual(model.wikiEditPhase, .content)
        XCTAssertEqual(model.wikiEditingNode?.markdown, "# Alpha")
        XCTAssertEqual(model.wikiEditingNode?.revision, 1)

        let saved = await model.saveWikiEdit(
            title: nil,
            summary: nil,
            markdown: "# Alpha v2",
            toStatus: "published"
        )
        XCTAssertTrue(saved)
        XCTAssertEqual(model.wikiEditingNode?.revision, 2)
        XCTAssertEqual(model.wikiEditingNode?.status, "published")
        XCTAssertEqual(model.wikiEditingNode?.markdown, "# Alpha v2")
        XCTAssertEqual(model.wikiNodes.first?.status, "published")
    }

    func testWikiEditConflictReloadsNodeAndLeavesNote() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot])
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        _ = await model.createWikiNode(kind: "note", title: "Alpha rules", summary: nil, markdown: "# Alpha")
        let nodeID = try XCTUnwrap(model.wikiNodes.first?.id)
        await model.beginWikiEdit(nodeID: nodeID)
        XCTAssertEqual(model.wikiEditingNode?.revision, 1)

        // Another actor revises the node first.
        _ = try await client.reviseWikiNode(
            nodeID,
            expectedRevision: 1,
            markdown: "# Alpha from elsewhere"
        )

        let saved = await model.saveWikiEdit(
            title: nil,
            summary: nil,
            markdown: "# Alpha stale write",
            toStatus: nil
        )

        XCTAssertFalse(saved)
        XCTAssertNotNil(model.wikiConflictNote)
        XCTAssertNil(model.wikiWriteError)
        XCTAssertEqual(model.wikiEditingNode?.revision, 2)
        XCTAssertEqual(model.wikiEditingNode?.markdown, "# Alpha from elsewhere")
        XCTAssertEqual(model.wikiEditPhase, .content)
    }

    func testWikiCreateRejectionSurfacesInlineError() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))
        await model.refresh()

        let created = await model.createWikiNode(
            kind: "not-a-kind",
            title: "Broken",
            summary: nil,
            markdown: "# x"
        )

        XCTAssertFalse(created)
        XCTAssertNotNil(model.wikiWriteError)
        XCTAssertFalse(model.isSavingWikiNode)
    }

    func testKnowledgeCollectionCreateEditAndConflictReload() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot])
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        _ = await model.createWikiNode(
            kind: "screen",
            title: "Home",
            summary: nil,
            markdown: "# Home"
        )
        _ = await model.createWikiNode(
            kind: "path",
            title: "Checkout path",
            summary: nil,
            markdown: "# Checkout"
        )
        let nodes = model.wikiNodes
        XCTAssertEqual(nodes.count, 2)

        let created = await model.createKnowledgeCollection(
            name: "Checkout knowledge",
            summary: "The local checkout flow.",
            nodeIDs: nodes.map(\.id),
            entryNodeIDs: [nodes[0].id]
        )

        XCTAssertTrue(created)
        XCTAssertNil(model.knowledgeCollectionError)
        XCTAssertEqual(model.knowledgeCollectionsPhase, .content)
        let collection = try XCTUnwrap(model.selectedKnowledgeCollection)
        XCTAssertEqual(collection.revision, 1)
        XCTAssertEqual(collection.publication.state, "draft")
        XCTAssertEqual(Set(collection.nodeIDs), Set(nodes.map(\.id)))

        model.beginKnowledgeCollectionEdit(collection)
        let updated = await model.updateSelectedKnowledgeCollection(
            name: "Checkout runtime knowledge",
            summary: "The verified checkout flow.",
            nodeIDs: nodes.map(\.id),
            entryNodeIDs: nodes.map(\.id)
        )
        XCTAssertTrue(updated)
        XCTAssertEqual(model.selectedKnowledgeCollection?.revision, 2)
        XCTAssertEqual(model.selectedKnowledgeCollection?.name, "Checkout runtime knowledge")
        XCTAssertEqual(Set(model.selectedKnowledgeCollection?.entryNodeIDs ?? []), Set(nodes.map(\.id)))

        _ = try await client.reviseKnowledgeCollection(
            id: collection.id,
            KnowledgeCollectionRevisionDraft(
                expectedRevision: 2,
                name: "Changed elsewhere"
            )
        )
        let staleSave = await model.updateSelectedKnowledgeCollection(
            name: "Stale local title",
            summary: "The verified checkout flow.",
            nodeIDs: nodes.map(\.id),
            entryNodeIDs: nodes.map(\.id)
        )

        XCTAssertFalse(staleSave)
        XCTAssertNotNil(model.knowledgeCollectionConflictNote)
        XCTAssertNil(model.knowledgeCollectionError)
        XCTAssertEqual(model.selectedKnowledgeCollection?.revision, 3)
        XCTAssertEqual(model.selectedKnowledgeCollection?.name, "Changed elsewhere")
    }

    func testLocalQualityWorkflowValidatesSuppressesAndComparesBuilds() async throws {
        let original = try StudioTestFixtures.snapshot()
        let secondBuild = try Self.snapshotForSecondBuild()
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(
                snapshots: [original, secondBuild],
                canvasGraph: Self.fixtureGraph()
            )
        )
        await model.refresh()
        XCTAssertEqual(model.qualityBuildScopes.count, 2)

        await model.validateSelectedSnapshot()
        XCTAssertEqual(model.validationPhase, .content)
        XCTAssertEqual(model.lastValidationRun?.state, "succeeded")
        XCTAssertEqual(model.lastValidationRun?.findingCounts.open, 1)
        let finding = try XCTUnwrap(model.validationFindings.first)
        XCTAssertEqual(finding.status, "open")

        let suppressed = await model.suppressValidationFinding(
            id: finding.id,
            reasonCode: "known_issue",
            justification: "Tracked in the local product backlog."
        )
        XCTAssertTrue(suppressed)
        XCTAssertEqual(model.validationFindings.first?.status, "suppressed")
        XCTAssertEqual(model.lastValidationRun?.findingCounts.open, 0)
        XCTAssertEqual(model.lastValidationRun?.findingCounts.suppressed, 1)

        await model.validateSelectedScreenGraph()
        XCTAssertEqual(model.validationPhase, .empty)
        XCTAssertEqual(model.lastValidationRun?.target.kind, "screen_graph")

        await model.compareBuilds(
            leftBuildID: original.runtimeContext.buildID.rawValue,
            rightBuildID: secondBuild.runtimeContext.buildID.rawValue
        )
        XCTAssertEqual(model.buildDiffPhase, .content)
        XCTAssertNil(model.buildDiffError)
        XCTAssertEqual(model.lastBuildDiff?.summary.changed, 1)
        XCTAssertEqual(model.lastBuildDiff?.entries.first?.kind, "changed")

        let alternateScope = try XCTUnwrap(
            model.availableScopes.first(where: { $0 != model.selectedScope })
        )
        await model.selectScope(alternateScope)
        XCTAssertEqual(model.validationPhase, .idle)
        XCTAssertNil(model.lastValidationRun)
        XCTAssertEqual(model.buildDiffPhase, .idle)
        XCTAssertNil(model.lastBuildDiff)
    }

    // MARK: - Canvas Screen State details and knowledge links

    func testCanvasStateSelectionLoadsDetailAndLinksWikiNode() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        )
        await model.refresh()
        _ = await model.createWikiNode(
            kind: "screen",
            title: "Home knowledge",
            summary: nil,
            markdown: "# Home"
        )
        let wikiNodeID = try XCTUnwrap(model.wikiNodes.first?.id)
        let stateID = "screenstate_019f0000-0000-7000-8000-000000000001"

        await model.selectCanvasState(id: stateID)

        XCTAssertEqual(model.canvasStatePhase, .content)
        let detail = try XCTUnwrap(model.canvasStateDetail)
        XCTAssertEqual(detail.title, "Home")
        XCTAssertEqual(detail.kind, "screen")
        XCTAssertEqual(detail.canonicalSnapshotID, snapshot.snapshotID.rawValue)
        XCTAssertFalse(detail.firstSeen.isEmpty)
        XCTAssertTrue(model.relatedWikiNodes.isEmpty)

        await model.linkSelectedCanvasState(toWikiNode: wikiNodeID)

        XCTAssertNil(model.canvasLinkError)
        XCTAssertEqual(model.relatedWikiNodes.map(\.title), ["Home knowledge"])

        await model.selectCanvasState(id: nil)
        XCTAssertNil(model.canvasStateDetail)
        XCTAssertEqual(model.canvasStatePhase, .idle)
        XCTAssertTrue(model.relatedWikiNodes.isEmpty)
    }

    func testCanvasUnknownStateSurfacesInlineFailure() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        )
        await model.refresh()

        await model.selectCanvasState(id: "screenstate_019f0000-0000-7000-8000-00000000ffff")

        guard case .failure = model.canvasStatePhase else {
            return XCTFail("Expected the unknown Screen State to surface an inline failure.")
        }
        XCTAssertNil(model.canvasStateDetail)
    }

    func testLifecycleTablesMatchTheEngineTruth() {
        XCTAssertEqual(
            ReviewIssueLifecycle.legalTargets(from: "ready_for_verification"),
            ["in_progress", "resolved", "wont_fix"]
        )
        XCTAssertEqual(ReviewIssueLifecycle.legalTargets(from: "resolved"), ["open"])
        XCTAssertEqual(ReviewIssueLifecycle.legalTargets(from: "unknown"), [])
        XCTAssertEqual(WikiVocabulary.legalStatusTargets(from: "draft"), ["published", "archived"])
        XCTAssertEqual(WikiVocabulary.legalStatusTargets(from: "published"), ["archived"])
        XCTAssertEqual(WikiVocabulary.legalStatusTargets(from: "archived"), ["published"])
        XCTAssertEqual(WikiVocabulary.nodeKinds.count, 8)
    }
}

private extension FixtureHostClient {
    /// A test-side convenience for simulating an external Wiki revision.
    func reviseWikiNode(
        _ nodeID: String,
        expectedRevision: UInt64,
        markdown: String
    ) async throws -> WikiNodeDetail {
        try await reviseWikiNode(
            id: nodeID,
            WikiNodeRevisionDraft(
                expectedRevision: expectedRevision,
                markdown: markdown,
                updatedBy: .studio
            )
        )
    }
}
