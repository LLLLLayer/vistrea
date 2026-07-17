import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

/// The Application + Version information architecture: scope derivation from
/// the Snapshot contexts, the Canvas as the scope's landing surface, the
/// state-driven single-screen Inspector, the bottom timeline strip summary,
/// and the 3D layer pixel-crop math.
@MainActor
final class WorkspaceScopeAndInspectorTests: XCTestCase {
    private static let fixtureScope = WorkspaceScope(
        projectID: "project_019f0000-0000-7000-8000-000000000001",
        applicationID: "dev.vistrea.demo",
        applicationVersion: "1.0.0",
        buildID: "build_019f0000-0000-7000-8000-000000000001"
    )

    private static let otherScope = WorkspaceScope(
        projectID: "project_019f0000-0000-7000-8000-000000000001",
        applicationID: "dev.vistrea.other",
        applicationVersion: "2.0.0",
        buildID: "build_019f0000-0000-7000-8000-000000000002"
    )

    /// A mutated copy of the canonical fixture Snapshot.
    private static func snapshotVariant(
        snapshotID: String,
        capturedAt: String,
        applicationID: String? = nil,
        applicationVersion: String? = nil,
        buildID: String? = nil
    ) throws -> RuntimeSnapshot {
        let source = try StudioTestFixtures.data(
            "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
        )
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: source) as? [String: Any])
        object["snapshot_id"] = snapshotID
        var captured = try XCTUnwrap(object["captured_at"] as? [String: Any])
        captured["wall_time"] = capturedAt
        object["captured_at"] = captured
        var context = try XCTUnwrap(object["runtime_context"] as? [String: Any])
        if let applicationID {
            context["application_id"] = applicationID
        }
        if let applicationVersion {
            context["application_version"] = applicationVersion
        }
        if let buildID {
            context["build_id"] = buildID
        }
        object["runtime_context"] = context
        return try RuntimeSnapshotCodec.decode(
            JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }

    /// A Snapshot of the second application scope, captured after the
    /// canonical fixture Snapshot.
    private static func otherScopeSnapshot() throws -> RuntimeSnapshot {
        try snapshotVariant(
            snapshotID: "snapshot_019f0000-0000-7000-8000-000000000098",
            capturedAt: "2026-07-13T00:00:00Z",
            applicationID: Self.otherScope.applicationID,
            applicationVersion: Self.otherScope.applicationVersion,
            buildID: Self.otherScope.buildID
        )
    }

    // MARK: - Scope derivation

    func testScopeDerivationIsDistinctAndFirstAppearanceOrdered() throws {
        let newestOther = try Self.otherScopeSnapshot()
        let fixture = try StudioTestFixtures.snapshot()
        let duplicate = try Self.snapshotVariant(
            snapshotID: "snapshot_019f0000-0000-7000-8000-000000000097",
            capturedAt: "2026-07-11T00:00:00Z"
        )
        // Newest-first list order, exactly as the Host returns it.
        let items = [newestOther, fixture, duplicate].map(SnapshotListItem.init(snapshot:))

        let scopes = WorkspaceScopeDerivation.scopes(from: items)

        XCTAssertEqual(scopes, [Self.otherScope, Self.fixtureScope])
        XCTAssertEqual(items[1].scope, items[2].scope, "Same context, one scope.")
        XCTAssertEqual(WorkspaceScopeDerivation.scopes(from: []), [])
    }

    // MARK: - Scope selection drives the Canvas

    func testRefreshSelectsTheOnlyScopeAndLandsOnTheCanvas() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = ScopeRecordingHostClient(snapshots: [snapshot])
        let model = SnapshotWorkspaceModel(client: client)

        await model.refresh()

        // The single scope — today's common case — is selected without a click.
        XCTAssertEqual(model.availableScopes, [Self.fixtureScope])
        XCTAssertEqual(model.selectedScope, Self.fixtureScope)
        // The Canvas landed for the scope before any Snapshot was clicked.
        let requests = await client.screenGraphRequests
        XCTAssertEqual(
            requests,
            [[
                Self.fixtureScope.projectID,
                Self.fixtureScope.applicationID,
                Self.fixtureScope.applicationVersion,
                Self.fixtureScope.buildID,
            ]]
        )
        XCTAssertEqual(model.canvasPhase, .content)
    }

    func testScopeSelectionReloadsTheCanvasAndFiltersTheEvidenceLibrary() async throws {
        let fixture = try StudioTestFixtures.snapshot()
        let other = try Self.otherScopeSnapshot()
        let client = ScopeRecordingHostClient(snapshots: [fixture, other])
        let model = SnapshotWorkspaceModel(client: client)

        await model.refresh()

        // Both scopes are offered; the most recently captured one is selected.
        XCTAssertEqual(model.availableScopes, [Self.otherScope, Self.fixtureScope])
        XCTAssertEqual(model.selectedScope, Self.otherScope)
        XCTAssertEqual(model.scopedSnapshots.map(\.id), [other.snapshotID.rawValue])

        // A stale state selection from the previous scope must not leak into
        // the next one.
        await model.selectCanvasState(id: "screenstate_019f0000-0000-7000-8000-00000000ffff")
        XCTAssertNotNil(model.selectedCanvasStateID)

        await model.selectScope(Self.fixtureScope)

        XCTAssertEqual(model.selectedScope, Self.fixtureScope)
        XCTAssertNil(model.selectedCanvasStateID)
        XCTAssertEqual(model.scopedSnapshots.map(\.id), [fixture.snapshotID.rawValue])
        let requests = await client.screenGraphRequests
        XCTAssertEqual(
            requests,
            [
                [
                    Self.otherScope.projectID,
                    Self.otherScope.applicationID,
                    Self.otherScope.applicationVersion,
                    Self.otherScope.buildID,
                ],
                [
                    Self.fixtureScope.projectID,
                    Self.fixtureScope.applicationID,
                    Self.fixtureScope.applicationVersion,
                    Self.fixtureScope.buildID,
                ],
            ]
        )

        // A scope that is not offered is refused; the selection stays.
        await model.selectScope(
            WorkspaceScope(
                projectID: "project_019f0000-0000-7000-8000-00000000ffff",
                applicationID: "dev.vistrea.unknown",
                applicationVersion: "9.9.9",
                buildID: "build_019f0000-0000-7000-8000-00000000ffff"
            )
        )
        XCTAssertEqual(model.selectedScope, Self.fixtureScope)
    }

    func testRefreshKeepsAStillAvailableScopeSelection() async throws {
        let fixture = try StudioTestFixtures.snapshot()
        let other = try Self.otherScopeSnapshot()
        let client = ScopeRecordingHostClient(snapshots: [fixture, other])
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        await model.selectScope(Self.fixtureScope)

        await model.refresh()

        // The refresh re-derives the scopes but never yanks the user's context.
        XCTAssertEqual(model.selectedScope, Self.fixtureScope)
    }

    // MARK: - State-driven single-screen Inspector

    func testSelectingACanvasStateDrivesTheInspectorFromItsCanonicalSnapshot() async throws {
        let original = try StudioTestFixtures.snapshot()
        let later = try Self.snapshotVariant(
            snapshotID: "snapshot_019f0000-0000-7000-8000-000000000099",
            capturedAt: "2026-07-13T00:00:00Z"
        )
        let stateID = "screenstate_019f0000-0000-7000-8000-000000000001"
        let graph = CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-000000000001",
            entryStateIDs: [stateID],
            states: [
                CanvasStateSummary(
                    screenStateID: stateID,
                    title: "Home",
                    kind: "screen",
                    status: "active",
                    observationIDs: ["observation-a1"]
                ),
            ],
            transitions: []
        )
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(snapshots: [original, later], canvasGraph: graph)
        )
        await model.refresh()

        // The Evidence library has the OLDER capture selected.
        await model.selectSnapshot(id: original.snapshotID.rawValue)
        XCTAssertEqual(model.selectedSnapshotID, original.snapshotID.rawValue)

        await model.selectCanvasState(id: stateID)

        // The state resolved its canonical observation Snapshot — the fixture
        // Host materializes the latest capture — and that Snapshot now drives
        // the Inspector panes, not the Evidence selection.
        XCTAssertEqual(model.canvasStatePhase, .content)
        let detail = try XCTUnwrap(model.canvasStateDetail)
        XCTAssertEqual(detail.canonicalSnapshotID, later.snapshotID.rawValue)
        XCTAssertEqual(model.selectedSnapshotID, later.snapshotID.rawValue)
        XCTAssertEqual(model.selectedSnapshot?.id, later.snapshotID.rawValue)
        XCTAssertEqual(model.detailPhase, .content)
        XCTAssertFalse(model.layerBoxes.isEmpty)
        XCTAssertEqual(model.selectedNode?.stableID, "demo.home.root")
    }

    func testCanvasStateWithMissingCanonicalSnapshotDegradesHonestly() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let stateID = "screenstate_019f0000-0000-7000-8000-000000000001"
        let client = MissingCanonicalSnapshotHostClient(snapshot: snapshot, stateID: stateID)
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()

        await model.selectCanvasState(id: stateID)

        // The state detail is shown; the unresolvable canonical Snapshot is an
        // explicit Inspector failure, never a silently kept stale pane.
        XCTAssertEqual(model.canvasStatePhase, .content)
        guard case .failure = model.detailPhase else {
            return XCTFail("Expected the Inspector to report the missing canonical Snapshot.")
        }
    }

    // MARK: - Timeline strip

    func testEventTimelineStripSummaryLines() {
        XCTAssertEqual(
            EventTimelineStripPresentation.summary(phase: .content, eventCount: 2, gapCount: 1),
            "2 events · 1 reported gap"
        )
        XCTAssertEqual(
            EventTimelineStripPresentation.summary(phase: .content, eventCount: 1, gapCount: 0),
            "1 event"
        )
        XCTAssertEqual(
            EventTimelineStripPresentation.summary(phase: .empty, eventCount: 0, gapCount: 0),
            "No Runtime events have been persisted yet."
        )
        XCTAssertEqual(
            EventTimelineStripPresentation.summary(phase: .loading, eventCount: 0, gapCount: 0),
            "Loading Runtime events…"
        )
        XCTAssertEqual(
            EventTimelineStripPresentation.summary(
                phase: .failure("offline"),
                eventCount: 0,
                gapCount: 0
            ),
            "offline"
        )
    }

    // MARK: - 3D layer pixel-crop math

    func testPixelCropMapsTheLogicalFrameThroughThePixelScale() throws {
        // The canonical fixture geometry: 390 × 844 points at 3× pixel scale.
        let crop = try XCTUnwrap(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: 24, y: 120, width: 342, height: 52),
                coverage: RectPresentation(x: 0, y: 0, width: 390, height: 844),
                pixelWidth: 1_170,
                pixelHeight: 2_532
            )
        )
        XCTAssertEqual(crop.x, 72, accuracy: 0.0001)
        XCTAssertEqual(crop.y, 360, accuracy: 0.0001)
        XCTAssertEqual(crop.width, 1_026, accuracy: 0.0001)
        XCTAssertEqual(crop.height, 156, accuracy: 0.0001)
    }

    func testPixelCropTranslatesAnOffOriginCoverage() throws {
        // A screenshot that covers only the region below a 44 pt status bar.
        let crop = try XCTUnwrap(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: 10, y: 50, width: 100, height: 100),
                coverage: RectPresentation(x: 0, y: 44, width: 390, height: 800),
                pixelWidth: 780,
                pixelHeight: 1_600
            )
        )
        XCTAssertEqual(crop.x, 20, accuracy: 0.0001)
        XCTAssertEqual(crop.y, 12, accuracy: 0.0001)
        XCTAssertEqual(crop.width, 200, accuracy: 0.0001)
        XCTAssertEqual(crop.height, 200, accuracy: 0.0001)
    }

    func testPixelCropClampsToTheRasterBounds() throws {
        let coverage = RectPresentation(x: 0, y: 0, width: 390, height: 844)
        // A frame hanging off the top-left corner keeps only its visible part.
        let topLeft = try XCTUnwrap(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: -20, y: -20, width: 100, height: 100),
                coverage: coverage,
                pixelWidth: 390,
                pixelHeight: 844
            )
        )
        XCTAssertEqual(topLeft.x, 0, accuracy: 0.0001)
        XCTAssertEqual(topLeft.y, 0, accuracy: 0.0001)
        XCTAssertEqual(topLeft.width, 80, accuracy: 0.0001)
        XCTAssertEqual(topLeft.height, 80, accuracy: 0.0001)

        // A frame hanging off the bottom-right corner is clamped there too.
        let bottomRight = try XCTUnwrap(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: 350, y: 800, width: 100, height: 100),
                coverage: coverage,
                pixelWidth: 390,
                pixelHeight: 844
            )
        )
        XCTAssertEqual(bottomRight.x, 350, accuracy: 0.0001)
        XCTAssertEqual(bottomRight.y, 800, accuracy: 0.0001)
        XCTAssertEqual(bottomRight.width, 40, accuracy: 0.0001)
        XCTAssertEqual(bottomRight.height, 44, accuracy: 0.0001)
    }

    func testPixelCropRejectsOutsideAndDegenerateGeometry() {
        let coverage = RectPresentation(x: 0, y: 0, width: 390, height: 844)
        // Entirely outside the covered region: no pixels were captured there.
        XCTAssertNil(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: 400, y: 900, width: 50, height: 50),
                coverage: coverage,
                pixelWidth: 390,
                pixelHeight: 844
            )
        )
        XCTAssertNil(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: -100, y: -100, width: 50, height: 50),
                coverage: coverage,
                pixelWidth: 390,
                pixelHeight: 844
            )
        )
        // Degenerate inputs never produce a crop.
        XCTAssertNil(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: 0, y: 0, width: 0, height: 50),
                coverage: coverage,
                pixelWidth: 390,
                pixelHeight: 844
            )
        )
        XCTAssertNil(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: 0, y: 0, width: 50, height: 50),
                coverage: RectPresentation(x: 0, y: 0, width: 0, height: 844),
                pixelWidth: 390,
                pixelHeight: 844
            )
        )
        XCTAssertNil(
            LayerTextureProjection.pixelCropRect(
                frame: RectPresentation(x: 0, y: 0, width: 50, height: 50),
                coverage: coverage,
                pixelWidth: 0,
                pixelHeight: 844
            )
        )
    }
}

