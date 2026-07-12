package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.RuntimeIdentifierFactory
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

private val CANONICAL_TUNING_TIMESTAMP =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/**
 * Applies one allowlisted visual property preview inside the authorized process.
 *
 * The transport never mutates views itself; platform adapters resolve stable
 * identifiers to live views and stay observation-honest about failures.
 */
interface RuntimeTuningApplying {
    /** The current alpha for the stable identifier, or null when unresolvable. */
    suspend fun currentAlpha(stableId: String): Double?

    suspend fun setAlpha(stableId: String, value: Double)
}

internal data class RuntimeTuningRejection(
    val changeId: String,
    val runtimeTarget: JsonElement,
    val reasonCode: String,
    val message: String,
)

internal data class RuntimeTuningRestoreEntry(
    val stableId: String,
    val originalAlpha: Double,
)

/** One processed apply command: the canonical application plus local restore state. */
internal data class RuntimeTuningOutcome(
    val application: JsonObject,
    val restoreEntries: List<RuntimeTuningRestoreEntry>,
    val isActive: Boolean,
)

/**
 * Builds canonical TuningApplication values for the loopback transport.
 *
 * Only the `alpha` property is currently applied; every other allowlisted
 * property is rejected explicitly instead of being silently ignored, and a
 * partial failure restores already-applied changes before reporting.
 */
internal object RuntimeTuningProcessor {
    const val SUPPORTED_PROPERTY = "alpha"
    const val ALPHA_TOLERANCE = 0.001

    @Suppress("CognitiveComplexMethod", "CyclomaticComplexMethod", "LongMethod", "ReturnCount")
    suspend fun apply(
        patch: JsonElement,
        expectedSnapshotId: String,
        lastCapturedSnapshotId: String?,
        connectionId: String,
        controller: RuntimeTuningApplying,
    ): RuntimeTuningOutcome {
        val patchObject = patch as? JsonObject
            ?: throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        val patchId = stringValue(patchObject["patch_id"])
        val patchRevision = (patchObject["revision"] as? JsonPrimitive)
            ?.takeUnless(JsonPrimitive::isString)?.longOrNull
        val changes = patchObject["changes"] as? JsonArray
        if (patchId == null || patchRevision == null || changes.isNullOrEmpty()) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }

        val startedAt = CANONICAL_TUNING_TIMESTAMP.format(Instant.now())
        var applied = mutableListOf<JsonObject>()
        val rejected = mutableListOf<RuntimeTuningRejection>()
        var restoreEntries = mutableListOf<RuntimeTuningRestoreEntry>()
        val snapshotIsCurrent =
            lastCapturedSnapshotId != null && lastCapturedSnapshotId == expectedSnapshotId

