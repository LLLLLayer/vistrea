package dev.vistrea.runtime.connection

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val SNAPSHOT_ID = "snapshot_019f0000-0000-7000-8000-000000000001"
private const val CONNECTION_ID = "connection_019f0000-0000-7000-8000-000000000001"

private class ScriptedTuningController(
    initial: Map<String, Double>,
) : RuntimeTuningApplying {
    private val alphaByStableId = initial.toMutableMap()
    private val setAlphaCounts = mutableMapOf<String, Int>()
    var vanishOnSetAlpha = false
    var failSecondSetAlphaFor: String? = null

    override suspend fun currentAlpha(stableId: String): Double? = alphaByStableId[stableId]

    override suspend fun setAlpha(stableId: String, value: Double): Boolean {
        val callCount = (setAlphaCounts[stableId] ?: 0) + 1
        setAlphaCounts[stableId] = callCount
        if (vanishOnSetAlpha || !alphaByStableId.containsKey(stableId)) {
            return false
        }
        if (stableId == failSecondSetAlphaFor && callCount > 1) {
            // The apply write succeeded; only the later restore write fails.
            return false
        }
        alphaByStableId[stableId] = value
        return true
    }

    fun alpha(stableId: String): Double? = alphaByStableId[stableId]
}

class RuntimeTuningProcessorTest {
    @Test
    fun `applies alpha and builds a canonical active application`() = runBlocking {
        val controller = ScriptedTuningController(mapOf("demo.home.open_catalog" to 1.0))
        val outcome = RuntimeTuningProcessor.apply(
            patch = alphaPatch(preview = 0.7),
            expectedSnapshotId = SNAPSHOT_ID,
            lastCapturedSnapshotId = SNAPSHOT_ID,
            connectionId = CONNECTION_ID,
            controller = controller,
        )
        assertTrue(outcome.isActive)
        assertEquals(0.7, controller.alpha("demo.home.open_catalog"))
        assertEquals(1, outcome.restoreEntries.size)
        assertEquals(1.0, outcome.restoreEntries[0].originalAlpha)
        val application = outcome.application
        assertEquals("active", application["status"]?.jsonPrimitive?.content)
        assertEquals(1, application["applied_changes"]?.jsonArray?.size)
        assertEquals(0, application["rejected_changes"]?.jsonArray?.size)
        assertTrue(
            application["tuning_application_id"]?.jsonPrimitive?.content
                .orEmpty()
                .startsWith("tuningapp_"),
        )
        assertEquals(CONNECTION_ID, application["connection_id"]?.jsonPrimitive?.content)

        val terminal = RuntimeTuningProcessor.terminalApplication(
            application,
            reason = "explicit_revert",
        )
        assertEquals("2", terminal["revision"]?.jsonPrimitive?.content)
        assertEquals("reverted", terminal["status"]?.jsonPrimitive?.content)
        assertEquals("explicit_revert", terminal["reversion_reason"]?.jsonPrimitive?.content)

        val expired = RuntimeTuningProcessor.terminalApplication(
            application,
            reason = "ttl_expiry",
        )
        assertEquals("expired", expired["status"]?.jsonPrimitive?.content)
    }

