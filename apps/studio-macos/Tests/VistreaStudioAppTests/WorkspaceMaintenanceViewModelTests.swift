import VistreaRuntimeModels
import VistreaStudioCore
import XCTest
@testable import VistreaStudioApp

@MainActor
final class WorkspaceMaintenanceViewModelTests: XCTestCase {
    func testMaintenanceSelectionRequiresCurrentOrExplicitFailedWorkspace() {
        XCTAssertTrue(
            WorkspaceMaintenanceSelectionPolicy.allowsMaintenance(
                selectedPath: "/current.vistrea",
                currentPath: "/current.vistrea",
                recoveryEligiblePath: nil
            )
        )
        XCTAssertTrue(
            WorkspaceMaintenanceSelectionPolicy.allowsMaintenance(
                selectedPath: "/failed.vistrea",
                currentPath: nil,
                recoveryEligiblePath: "/failed.vistrea"
            )
        )
        XCTAssertFalse(
            WorkspaceMaintenanceSelectionPolicy.allowsMaintenance(
                selectedPath: "/other.vistrea",
                currentPath: nil,
                recoveryEligiblePath: "/failed.vistrea"
            )
        )
        XCTAssertFalse(
            WorkspaceMaintenanceSelectionPolicy.allowsMaintenance(
                selectedPath: "/closed.vistrea",
                currentPath: nil,
                recoveryEligiblePath: nil
            )
        )
        XCTAssertEqual(
            WorkspaceMaintenanceSelectionPolicy.recoveryFailureMessage(
                selectedPath: "/failed.vistrea",
                recoveryEligiblePath: "/failed.vistrea",
                message: "Host failed to start."
            ),
            "Host failed to start."
        )
        XCTAssertNil(
            WorkspaceMaintenanceSelectionPolicy.recoveryFailureMessage(
                selectedPath: "/other.vistrea",
                recoveryEligiblePath: "/failed.vistrea",
                message: "Host failed to start."
            )
        )
    }

    func testOnlineMutationsInvalidateGarbagePreview() async throws {
        let existing = try recoveryPoint(hashCharacter: "a", activePolicies: ["migration:v1"])
        let created = try recoveryPoint(hashCharacter: "b", activePolicies: ["workspace-recovery:test"])
        let client = StubWorkspaceMaintenanceClient(points: [existing], createdPoint: created)
        let model = WorkspaceMaintenanceViewModel(client: client)

        await model.loadRecoveryPoints()
        XCTAssertEqual(model.recoveryPoints, [existing])

        model.completeOfflineMaintenance(
            message: "Analyzed.",
            garbageResult: try garbagePreview()
        )
        XCTAssertNotNil(model.garbagePreview)
        model.garbageConfirmation = "DELETE"
        model.recoveryPointReason = "  Before a local experiment  "
        await model.createRecoveryPoint()

        XCTAssertEqual(model.recoveryPoints.first, created)
        XCTAssertNil(model.garbagePreview)
        XCTAssertEqual(model.garbageConfirmation, "")
        let createdReasons = await client.recordedCreatedReasons()
        XCTAssertEqual(createdReasons, ["Before a local experiment"])

        model.completeOfflineMaintenance(
            message: "Analyzed again.",
            garbageResult: try garbagePreview()
        )
        model.garbageConfirmation = "DELETE"
        await model.releaseRecoveryPoint(
            recoveryPointID: created.recoveryPointID,
            retentionPolicyID: "workspace-recovery:test"
        )

        XCTAssertEqual(model.recoveryPoints.first?.activeRetentionPolicyIDs, [])
        XCTAssertNil(model.garbagePreview)
        XCTAssertEqual(model.garbageConfirmation, "")
        let releases = await client.recordedReleases()
        XCTAssertEqual(
            releases,
            [RetentionReleaseCall(
                recoveryPointID: created.recoveryPointID,
                policyID: "workspace-recovery:test"
            )]
        )
    }