        for (change in changes) {
            val changeObject = change as? JsonObject
                ?: throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
            val changeId = stringValue(changeObject["tuning_change_id"])
            val runtimeTarget = changeObject["runtime_target"]
            val property = stringValue(changeObject["property"])
            val originalValue = changeObject["original_value"]
            val previewValue = changeObject["preview_value"]
            if (
                changeId == null || runtimeTarget == null || property == null ||
                originalValue == null || previewValue == null
            ) {
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
            }
            if (!snapshotIsCurrent) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "stale_snapshot",
                    message = "The expected Snapshot is not the most recent capture on this connection.",
                )
                continue
            }
            if (property != SUPPORTED_PROPERTY) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "property_not_allowed",
                    message = "This Runtime applies only the alpha property in the current slice.",
                )
                continue
            }
            val stableId = stringValue((runtimeTarget as? JsonObject)?.get("stable_id"))
            if (stableId == null) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "target_not_found",
                    message = "The change has no stable identifier to resolve a live view.",
                )
                continue
            }
            val expectedOriginal = numberValue(originalValue)
            val previewAlpha = numberValue(previewValue)
            if (expectedOriginal == null || previewAlpha == null || previewAlpha !in 0.0..1.0) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "unsupported_value",
                    message = "Alpha values must be ratio numbers between zero and one.",
                )
                continue
            }
            val currentAlpha = controller.currentAlpha(stableId)
            if (currentAlpha == null) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "target_not_found",
                    message = "No live view matches the stable identifier.",
                )
                continue
            }
            if (abs(currentAlpha - expectedOriginal) > ALPHA_TOLERANCE) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "original_value_mismatch",
                    message = "The live original value no longer matches the captured original.",
                )
                continue
            }
            controller.setAlpha(stableId, previewAlpha)
            restoreEntries += RuntimeTuningRestoreEntry(
                stableId = stableId,
                originalAlpha = currentAlpha,
            )
            applied += buildJsonObject {
                put("tuning_change_id", JsonPrimitive(changeId))
                put("runtime_target", runtimeTarget)
                put("original_value", originalValue)
                put("applied_value", previewValue)
                put("extensions", JsonObject(emptyMap()))
            }
        }

        // The patch reversion policy restores captured originals whenever any
        // change fails; a partially applied preview never survives silently.
        if (rejected.isNotEmpty() && restoreEntries.isNotEmpty()) {
            for (entry in restoreEntries.reversed()) {
                controller.setAlpha(entry.stableId, entry.originalAlpha)
            }
            for (change in applied) {
                val changeId = stringValue(change["tuning_change_id"]) ?: continue
                val runtimeTarget = change["runtime_target"] ?: continue
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "policy_blocked",
                    message = "Restored after a partial failure per the patch reversion policy.",
                )
            }
            applied = mutableListOf()
            restoreEntries = mutableListOf()
        }

        val isActive = applied.isNotEmpty()
        val application = buildJsonObject {
            put(
                "tuning_application_id",
                JsonPrimitive(RuntimeIdentifierFactory.make("tuningapp")),
            )
            put(
                "protocol_version",
                buildJsonObject {
                    put("major", JsonPrimitive(1))
                    put("minor", JsonPrimitive(0))
                },
            )
            put("revision", JsonPrimitive(1))
            put("patch_id", JsonPrimitive(patchId))
            put("patch_revision", JsonPrimitive(patchRevision))
            put("connection_id", JsonPrimitive(connectionId))
            put("expected_snapshot_id", JsonPrimitive(expectedSnapshotId))
            put("status", JsonPrimitive(if (isActive) "active" else "failed"))
            put("applied_changes", JsonArray(applied))
            put(
                "rejected_changes",
                JsonArray(
                    rejected.map { rejection ->
                        buildJsonObject {
                            put("tuning_change_id", JsonPrimitive(rejection.changeId))
                            put("runtime_target", rejection.runtimeTarget)
                            put("reason_code", JsonPrimitive(rejection.reasonCode))
                            put("message", JsonPrimitive(rejection.message))
                            put("extensions", JsonObject(emptyMap()))
                        }
                    },
                ),
            )
            put("started_at", JsonPrimitive(startedAt))
            if (isActive) {
                put(
                    "applied_at",
                    JsonPrimitive(CANONICAL_TUNING_TIMESTAMP.format(Instant.now())),
                )
            }
            put(
                "actor",
                buildJsonObject {
                    put("kind", JsonPrimitive("service"))
                    put("id", JsonPrimitive("vistrea-runtime-tuning"))
                    put("extensions", JsonObject(emptyMap()))
                },
            )
            put("extensions", JsonObject(emptyMap()))
        }
        return RuntimeTuningOutcome(
            application = application,
            restoreEntries = restoreEntries,
            isActive = isActive,
        )
    }

    /** The terminal application after reverting the captured originals. */
    fun terminalApplication(application: JsonObject, reason: String): JsonObject {
        val values = application.toMutableMap()
        (application["revision"] as? JsonPrimitive)?.longOrNull?.let { revision ->
            values["revision"] = JsonPrimitive(revision + 1)
        }
        values["status"] = JsonPrimitive(if (reason == "ttl_expiry") "expired" else "reverted")
        values["reverted_at"] = JsonPrimitive(CANONICAL_TUNING_TIMESTAMP.format(Instant.now()))
        values["reversion_reason"] = JsonPrimitive(reason)
        return JsonObject(values)
    }

    fun previewExpiryTimestamp(ttlMilliseconds: Long): String =
        CANONICAL_TUNING_TIMESTAMP.format(Instant.now().plusMillis(ttlMilliseconds))

    private fun stringValue(element: JsonElement?): String? =
        (element as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content

    private fun numberValue(element: JsonElement?): Double? {
        val propertyValue = element as? JsonObject ?: return null
        if (stringValue(propertyValue["kind"]) != "number") {
            return null
        }
        return (propertyValue["value"] as? JsonPrimitive)
            ?.takeUnless(JsonPrimitive::isString)?.doubleOrNull
    }
}
