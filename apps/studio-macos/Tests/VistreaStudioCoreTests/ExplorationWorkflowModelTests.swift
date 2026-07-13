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

    /// The defect: the Canvas pane used to stop the poll loop on
    /// `onDisappear`, so switching tabs orphaned the running Operation — no
    /// progress, no report, no Canvas refresh, and no reachable Cancel. An
    /// exploration belongs to the run, not to the visible tab.
    func testTabSwitchKeepsTheRunPollingAndRefreshesTheCanvas() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        let canvasLoadsBeforeExploration = await client.screenGraphLoadCount

        // Every poll happens with the Canvas pane hidden: the user switched to
        // another tab as soon as the run started. The pane owns no exploration
        // lifecycle, so nothing is torn down.
        let observations = PollObservations()
        model.explorationPollSleep = { [weak model] in
            guard let model else { return }
            await observations.record(
                isExploring: await model.isExploring,
                operationID: await model.explorationOperationID,
                isAddressable: await model.isExplorationRunAddressable
            )
        }

        await model.startExploration(maximumActions: 20)

        // The run settled on its own while the pane was away.
        let operationID = try XCTUnwrap(model.explorationOperationID)
        XCTAssertEqual(model.explorationState, "succeeded")
        XCTAssertNotNil(model.explorationReport)
        XCTAssertNil(model.explorationError)
        XCTAssertFalse(model.isExploring)
        // The Canvas refreshed automatically, exactly as it does with the pane
        // on screen.
        let canvasLoadsAfterExploration = await client.screenGraphLoadCount
        XCTAssertEqual(canvasLoadsAfterExploration, canvasLoadsBeforeExploration + 1)
        // Throughout the hidden run the Operation stayed this Studio's: the
        // Explore button stayed disabled, the identity stayed known, and Cancel
        // stayed reachable.
        let polls = await observations.records
        XCTAssertGreaterThanOrEqual(polls.count, 4)
        XCTAssertTrue(polls.allSatisfy(\.isExploring))
        XCTAssertTrue(polls.allSatisfy(\.isAddressable))
        XCTAssertTrue(polls.allSatisfy { $0.operationID == operationID })
        // A settled run is no longer addressable, so Cancel disappears.
        XCTAssertFalse(model.isExplorationRunAddressable)
    }

    /// Cancel must still reach the Host-side run when this Studio is no longer
    /// polling it, and a rejected start must never drop the previous run's
    /// identity — otherwise a still-running exploration becomes unstoppable.
    func testAStoppedPollLoopKeepsTheRunCancellable() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot], canvasGraph: Self.fixtureGraph())
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        // The poll loop is torn down before the first poll fires.
        model.explorationPollSleep = { [weak model] in
            await model?.stopExplorationPolling()
        }

        await model.startExploration(maximumActions: 20)

        let pollCount = await client.explorationPollCount
        XCTAssertEqual(pollCount, 0, "The generation guard stopped the loop before any status poll.")
        XCTAssertFalse(model.isExploring)
        XCTAssertNil(model.explorationError)
        XCTAssertEqual(model.explorationState, "running")
        let firstOperationID = try XCTUnwrap(model.explorationOperationID)
        XCTAssertTrue(model.isExplorationRunAddressable, "Cancel stays reachable.")

        // A superseding start is rejected because the Host-side run is still
        // active. The rejected start must keep the previous Operation
        // addressable instead of clearing it.
        model.explorationPollSleep = {}
        await model.startExploration(maximumActions: 20)
        XCTAssertEqual(
            model.explorationError,
            "conflict: An exploration operation is already running."
        )
        XCTAssertFalse(model.isExploring)
        XCTAssertEqual(model.explorationOperationID, firstOperationID)
        XCTAssertTrue(model.isExplorationRunAddressable)

        // Cancel reaches the still-running Operation.
        await model.cancelExploration()
        let record = try await client.getExplorationOperation(id: firstOperationID)
        XCTAssertEqual(record.operation.state, "cancelled")
    }
}

/// Records what the workspace exposed on each exploration poll.
private actor PollObservations {
    struct Record {
        let isExploring: Bool
        let operationID: String?
        let isAddressable: Bool
    }

    private(set) var records: [Record] = []

    func record(isExploring: Bool, operationID: String?, isAddressable: Bool) {
        records.append(
            Record(isExploring: isExploring, operationID: operationID, isAddressable: isAddressable)
        )
    }
}
