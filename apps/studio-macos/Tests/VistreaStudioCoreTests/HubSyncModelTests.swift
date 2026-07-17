import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

@MainActor
final class HubSyncModelTests: XCTestCase {
    func testConnectLoadsIdentityRefsAndActivityThenDisconnectForgetsCredential() async throws {
        let client = HubSyncScriptedHostClient(
            status: try decodeHub(HubSyncStatus.self, HubSyncFixtures.statusData()),
            activityPages: [try decodeHub(HubSyncActivityPage.self, HubSyncFixtures.activityPageData())]
        )
        let model = SnapshotWorkspaceModel(client: client)

        await model.connectHub(
            baseURL: " https://hub.example.com ",
            projectID: " \(hubProjectID) ",
            bearerToken: " \(hubBearerToken) ",
            refNames: [" \(hubRefName) "]
        )

        XCTAssertEqual(model.hubSyncPhase, .connected)
        XCTAssertEqual(model.hubSyncStatus?.identity.role, .maintainer)
        XCTAssertEqual(model.hubSyncStatus?.refs.first?.relation, .localOnly)
        XCTAssertEqual(model.hubSyncActivity.map(\.sequence), [5])
        XCTAssertEqual(model.hubActivityCursor, 5)
        XCTAssertEqual(model.hubRefNames, [hubRefName])
        XCTAssertEqual(model.hubRemote?.bearerToken, hubBearerToken)
        let calls = await client.calls
        XCTAssertEqual(calls, ["status:\(hubRefName)", "activity:0:100"])

        model.disconnectHub()

        XCTAssertEqual(model.hubSyncPhase, .idle)
        XCTAssertNil(model.hubRemote)
        XCTAssertNil(model.hubSyncStatus)
        XCTAssertTrue(model.hubSyncActivity.isEmpty)
        XCTAssertTrue(model.hubRefNames.isEmpty)
    }

    func testPushProjectsConflictSummaryAndReloadsActivityFromStart() async throws {
        let status = try decodeHub(HubSyncStatus.self, HubSyncFixtures.statusData())
        let activity = try decodeHub(HubSyncActivityPage.self, HubSyncFixtures.activityPageData())
        let push = try decodeHub(HubSyncPushOutcome.self, HubSyncFixtures.pushOutcomeData())
        let client = HubSyncScriptedHostClient(
            status: status,
            pushOutcome: push,
            activityPages: [activity, activity]
        )
        let model = SnapshotWorkspaceModel(client: client)
        await model.connectHub(
            baseURL: "https://hub.example.com",
            projectID: hubProjectID,
            bearerToken: hubBearerToken,
            refNames: [hubRefName]
        )

        await model.pushToHub(message: " Publish the reviewed baseline. ")

        XCTAssertNil(model.hubSyncError)
        XCTAssertFalse(model.isHubTransferring)
        XCTAssertEqual(model.hubSyncStatus?.refs.first?.relation, .diverged)
        XCTAssertEqual(model.lastHubTransfer?.direction, .push)
        XCTAssertEqual(model.lastHubTransfer?.importedCommitCount, 1)
        XCTAssertEqual(model.lastHubTransfer?.importedObjectCount, 1)
        XCTAssertEqual(model.lastHubTransfer?.advancedRefCount, 1)
        XCTAssertEqual(model.lastHubTransfer?.conflicts.first?.name, hubRefName)
        XCTAssertEqual(model.hubSyncActivity.map(\.eventID), [
            "hub_audit_019f0000-0000-7000-8000-000000000005",
        ])
        let calls = await client.calls
        XCTAssertEqual(calls, [
            "status:\(hubRefName)",
            "activity:0:100",
            "push:\(hubRefName):Publish the reviewed baseline.",
            "activity:0:100",
        ])
    }

