import Foundation
import XCTest
@testable import VistreaStudioCore
@testable import VistreaStudioHostRuntime

final class ManagedWorkspaceMaintenanceTests: XCTestCase {
    func testLocatesTheMaintenanceRunnerInTheManagedHostRuntime() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let architecture = try XCTUnwrap(ManagedStudioHost.architectureDirectoryName)
        let runtime = root
            .appendingPathComponent("HostRuntime", isDirectory: true)
            .appendingPathComponent(architecture, isDirectory: true)
        let applicationRoot = runtime.appendingPathComponent("app", isDirectory: true)
        let serve = applicationRoot.appendingPathComponent(
            ".build/typescript/apps/host/serve.js",
            isDirectory: false
        )
        let maintenance = applicationRoot.appendingPathComponent(
            ".build/typescript/apps/host/workspace-maintenance.js",
            isDirectory: false
        )
        try FileManager.default.createDirectory(
            at: serve.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let node = runtime.appendingPathComponent("node", isDirectory: false)
        try Data("#!/bin/sh\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        try Data("export {};\n".utf8).write(to: serve)

        XCTAssertThrowsError(try ManagedWorkspaceMaintenance.runtimeURL(resourceURL: root))
        try Data("export {};\n".utf8).write(to: maintenance)
        XCTAssertEqual(try ManagedWorkspaceMaintenance.runtimeURL(resourceURL: root), runtime)
    }

    func testRunsEveryTypedOperationWithOneBoundedJSONCommand() async throws {
        let runtime = URL(fileURLWithPath: "/embedded/HostRuntime/arm64", isDirectory: true)
        let runner = RecordingWorkspaceMaintenanceProcessRunner(responses: [
            WorkspaceMaintenanceProcessResult(
                terminationStatus: 0,
                standardOutput: try maintenanceEnvelope(
                    operation: "restore",
                    result: restoreResultJSON()
                )
            ),
            WorkspaceMaintenanceProcessResult(
                terminationStatus: 0,
                standardOutput: try maintenanceEnvelope(
                    operation: "collect_garbage",
                    result: garbageResultJSON()
                )
            ),
            WorkspaceMaintenanceProcessResult(
                terminationStatus: 0,
                standardOutput: try maintenanceEnvelope(
                    operation: "recover_interrupted_restore",
                    result: [
                        "recovery_id": "restore-test",
                        "restored_original_files": ["metadata.sqlite"],
                    ]
                )
            ),
            WorkspaceMaintenanceProcessResult(
                terminationStatus: 0,
                standardOutput: try maintenanceEnvelope(
                    operation: "recover_stale_lock",
                    result: [
                        "recovered_process_id": 321,
                        "recovery_id": "lock-test",
                    ]
                )
            ),
        ])
        let maintenance = ManagedWorkspaceMaintenance(runtimeURL: runtime, processRunner: runner)
        let workspace = URL(fileURLWithPath: "/tmp/Vistrea Maintenance Test.vistrea", isDirectory: true)
        let hash = workspaceMaintenanceBackupHash

        let restored = try await maintenance.restore(
            workspaceURL: workspace,
            command: try RestoreWorkspaceCommand(backupHash: hash)
        )
        XCTAssertEqual(restored.backup.hash, hash)
        XCTAssertEqual(restored.restoredGeneration, 7)
        let garbage = try await maintenance.collectGarbage(
            workspaceURL: workspace,
            command: try CollectWorkspaceGarbageCommand(dryRun: true, minimumAgeSeconds: 0)
        )
        XCTAssertEqual(garbage.planDigest, workspaceMaintenancePlanDigest)
        XCTAssertEqual(garbage.candidateHashes, [])
        let interrupted = try await maintenance.recoverInterruptedRestore(workspaceURL: workspace)
        XCTAssertEqual(interrupted.restoredOriginalFiles, ["metadata.sqlite"])
        let staleLock = try await maintenance.recoverStaleLock(workspaceURL: workspace)
        XCTAssertEqual(staleLock.recoveredProcessID, 321)

        let requests = await runner.requests
        XCTAssertEqual(requests.count, 4)
        let applicationRoot = runtime.appendingPathComponent("app", isDirectory: true)
        let executable = runtime.appendingPathComponent("node", isDirectory: false)
        let script = applicationRoot.appendingPathComponent(
            ".build/typescript/apps/host/workspace-maintenance.js",
            isDirectory: false
        )
        for request in requests {
            XCTAssertEqual(request.executableURL, executable)
            XCTAssertEqual(request.currentDirectoryURL, applicationRoot)
            XCTAssertEqual(request.arguments, [
                script.path,
                "--workspace",
                workspace.standardizedFileURL.resolvingSymlinksInPath().path,
            ])
            XCTAssertEqual(request.maximumStdoutBytes, ManagedWorkspaceMaintenance.maximumStdoutBytes)
            XCTAssertEqual(request.environment["NODE_ENV"], "production")
            XCTAssertNil(request.environment["VISTREA_HOST_TOKEN"])
            XCTAssertTrue(request.standardInput.last == 0x0A)
            let withoutNewline = request.standardInput.dropLast()
            XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(withoutNewline)))
            XCTAssertFalse(withoutNewline.contains(0x0A))
        }
        let operations = try requests.map { request -> String in
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(request.standardInput.dropLast()))
                    as? [String: Any]
            )
            return try XCTUnwrap(object["operation"] as? String)
        }
        XCTAssertEqual(operations, [
            "restore",
            "collect_garbage",
            "recover_interrupted_restore",
            "recover_stale_lock",
        ])
    }

    func testValidatesFailureAndSuccessEnvelopesWithoutLeakingInvocationDetails() async throws {
        let workspace = URL(fileURLWithPath: "/tmp/private-workspace.vistrea", isDirectory: true)
        let runtime = URL(fileURLWithPath: "/embedded/runtime", isDirectory: true)
        let failure = try JSONSerialization.data(withJSONObject: [
            "format_version": 1,
            "status": "failed",
            "operation": "restore",
            "error": [
                "code": "conflict",
                "message": "The request conflicts with the current Workspace state.",
                "retryable": true,
            ],
        ])
        let failureRunner = RecordingWorkspaceMaintenanceProcessRunner(responses: [
            WorkspaceMaintenanceProcessResult(terminationStatus: 1, standardOutput: failure),
        ])
        let maintenance = ManagedWorkspaceMaintenance(
            runtimeURL: runtime,
            processRunner: failureRunner
        )
        do {
            _ = try await maintenance.restore(
                workspaceURL: workspace,
                command: try RestoreWorkspaceCommand(backupHash: workspaceMaintenanceBackupHash)
            )
            XCTFail("Expected the failed maintenance envelope to throw.")
        } catch let error as ManagedWorkspaceMaintenanceError {
            XCTAssertEqual(
                error,
                .operationFailed(
                    code: "conflict",
                    message: "The request conflicts with the current Workspace state.",
                    retryable: true
                )
            )
            XCTAssertFalse(error.localizedDescription.contains(workspace.path))
        }

        let mismatchedRunner = RecordingWorkspaceMaintenanceProcessRunner(responses: [
            WorkspaceMaintenanceProcessResult(
                terminationStatus: 0,
                standardOutput: try maintenanceEnvelope(
                    operation: "collect_garbage",
                    result: restoreResultJSON()
                )
            ),
        ])
        let mismatched = ManagedWorkspaceMaintenance(
            runtimeURL: runtime,
            processRunner: mismatchedRunner
        )
        do {
            _ = try await mismatched.restore(
                workspaceURL: workspace,
                command: try RestoreWorkspaceCommand(backupHash: workspaceMaintenanceBackupHash)
            )
            XCTFail("Expected an operation mismatch to fail closed.")
        } catch let error as ManagedWorkspaceMaintenanceError {
            XCTAssertEqual(error, .invalidResponse)
        }
    }

    func testFoundationProcessRunnerWritesInputAndBoundsStdout() async throws {
        let runner = FoundationWorkspaceMaintenanceProcessRunner()
        let input = Data("{\"format_version\":1}\n".utf8)
        let request = WorkspaceMaintenanceProcessRequest(
            executableURL: URL(fileURLWithPath: "/bin/cat"),
            arguments: [],
            currentDirectoryURL: URL(fileURLWithPath: "/tmp", isDirectory: true),
            environment: [:],
            standardInput: input,
            maximumStdoutBytes: input.count
        )
        let output = try await runner.run(request)
        XCTAssertEqual(output.terminationStatus, 0)
        XCTAssertEqual(output.standardOutput, input)

        var bounded = request
        bounded = WorkspaceMaintenanceProcessRequest(
            executableURL: bounded.executableURL,
            arguments: bounded.arguments,
            currentDirectoryURL: bounded.currentDirectoryURL,
            environment: bounded.environment,
            standardInput: bounded.standardInput,
            maximumStdoutBytes: input.count - 1
        )
        do {
            _ = try await runner.run(bounded)
            XCTFail("Expected the bounded reader to reject excess output.")
        } catch let error as WorkspaceMaintenanceProcessError {
            XCTAssertEqual(error, .stdoutTooLarge)
        }
    }
}