    @Test
    fun `rejects explicitly and restores applied changes on partial failure`() = runBlocking {
        // A stale snapshot rejects every change without touching a view.
        val staleController = ScriptedTuningController(mapOf("demo.home.open_catalog" to 1.0))
        val stale = RuntimeTuningProcessor.apply(
            patch = alphaPatch(preview = 0.7),
            expectedSnapshotId = SNAPSHOT_ID,
            lastCapturedSnapshotId = "snapshot_019f0000-0000-7000-8000-000000000002",
            connectionId = CONNECTION_ID,
            controller = staleController,
        )
        assertFalse(stale.isActive)
        assertEquals(1.0, staleController.alpha("demo.home.open_catalog"))
        assertEquals("failed", stale.application["status"]?.jsonPrimitive?.content)
        assertEquals("stale_snapshot", firstRejectionReason(stale.application))

        for ((patch, expectedReason) in listOf(
            alphaPatch(preview = 0.7, property = "frame") to "property_not_allowed",
            alphaPatch(preview = 0.7, original = 0.5) to "original_value_mismatch",
            alphaPatch(preview = 0.7, stableId = null) to "target_not_found",
            alphaPatch(preview = 1.5) to "unsupported_value",
        )) {
            val controller = ScriptedTuningController(mapOf("demo.home.open_catalog" to 1.0))
            val outcome = RuntimeTuningProcessor.apply(
                patch = patch,
                expectedSnapshotId = SNAPSHOT_ID,
                lastCapturedSnapshotId = SNAPSHOT_ID,
                connectionId = CONNECTION_ID,
                controller = controller,
            )
            assertFalse(outcome.isActive)
            assertEquals(1.0, controller.alpha("demo.home.open_catalog"))
            assertEquals(expectedReason, firstRejectionReason(outcome.application))
        }

        // A partial failure restores the already-applied change and reports it
        // as policy_blocked instead of leaving a partial preview alive.
        val partialController = ScriptedTuningController(mapOf("demo.home.open_catalog" to 1.0))
        val partial = RuntimeTuningProcessor.apply(
            patch = twoChangePatch(),
            expectedSnapshotId = SNAPSHOT_ID,
            lastCapturedSnapshotId = SNAPSHOT_ID,
            connectionId = CONNECTION_ID,
            controller = partialController,
        )
        assertFalse(partial.isActive)
        assertTrue(partial.restoreEntries.isEmpty())
        assertEquals(1.0, partialController.alpha("demo.home.open_catalog"))
        assertEquals(0, partial.application["applied_changes"]?.jsonArray?.size)
        val reasons = partial.application["rejected_changes"]?.jsonArray.orEmpty().map {
            it.jsonObject["reason_code"]?.jsonPrimitive?.content
        }
        assertEquals(listOf("target_not_found", "policy_blocked"), reasons)
    }

    @Test
    fun `rejects a change whose target another active application already covers`() = runBlocking {
        val controller = ScriptedTuningController(mapOf("demo.home.open_catalog" to 1.0))
        val outcome = RuntimeTuningProcessor.apply(
            patch = alphaPatch(preview = 0.7),
            expectedSnapshotId = SNAPSHOT_ID,
            lastCapturedSnapshotId = SNAPSHOT_ID,
            connectionId = CONNECTION_ID,
            controller = controller,
            activeTargetStableIds = setOf("demo.home.open_catalog"),
        )
        assertFalse(outcome.isActive)
        assertTrue(outcome.restoreEntries.isEmpty())
        assertEquals(1.0, controller.alpha("demo.home.open_catalog"))
        assertEquals("policy_blocked", firstRejectionReason(outcome.application))
    }

    @Test
    fun `rejects a change whose target vanishes before the preview applies`() = runBlocking {
        val controller = ScriptedTuningController(mapOf("demo.home.open_catalog" to 1.0))
        controller.vanishOnSetAlpha = true
        val outcome = RuntimeTuningProcessor.apply(
            patch = alphaPatch(preview = 0.7),
            expectedSnapshotId = SNAPSHOT_ID,
            lastCapturedSnapshotId = SNAPSHOT_ID,
            connectionId = CONNECTION_ID,
            controller = controller,
        )
        assertFalse(outcome.isActive)
        assertTrue(outcome.restoreEntries.isEmpty())
        assertEquals(1.0, controller.alpha("demo.home.open_catalog"))
        assertEquals("target_not_found", firstRejectionReason(outcome.application))
    }

