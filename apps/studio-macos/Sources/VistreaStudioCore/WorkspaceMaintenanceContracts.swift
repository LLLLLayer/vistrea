import Foundation
import VistreaRuntimeModels

public enum WorkspaceMaintenanceContractError: Error, Equatable, Sendable {
    case invalidValue(String)
}

extension WorkspaceMaintenanceContractError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .invalidValue(message):
            message
        }
    }
}

public enum WorkspaceRecoveryPointSource: String, Codable, Equatable, Sendable {
    case manual
    case preMigration = "pre_migration"
}

public struct WorkspaceRetentionPolicy: Codable, Equatable, Sendable {
    public let policyID: String
    public let retainUntil: Timestamp?
    public let reason: String

    public init(policyID: String, retainUntil: Timestamp? = nil, reason: String) throws {
        guard workspaceMaintenanceTextLength(policyID, range: 1...256) else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "A retention policy ID must contain 1 through 256 characters."
            )
        }
        guard workspaceMaintenanceTextLength(reason, range: 1...1_024) else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "A retention reason must contain 1 through 1024 characters."
            )
        }
        self.policyID = policyID
        self.retainUntil = retainUntil
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case policyID = "policy_id"
        case retainUntil = "retain_until"
        case reason
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                policyID: container.decode(String.self, forKey: .policyID),
                retainUntil: container.decodeIfPresent(Timestamp.self, forKey: .retainUntil),
                reason: container.decode(String.self, forKey: .reason)
            )
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

public struct WorkspaceRecoveryPoint: Codable, Equatable, Sendable {
    public let recoveryPointID: String
    public let backup: ObjectReference
    public let source: WorkspaceRecoveryPointSource
    public let reason: String
    public let createdAt: Timestamp
    public let schemaVersion: UInt64
    public let generation: UInt64
    public let retentionPolicies: [WorkspaceRetentionPolicy]
    public let activeRetentionPolicyIDs: [String]

    public init(
        recoveryPointID: String,
        backup: ObjectReference,
        source: WorkspaceRecoveryPointSource,
        reason: String,
        createdAt: Timestamp,
        schemaVersion: UInt64,
        generation: UInt64,
        retentionPolicies: [WorkspaceRetentionPolicy],
        activeRetentionPolicyIDs: [String]
    ) throws {
        guard isCanonicalWorkspaceObjectHash(recoveryPointID), recoveryPointID == backup.hash else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "A recovery point ID must equal its canonical backup Object hash."
            )
        }
        guard backup.mediaType == workspaceBackupMediaType, backup.compression == .none else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "A recovery point backup must be an uncompressed Workspace SQLite backup."
            )
        }
        guard workspaceMaintenanceTextLength(reason, range: 1...1_024) else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "A recovery-point reason must contain 1 through 1024 characters."
            )
        }
        guard schemaVersion > 0,
              isWorkspaceJSONSafeInteger(schemaVersion),
              isWorkspaceJSONSafeInteger(generation)
        else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "Recovery-point schema and generation values must be JSON-safe integers."
            )
        }
        let policyIDs = retentionPolicies.map(\.policyID)
        guard Set(policyIDs).count == policyIDs.count,
              Set(activeRetentionPolicyIDs).count == activeRetentionPolicyIDs.count,
              activeRetentionPolicyIDs.allSatisfy(Set(policyIDs).contains)
        else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "Recovery-point retention policy identities must be unique and internally consistent."
            )
        }
        self.recoveryPointID = recoveryPointID
        self.backup = backup
        self.source = source
        self.reason = reason
        self.createdAt = createdAt
        self.schemaVersion = schemaVersion
        self.generation = generation
        self.retentionPolicies = retentionPolicies
        self.activeRetentionPolicyIDs = activeRetentionPolicyIDs
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case recoveryPointID = "recovery_point_id"
        case backup
        case source
        case reason
        case createdAt = "created_at"
        case schemaVersion = "schema_version"
        case generation
        case retentionPolicies = "retention_policies"
        case activeRetentionPolicyIDs = "active_retention_policy_ids"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                recoveryPointID: container.decode(String.self, forKey: .recoveryPointID),
                backup: container.decode(ObjectReference.self, forKey: .backup),
                source: container.decode(WorkspaceRecoveryPointSource.self, forKey: .source),
                reason: container.decode(String.self, forKey: .reason),
                createdAt: container.decode(Timestamp.self, forKey: .createdAt),
                schemaVersion: container.decode(UInt64.self, forKey: .schemaVersion),
                generation: container.decode(UInt64.self, forKey: .generation),
                retentionPolicies: container.decode(
                    [WorkspaceRetentionPolicy].self,
                    forKey: .retentionPolicies
                ),
                activeRetentionPolicyIDs: container.decode(
                    [String].self,
                    forKey: .activeRetentionPolicyIDs
                )
            )
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

