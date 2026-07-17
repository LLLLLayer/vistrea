package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.RuntimeIdentifierFactory
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
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
    val supportedTuningProperties: Set<String>
        get() = setOf("alpha")

    /** The current alpha for the stable identifier, or null when unresolvable. */
    suspend fun currentAlpha(stableId: String): Double?

    /** Returns true only when a live view resolved and the value applied. */
    suspend fun setAlpha(stableId: String, value: Double): Boolean

    suspend fun currentTuningValue(stableId: String, property: String): JsonElement? {
        if (property != "alpha") return null
        val alpha = currentAlpha(stableId) ?: return null
        return numberValue(alpha, "ratio")
    }

    suspend fun setTuningValue(
        stableId: String,
        property: String,
        value: JsonElement,
    ): Boolean {
        if (property != "alpha") return false
        return setAlpha(stableId, propertyNumber(value) ?: return false)
    }
}

internal data class RuntimeTuningRejection(
    val changeId: String,
    val runtimeTarget: JsonElement,
    val reasonCode: String,
    val message: String,
)

internal data class RuntimeTuningRestoreEntry(
    val stableId: String,
    val property: String,
    val originalValue: JsonElement,
) {
    constructor(stableId: String, originalAlpha: Double) : this(
        stableId = stableId,
        property = "alpha",
        originalValue = numberValue(originalAlpha, "ratio"),
    )

    val originalAlpha: Double?
        get() = propertyNumber(originalValue)
}

/** One processed apply command: the canonical application plus local restore state. */
internal data class RuntimeTuningOutcome(
    val application: JsonObject,
    val restoreEntries: List<RuntimeTuningRestoreEntry>,
    val isActive: Boolean,
)

/**
 * Builds canonical TuningApplication values for the loopback transport.
 *
 * Every mutation is preceded by a live read. Unsupported platform/property
 * combinations reject explicitly, and partial failures restore every
 * captured original before reporting.
 */
internal object RuntimeTuningProcessor {
    val PROJECT_ALLOWLIST: Set<String> = setOf(
        "content_insets",
        "spacing",
        "font",
        "foreground_color",
        "background_color",
        "alpha",
        "corner_radius",
    )