    func testGarbageApplyRequiresExactConfirmationAndPreview() throws {
        let model = WorkspaceMaintenanceViewModel(client: nil)
        let preview = try garbagePreview()

        model.completeOfflineMaintenance(message: "Analyzed.", garbageResult: preview)
        XCTAssertFalse(model.canApplyGarbagePreview)
        model.garbageConfirmation = "delete"
        XCTAssertFalse(model.canApplyGarbagePreview)
        model.garbageConfirmation = "DELETE"
        XCTAssertTrue(model.canApplyGarbagePreview)

        model.garbageMinimumAgeDays = 30
        XCTAssertNil(model.garbagePreview)
        XCTAssertEqual(model.garbageConfirmation, "")
        XCTAssertFalse(model.canApplyGarbagePreview)
    }

    func testOfflineMaintenanceKeepsSuccessAndReopenFailureSeparate() {
        let model = WorkspaceMaintenanceViewModel(client: nil)

        model.beginOfflineMaintenance(.recoverStaleLock)
        XCTAssertEqual(model.phase, .preparingOfflineMaintenance)
        model.markHostStopping()
        XCTAssertEqual(model.phase, .stoppingHost)
        model.markOfflineMaintenanceRunning(.recoverStaleLock)
        XCTAssertEqual(model.phase, .runningOfflineMaintenance(.recoverStaleLock))
        model.markWorkspaceReopening()
        XCTAssertEqual(model.phase, .reopeningWorkspace)
        model.recordMaintenanceSucceededButReopenFailed(
            successMessage: "The stale lock was recovered.",
            reopenMessage: "The Workspace still could not open."
        )

        XCTAssertEqual(model.phase, .reopenFailed)
        XCTAssertEqual(model.resultMessage, "The stale lock was recovered.")
        XCTAssertEqual(model.errorMessage, "The Workspace still could not open.")
        XCTAssertFalse(model.isBusy)
    }

    func testOfflineMaintenanceInvalidatesExistingGarbagePlan() throws {
        let model = WorkspaceMaintenanceViewModel(client: nil)
        model.completeOfflineMaintenance(
            message: "Analyzed.",
            garbageResult: try garbagePreview()
        )
        model.garbageConfirmation = "DELETE"

        model.beginOfflineMaintenance(.restore(recoveryPointID: "recovery-point"))

        XCTAssertNil(model.garbagePreview)
        XCTAssertEqual(model.garbageConfirmation, "")
        XCTAssertFalse(model.canApplyGarbagePreview)
    }

    func testWorkspaceConfigurationResetsWorkspaceScopedDrafts() {
        let model = WorkspaceMaintenanceViewModel(client: nil)
        model.recoveryPointReason = "Before changing another Workspace"

        model.configure(client: nil)

        XCTAssertEqual(model.recoveryPointReason, "Manual recovery point")
    }

    func testWorkspaceOpenFailureIsVisibleAndRetryable() {
        let model = WorkspaceMaintenanceViewModel(client: nil)

        model.recordWorkspaceOpenFailure(message: "The local Host failed to start.")

        XCTAssertEqual(model.phase, .reopenFailed)
        XCTAssertEqual(model.errorMessage, "The local Host failed to start.")
        XCTAssertFalse(model.isBusy)
        model.markWorkspaceReopening()
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.phase, .reopeningWorkspace)
    }

    func testEmptyRecoveryPointReasonFailsBeforeCallingClient() async throws {
        let point = try recoveryPoint(hashCharacter: "a", activePolicies: ["workspace:test"])
        let client = StubWorkspaceMaintenanceClient(points: [], createdPoint: point)
        let model = WorkspaceMaintenanceViewModel(client: client)
        model.recoveryPointReason = " \n "

        await model.createRecoveryPoint()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.errorMessage, "Enter a reason for the recovery point.")
        let createdReasons = await client.recordedCreatedReasons()
        XCTAssertEqual(createdReasons, [])
    }
}