public struct WorkspaceRecoveryPointPage: Codable, Equatable, Sendable {
    public let recoveryPoints: [WorkspaceRecoveryPoint]

    public init(recoveryPoints: [WorkspaceRecoveryPoint]) {
        self.recoveryPoints = recoveryPoints
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case recoveryPoints = "recovery_points"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        recoveryPoints = try container.decode([WorkspaceRecoveryPoint].self, forKey: .recoveryPoints)
    }
}

/// Online-safe recovery-point operations exposed by a running Host.
/// Offline restore and repair operations deliberately live outside HostClient.
public protocol WorkspaceMaintenanceClient: Sendable {
    func listRecoveryPoints() async throws -> WorkspaceRecoveryPointPage
    func createRecoveryPoint(reason: String) async throws -> WorkspaceRecoveryPoint
    func releaseRecoveryPoint(
        recoveryPointID: String,
        retentionPolicyID: String
    ) async throws -> WorkspaceRecoveryPoint
}

public enum WorkspaceMaintenanceOperation: String, Codable, Equatable, Sendable {
    case restore
    case collectGarbage = "collect_garbage"
    case recoverInterruptedRestore = "recover_interrupted_restore"
    case recoverStaleLock = "recover_stale_lock"
}

public struct RestoreWorkspaceCommand: Codable, Equatable, Sendable {
    public let backupHash: String

    public init(backupHash: String) throws {
        guard isCanonicalWorkspaceObjectHash(backupHash) else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "A restore backup hash must be a canonical SHA-256 Object hash."
            )
        }
        self.backupHash = backupHash
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case formatVersion = "format_version"
        case operation
        case backupHash = "backup_hash"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(1, forKey: .formatVersion)
        try container.encode(WorkspaceMaintenanceOperation.restore, forKey: .operation)
        try container.encode(backupHash, forKey: .backupHash)
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try requireWorkspaceMaintenanceHeader(
            formatVersion: container.decode(Int.self, forKey: .formatVersion),
            operation: container.decode(WorkspaceMaintenanceOperation.self, forKey: .operation),
            expected: .restore
        )
        do {
            try self.init(backupHash: container.decode(String.self, forKey: .backupHash))
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

public struct CollectWorkspaceGarbageCommand: Codable, Equatable, Sendable {
    public let dryRun: Bool
    public let minimumAgeSeconds: UInt64?
    public let expectedPlanDigest: String?

    public init(
        dryRun: Bool = true,
        minimumAgeSeconds: UInt64? = nil,
        expectedPlanDigest: String? = nil
    ) throws {
        if let minimumAgeSeconds, minimumAgeSeconds > workspaceMaximumGarbageAgeSeconds {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "The garbage-collection minimum age must be at most one year."
            )
        }
        if let expectedPlanDigest, !isCanonicalWorkspaceObjectHash(expectedPlanDigest) {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "A garbage-collection plan digest must be a canonical SHA-256 digest."
            )
        }
        guard (dryRun && expectedPlanDigest == nil) || (!dryRun && expectedPlanDigest != nil) else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "Destructive garbage collection requires a dry-run plan digest, while dry runs reject one."
            )
        }
        self.dryRun = dryRun
        self.minimumAgeSeconds = minimumAgeSeconds
        self.expectedPlanDigest = expectedPlanDigest
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case formatVersion = "format_version"
        case operation
        case dryRun = "dry_run"
        case minimumAgeSeconds = "minimum_age_seconds"
        case expectedPlanDigest = "expected_plan_digest"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(1, forKey: .formatVersion)
        try container.encode(WorkspaceMaintenanceOperation.collectGarbage, forKey: .operation)
        try container.encode(dryRun, forKey: .dryRun)
        try container.encodeIfPresent(minimumAgeSeconds, forKey: .minimumAgeSeconds)
        try container.encodeIfPresent(expectedPlanDigest, forKey: .expectedPlanDigest)
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try requireWorkspaceMaintenanceHeader(
            formatVersion: container.decode(Int.self, forKey: .formatVersion),
            operation: container.decode(WorkspaceMaintenanceOperation.self, forKey: .operation),
            expected: .collectGarbage
        )
        do {
            try self.init(
                dryRun: container.decode(Bool.self, forKey: .dryRun),
                minimumAgeSeconds: container.decodeIfPresent(UInt64.self, forKey: .minimumAgeSeconds),
                expectedPlanDigest: container.decodeIfPresent(String.self, forKey: .expectedPlanDigest)
            )
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

public struct RecoverInterruptedRestoreCommand: Codable, Equatable, Sendable {
    public init() {}

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case formatVersion = "format_version"
        case operation
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(1, forKey: .formatVersion)
        try container.encode(WorkspaceMaintenanceOperation.recoverInterruptedRestore, forKey: .operation)
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try requireWorkspaceMaintenanceHeader(
            formatVersion: container.decode(Int.self, forKey: .formatVersion),
            operation: container.decode(WorkspaceMaintenanceOperation.self, forKey: .operation),
            expected: .recoverInterruptedRestore
        )
    }
}

