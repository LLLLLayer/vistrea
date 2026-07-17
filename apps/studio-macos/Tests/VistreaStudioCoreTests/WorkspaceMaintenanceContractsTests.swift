import Foundation
import XCTest
@testable import VistreaStudioCore

final class WorkspaceMaintenanceContractsTests: XCTestCase {
    func testOfflineCommandsEncodeTheExactRunnerOperations() throws {
        let hash = "sha256:" + String(repeating: "a", count: 64)
        let digest = "sha256:" + String(repeating: "b", count: 64)

        XCTAssertEqual(
            try jsonObject(RestoreWorkspaceCommand(backupHash: hash)),
            [
                "format_version": 1,
                "operation": "restore",
                "backup_hash": hash,
            ] as NSDictionary
        )
        XCTAssertEqual(
            try jsonObject(
                CollectWorkspaceGarbageCommand(
                    dryRun: false,
                    minimumAgeSeconds: 60,
                    expectedPlanDigest: digest
                )
            ),
            [
                "format_version": 1,
                "operation": "collect_garbage",
                "dry_run": false,
                "minimum_age_seconds": 60,
                "expected_plan_digest": digest,
            ] as NSDictionary
        )
        XCTAssertEqual(
            try jsonObject(RecoverInterruptedRestoreCommand()),
            [
                "format_version": 1,
                "operation": "recover_interrupted_restore",
            ] as NSDictionary
        )
        XCTAssertEqual(
            try jsonObject(RecoverStaleLockCommand()),
            [
                "format_version": 1,
                "operation": "recover_stale_lock",
            ] as NSDictionary
        )
    }

    func testGarbageCommandsRequireTheDryRunDigestHandshake() throws {
        let digest = "sha256:" + String(repeating: "c", count: 64)
        XCTAssertThrowsError(try CollectWorkspaceGarbageCommand(dryRun: false))
        XCTAssertThrowsError(
            try CollectWorkspaceGarbageCommand(dryRun: true, expectedPlanDigest: digest)
        )
        XCTAssertThrowsError(
            try CollectWorkspaceGarbageCommand(
                dryRun: true,
                minimumAgeSeconds: 365 * 24 * 60 * 60 + 1
            )
        )
        XCTAssertNoThrow(try CollectWorkspaceGarbageCommand(dryRun: true))
        XCTAssertNoThrow(
            try CollectWorkspaceGarbageCommand(
                dryRun: false,
                expectedPlanDigest: digest
            )
        )
    }

    func testGarbageResultStrictlyValidatesCountsHashesAndUnknownFields() throws {
        let first = "sha256:" + String(repeating: "1", count: 64)
        let second = "sha256:" + String(repeating: "2", count: 64)
        let data = try JSONSerialization.data(withJSONObject: garbageResultJSON(
            candidateHashes: [first, second]
        ))
        let result = try JSONDecoder().decode(CollectWorkspaceGarbageResult.self, from: data)
        XCTAssertTrue(result.dryRun)
        XCTAssertEqual(result.planDigest, "sha256:" + String(repeating: "d", count: 64))
        XCTAssertEqual(result.candidateObjects, 2)
        XCTAssertEqual(result.candidateBytes, 30)
        XCTAssertEqual(result.candidateHashes, [first, second])

        var unsorted = garbageResultJSON(candidateHashes: [second, first])
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                CollectWorkspaceGarbageResult.self,
                from: JSONSerialization.data(withJSONObject: unsorted)
            )
        )
        unsorted = garbageResultJSON(candidateHashes: [first, second])
        unsorted["unexpected"] = true
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                CollectWorkspaceGarbageResult.self,
                from: JSONSerialization.data(withJSONObject: unsorted)
            )
        )
        var mismatchedCount = garbageResultJSON(candidateHashes: [first, second])
        mismatchedCount["candidate_objects"] = 1
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                CollectWorkspaceGarbageResult.self,
                from: JSONSerialization.data(withJSONObject: mismatchedCount)
            )
        )
    }
}

private func jsonObject<Value: Encodable>(_ value: Value) throws -> NSDictionary {
    let data = try JSONEncoder().encode(value)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
}

private func garbageResultJSON(candidateHashes: [String]) -> [String: Any] {
    [
        "dry_run": true,
        "minimum_age_seconds": 0,
        "plan_digest": "sha256:" + String(repeating: "d", count: 64),
        "scanned_objects": 8,
        "reachable_objects": 3,
        "retained_objects": 1,
        "young_objects": 2,
        "candidate_objects": candidateHashes.count,
        "candidate_bytes": 30,
        "stale_catalog_entries": 0,
        "removed_catalog_entries": 0,
        "deleted_objects": 0,
        "deleted_bytes": 0,
        "candidate_hashes": candidateHashes,
    ]
}
