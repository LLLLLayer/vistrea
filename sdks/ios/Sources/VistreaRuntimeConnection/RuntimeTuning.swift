import Foundation
import VistreaRuntimeModels

/// Applies one allowlisted visual property preview inside the authorized process.
///
/// The transport never mutates views itself; platform adapters resolve stable
/// identifiers to live views and stay observation-honest about failures.
public protocol RuntimeTuningApplying: Sendable {
    /// The current alpha for the stable identifier, or nil when unresolvable.
    func currentAlpha(stableID: String) async -> Double?
    func setAlpha(stableID: String, value: Double) async
}

struct RuntimeTuningRejection: Sendable {
    let changeID: String
    let runtimeTarget: JSONValue
    let reasonCode: String
    let message: String
}

struct RuntimeTuningRestoreEntry: Sendable {
    let stableID: String
    let originalAlpha: Double
}

/// One processed apply command: the canonical application plus local restore state.
struct RuntimeTuningOutcome: Sendable {
    let application: [String: JSONValue]
    let restoreEntries: [RuntimeTuningRestoreEntry]
    let isActive: Bool
}

/// Builds canonical TuningApplication values for the loopback transport.
///
/// Only the `alpha` property is currently applied; every other allowlisted
/// property is rejected explicitly instead of being silently ignored, and a
/// partial failure restores already-applied changes before reporting.
enum RuntimeTuningProcessor {
    static let supportedProperty = "alpha"
    static let alphaTolerance = 0.001

    // swiftlint:disable:next function_body_length
    static func apply(
        patch: JSONValue,
        expectedSnapshotID: String,
        lastCapturedSnapshotID: String?,
        connectionID: String,
        controller: any RuntimeTuningApplying
    ) async throws -> RuntimeTuningOutcome {
        guard case let .object(patchObject) = patch,
              case let .string(patchID)? = patchObject["patch_id"],
              case let .integer(patchRevision)? = patchObject["revision"],
              case let .array(changes)? = patchObject["changes"],
              !changes.isEmpty
        else {
            throw RuntimeConnectionError.protocolViolation
        }

        let startedAt = canonicalTimestamp(Date())
        var applied: [JSONValue] = []
        var rejected: [RuntimeTuningRejection] = []
        var restoreEntries: [RuntimeTuningRestoreEntry] = []

        let snapshotIsCurrent =
            lastCapturedSnapshotID != nil && lastCapturedSnapshotID == expectedSnapshotID

        for change in changes {
            guard case let .object(changeObject) = change,
                  case let .string(changeID)? = changeObject["tuning_change_id"],
                  let runtimeTarget = changeObject["runtime_target"],
                  case let .string(property)? = changeObject["property"],
                  let originalValue = changeObject["original_value"],
                  let previewValue = changeObject["preview_value"]
            else {
                throw RuntimeConnectionError.protocolViolation
            }
            if !snapshotIsCurrent {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "stale_snapshot",
                    message: "The expected Snapshot is not the most recent capture on this connection."
                ))
                continue
            }
            guard property == supportedProperty else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "property_not_allowed",
                    message: "This Runtime applies only the alpha property in the current slice."
                ))
                continue
            }
            guard case let .object(targetObject) = runtimeTarget,
                  case let .string(stableID)? = targetObject["stable_id"]
            else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "target_not_found",
                    message: "The change has no stable identifier to resolve a live view."
                ))
                continue
            }
            guard let expectedOriginal = numberValue(originalValue),
                  let previewAlpha = numberValue(previewValue),
                  (0.0...1.0).contains(previewAlpha)
            else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "unsupported_value",
                    message: "Alpha values must be ratio numbers between zero and one."
                ))
                continue
            }
            guard let currentAlpha = await controller.currentAlpha(stableID: stableID) else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "target_not_found",
                    message: "No live view matches the stable identifier."
                ))
                continue
            }
            guard abs(currentAlpha - expectedOriginal) <= alphaTolerance else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "original_value_mismatch",
                    message: "The live original value no longer matches the captured original."
                ))
                continue
            }
            await controller.setAlpha(stableID: stableID, value: previewAlpha)
            restoreEntries.append(RuntimeTuningRestoreEntry(
                stableID: stableID,
                originalAlpha: currentAlpha
            ))
            applied.append(.object([
                "tuning_change_id": .string(changeID),
                "runtime_target": runtimeTarget,
                "original_value": originalValue,
                "applied_value": previewValue,
                "extensions": .object([:]),
            ]))
        }

        // The patch reversion policy restores captured originals whenever any
        // change fails; a partially applied preview never survives silently.
        if !rejected.isEmpty && !restoreEntries.isEmpty {
            for entry in restoreEntries.reversed() {
                await controller.setAlpha(stableID: entry.stableID, value: entry.originalAlpha)
            }
            for change in applied {
                guard case let .object(appliedObject) = change,
                      case let .string(changeID)? = appliedObject["tuning_change_id"],
                      let runtimeTarget = appliedObject["runtime_target"]
                else {
                    continue
                }
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "policy_blocked",
                    message: "Restored after a partial failure per the patch reversion policy."
                ))
            }
            applied = []
            restoreEntries = []
        }

        let isActive = !applied.isEmpty
        var application: [String: JSONValue] = [
            "tuning_application_id": .string(
                RuntimeIdentifierFactory.make(prefix: "tuningapp")
            ),
            "protocol_version": .object(["major": .integer(1), "minor": .integer(0)]),
            "revision": .integer(1),
            "patch_id": .string(patchID),
            "patch_revision": .integer(patchRevision),
            "connection_id": .string(connectionID),
            "expected_snapshot_id": .string(expectedSnapshotID),
            "status": .string(isActive ? "active" : "failed"),
            "applied_changes": .array(applied),
            "rejected_changes": .array(rejected.map { rejection in
                .object([
                    "tuning_change_id": .string(rejection.changeID),
                    "runtime_target": rejection.runtimeTarget,
                    "reason_code": .string(rejection.reasonCode),
                    "message": .string(rejection.message),
                    "extensions": .object([:]),
                ])
            }),
            "started_at": .string(startedAt),
            "actor": .object([
                "kind": .string("service"),
                "id": .string("vistrea-runtime-tuning"),
                "extensions": .object([:]),
            ]),
            "extensions": .object([:]),
        ]
        if isActive {
            application["applied_at"] = .string(canonicalTimestamp(Date()))
        }
        return RuntimeTuningOutcome(
            application: application,
            restoreEntries: restoreEntries,
            isActive: isActive
        )
    }

    /// The terminal application after reverting the captured originals.
    static func terminalApplication(
        from application: [String: JSONValue],
        reason: String
    ) -> [String: JSONValue] {
        var terminal = application
        if case let .integer(revision)? = application["revision"] {
            terminal["revision"] = .integer(revision + 1)
        }
        terminal["status"] = .string(reason == "ttl_expiry" ? "expired" : "reverted")
        terminal["reverted_at"] = .string(canonicalTimestamp(Date()))
        terminal["reversion_reason"] = .string(reason)
        return terminal
    }

    private static func numberValue(_ value: JSONValue) -> Double? {
        guard case let .object(propertyValue) = value,
              case let .string(kind)? = propertyValue["kind"],
              kind == "number"
        else {
            return nil
        }
        switch propertyValue["value"] {
        case let .number(number):
            return number
        case let .integer(integer):
            return Double(integer)
        default:
            return nil
        }
    }

    private static func canonicalTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