    @Test
    fun `reports a failed restore honestly after a partial failure`() = runBlocking {
        val controller = ScriptedTuningController(mapOf("demo.home.open_catalog" to 1.0))
        controller.failSecondSetAlphaFor = "demo.home.open_catalog"
        val outcome = RuntimeTuningProcessor.apply(
            patch = twoChangePatch(),
            expectedSnapshotId = SNAPSHOT_ID,
            lastCapturedSnapshotId = SNAPSHOT_ID,
            connectionId = CONNECTION_ID,
            controller = controller,
        )
        assertFalse(outcome.isActive)
        assertTrue(outcome.restoreEntries.isEmpty())
        assertEquals(0, outcome.application["applied_changes"]?.jsonArray?.size)
        val reasons = outcome.application["rejected_changes"]?.jsonArray.orEmpty().map {
            it.jsonObject["reason_code"]?.jsonPrimitive?.content
        }
        // The applied change failed to restore, so it must not claim success.
        assertEquals(listOf("target_not_found", "internal"), reasons)
    }

    private fun firstRejectionReason(application: JsonObject): String? =
        application["rejected_changes"]?.jsonArray?.firstOrNull()
            ?.jsonObject?.get("reason_code")?.jsonPrimitive?.content

    private fun alphaPatch(
        preview: Double,
        original: Double = 1.0,
        property: String = "alpha",
        stableId: String? = "demo.home.open_catalog",
    ): JsonElement = buildJsonObject {
        put("patch_id", JsonPrimitive("patch_019f0000-0000-7000-8000-000000000001"))
        put("revision", JsonPrimitive(1))
        put("target_snapshot_id", JsonPrimitive(SNAPSHOT_ID))
        put(
            "changes",
            buildJsonArray {
                add(
                    change(
                        changeId = "tuningchange_019f0000-0000-7000-8000-000000000001",
                        stableId = stableId,
                        property = property,
                        original = original,
                        preview = preview,
                    ),
                )
            },
        )
    }

    private fun twoChangePatch(): JsonElement = buildJsonObject {
        put("patch_id", JsonPrimitive("patch_019f0000-0000-7000-8000-000000000001"))
        put("revision", JsonPrimitive(1))
        put("target_snapshot_id", JsonPrimitive(SNAPSHOT_ID))
        put(
            "changes",
            buildJsonArray {
                add(
                    change(
                        changeId = "tuningchange_019f0000-0000-7000-8000-000000000001",
                        stableId = "demo.home.open_catalog",
                        property = "alpha",
                        original = 1.0,
                        preview = 0.4,
                    ),
                )
                add(
                    change(
                        changeId = "tuningchange_019f0000-0000-7000-8000-000000000002",
                        stableId = "demo.home.missing",
                        property = "alpha",
                        original = 1.0,
                        preview = 0.4,
                    ),
                )
            },
        )
    }

    private fun change(
        changeId: String,
        stableId: String?,
        property: String,
        original: Double,
        preview: Double,
    ): JsonObject = buildJsonObject {
        put("tuning_change_id", JsonPrimitive(changeId))
        put(
            "runtime_target",
            buildJsonObject {
                put("snapshot_id", JsonPrimitive(SNAPSHOT_ID))
                put("tree_id", JsonPrimitive("tree_019f0000-0000-7000-8000-000000000002"))
                put("node_id", JsonPrimitive("node_019f0000-0000-7000-8000-000000000011"))
                if (stableId != null) {
                    put("stable_id", JsonPrimitive(stableId))
                }
                put("extensions", JsonObject(emptyMap()))
            },
        )
        put("property", JsonPrimitive(property))
        put("original_value", ratioValue(original))
        put("preview_value", ratioValue(preview))
    }

    private fun ratioValue(value: Double): JsonObject = buildJsonObject {
        put("kind", JsonPrimitive("number"))
        put("value", JsonPrimitive(value))
        put("unit", JsonPrimitive("ratio"))
        put("extensions", JsonObject(emptyMap()))
    }
}
