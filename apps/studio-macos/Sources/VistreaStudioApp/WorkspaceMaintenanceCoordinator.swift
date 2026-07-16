import VistreaStudioCore

struct WorkspaceMaintenanceExecutionSummary: Sendable {
    let message: String
    let garbageResult: CollectWorkspaceGarbageResult?

    init(
        message: String,
        garbageResult: CollectWorkspaceGarbageResult? = nil
    ) {
        self.message = message
        self.garbageResult = garbageResult
    }
}

enum WorkspaceMaintenanceCoordinatorStage: Equatable {
    case stoppingHost
    case runningMaintenance
    case reopeningWorkspace
}

enum WorkspaceMaintenanceCoordinatorOutcome<Success> {
    case succeeded(Success)
    case maintenanceFailed(Error)
    case reopenFailed(success: Success, error: Error)
    case maintenanceAndReopenFailed(maintenanceError: Error, reopenError: Error)
}

/// Owns the safety-critical offline order independently of AppKit and the
/// concrete Host runtime. Reopening is attempted after every maintenance
/// result so a failed runner cannot strand an otherwise healthy Workspace.
@MainActor
struct WorkspaceMaintenanceCoordinator {
    func run<Success: Sendable>(
        stopHost: (() async -> Void)?,
        execute: () async throws -> Success,
        reopen: () async throws -> Void,
        onStage: (WorkspaceMaintenanceCoordinatorStage) -> Void
    ) async -> WorkspaceMaintenanceCoordinatorOutcome<Success> {
        if let stopHost {
            onStage(.stoppingHost)
            await stopHost()
        }

        onStage(.runningMaintenance)
        let execution: Result<Success, Error>
        do {
            execution = .success(try await execute())
        } catch {
            execution = .failure(error)
        }

        onStage(.reopeningWorkspace)
        let reopenResult: Result<Void, Error>
        do {
            try await reopen()
            reopenResult = .success(())
        } catch {
            reopenResult = .failure(error)
        }

        switch (execution, reopenResult) {
        case let (.success(success), .success):
            return .succeeded(success)
        case let (.failure(error), .success):
            return .maintenanceFailed(error)
        case let (.success(success), .failure(error)):
            return .reopenFailed(success: success, error: error)
        case let (.failure(maintenanceError), .failure(reopenError)):
            return .maintenanceAndReopenFailed(
                maintenanceError: maintenanceError,
                reopenError: reopenError
            )
        }
    }
}