public struct RecoverStaleLockCommand: Codable, Equatable, Sendable {
    public init() {}

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case formatVersion = "format_version"
        case operation
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(1, forKey: .formatVersion)
        try container.encode(WorkspaceMaintenanceOperation.recoverStaleLock, forKey: .operation)
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try requireWorkspaceMaintenanceHeader(
            formatVersion: container.decode(Int.self, forKey: .formatVersion),
            operation: container.decode(WorkspaceMaintenanceOperation.self, forKey: .operation),
            expected: .recoverStaleLock
        )
    }
}

public struct WorkspaceRestoreResult: Codable, Equatable, Sendable {
    public let backup: ObjectReference
    public let restoredSchemaVersion: UInt64
    public let restoredGeneration: UInt64
    public let recoveryID: String

    public init(
        backup: ObjectReference,
        restoredSchemaVersion: UInt64,
        restoredGeneration: UInt64,
        recoveryID: String
    ) throws {
        guard backup.mediaType == workspaceBackupMediaType, backup.compression == .none,
              restoredSchemaVersion > 0,
              isWorkspaceJSONSafeInteger(restoredSchemaVersion),
              isWorkspaceJSONSafeInteger(restoredGeneration),
              workspaceMaintenanceTextLength(recoveryID, range: 1...256)
        else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "The Workspace restore result is invalid."
            )
        }
        self.backup = backup
        self.restoredSchemaVersion = restoredSchemaVersion
        self.restoredGeneration = restoredGeneration
        self.recoveryID = recoveryID
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case backup
        case restoredSchemaVersion = "restored_schema_version"
        case restoredGeneration = "restored_generation"
        case recoveryID = "recovery_id"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                backup: container.decode(ObjectReference.self, forKey: .backup),
                restoredSchemaVersion: container.decode(UInt64.self, forKey: .restoredSchemaVersion),
                restoredGeneration: container.decode(UInt64.self, forKey: .restoredGeneration),
                recoveryID: container.decode(String.self, forKey: .recoveryID)
            )
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

public struct CollectWorkspaceGarbageResult: Codable, Equatable, Sendable {
    public let dryRun: Bool
    public let minimumAgeSeconds: UInt64
    public let planDigest: String
    public let scannedObjects: UInt64
    public let reachableObjects: UInt64
    public let retainedObjects: UInt64
    public let youngObjects: UInt64
    public let candidateObjects: UInt64
    public let candidateBytes: UInt64
    public let staleCatalogEntries: UInt64
    public let removedCatalogEntries: UInt64
    public let deletedObjects: UInt64
    public let deletedBytes: UInt64
    public let candidateHashes: [String]

