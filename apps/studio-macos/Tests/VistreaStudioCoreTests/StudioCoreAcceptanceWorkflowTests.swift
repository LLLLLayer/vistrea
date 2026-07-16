import Foundation
import VistreaRuntimeModels
import XCTest
@testable import VistreaStudioCore

@MainActor
final class StudioCoreAcceptanceWorkflowTests: XCTestCase {
    func testWorkflowDrivesWorkspaceInspectorCanvasAndSupportingPanes() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let screenshot = try XCTUnwrap(snapshot.screenshot)
        let screenshotBytes = Data(repeating: 0x5a, count: Int(screenshot.object.byteSize.rawValue))
        let stateID = "screenstate_019f0000-0000-7000-8000-000000000001"
        let graph = CanvasGraph(
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
        let client = FixtureHostClient(
            snapshots: [snapshot],
            objectsByHash: [screenshot.object.hash: screenshotBytes],
            canvasGraph: graph,
            designReferences: []
        )

        let result = try await StudioCoreAcceptanceWorkflow.run(
            client: client,
            request: StudioCoreAcceptanceRequest(
                expectedSnapshotID: snapshot.snapshotID.rawValue
            )
        )

        XCTAssertEqual(result.snapshotID, snapshot.snapshotID.rawValue)
        XCTAssertEqual(result.screenshotHash, screenshot.object.hash)
        XCTAssertEqual(result.screenshotByteCount, screenshotBytes.count)
        XCTAssertEqual(result.workspaceSnapshotCount, 1)
        XCTAssertEqual(result.scopeCount, 1)
        XCTAssertEqual(result.canvasStateCount, 1)
        XCTAssertEqual(result.selectedScreenStateID, stateID)
        XCTAssertGreaterThan(result.nodeCount, 0)
        XCTAssertGreaterThan(result.layerBoxCount, 0)
        XCTAssertTrue(result.runtimeConnected)
        XCTAssertTrue(result.coreWorkflowCompleted)
    }

    func testWorkflowFailsClosedWhenRuntimeOrCanvasIsMissing() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let disconnected = FixtureHostClient(
            snapshots: [snapshot],
            status: HostStatus(status: .ready, runtimeConnected: false),
            designReferences: []
        )

        await XCTAssertThrowsErrorAsync {
            _ = try await StudioCoreAcceptanceWorkflow.run(
                client: disconnected,
                request: StudioCoreAcceptanceRequest(
                    expectedSnapshotID: snapshot.snapshotID.rawValue
                )
            )
        }

        let noCanvas = FixtureHostClient(
            snapshots: [snapshot],
            objectsByHash: try screenshotObject(for: snapshot),
            designReferences: []
        )
        await XCTAssertThrowsErrorAsync {
            _ = try await StudioCoreAcceptanceWorkflow.run(
                client: noCanvas,
                request: StudioCoreAcceptanceRequest(
                    expectedSnapshotID: snapshot.snapshotID.rawValue
                )
            )
        }
    }

    func testWorkflowExercisesTuningRevertAndQualityAsOneMainPath() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let screenshot = try XCTUnwrap(snapshot.screenshot)
        let stateID = "screenstate_019f0000-0000-7000-8000-000000000001"
        let graph = CanvasGraph(
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
        let client = FixtureHostClient(
            snapshots: [snapshot],
            objectsByHash: [
                screenshot.object.hash: Data(
                    repeating: 0x5a,
                    count: Int(screenshot.object.byteSize.rawValue)
                ),
            ],
            canvasGraph: graph,
            designReferences: []
        )

        let result = try await StudioCoreAcceptanceWorkflow.run(
            client: client,
            request: StudioCoreAcceptanceRequest(
                expectedSnapshotID: snapshot.snapshotID.rawValue,
                exerciseReversibleTuningAndQuality: true
            )
        )

        XCTAssertTrue(result.tuningPreviewReverted)
        XCTAssertTrue(result.validationCompleted)
        XCTAssertTrue(result.coreWorkflowCompleted)
        let previewTTL = await client.lastTuningPreviewTTLMilliseconds
        XCTAssertEqual(previewTTL, 30_000)
        let activeApplications = try await client.listActiveTuningApplications()
        XCTAssertTrue(activeApplications.items.isEmpty)
    }

    func testWorkflowCleansUpBoundedPreviewWhenPostApplyReloadFails() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let screenshot = try XCTUnwrap(snapshot.screenshot)
        let stateID = "screenstate_019f0000-0000-7000-8000-000000000001"
        let graph = CanvasGraph(
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
        let client = FixtureHostClient(
            snapshots: [snapshot],
            objectsByHash: [
                screenshot.object.hash: Data(
                    repeating: 0x5a,
                    count: Int(screenshot.object.byteSize.rawValue)
                ),
            ],
            canvasGraph: graph,
            designReferences: [],
            failActiveTuningReloadWhileApplicationIsActive: true
        )

        do {
            _ = try await StudioCoreAcceptanceWorkflow.run(
                client: client,
                request: StudioCoreAcceptanceRequest(
                    expectedSnapshotID: snapshot.snapshotID.rawValue,
                    exerciseReversibleTuningAndQuality: true
                )
            )
            XCTFail("Expected the failed active-preview reload to fail acceptance.")
        } catch {
            XCTAssertEqual(
                error as? StudioCoreAcceptanceError,
                .failed("The reversible tuning preview did not become active.")
            )
        }

        let previewTTL = await client.lastTuningPreviewTTLMilliseconds
        XCTAssertEqual(previewTTL, 30_000)
        let activeApplications = try await client.listActiveTuningApplications()
        XCTAssertTrue(
            activeApplications.items.isEmpty,
            "Acceptance failure must not leave a Runtime tuning override active."
        )
    }

    private func screenshotObject(for snapshot: RuntimeSnapshot) throws -> [String: Data] {
        let screenshot = try XCTUnwrap(snapshot.screenshot)
        return [
            screenshot.object.hash: Data(
                repeating: 0x5a,
                count: Int(screenshot.object.byteSize.rawValue)
            ),
        ]
    }
}

@MainActor
private func XCTAssertThrowsErrorAsync(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected an error.", file: file, line: line)
    } catch {
        // The exact user-facing reason is intentionally asserted by the
        // workflow's focused state tests; this helper only proves fail-closed.
    }
}
