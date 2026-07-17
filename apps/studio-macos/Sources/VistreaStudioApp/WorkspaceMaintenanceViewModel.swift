import Combine
import Foundation
import VistreaStudioCore

enum WorkspaceOfflineMaintenanceAction: Equatable {
    case restore(recoveryPointID: String)
    case analyzeGarbage(minimumAgeSeconds: UInt64)
    case applyGarbage(minimumAgeSeconds: UInt64, planDigest: String)
    case recoverInterruptedRestore
    case recoverStaleLock

    var operation: WorkspaceMaintenanceOperation {
        switch self {
        case .restore:
            .restore
        case .analyzeGarbage, .applyGarbage:
            .collectGarbage
        case .recoverInterruptedRestore:
            .recoverInterruptedRestore
        case .recoverStaleLock:
            .recoverStaleLock
        }
    }
}

enum WorkspaceMaintenanceSelectionPolicy {
    static func allowsMaintenance(
        selectedPath: String?,
        currentPath: String?,
        recoveryEligiblePath: String?
    ) -> Bool {
        guard let selectedPath else { return false }
        return selectedPath == currentPath || selectedPath == recoveryEligiblePath
    }

    static func recoveryFailureMessage(
        selectedPath: String?,
        recoveryEligiblePath: String?,
        message: String?
    ) -> String? {
        guard selectedPath != nil, selectedPath == recoveryEligiblePath else { return nil }
        return message
    }
}