    func testConnectionFailureDoesNotRetainCredential() async {
        let client = HubSyncScriptedHostClient(error: HostClientError.transport("Hub offline"))
        let model = SnapshotWorkspaceModel(client: client)

        await model.connectHub(
            baseURL: "https://hub.example.com",
            projectID: hubProjectID,
            bearerToken: hubBearerToken,
            refNames: [hubRefName]
        )

        XCTAssertNil(model.hubRemote)
        XCTAssertNil(model.hubSyncStatus)
        XCTAssertEqual(model.hubSyncError, "The Host could not be reached: Hub offline")
        XCTAssertEqual(
            model.hubSyncPhase,
            .failure("The Host could not be reached: Hub offline")
        )
    }
}

private func decodeHub<Value: Decodable>(_ type: Value.Type, _ data: Data) throws -> Value {
    try JSONDecoder().decode(type, from: data)
}

private actor HubSyncScriptedHostClient: HostClient {
    private let status: HubSyncStatus?
    private let pushOutcome: HubSyncPushOutcome?
    private let error: (any Error)?
    private var activityPages: [HubSyncActivityPage]
    private(set) var calls: [String] = []

    init(
        status: HubSyncStatus? = nil,
        pushOutcome: HubSyncPushOutcome? = nil,
        activityPages: [HubSyncActivityPage] = [],
        error: (any Error)? = nil
    ) {
        self.status = status
        self.pushOutcome = pushOutcome
        self.activityPages = activityPages
        self.error = error
    }

    init(error: any Error) {
        status = nil
        pushOutcome = nil
        activityPages = []
        self.error = error
    }

    func getSyncStatus(remote: HubSyncRemote, refNames: [String]?) async throws -> HubSyncStatus {
        calls.append("status:\((refNames ?? []).joined(separator: ","))")
        if let error { throw error }
        guard let status else { throw HostClientError.fixtureUnavailable("No Hub status fixture.") }
        return status
    }

    func pushWorkspace(
        remote: HubSyncRemote,
        refNames: [String],
        actor: HubSyncActor,
        message: String?
    ) async throws -> HubSyncPushOutcome {
        calls.append("push:\(refNames.joined(separator: ",")):\(message ?? "")")
        if let error { throw error }
        guard let pushOutcome else {
            throw HostClientError.fixtureUnavailable("No Hub push fixture.")
        }
        return pushOutcome
    }

    func getSyncActivity(
        remote: HubSyncRemote,
        afterSequence: UInt64?,
        limit: Int?
    ) async throws -> HubSyncActivityPage {
        calls.append("activity:\(afterSequence ?? 0):\(limit ?? 0)")
        if let error { throw error }
        guard !activityPages.isEmpty else {
            throw HostClientError.fixtureUnavailable("No Hub activity fixture.")
        }
        return activityPages.removeFirst()
    }

    func getStatus() async throws -> HostStatus {
        HostStatus(status: .ready, runtimeConnected: false)
    }

    func listSnapshots() async throws -> SnapshotPage { SnapshotPage(items: []) }

    func getSnapshot(id: String) async throws -> RuntimeSnapshot {
        throw HostClientError.fixtureUnavailable("No Snapshot fixture.")
    }

    func getObject(hash: String, range: ObjectByteRange?) async throws -> Data {
        throw HostClientError.fixtureUnavailable("No Object fixture.")
    }

    func capture(_ request: CaptureRequest) async throws -> RuntimeSnapshot {
        throw HostClientError.fixtureUnavailable("No capture fixture.")
    }

    func getEventTimeline(eventEpochID: String?) async throws -> EventTimeline {
        EventTimeline(events: [], reportedGaps: [])
    }

    func listReviewIssues(states: [String]?) async throws -> ReviewIssuePage {
        ReviewIssuePage(items: [])
    }

    func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph {
        throw HostClientError.fixtureUnavailable("No Screen Graph fixture.")
    }

    func searchWikiNodes(text: String?) async throws -> WikiNodePage {
        WikiNodePage(items: [])
    }
}