    public init(
        dryRun: Bool,
        minimumAgeSeconds: UInt64,
        planDigest: String,
        scannedObjects: UInt64,
        reachableObjects: UInt64,
        retainedObjects: UInt64,
        youngObjects: UInt64,
        candidateObjects: UInt64,
        candidateBytes: UInt64,
        staleCatalogEntries: UInt64,
        removedCatalogEntries: UInt64,
        deletedObjects: UInt64,
        deletedBytes: UInt64,
        candidateHashes: [String]
    ) throws {
        let counters = [
            scannedObjects, reachableObjects, retainedObjects, youngObjects,
            candidateObjects, candidateBytes, staleCatalogEntries,
            removedCatalogEntries, deletedObjects, deletedBytes,
        ]
        guard minimumAgeSeconds <= workspaceMaximumGarbageAgeSeconds,
              isCanonicalWorkspaceObjectHash(planDigest),
              counters.allSatisfy(isWorkspaceJSONSafeInteger),
              candidateObjects == UInt64(candidateHashes.count),
              candidateHashes.allSatisfy(isCanonicalWorkspaceObjectHash),
              candidateHashes == Array(Set(candidateHashes)).sorted(),
              deletedObjects <= candidateObjects,
              deletedBytes <= candidateBytes,
              !dryRun || (removedCatalogEntries == 0 && deletedObjects == 0 && deletedBytes == 0)
        else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "The Workspace garbage-collection result is invalid."
            )
        }
        self.dryRun = dryRun
        self.minimumAgeSeconds = minimumAgeSeconds
        self.planDigest = planDigest
        self.scannedObjects = scannedObjects
        self.reachableObjects = reachableObjects
        self.retainedObjects = retainedObjects
        self.youngObjects = youngObjects
        self.candidateObjects = candidateObjects
        self.candidateBytes = candidateBytes
        self.staleCatalogEntries = staleCatalogEntries
        self.removedCatalogEntries = removedCatalogEntries
        self.deletedObjects = deletedObjects
        self.deletedBytes = deletedBytes
        self.candidateHashes = candidateHashes
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case dryRun = "dry_run"
        case minimumAgeSeconds = "minimum_age_seconds"
        case planDigest = "plan_digest"
        case scannedObjects = "scanned_objects"
        case reachableObjects = "reachable_objects"
        case retainedObjects = "retained_objects"
        case youngObjects = "young_objects"
        case candidateObjects = "candidate_objects"
        case candidateBytes = "candidate_bytes"
        case staleCatalogEntries = "stale_catalog_entries"
        case removedCatalogEntries = "removed_catalog_entries"
        case deletedObjects = "deleted_objects"
        case deletedBytes = "deleted_bytes"
        case candidateHashes = "candidate_hashes"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                dryRun: container.decode(Bool.self, forKey: .dryRun),
                minimumAgeSeconds: container.decode(UInt64.self, forKey: .minimumAgeSeconds),
                planDigest: container.decode(String.self, forKey: .planDigest),
                scannedObjects: container.decode(UInt64.self, forKey: .scannedObjects),
                reachableObjects: container.decode(UInt64.self, forKey: .reachableObjects),
                retainedObjects: container.decode(UInt64.self, forKey: .retainedObjects),
                youngObjects: container.decode(UInt64.self, forKey: .youngObjects),
                candidateObjects: container.decode(UInt64.self, forKey: .candidateObjects),
                candidateBytes: container.decode(UInt64.self, forKey: .candidateBytes),
                staleCatalogEntries: container.decode(UInt64.self, forKey: .staleCatalogEntries),
                removedCatalogEntries: container.decode(UInt64.self, forKey: .removedCatalogEntries),
                deletedObjects: container.decode(UInt64.self, forKey: .deletedObjects),
                deletedBytes: container.decode(UInt64.self, forKey: .deletedBytes),
                candidateHashes: container.decode([String].self, forKey: .candidateHashes)
            )
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

