import Foundation
import VistreaRuntimeModels

/// Applies one allowlisted visual property preview inside the authorized process.
///
/// The transport never mutates views itself; platform adapters resolve stable
/// identifiers to live views and stay observation-honest about failures.
public protocol RuntimeTuningApplying: Sendable {
    /// Properties this concrete platform adapter can read, mutate, and restore.
    var supportedTuningProperties: Set<String> { get }

    /// The current alpha for the stable identifier, or nil when unresolvable.
    func currentAlpha(stableID: String) async -> Double?
    func setAlpha(stableID: String, value: Double) async

    /// Canonical PropertyValue access used by the multi-property processor.
    func currentTuningValue(stableID: String, property: String) async -> JSONValue?
    @discardableResult
    func setTuningValue(stableID: String, property: String, value: JSONValue) async -> Bool
}

public extension RuntimeTuningApplying {
    var supportedTuningProperties: Set<String> { ["alpha"] }

    func currentTuningValue(stableID: String, property: String) async -> JSONValue? {
        guard property == "alpha", let alpha = await currentAlpha(stableID: stableID) else {
            return nil
        }
        return .object([
            "kind": .string("number"),
            "value": .number(alpha),
            "unit": .string("ratio"),
            "extensions": .object([:]),
        ])
    }

    func setTuningValue(stableID: String, property: String, value: JSONValue) async -> Bool {
        guard property == "alpha", let alpha = RuntimeTuningProcessor.numberValue(value) else {
            return false
        }
        await setAlpha(stableID: stableID, value: alpha)
        return true
    }
}

struct RuntimeTuningRejection: Sendable {
    let changeID: String
    let runtimeTarget: JSONValue
    let reasonCode: String
    let message: String
}

struct RuntimeTuningRestoreEntry: Sendable {
    let stableID: String
    let property: String
    let originalValue: JSONValue

    init(stableID: String, property: String, originalValue: JSONValue) {
        self.stableID = stableID
        self.property = property
        self.originalValue = originalValue
    }

    init(stableID: String, originalAlpha: Double) {
        self.init(
            stableID: stableID,
            property: "alpha",
            originalValue: .object([
                "kind": .string("number"),
                "value": .number(originalAlpha),
                "unit": .string("ratio"),
                "extensions": .object([:]),
            ])
        )
    }

    var originalAlpha: Double? { RuntimeTuningProcessor.numberValue(originalValue) }
}

/// One processed apply command: the canonical application plus local restore state.
struct RuntimeTuningOutcome: Sendable {
    let application: [String: JSONValue]
    let restoreEntries: [RuntimeTuningRestoreEntry]
    let isActive: Bool
}

/// Builds canonical TuningApplication values for the loopback transport.
///
/// Every property is read back from the live view before mutation. Unsupported
/// platform/property combinations reject explicitly, and a partial failure
/// restores every already-applied captured original before reporting.
enum RuntimeTuningProcessor {
    static let projectAllowlist: Set<String> = [
        "content_insets",
        "spacing",
        "font",
        "foreground_color",
        "background_color",
        "alpha",
        "corner_radius",
    ]

    // swiftlint:disable:next function_body_length
    static func apply(
        patch: JSONValue,
        expectedSnapshotID: String,
        lastCapturedSnapshotID: String?,
        connectionID: String,
        controller: any RuntimeTuningApplying,
        activeTargetStableIDs: Set<String> = []
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
            guard projectAllowlist.contains(property),
                  controller.supportedTuningProperties.contains(property)
            else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "property_not_allowed",
                    message: "The Runtime adapter cannot safely read, apply, and restore this property."
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
            if activeTargetStableIDs.contains(stableID) {
                // Stacking previews on one target makes restore order ambiguous,
                // so a covered (stable_id, property) rejects instead of stacking.
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "policy_blocked",
                    message: "Another active tuning application already previews this target property."
                ))
                continue
            }
            guard validValue(originalValue, for: property),
                  validValue(previewValue, for: property) else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "unsupported_value",
                    message: "The PropertyValue does not match the selected tuning property."
                ))
                continue
            }
            guard let currentValue = await controller.currentTuningValue(
                stableID: stableID,
                property: property
            ) else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "target_not_found",
                    message: "No live view matches the stable identifier."
                ))
                continue
            }
            guard valuesMatch(currentValue, originalValue, property: property) else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "original_value_mismatch",
                    message: "The live original value no longer matches the captured original."
                ))
                continue
            }
            guard await controller.setTuningValue(
                stableID: stableID,
                property: property,
                value: previewValue
            ) else {
                rejected.append(RuntimeTuningRejection(
                    changeID: changeID,
                    runtimeTarget: runtimeTarget,
                    reasonCode: "target_not_found",
                    message: "The live view vanished or stopped supporting the property before it applied."
                ))
                continue
            }
            restoreEntries.append(RuntimeTuningRestoreEntry(
                stableID: stableID,
                property: property,
                originalValue: currentValue
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
                _ = await controller.setTuningValue(
                    stableID: entry.stableID,
                    property: entry.property,
                    value: entry.originalValue
                )
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

    static func numberValue(_ value: JSONValue) -> Double? {
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

    private static func validValue(_ value: JSONValue, for property: String) -> Bool {
        guard case let .object(object) = value, case let .string(kind)? = object["kind"] else {
            return false
        }
        switch property {
        case "alpha":
            guard kind == "number", object["unit"] == .string("ratio"),
                  let number = numberValue(value) else { return false }
            return (0...1).contains(number)
        case "spacing", "corner_radius":
            guard kind == "number", object["unit"] == .string("logical_point"),
                  let number = numberValue(value) else { return false }
            return number >= 0
        case "foreground_color", "background_color":
            return kind == "color_rgba" && colorComponents(value) != nil
        case "font":
            guard kind == "font", case let .object(font)? = object["value"],
                  case let .string(family)? = font["family"], !family.isEmpty,
                  let size = rawNumber(font["size"]), size > 0,
                  let weight = rawNumber(font["weight"]), (1...1000).contains(weight),
                  case let .string(style)? = font["style"]
            else { return false }
            return style == "normal" || style == "italic"
        case "content_insets":
            guard kind == "insets", case let .object(insets)? = object["value"] else {
                return false
            }
            return ["top", "leading", "bottom", "trailing"].allSatisfy {
                rawNumber(insets[$0]) != nil
            }
        default:
            return false
        }
    }

    private static func valuesMatch(
        _ current: JSONValue,
        _ expected: JSONValue,
        property: String
    ) -> Bool {
        if current == expected { return true }
        switch property {
        case "alpha", "spacing", "corner_radius":
            guard let left = numberValue(current), let right = numberValue(expected) else {
                return false
            }
            return abs(left - right) <= 0.001
        case "foreground_color", "background_color":
            guard let left = colorComponents(current), let right = colorComponents(expected) else {
                return false
            }
            return zip(left, right).allSatisfy { pair in
                abs(pair.0 - pair.1) <= 0.002
            }
        default:
            return false
        }
    }

    private static func colorComponents(_ value: JSONValue) -> [Double]? {
        guard case let .object(propertyValue) = value,
              case let .object(color)? = propertyValue["value"] else { return nil }
        let components = ["red", "green", "blue", "alpha"].compactMap {
            rawNumber(color[$0])
        }
        guard components.count == 4, components.allSatisfy({ (0...1).contains($0) }) else {
            return nil
        }
        return components
    }

    private static func rawNumber(_ value: JSONValue?) -> Double? {
        switch value {
        case let .number(number): number
        case let .integer(integer): Double(integer)
        default: nil
        }
    }

    private static func canonicalTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
