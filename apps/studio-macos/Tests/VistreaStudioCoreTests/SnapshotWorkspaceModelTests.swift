import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

@MainActor
final class SnapshotWorkspaceModelTests: XCTestCase {
    func testRefreshLoadsFixtureSelectsRootAndPreservesObjectPlaceholder() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))

        await model.refresh()

        XCTAssertEqual(model.contentPhase, .content)
        XCTAssertEqual(model.connectionPhase, .available(HostStatus(
            status: .ready,
            runtimeConnected: true,
            message: "Canonical fixture"
        )))
        XCTAssertEqual(model.snapshots.count, 1)
        XCTAssertEqual(model.selectedSnapshotID, snapshot.snapshotID.rawValue)
        XCTAssertEqual(model.selectedNode?.stableID, "demo.home.root")
        guard case .unavailable = model.screenshotPhase else {
            return XCTFail("The fixture should expose an Object placeholder when bytes are absent.")
        }
    }

    func testNodeSelectionAndCaptureTransitions() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let model = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: [snapshot]))
        await model.refresh()

        let childID = "node_019f0000-0000-7000-8000-000000000011"
        model.selectNode(id: childID)
        XCTAssertEqual(model.selectedNodeID, childID)
        XCTAssertEqual(model.selectedNode?.stableID, "demo.home.open_catalog")

        await model.capture()

        XCTAssertFalse(model.isCapturing)
        XCTAssertNil(model.operationError)
        XCTAssertEqual(model.contentPhase, .content)
        XCTAssertEqual(model.selectedSnapshotID, snapshot.snapshotID.rawValue)
        XCTAssertEqual(model.selectedNode?.stableID, "demo.home.root")
    }

    func testEmptyAndFailureStatesRemainDistinct() async {
        let emptyModel = SnapshotWorkspaceModel(client: FixtureHostClient(snapshots: []))
        await emptyModel.refresh()
        XCTAssertEqual(emptyModel.contentPhase, .empty)

        let failedModel = SnapshotWorkspaceModel(client: AlwaysFailingHostClient())
        await failedModel.refresh()
        guard case .failure = failedModel.contentPhase else {
            return XCTFail("Expected the Snapshot list failure state.")
        }
        guard case .unavailable = failedModel.connectionPhase else {
            return XCTFail("Expected the independent Host connection failure state.")
        }
    }

    func testRefreshAndCaptureMutationsAreMutuallyExclusive() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = OperationGateHostClient(snapshot: snapshot, blockStatus: true)
        let model = SnapshotWorkspaceModel(client: client)

        let refreshTask = Task { await model.refresh() }
        while !(await client.isStatusWaiting()) {
            await Task.yield()
        }
        XCTAssertTrue(model.isRefreshing)
        await model.capture()
        let capturesDuringRefresh = await client.captureRequestCount
        XCTAssertEqual(capturesDuringRefresh, 0)
        await client.releaseStatus()
        await refreshTask.value
        XCTAssertFalse(model.isRefreshing)

        await client.blockNextCapture()
        let statusRequestsBeforeCapture = await client.statusRequestCount
        let captureTask = Task { await model.capture() }
        while !(await client.isCaptureWaiting()) {
            await Task.yield()
        }
        XCTAssertTrue(model.isCapturing)
        await model.refresh()
        let statusRequestsDuringCapture = await client.statusRequestCount
        XCTAssertEqual(statusRequestsDuringCapture, statusRequestsBeforeCapture)
        await client.releaseCapture()
        await captureTask.value
        XCTAssertFalse(model.isCapturing)
    }

    func testCaptureProjectionFailureDoesNotPartiallyMutateSelectionOrList() async throws {
        let original = try StudioTestFixtures.snapshot()
        let invalidCapture = try StudioTestFixtures.snapshot(
            "protocol/fixtures/v1/runtime-snapshot/invalid/dangling-child-reference.json"
        )
        let model = SnapshotWorkspaceModel(
            client: CaptureResultHostClient(original: original, captured: invalidCapture)
        )
        await model.refresh()
        let originalItems = model.snapshots
        let originalSnapshotID = model.selectedSnapshotID
        let originalNode = model.selectedNode

        await model.capture()

        XCTAssertEqual(model.snapshots, originalItems)
        XCTAssertEqual(model.selectedSnapshotID, originalSnapshotID)
        XCTAssertEqual(model.selectedSnapshot?.id, originalSnapshotID)
        XCTAssertEqual(model.selectedNode, originalNode)
        XCTAssertNotNil(model.operationError)
        XCTAssertFalse(model.isCapturing)
    }
}

private struct AlwaysFailingHostClient: HostClient {
    func getStatus() async throws -> HostStatus { throw HostClientError.transport("offline") }
    func listSnapshots() async throws -> SnapshotPage { throw HostClientError.transport("offline") }
    func getSnapshot(id: String) async throws -> RuntimeSnapshot { throw HostClientError.transport("offline") }
    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        throw HostClientError.transport("offline")
    }
    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        throw HostClientError.transport("offline")
    }
}

private actor OperationGateHostClient: HostClient {
    let snapshot: RuntimeSnapshot
    private var shouldBlockStatus: Bool
    private var shouldBlockCapture = false
    private var statusContinuation: CheckedContinuation<Void, Never>?
    private var captureContinuation: CheckedContinuation<Void, Never>?
    private(set) var statusRequestCount = 0
    private(set) var captureRequestCount = 0

    init(snapshot: RuntimeSnapshot, blockStatus: Bool) {
        self.snapshot = snapshot
        shouldBlockStatus = blockStatus
    }

    func getStatus() async throws -> HostStatus {
        statusRequestCount += 1
        if shouldBlockStatus {
            await withCheckedContinuation { continuation in
                statusContinuation = continuation
            }
        }
        return HostStatus(status: .ready, runtimeConnected: true)
    }

    func listSnapshots() async throws -> SnapshotPage {
        SnapshotPage(items: [SnapshotSummary(snapshot: snapshot)])
    }

    func getSnapshot(id: String) async throws -> RuntimeSnapshot { snapshot }

    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        throw HostClientError.fixtureUnavailable("No binary fixture.")
    }

    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        captureRequestCount += 1
        if shouldBlockCapture {
            await withCheckedContinuation { continuation in
                captureContinuation = continuation
            }
        }
        return snapshot
    }

    func isStatusWaiting() -> Bool { statusContinuation != nil }
    func isCaptureWaiting() -> Bool { captureContinuation != nil }

    func releaseStatus() {
        shouldBlockStatus = false
        statusContinuation?.resume()
        statusContinuation = nil
    }

    func blockNextCapture() {
        shouldBlockCapture = true
    }

    func releaseCapture() {
        shouldBlockCapture = false
        captureContinuation?.resume()
        captureContinuation = nil
    }
}

private struct CaptureResultHostClient: HostClient {
    let original: RuntimeSnapshot
    let captured: RuntimeSnapshot

    func getStatus() async throws -> HostStatus {
        HostStatus(status: .ready, runtimeConnected: true)
    }

    func listSnapshots() async throws -> SnapshotPage {
        SnapshotPage(items: [SnapshotSummary(snapshot: original)])
    }

    func getSnapshot(id: String) async throws -> RuntimeSnapshot { original }

    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        throw HostClientError.fixtureUnavailable("No binary fixture.")
    }

    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot { captured }
}
