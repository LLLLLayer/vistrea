import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

@MainActor
final class ExplorationWorkflowModelTests: XCTestCase {
    private static let defaultExcludedStableIDs = [
        "android.debug.inspector.open",
        "vistrea.inspector.capture",
        "BackButton",
    ]

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

    func testExplorationRunsToSuccessAndRefreshesTheCanvas() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        let model = SnapshotWorkspaceModel(client: client)
        model.explorationPollSleep = {}
        await model.refresh()
        XCTAssertEqual(model.canvasPhase, .content)
        let canvasLoadsBeforeExploration = await client.screenGraphLoadCount

        await model.startExploration(
            maximumActions: 20,
            settleMilliseconds: 1_500,
            excludedStableIDs: Self.defaultExcludedStableIDs
        )

        XCTAssertNil(model.explorationError)
        XCTAssertNotNil(model.explorationOperationID)
        XCTAssertEqual(model.explorationState, "succeeded")
        XCTAssertFalse(model.isExploring)
        let report = try XCTUnwrap(model.explorationReport)
        XCTAssertEqual(report.discoveredStateIDs.count, 3)
        XCTAssertEqual(report.actionCount, 3)
        XCTAssertEqual(report.stoppedReason, "frontier_exhausted")
        // The scripted operation advanced one progress event per poll.
        let progress = try XCTUnwrap(model.explorationProgress)
        XCTAssertEqual(progress.phase, "exploration.walk")
        XCTAssertEqual(progress.completedUnits, 3)
        XCTAssertEqual(progress.totalUnits, 20)
        XCTAssertEqual(
            model.explorationLastEventMessage,
            "Tapped demo.explore.step3 and discovered a new state"
        )
        // A succeeded run reloads the Canvas Screen Graph automatically.
        let canvasLoadsAfterExploration = await client.screenGraphLoadCount
        XCTAssertEqual(canvasLoadsAfterExploration, canvasLoadsBeforeExploration + 1)
        XCTAssertEqual(model.canvasPhase, .content)
    }

    func testExplorationCancellationSettlesCancelledWithVerbatimError() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        let canvasLoadsBeforeExploration = await client.screenGraphLoadCount
        // Request cancellation between polls, exactly like the Cancel button.
        model.explorationPollSleep = { [weak model] in
            await model?.cancelExploration()
        }

        await model.startExploration(maximumActions: 20)

        XCTAssertEqual(model.explorationState, "cancelled")
        XCTAssertEqual(
            model.explorationError,
            "cancelled: The exploration run was cancelled by the caller."
        )
        XCTAssertNil(model.explorationReport)
        // Controls are usable again after the terminal state.
        XCTAssertFalse(model.isExploring)
        XCTAssertFalse(model.isCancellingExploration)
        // A cancelled run does not refresh the Canvas.
        let canvasLoadsAfterExploration = await client.screenGraphLoadCount
        XCTAssertEqual(canvasLoadsAfterExploration, canvasLoadsBeforeExploration)
    }

    func testExplorationWithoutAutomationProviderDegradesHonestly() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(snapshots: [snapshot], automationConfigured: false)
        )
        model.explorationPollSleep = {}
        await model.refresh()

        await model.startExploration(maximumActions: 20)

        XCTAssertEqual(
            model.explorationError,
            "unsupported: No device automation provider is configured on this Host."
        )
        XCTAssertNil(model.explorationOperationID)
        XCTAssertNil(model.explorationState)
        XCTAssertNil(model.explorationReport)
        XCTAssertFalse(model.isExploring)
    }

    func testStoppingThePaneHaltsThePollLoopAndSupersedesTheRun() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        // The pane disappears before the first poll fires.
        model.explorationPollSleep = { [weak model] in
            await model?.stopExplorationPolling()
        }

        await model.startExploration(maximumActions: 20)

        // The generation guard stopped the loop before any status poll.
        let pollCount = await client.explorationPollCount
        XCTAssertEqual(pollCount, 0)
        XCTAssertFalse(model.isExploring)
        XCTAssertNil(model.explorationError)
        XCTAssertEqual(model.explorationState, "running")

        // A superseding start degrades honestly while the Host-side run is
        // still active.
        model.explorationPollSleep = {}
        await model.startExploration(maximumActions: 20)
        XCTAssertEqual(
            model.explorationError,
            "conflict: An exploration operation is already running."
        )
        XCTAssertFalse(model.isExploring)
    }
}
