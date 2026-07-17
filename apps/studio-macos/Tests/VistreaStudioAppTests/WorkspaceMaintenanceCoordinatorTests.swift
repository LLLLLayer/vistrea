import XCTest
@testable import VistreaStudioApp

@MainActor
final class WorkspaceMaintenanceCoordinatorTests: XCTestCase {
    func testRunsStopExecuteAndReopenInStrictOrder() async {
        var events: [String] = []

        let outcome = await WorkspaceMaintenanceCoordinator().run(
            stopHost: {
                events.append("stop")
            },
            execute: {
                events.append("execute")
                return "maintained"
            },
            reopen: {
                events.append("reopen")
            },
            onStage: { stage in
                events.append("stage:\(stage)")
            }
        )

        XCTAssertEqual(events, [
            "stage:stoppingHost",
            "stop",
            "stage:runningMaintenance",
            "execute",
            "stage:reopeningWorkspace",
            "reopen",
        ])
        guard case let .succeeded(value) = outcome else {
            return XCTFail("Expected a successful maintenance outcome.")
        }
        XCTAssertEqual(value, "maintained")
    }

    func testMaintenanceFailureStillReopensWorkspace() async {
        var events: [String] = []

        let outcome: WorkspaceMaintenanceCoordinatorOutcome<String> =
            await WorkspaceMaintenanceCoordinator().run(
                stopHost: {
                    events.append("stop")
                },
                execute: {
                    events.append("execute")
                    throw CoordinatorTestError.maintenance
                },
                reopen: {
                    events.append("reopen")
                },
                onStage: { _ in }
            )

        XCTAssertEqual(events, ["stop", "execute", "reopen"])
        guard case let .maintenanceFailed(error) = outcome else {
            return XCTFail("Expected a maintenance failure with successful reopen.")
        }
        XCTAssertEqual(error as? CoordinatorTestError, .maintenance)
    }

    func testNoHostRepairSkipsStopAndStillRunsOfflineOperation() async {
        var stages: [WorkspaceMaintenanceCoordinatorStage] = []
        var executed = false
        var reopened = false

        let outcome = await WorkspaceMaintenanceCoordinator().run(
            stopHost: nil,
            execute: {
                executed = true
                return 7
            },
            reopen: {
                reopened = true
            },
            onStage: { stages.append($0) }
        )

        XCTAssertTrue(executed)
        XCTAssertTrue(reopened)
        XCTAssertEqual(stages, [.runningMaintenance, .reopeningWorkspace])
        guard case let .succeeded(value) = outcome else {
            return XCTFail("Expected no-Host repair to succeed.")
        }
        XCTAssertEqual(value, 7)
    }

    func testSuccessfulMaintenanceAndReopenFailureRemainSeparate() async {
        let outcome = await WorkspaceMaintenanceCoordinator().run(
            stopHost: nil,
            execute: { "maintenance succeeded" },
            reopen: { throw CoordinatorTestError.reopen },
            onStage: { _ in }
        )

        guard case let .reopenFailed(success, error) = outcome else {
            return XCTFail("Expected a separate reopen failure.")
        }
        XCTAssertEqual(success, "maintenance succeeded")
        XCTAssertEqual(error as? CoordinatorTestError, .reopen)
    }
}

private enum CoordinatorTestError: Error, Equatable {
    case maintenance
    case reopen
}