private struct RetentionReleaseCall: Equatable, Sendable {
    let recoveryPointID: String
    let policyID: String
}

private actor StubWorkspaceMaintenanceClient: WorkspaceMaintenanceClient {
    private var points: [WorkspaceRecoveryPoint]
    private let createdPoint: WorkspaceRecoveryPoint
    private(set) var createdReasons: [String] = []
    private(set) var releases: [RetentionReleaseCall] = []

    init(points: [WorkspaceRecoveryPoint], createdPoint: WorkspaceRecoveryPoint) {
        self.points = points
        self.createdPoint = createdPoint
    }

    func listRecoveryPoints() async throws -> WorkspaceRecoveryPointPage {
        WorkspaceRecoveryPointPage(recoveryPoints: points)
    }

    func createRecoveryPoint(reason: String) async throws -> WorkspaceRecoveryPoint {
        createdReasons.append(reason)
        points.insert(createdPoint, at: 0)
        return createdPoint
    }

    func releaseRecoveryPoint(
        recoveryPointID: String,
        retentionPolicyID: String
    ) async throws -> WorkspaceRecoveryPoint {
        releases.append(
            RetentionReleaseCall(
                recoveryPointID: recoveryPointID,
                policyID: retentionPolicyID
            )
        )
        guard let index = points.firstIndex(where: {
            $0.recoveryPointID == recoveryPointID
        }) else {
            throw WorkspaceMaintenanceContractError.invalidValue("Missing recovery point.")
        }
        let current = points[index]
        let updated = try WorkspaceRecoveryPoint(
            recoveryPointID: current.recoveryPointID,
            backup: current.backup,
            source: current.source,
            reason: current.reason,
            createdAt: current.createdAt,
            schemaVersion: current.schemaVersion,
            generation: current.generation,
            retentionPolicies: current.retentionPolicies,
            activeRetentionPolicyIDs: current.activeRetentionPolicyIDs.filter {
                $0 != retentionPolicyID
            }
        )
        points[index] = updated
        return updated
    }

    func recordedCreatedReasons() -> [String] {
        createdReasons
    }

    func recordedReleases() -> [RetentionReleaseCall] {
        releases
    }
}

private func recoveryPoint(
    hashCharacter: Character,
    activePolicies: [String]
) throws -> WorkspaceRecoveryPoint {
    let hash = "sha256:" + String(repeating: String(hashCharacter), count: 64)
    let policies = try activePolicies.map {
        try WorkspaceRetentionPolicy(policyID: $0, reason: "Test retention policy")
    }
    return try WorkspaceRecoveryPoint(
        recoveryPointID: hash,
        backup: ObjectReference(
            hash: hash,
            mediaType: "application/vnd.vistrea.workspace-metadata-backup+sqlite3",
            byteSize: JSONSafeUInt(validating: 512),
            compression: .none,
            logicalName: "metadata.sqlite"
        ),
        source: .manual,
        reason: "Test recovery point",
        createdAt: Timestamp(validating: "2026-07-17T00:00:00.000Z"),
        schemaVersion: 1,
        generation: 2,
        retentionPolicies: policies,
        activeRetentionPolicyIDs: activePolicies
    )
}

private func garbagePreview() throws -> CollectWorkspaceGarbageResult {
    try CollectWorkspaceGarbageResult(
        dryRun: true,
        minimumAgeSeconds: 7 * 24 * 60 * 60,
        planDigest: "sha256:" + String(repeating: "c", count: 64),
        scannedObjects: 8,
        reachableObjects: 4,
        retainedObjects: 2,
        youngObjects: 1,
        candidateObjects: 1,
        candidateBytes: 1_024,
        staleCatalogEntries: 0,
        removedCatalogEntries: 0,
        deletedObjects: 0,
        deletedBytes: 0,
        candidateHashes: ["sha256:" + String(repeating: "d", count: 64)]
    )
}