@MainActor
final class WorkspaceMaintenanceViewModel: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loadingRecoveryPoints
        case creatingRecoveryPoint
        case releasingRecoveryPoint
        case preparingOfflineMaintenance
        case stoppingHost
        case runningOfflineMaintenance(WorkspaceMaintenanceOperation)
        case reopeningWorkspace
        case succeeded
        case failed
        case reopenFailed
    }

    @Published private(set) var recoveryPoints: [WorkspaceRecoveryPoint] = []
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var resultMessage: String?
    @Published private(set) var errorMessage: String?
    @Published private(set) var garbagePreview: CollectWorkspaceGarbageResult?
    @Published var recoveryPointReason = "Manual recovery point"
    @Published var garbageMinimumAgeDays = 7 {
        didSet {
            let bounded = min(max(garbageMinimumAgeDays, 0), 365)
            if bounded != garbageMinimumAgeDays {
                garbageMinimumAgeDays = bounded
                return
            }
            if oldValue != garbageMinimumAgeDays {
                garbagePreview = nil
                garbageConfirmation = ""
            }
        }
    }
    @Published var garbageConfirmation = ""

    private var client: (any WorkspaceMaintenanceClient)?

    init(client: (any WorkspaceMaintenanceClient)?) {
        self.client = client
    }

    var hasOnlineClient: Bool {
        client != nil
    }

    var isBusy: Bool {
        switch phase {
        case .idle, .succeeded, .failed, .reopenFailed:
            false
        default:
            true
        }
    }

    var garbageMinimumAgeSeconds: UInt64 {
        UInt64(garbageMinimumAgeDays) * 24 * 60 * 60
    }

    var canApplyGarbagePreview: Bool {
        guard let garbagePreview, garbagePreview.dryRun else { return false }
        return garbageConfirmation == "DELETE" &&
            (garbagePreview.candidateObjects > 0 || garbagePreview.staleCatalogEntries > 0)
    }

    var statusMessage: String? {
        switch phase {
        case .idle:
            nil
        case .loadingRecoveryPoints:
            "Loading recovery points…"
        case .creatingRecoveryPoint:
            "Creating a verified recovery point…"
        case .releasingRecoveryPoint:
            "Releasing the selected retention policy…"
        case .preparingOfflineMaintenance:
            "Preparing offline Workspace maintenance…"
        case .stoppingHost:
            "Stopping the local Host safely…"
        case let .runningOfflineMaintenance(operation):
            switch operation {
            case .restore:
                "Restoring the selected recovery point…"
            case .collectGarbage:
                "Analyzing or cleaning Workspace objects…"
            case .recoverInterruptedRestore:
                "Recovering an interrupted restore…"
            case .recoverStaleLock:
                "Recovering a stale Host lock…"
            }
        case .reopeningWorkspace:
            "Reopening the Workspace and local Host…"
        case .succeeded, .failed, .reopenFailed:
            nil
        }
    }

    func configure(client: (any WorkspaceMaintenanceClient)?) {
        self.client = client
        recoveryPoints = []
        garbagePreview = nil
        garbageConfirmation = ""
        recoveryPointReason = "Manual recovery point"
        phase = .idle
        resultMessage = nil
        errorMessage = nil
    }

    func replaceOnlineClient(_ client: (any WorkspaceMaintenanceClient)?) {
        self.client = client
        recoveryPoints = []
    }

    func loadRecoveryPoints() async {
        guard !isBusy, let client else { return }
        phase = .loadingRecoveryPoints
        errorMessage = nil
        do {
            recoveryPoints = try await client.listRecoveryPoints().recoveryPoints
            phase = .idle
        } catch {
            phase = .failed
            errorMessage = error.localizedDescription
        }
    }

    func createRecoveryPoint() async {
        guard !isBusy, let client else { return }
        let reason = recoveryPointReason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty else {
            errorMessage = "Enter a reason for the recovery point."
            phase = .failed
            return
        }
        phase = .creatingRecoveryPoint
        resultMessage = nil
        errorMessage = nil
        do {
            let created = try await client.createRecoveryPoint(reason: reason)
            replaceOrInsert(created)
            garbagePreview = nil
            garbageConfirmation = ""
            recoveryPointReason = "Manual recovery point"
            resultMessage = "Recovery point created and retained."
            phase = .succeeded
        } catch {
            phase = .failed
            errorMessage = error.localizedDescription
        }
    }

    func releaseRecoveryPoint(
        recoveryPointID: String,
        retentionPolicyID: String
    ) async {
        guard !isBusy, let client else { return }
        phase = .releasingRecoveryPoint
        resultMessage = nil
        errorMessage = nil
        do {
            let updated = try await client.releaseRecoveryPoint(
                recoveryPointID: recoveryPointID,
                retentionPolicyID: retentionPolicyID
            )
            replaceOrInsert(updated)
            garbagePreview = nil
            garbageConfirmation = ""
            resultMessage = "Retention policy released. The backup remains until it becomes eligible for garbage collection."
            phase = .succeeded
        } catch {
            phase = .failed
            errorMessage = error.localizedDescription
        }
    }

    func beginOfflineMaintenance(_ action: WorkspaceOfflineMaintenanceAction) {
        guard !isBusy else { return }
        resultMessage = nil
        errorMessage = nil
        // Every offline operation can change metadata, retained roots, or the
        // object catalog. Never let a pre-operation plan remain actionable.
        garbagePreview = nil
        garbageConfirmation = ""
        phase = .preparingOfflineMaintenance
    }

    func markHostStopping() {
        phase = .stoppingHost
    }

    func markOfflineMaintenanceRunning(_ operation: WorkspaceMaintenanceOperation) {
        phase = .runningOfflineMaintenance(operation)
    }

    func markWorkspaceReopening() {
        errorMessage = nil
        phase = .reopeningWorkspace
    }

    func recordWorkspaceOpenFailure(message: String) {
        resultMessage = nil
        errorMessage = message
        phase = .reopenFailed
    }

    func completeOfflineMaintenance(
        message: String,
        garbageResult: CollectWorkspaceGarbageResult? = nil
    ) {
        if let garbageResult, garbageResult.dryRun {
            garbagePreview = garbageResult
            garbageConfirmation = ""
        } else if garbageResult != nil {
            garbagePreview = nil
            garbageConfirmation = ""
        }
        resultMessage = message
        errorMessage = nil
        phase = .succeeded
    }

    func failOfflineMaintenance(message: String, workspaceReopened: Bool) {
        errorMessage = message
        phase = workspaceReopened ? .failed : .reopenFailed
    }

    func recordMaintenanceSucceededButReopenFailed(
        successMessage: String,
        reopenMessage: String
    ) {
        resultMessage = successMessage
        errorMessage = reopenMessage
        phase = .reopenFailed
    }

    private func replaceOrInsert(_ recoveryPoint: WorkspaceRecoveryPoint) {
        if let index = recoveryPoints.firstIndex(where: {
            $0.recoveryPointID == recoveryPoint.recoveryPointID
        }) {
            recoveryPoints[index] = recoveryPoint
        } else {
            recoveryPoints.insert(recoveryPoint, at: 0)
        }
    }
}