public struct RecoverInterruptedRestoreResult: Codable, Equatable, Sendable {
    public let recoveryID: String
    public let restoredOriginalFiles: [String]

    public init(recoveryID: String, restoredOriginalFiles: [String]) throws {
        guard workspaceMaintenanceTextLength(recoveryID, range: 1...256),
              Set(restoredOriginalFiles).count == restoredOriginalFiles.count,
              restoredOriginalFiles.allSatisfy({
                  workspaceMaintenanceTextLength($0, range: 1...256) &&
                      !$0.contains("/") && !$0.contains("\0")
              })
        else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "The interrupted-restore recovery result is invalid."
            )
        }
        self.recoveryID = recoveryID
        self.restoredOriginalFiles = restoredOriginalFiles
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case recoveryID = "recovery_id"
        case restoredOriginalFiles = "restored_original_files"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                recoveryID: container.decode(String.self, forKey: .recoveryID),
                restoredOriginalFiles: container.decode([String].self, forKey: .restoredOriginalFiles)
            )
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

public struct RecoverStaleLockResult: Codable, Equatable, Sendable {
    public let recoveredProcessID: Int32
    public let recoveryID: String

    public init(recoveredProcessID: Int32, recoveryID: String) throws {
        guard recoveredProcessID > 0, workspaceMaintenanceTextLength(recoveryID, range: 1...256) else {
            throw WorkspaceMaintenanceContractError.invalidValue(
                "The stale-lock recovery result is invalid."
            )
        }
        self.recoveredProcessID = recoveredProcessID
        self.recoveryID = recoveryID
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case recoveredProcessID = "recovered_process_id"
        case recoveryID = "recovery_id"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectWorkspaceMaintenanceUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                recoveredProcessID: container.decode(Int32.self, forKey: .recoveredProcessID),
                recoveryID: container.decode(String.self, forKey: .recoveryID)
            )
        } catch {
            throw workspaceMaintenanceDecodingError(error, codingPath: decoder.codingPath)
        }
    }
}

private let workspaceBackupMediaType =
    "application/vnd.vistrea.workspace-metadata-backup+sqlite3"
private let workspaceJSONSafeIntegerMaximum: UInt64 = 9_007_199_254_740_991
private let workspaceMaximumGarbageAgeSeconds: UInt64 = 365 * 24 * 60 * 60

private func isWorkspaceJSONSafeInteger(_ value: UInt64) -> Bool {
    value <= workspaceJSONSafeIntegerMaximum
}

private func workspaceMaintenanceTextLength(_ value: String, range: ClosedRange<Int>) -> Bool {
    !value.contains("\0") && range.contains(value.utf16.count)
}

private func isCanonicalWorkspaceObjectHash(_ value: String) -> Bool {
    guard value.utf8.count == 71, value.hasPrefix("sha256:") else { return false }
    return value.utf8.dropFirst(7).allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
    }
}

private func requireWorkspaceMaintenanceHeader(
    formatVersion: Int,
    operation: WorkspaceMaintenanceOperation,
    expected: WorkspaceMaintenanceOperation
) throws {
    guard formatVersion == 1, operation == expected else {
        throw WorkspaceMaintenanceContractError.invalidValue(
            "The Workspace maintenance command header is invalid."
        )
    }
}

private func workspaceMaintenanceDecodingError(
    _ error: Error,
    codingPath: [CodingKey]
) -> DecodingError {
    .dataCorrupted(
        .init(codingPath: codingPath, debugDescription: String(describing: error))
    )
}

private struct WorkspaceMaintenanceDynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private extension Decoder {
    func rejectWorkspaceMaintenanceUnknownKeys<Keys>(_ keys: Keys.Type) throws
    where Keys: CodingKey & CaseIterable, Keys.AllCases: Collection {
        let container = try self.container(keyedBy: WorkspaceMaintenanceDynamicCodingKey.self)
        let allowed = Set(Keys.allCases.map(\.stringValue))
        let unknown = container.allKeys.map(\.stringValue).filter { !allowed.contains($0) }.sorted()
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: codingPath,
                    debugDescription: "Unknown Workspace maintenance fields: \(unknown.joined(separator: ", "))"
                )
            )
        }
    }
}
