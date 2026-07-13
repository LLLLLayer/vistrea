import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

private let projectID = "project_019f0000-0000-7000-8000-000000000001"
private let applicationID = "dev.vistrea.demo"
private let stateOneID = "screenstate_019f0000-0000-7000-8000-000000000001"
private let stateTwoID = "screenstate_019f0000-0000-7000-8000-000000000002"
private let stateThreeID = "screenstate_019f0000-0000-7000-8000-000000000003"

/// Screen State annotations: the pure editor form rules, the fixture Host
/// round trip with its revision bump, and the model's begin/submit revision
/// guard mirroring merge and split.
@MainActor
final class StateAnnotationTests: XCTestCase {
    private static func fixtureGraph() -> CanvasGraph {
        CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-000000000001",
            revision: 1,
            entryStateIDs: [stateOneID],
            states: [
                CanvasStateSummary(
                    screenStateID: stateOneID,
                    title: "Home",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation-a1", "observation-a2"]
                ),
                CanvasStateSummary(
                    screenStateID: stateTwoID,
                    title: "Catalog",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation-b1"]
                ),
                CanvasStateSummary(
                    screenStateID: stateThreeID,
                    title: "Settings",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation-c1"]
                ),
            ],
            transitions: []
        )
    }

    private func makeModel() async throws -> (SnapshotWorkspaceModel, FixtureHostClient) {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        XCTAssertEqual(model.canvasPhase, .content)
        XCTAssertEqual(model.canvasGraph?.revision, 1)
        return (model, client)
    }

    // MARK: - Pure editor form rules

    func testAnnotationFormParsesTrimsAndDeduplicatesLabels() {
        XCTAssertEqual(
            ScreenStateAnnotationForm.parseLabels(" checkout , entry ,, checkout ,"),
            ["checkout", "entry"]
        )
        XCTAssertEqual(ScreenStateAnnotationForm.parseLabels("solo"), ["solo"])
        // An all-whitespace field parses to the canonical clearing value.
        XCTAssertEqual(ScreenStateAnnotationForm.parseLabels("   "), [])
        XCTAssertEqual(ScreenStateAnnotationForm.parseLabels(""), [])
    }

    func testAnnotationFormValidatesTheHostContractBounds() {
        // Empty values are legal: they clear the annotation fields.
        XCTAssertNil(ScreenStateAnnotationForm.validationError(labels: [], summary: ""))
        XCTAssertNil(
            ScreenStateAnnotationForm.validationError(
                labels: ["entry"],
                summary: String(repeating: "s", count: 280)
            )
        )
        XCTAssertNotNil(ScreenStateAnnotationForm.validationError(labels: ["a", "a"], summary: ""))
        XCTAssertNotNil(ScreenStateAnnotationForm.validationError(labels: [""], summary: ""))
        XCTAssertNotNil(
            ScreenStateAnnotationForm.validationError(
                labels: [String(repeating: "l", count: 129)],
                summary: ""
            )
        )
        XCTAssertNil(
            ScreenStateAnnotationForm.validationError(
                labels: [String(repeating: "l", count: 128)],
                summary: ""
            )
        )
        XCTAssertNotNil(
            ScreenStateAnnotationForm.validationError(
                labels: [],
                summary: String(repeating: "s", count: 281)
            )
        )
        XCTAssertEqual(ScreenStateAnnotationForm.remainingSummaryCharacters(""), 280)
        XCTAssertEqual(ScreenStateAnnotationForm.remainingSummaryCharacters("abc"), 277)
        XCTAssertEqual(
            ScreenStateAnnotationForm.remainingSummaryCharacters(String(repeating: "s", count: 281)),
            -1
        )
    }

    // MARK: - Canonical decoding

    func testStateModelsDecodeLabelsAndSummaryLenientlyOnBothPaths() throws {
        // The Canvas list path: a graph state carrying annotations.
        let annotated = """
        {
          "screen_state_id": "\(stateOneID)",
          "title": "Home",
          "kind": "screen",
          "status": "active",
          "revision": 3,
          "identity": {"strategy": "structural"},
          "observation_ids": ["observation-a1"],
          "labels": ["entry", "checkout"],
          "summary": "The landing screen."
        }
        """
        let summary = try JSONDecoder().decode(CanvasStateSummary.self, from: Data(annotated.utf8))
        XCTAssertEqual(summary.labels, ["entry", "checkout"])
        XCTAssertEqual(summary.summary, "The landing screen.")

        // A canonical state without annotations still decodes.
        let bare = """
        {"screen_state_id": "\(stateTwoID)", "title": "Catalog", "kind": "screen", "status": "active"}
        """
        let bareSummary = try JSONDecoder().decode(CanvasStateSummary.self, from: Data(bare.utf8))
        XCTAssertEqual(bareSummary.labels, [])
        XCTAssertNil(bareSummary.summary)

        // The detail path: GET /v1/screen-states/:id serves the same fields.
        let detailJSON = """
        {
          "screen_state_id": "\(stateOneID)",
          "revision": 3,
          "title": "Home",
          "kind": "screen",
          "status": "active",
          "canonical_snapshot_id": "snapshot_019f0000-0000-7000-8000-000000000002",
          "first_seen": "2026-07-12T00:00:00Z",
          "last_seen": "2026-07-12T00:00:05Z",
          "labels": ["entry"],
          "summary": "The landing screen."
        }
        """
        let detail = try JSONDecoder().decode(ScreenStateDetail.self, from: Data(detailJSON.utf8))
        XCTAssertEqual(detail.labels, ["entry"])
        XCTAssertEqual(detail.summary, "The landing screen.")

        let bareDetailJSON = """
        {
          "screen_state_id": "\(stateTwoID)",
          "revision": 1,
          "title": "Catalog",
          "kind": "screen",
          "status": "active",
          "canonical_snapshot_id": "snapshot_019f0000-0000-7000-8000-000000000002",
          "first_seen": "2026-07-12T00:00:00Z",
          "last_seen": "2026-07-12T00:00:05Z"
        }
        """
        let bareDetail = try JSONDecoder().decode(ScreenStateDetail.self, from: Data(bareDetailJSON.utf8))
        XCTAssertEqual(bareDetail.labels, [])
        XCTAssertNil(bareDetail.summary)
    }

    // MARK: - Fixture Host round trip

    func testFixtureAnnotateRoundTripBumpsTheGraphRevision() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())

        let result = try await client.annotateScreenState(
            AnnotateScreenStateCommand(
                projectID: projectID,
                applicationID: applicationID,
                stateID: stateOneID,
                labels: ["entry", "checkout"],
                summary: "The landing screen.",
                expectedGraphRevision: 1,
                annotatedBy: .studio
            )
        )

        XCTAssertEqual(result.graphRevision, 2, "The annotation write bumps the graph revision.")
        XCTAssertEqual(result.state.labels, ["entry", "checkout"])
        XCTAssertEqual(result.state.summary, "The landing screen.")
        XCTAssertEqual(result.state.observationIDs, ["observation-a1", "observation-a2"])

        // The revision watch sees the bump, and the annotated state is in
        // the served graph.
        let graph = try await client.getScreenGraph(projectID: projectID, applicationID: applicationID)
        XCTAssertEqual(graph.revision, 2)
        let served = try XCTUnwrap(graph.states.first(where: { $0.id == stateOneID }))
        XCTAssertEqual(served.labels, ["entry", "checkout"])
        XCTAssertEqual(served.summary, "The landing screen.")

        // The detail route serves the annotation too.
        let detail = try await client.getScreenState(id: stateOneID)
        XCTAssertEqual(detail.labels, ["entry", "checkout"])
        XCTAssertEqual(detail.summary, "The landing screen.")

        // A stale expected revision conflicts, exactly like curation.
        do {
            _ = try await client.annotateScreenState(
                AnnotateScreenStateCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateID: stateOneID,
                    labels: ["stale"],
                    summary: nil,
                    expectedGraphRevision: 1,
                    annotatedBy: .studio
                )
            )
            XCTFail("Expected the revision conflict to surface.")
        } catch let error as HostClientError {
            guard case let .server(statusCode, _, code, _, _) = error else {
                return XCTFail("Expected a Host server error, received \(error)")
            }
            XCTAssertEqual(statusCode, 409)
            XCTAssertEqual(code, "conflict")
        }
    }

    // MARK: - Model flow

    func testAnnotateFlowPersistsAndReloadsTheGraphAndDetail() async throws {
        let (model, _) = try await makeModel()
        await model.selectCanvasState(id: stateOneID)
        model.beginAnnotationEdit()
        XCTAssertEqual(model.annotationDecisionRevision, 1)
        XCTAssertEqual(model.annotationDecisionStateID, stateOneID)

        let annotated = await model.annotateSelectedState(
            labels: ["entry", "checkout"],
            summary: "The landing screen."
        )

        XCTAssertTrue(annotated)
        XCTAssertNil(model.curationError)
        XCTAssertNil(model.graphConflictNote)
        XCTAssertNil(model.annotationDecisionRevision, "A persisted annotation closes its decision.")
        XCTAssertEqual(model.canvasGraph?.revision, 2)
        let state = try XCTUnwrap(model.canvasGraph?.states.first(where: { $0.id == stateOneID }))
        XCTAssertEqual(state.labels, ["entry", "checkout"])
        XCTAssertEqual(state.summary, "The landing screen.")
        // The Inspector detail reloaded and carries the annotation.
        XCTAssertEqual(model.canvasStateDetail?.labels, ["entry", "checkout"])
        XCTAssertEqual(model.canvasStateDetail?.summary, "The landing screen.")
    }

    /// The defect class the merge/split guard already covers: a background
    /// reload advances `canvasGraph.revision` while the annotation editor is
    /// open. Submitting the reloaded revision would launder the concurrent
    /// change into the user's edit; the edit must conflict instead, with
    /// zero posts, and re-arm once the user has seen the reloaded graph.
    func testGraphReloadUnderAnOpenAnnotationConflictsInsteadOfSubmitting() async throws {
        let (model, client) = try await makeModel()
        await model.selectCanvasState(id: stateOneID)
        // The editor opens against revision 1.
        model.beginAnnotationEdit()
        XCTAssertEqual(model.annotationDecisionRevision, 1)

        // Another actor curates the graph, and Studio reloads it in the
        // background while the editor is still open.
        _ = try await client.splitScreenState(
            SplitScreenStateCommand(
                projectID: projectID,
                applicationID: applicationID,
                stateID: stateOneID,
                observationIDs: ["observation-a2"],
                expectedGraphRevision: 1,
                splitBy: .studio
            )
        )
        await model.loadCanvas(projectID: projectID, applicationID: applicationID)
        XCTAssertEqual(model.canvasGraph?.revision, 2)
        let annotationsBeforeSubmit = await client.annotateCount

        let annotated = await model.annotateSelectedState(labels: ["entry"], summary: "Edited blind.")

        XCTAssertFalse(annotated)
        XCTAssertNotNil(model.graphConflictNote)
        XCTAssertNil(model.curationError)
        // Nothing was posted: the stale decision never reached the Host.
        let annotationsAfterSubmit = await client.annotateCount
        XCTAssertEqual(annotationsAfterSubmit, annotationsBeforeSubmit)
        XCTAssertEqual(model.canvasGraph?.revision, 2, "The graph is untouched.")
        // The decision is re-armed against the revision the user can now see.
        XCTAssertEqual(model.annotationDecisionRevision, 2)

        // A deliberate retry, after reviewing the reloaded graph, persists.
        let retried = await model.annotateSelectedState(labels: ["entry"], summary: "Edited blind.")
        XCTAssertTrue(retried)
        XCTAssertEqual(model.canvasGraph?.revision, 3)
    }

    func testClearingSubmitsTheEmptyArrayAndEmptyString() async throws {
        let (model, client) = try await makeModel()
        await model.selectCanvasState(id: stateOneID)
        model.beginAnnotationEdit()
        let firstWrite = await model.annotateSelectedState(
            labels: ["entry"],
            summary: "The landing screen."
        )
        XCTAssertTrue(firstWrite)
        XCTAssertEqual(model.canvasStateDetail?.labels, ["entry"])

        // Emptying both fields clears both annotation fields on the state.
        model.beginAnnotationEdit()
        XCTAssertEqual(model.annotationDecisionRevision, 2)
        let cleared = await model.annotateSelectedState(labels: [], summary: "")

        XCTAssertTrue(cleared)
        XCTAssertEqual(model.canvasGraph?.revision, 3)
        let state = try XCTUnwrap(model.canvasGraph?.states.first(where: { $0.id == stateOneID }))
        XCTAssertEqual(state.labels, [])
        XCTAssertNil(state.summary)
        XCTAssertEqual(model.canvasStateDetail?.labels, [])
        XCTAssertNil(model.canvasStateDetail?.summary)
        // Two accepted writes reached the Host, no more.
        let count = await client.annotateCount
        XCTAssertEqual(count, 2)
    }

    /// Annotating a tombstone is a distinguishable reason, not a graph that
    /// changed elsewhere — and nothing is posted.
    func testAnnotatingANonActiveStateReportsTheRealReason() async throws {
        let (model, client) = try await makeModel()
        model.toggleMergeSelection(stateID: stateOneID)
        model.toggleMergeSelection(stateID: stateTwoID)
        model.beginMergeDecision()
        let merged = await model.mergeSelectedStates(into: stateOneID, justification: nil)
        XCTAssertTrue(merged)

        await model.selectCanvasState(id: stateTwoID)
        model.beginAnnotationEdit()
        let annotationsBeforeSubmit = await client.annotateCount

        let annotated = await model.annotateSelectedState(labels: ["entry"], summary: "")

        XCTAssertFalse(annotated)
        XCTAssertNil(model.graphConflictNote, "A tombstone is not a concurrent change.")
        let error = try XCTUnwrap(model.curationError)
        XCTAssertTrue(error.contains("merged"), "The real reason names the tombstone status.")
        let annotationsAfterSubmit = await client.annotateCount
        XCTAssertEqual(annotationsAfterSubmit, annotationsBeforeSubmit)
    }

    /// Fixture merges and splits must not drop the annotations of the states
    /// they rebuild — the survivor keeps its knowledge.
    func testFixtureCurationPreservesAnnotations() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        _ = try await client.annotateScreenState(
            AnnotateScreenStateCommand(
                projectID: projectID,
                applicationID: applicationID,
                stateID: stateOneID,
                labels: ["entry"],
                summary: "The landing screen.",
                expectedGraphRevision: 1,
                annotatedBy: .studio
            )
        )

        let merge = try await client.mergeScreenStates(
            MergeScreenStatesCommand(
                projectID: projectID,
                applicationID: applicationID,
                stateIDs: [stateOneID, stateTwoID],
                intoStateID: stateOneID,
                expectedGraphRevision: 2,
                mergedBy: .studio
            )
        )
        XCTAssertEqual(merge.state.labels, ["entry"])
        XCTAssertEqual(merge.state.summary, "The landing screen.")

        let split = try await client.splitScreenState(
            SplitScreenStateCommand(
                projectID: projectID,
                applicationID: applicationID,
                stateID: stateOneID,
                observationIDs: ["observation-a2"],
                expectedGraphRevision: 3,
                splitBy: .studio
            )
        )
        let graph = try await client.getScreenGraph(projectID: projectID, applicationID: applicationID)
        let source = try XCTUnwrap(graph.states.first(where: { $0.id == stateOneID }))
        XCTAssertEqual(source.labels, ["entry"], "The split source keeps its annotation.")
        XCTAssertEqual(source.summary, "The landing screen.")
        XCTAssertEqual(split.state.labels, [], "The split-off state starts unannotated.")
        XCTAssertNil(split.state.summary)
    }
}