private actor RecordingWorkspaceMaintenanceProcessRunner: WorkspaceMaintenanceProcessRunning {
    private var responses: [WorkspaceMaintenanceProcessResult]
    private(set) var requests: [WorkspaceMaintenanceProcessRequest] = []

    init(responses: [WorkspaceMaintenanceProcessResult]) {
        self.responses = responses
    }

    func run(
        _ request: WorkspaceMaintenanceProcessRequest
    ) async throws -> WorkspaceMaintenanceProcessResult {
        requests.append(request)
        guard !responses.isEmpty else {
            throw WorkspaceMaintenanceProcessError.launchFailed
        }
        return responses.removeFirst()
    }
}

private let workspaceMaintenanceBackupHash = "sha256:" + String(repeating: "a", count: 64)
private let workspaceMaintenancePlanDigest = "sha256:" + String(repeating: "b", count: 64)

private func maintenanceEnvelope(operation: String, result: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "format_version": 1,
        "status": "succeeded",
        "operation": operation,
        "result": result,
    ])
}

private func restoreResultJSON() -> [String: Any] {
    [
        "backup": workspaceMaintenanceBackupJSON(),
        "restored_schema_version": 1,
        "restored_generation": 7,
        "recovery_id": "restore-test",
    ]
}

private func garbageResultJSON() -> [String: Any] {
    [
        "dry_run": true,
        "minimum_age_seconds": 0,
        "plan_digest": workspaceMaintenancePlanDigest,
        "scanned_objects": 4,
        "reachable_objects": 2,
        "retained_objects": 1,
        "young_objects": 1,
        "candidate_objects": 0,
        "candidate_bytes": 0,
        "stale_catalog_entries": 0,
        "removed_catalog_entries": 0,
        "deleted_objects": 0,
        "deleted_bytes": 0,
        "candidate_hashes": [],
    ]
}

private func workspaceMaintenanceBackupJSON() -> [String: Any] {
    [
        "hash": workspaceMaintenanceBackupHash,
        "media_type": "application/vnd.vistrea.workspace-metadata-backup+sqlite3",
        "byte_size": 256,
        "compression": "none",
        "logical_name": "metadata-schema-v1.sqlite",
        "extensions": [:],
    ]
}