    @Suppress("CognitiveComplexMethod", "CyclomaticComplexMethod", "LongMethod", "ReturnCount")
    suspend fun apply(
        patch: JsonElement,
        expectedSnapshotId: String,
        lastCapturedSnapshotId: String?,
        connectionId: String,
        controller: RuntimeTuningApplying,
        activeTargetStableIds: Set<String> = emptySet(),
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
            if (property !in PROJECT_ALLOWLIST || property !in controller.supportedTuningProperties) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "property_not_allowed",
                    message = "The Runtime adapter cannot safely read, apply, and restore this property.",
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
            if (stableId in activeTargetStableIds) {
                // Stacking previews on one target makes restore order ambiguous,
                // so a covered (stable_id, property) rejects instead of stacking.
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "policy_blocked",
                    message = "Another active tuning application already previews this target property.",
                )
                continue
            }
            if (!validValue(originalValue, property) || !validValue(previewValue, property)) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "unsupported_value",
                    message = "The PropertyValue does not match the selected tuning property.",
                )
                continue
            }
            val currentValue = controller.currentTuningValue(stableId, property)
            if (currentValue == null) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "target_not_found",
                    message = "No live view matches the stable identifier.",
                )
                continue
            }
            if (!valuesMatch(currentValue, originalValue, property)) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "original_value_mismatch",
                    message = "The live original value no longer matches the captured original.",
                )
                continue
            }
            if (!controller.setTuningValue(stableId, property, previewValue)) {
                rejected += RuntimeTuningRejection(
                    changeId = changeId,
                    runtimeTarget = runtimeTarget,
                    reasonCode = "target_not_found",
                    message = "The live view vanished before the preview value applied.",
                )
                continue
            }
            restoreEntries += RuntimeTuningRestoreEntry(
                stableId = stableId,
                property = property,
                originalValue = currentValue,
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
            val restoreFailed = restoreOriginals(controller, restoreEntries)
            for ((index, change) in applied.withIndex()) {
                val changeId = stringValue(change["tuning_change_id"]) ?: continue
                val runtimeTarget = change["runtime_target"] ?: continue
                rejected += if (restoreFailed[index]) {
                    RuntimeTuningRejection(
                        changeId = changeId,
                        runtimeTarget = runtimeTarget,
                        reasonCode = "internal",
                        message = "The captured original failed to restore after a partial failure.",
                    )
                } else {
                    RuntimeTuningRejection(
                        changeId = changeId,
                        runtimeTarget = runtimeTarget,
                        reasonCode = "policy_blocked",
                        message = "Restored after a partial failure per the patch reversion policy.",
                    )
                }
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

    /**
     * Restores captured originals in reverse apply order even when the caller
     * is cancelled or the controller throws, and reports per-entry failures.
     */
    @Suppress("TooGenericExceptionCaught")
    private suspend fun restoreOriginals(
        controller: RuntimeTuningApplying,
        entries: List<RuntimeTuningRestoreEntry>,
    ): BooleanArray {
        val failed = BooleanArray(entries.size)
        withContext(NonCancellable) {
            for (index in entries.indices.reversed()) {
                val entry = entries[index]
                val restored = try {
                    controller.setTuningValue(entry.stableId, entry.property, entry.originalValue)
                } catch (_: Exception) {
                    false
                }
                failed[index] = !restored
            }
        }
        return failed
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

    private fun validValue(value: JsonElement, property: String): Boolean {
        val propertyValue = value as? JsonObject ?: return false
        return when (property) {
            "alpha" -> stringValue(propertyValue["kind"]) == "number" &&
                stringValue(propertyValue["unit"]) == "ratio" &&
                propertyNumber(value)?.let { it in 0.0..1.0 } == true
            "spacing", "corner_radius" -> stringValue(propertyValue["kind"]) == "number" &&
                stringValue(propertyValue["unit"]) == "logical_point" &&
                propertyNumber(value)?.let { it >= 0 } == true
            "foreground_color", "background_color" ->
                stringValue(propertyValue["kind"]) == "color_rgba" && colorComponents(value) != null
            "content_insets" -> {
                val insets = propertyValue["value"] as? JsonObject
                stringValue(propertyValue["kind"]) == "insets" &&
                    listOf("top", "leading", "bottom", "trailing")
                        .all { rawNumber(insets?.get(it)) != null }
            }
            "font" -> {
                val font = propertyValue["value"] as? JsonObject
                val size = rawNumber(font?.get("size"))
                val weight = rawNumber(font?.get("weight"))
                val family = stringValue(font?.get("family"))
                val style = stringValue(font?.get("style"))
                stringValue(propertyValue["kind"]) == "font" &&
                    !family.isNullOrBlank() && size != null && size > 0 &&
                    weight != null && weight in 1.0..1000.0 &&
                    style in setOf("normal", "italic")
            }
            else -> false
        }
    }

    private fun valuesMatch(current: JsonElement, expected: JsonElement, property: String): Boolean {
        if (current == expected) return true
        return when (property) {
            "alpha", "spacing", "corner_radius" -> {
                val left = propertyNumber(current)
                val right = propertyNumber(expected)
                left != null && right != null && abs(left - right) <= 0.001
            }
            "foreground_color", "background_color" -> {
                val left = colorComponents(current)
                val right = colorComponents(expected)
                left != null && right != null && left.zip(right).all { (a, b) -> abs(a - b) <= 0.002 }
            }
            else -> false
        }
    }

    private fun colorComponents(value: JsonElement): List<Double>? {
        val property = value as? JsonObject ?: return null
        val color = property["value"] as? JsonObject ?: return null
        val components = listOf("red", "green", "blue", "alpha").map {
            rawNumber(color[it]) ?: return null
        }
        return components.takeIf { values -> values.all { it in 0.0..1.0 } }
    }
}

private fun propertyNumber(element: JsonElement?): Double? {
    val propertyValue = element as? JsonObject ?: return null
    if ((propertyValue["kind"] as? JsonPrimitive)?.content != "number") return null
    return rawNumber(propertyValue["value"])
}

private fun rawNumber(element: JsonElement?): Double? =
    (element as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.doubleOrNull

private fun numberValue(value: Double, unit: String): JsonObject = buildJsonObject {
    put("kind", JsonPrimitive("number"))
    put("value", JsonPrimitive(value))
    put("unit", JsonPrimitive(unit))
    put("extensions", JsonObject(emptyMap()))
}