/// The centralized layout metrics: the responsive Inspector breakpoint and
/// the consistency between the window minimum and the panes it must hold.
final class StudioLayoutMetricsTests: XCTestCase {
    func testInspectorArrangementCollapsesBelowTheSideBySideMinimum() {
        let threshold = StudioLayoutMetrics.inspectorSideBySideMinWidth
        XCTAssertEqual(
            threshold,
            StudioLayoutMetrics.inspectorPanesMinWidth + StudioLayoutMetrics.contextColumnMinWidth
        )
        XCTAssertEqual(StudioLayoutMetrics.inspectorArrangement(forWidth: threshold), .sideBySide)
        XCTAssertEqual(StudioLayoutMetrics.inspectorArrangement(forWidth: threshold + 200), .sideBySide)
        XCTAssertEqual(StudioLayoutMetrics.inspectorArrangement(forWidth: threshold - 1), .compact)
        XCTAssertEqual(StudioLayoutMetrics.inspectorArrangement(forWidth: 0), .compact)
    }

    func testWindowMinimumHoldsTheEssentialColumns() {
        // The narrowest window must hold the navigation column, the Canvas
        // pane, and the compact-mode Inspector without painting past the
        // window edge.
        XCTAssertGreaterThanOrEqual(
            StudioLayoutMetrics.windowMinWidth,
            StudioLayoutMetrics.navigationMinWidth
                + StudioLayoutMetrics.canvasPaneMinWidth
                + StudioLayoutMetrics.inspectorMinWidth
        )
    }

    func testPaneBoundsStayOrderedAndCardsFitTheirGridCells() {
        XCTAssertLessThanOrEqual(
            StudioLayoutMetrics.contextColumnMinWidth,
            StudioLayoutMetrics.contextColumnIdealWidth
        )
        XCTAssertLessThanOrEqual(
            StudioLayoutMetrics.contextColumnIdealWidth,
            StudioLayoutMetrics.contextColumnMaxWidth
        )
        XCTAssertLessThanOrEqual(
            StudioLayoutMetrics.navigationMinWidth,
            StudioLayoutMetrics.navigationMaxWidth
        )
        XCTAssertLessThanOrEqual(
            StudioLayoutMetrics.evidenceListMinWidth,
            StudioLayoutMetrics.evidenceListMaxWidth
        )
        XCTAssertLessThanOrEqual(
            StudioLayoutMetrics.canvasCardWidth,
            StudioLayoutMetrics.canvasColumnWidth
        )
        XCTAssertLessThanOrEqual(
            StudioLayoutMetrics.canvasCardHeight,
            StudioLayoutMetrics.canvasRowHeight
        )
    }
}