/// Records which Screen Graph the Canvas asked for, so scope selection can be
/// proven to drive the Canvas identity.
private actor ScopeRecordingHostClient: HostClient {
    private let snapshotsByID: [String: RuntimeSnapshot]
    private(set) var screenGraphRequests: [[String]] = []

    init(snapshots: [RuntimeSnapshot]) {
        snapshotsByID = Dictionary(
            uniqueKeysWithValues: snapshots.map { ($0.snapshotID.rawValue, $0) }
        )
    }

    func getStatus() async throws -> HostStatus {
        HostStatus(status: .ready, runtimeConnected: true)
    }

    func listSnapshots() async throws -> SnapshotPage {
        let items = snapshotsByID.values
            .sorted { $0.capturedAt.wallTime.rawValue > $1.capturedAt.wallTime.rawValue }
            .map(SnapshotSummary.init(snapshot:))
        return SnapshotPage(items: items)
    }

    func getSnapshot(id: String) async throws -> RuntimeSnapshot {
        guard let snapshot = snapshotsByID[id] else {
            throw HostClientError.fixtureUnavailable("Unknown Snapshot in this test double.")
        }
        return snapshot
    }

    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        throw HostClientError.fixtureUnavailable("No binary fixture.")
    }

    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        throw HostClientError.fixtureUnavailable("No capture in this test double.")
    }

    func getEventTimeline(eventEpochID: String?) async throws -> EventTimeline {
        EventTimeline(events: [], reportedGaps: [])
    }

    func listReviewIssues(states: [String]?) async throws -> ReviewIssuePage {
        ReviewIssuePage(items: [])
    }

    func searchWikiNodes(text: String?) async throws -> WikiNodePage {
        WikiNodePage(items: [])
    }

    func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph {
        screenGraphRequests.append([projectID, applicationID])
        return graph()
    }

    func getScreenGraph(
        projectID: String,
        applicationID: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> CanvasGraph {
        screenGraphRequests.append([projectID, applicationID, applicationVersion, buildID])
        return graph()
    }

    private func graph() -> CanvasGraph {
        return CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-000000000001",
            entryStateIDs: [],
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
}

/// Serves a Screen State whose canonical Snapshot no longer resolves.
private struct MissingCanonicalSnapshotHostClient: HostClient {
    let snapshot: RuntimeSnapshot
    let stateID: String

    func getStatus() async throws -> HostStatus {
        HostStatus(status: .ready, runtimeConnected: true)
    }

    func listSnapshots() async throws -> SnapshotPage {
        SnapshotPage(items: [SnapshotSummary(snapshot: snapshot)])
    }

    func getSnapshot(id: String) async throws -> RuntimeSnapshot {
        guard id == snapshot.snapshotID.rawValue else {
            throw HostClientError.server(
                statusCode: 404,
                requestID: nil,
                code: "not_found",
                message: "The canonical Snapshot has been garbage-collected.",
                retryable: false
            )
        }
        return snapshot
    }

    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        throw HostClientError.fixtureUnavailable("No binary fixture.")
    }

    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        throw HostClientError.fixtureUnavailable("No capture in this test double.")
    }

    func getEventTimeline(eventEpochID: String?) async throws -> EventTimeline {
        EventTimeline(events: [], reportedGaps: [])
    }

    func listReviewIssues(states: [String]?) async throws -> ReviewIssuePage {
        ReviewIssuePage(items: [])
    }

    func searchWikiNodes(text: String?) async throws -> WikiNodePage {
        WikiNodePage(items: [])
    }

    func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph {
        CanvasGraph(
            screenGraphID: "graph_019f0000-0000-7000-8000-000000000001",
            entryStateIDs: [stateID],
            states: [
                CanvasStateSummary(
                    screenStateID: stateID,
                    title: "Home",
                    kind: "screen",
                    status: "active"
                ),
            ],
            transitions: []
        )
    }

    func getScreenState(id: String) async throws -> ScreenStateDetail {
        ScreenStateDetail(
            screenStateID: id,
            revision: 1,
            title: "Home",
            kind: "screen",
            status: "active",
            canonicalSnapshotID: "snapshot_019f0000-0000-7000-8000-00000000dead",
            firstSeen: "2026-07-12T00:00:00Z",
            lastSeen: "2026-07-12T00:00:05Z"
        )
    }
}
