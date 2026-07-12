package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.ProtocolVersion
import dev.vistrea.protocol.v1.RuntimeEventBatch
import dev.vistrea.protocol.v1.RuntimeEventKind
import dev.vistrea.protocol.v1.StableId
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class RuntimeEventRecorderTest {
    @Test
    fun `assigns monotonic sequences and reports overflowed ranges as dropped`() = runBlocking {
        val recorder = RuntimeEventRecorder(maximumRetainedEvents = 3)
        val initial = recorder.epoch()
        assertTrue(initial.eventEpochId.startsWith("epoch_"))
        assertEquals(1, initial.oldestRetainedSequence)
        assertEquals(1, initial.nextSequence)

        repeat(5) { index ->
            val event = recorder.record(
                RuntimeEventDraft(
                    kind = RuntimeEventKind.TRANSIENT_PRESENTED,
                    stableId = StableId("demo.toast.success"),
                ),
            )
            assertEquals((index + 1).toLong(), event.sequence.value)
            assertEquals(initial.eventEpochId, event.eventEpochId.value)
        }
        val afterOverflow = recorder.epoch()
        assertEquals(3, afterOverflow.oldestRetainedSequence)
        assertEquals(6, afterOverflow.nextSequence)

        val batch = assertNotNull(
            recorder.batchAfter(
                cursor = 0,
                kinds = RuntimeEventKind.entries.toSet(),
                limit = 16,
            ),
        )
        assertEquals(1, batch.firstSequence.value)
        assertEquals(5, batch.lastSequence.value)
        assertEquals(2, batch.droppedEventCount.value)
        assertContentEquals(listOf(3L, 4L, 5L), batch.events.map { it.sequence.value })
    }

    @Test
    fun `filters kinds inside an advanced range and releases acknowledged events`() = runBlocking {
        val recorder = RuntimeEventRecorder()
        recorder.record(RuntimeEventDraft(kind = RuntimeEventKind.TRANSIENT_PRESENTED))
        recorder.record(RuntimeEventDraft(kind = RuntimeEventKind.LAYOUT_CHANGED))
        recorder.record(RuntimeEventDraft(kind = RuntimeEventKind.TRANSIENT_DISMISSED))

        val filtered = assertNotNull(
            recorder.batchAfter(
                cursor = 0,
                kinds = setOf(
                    RuntimeEventKind.TRANSIENT_PRESENTED,
                    RuntimeEventKind.TRANSIENT_DISMISSED,
                ),
                limit = 16,
            ),
        )
        assertEquals(1, filtered.firstSequence.value)
        assertEquals(3, filtered.lastSequence.value)
        assertEquals(0, filtered.droppedEventCount.value)
        assertContentEquals(
            listOf(RuntimeEventKind.TRANSIENT_PRESENTED, RuntimeEventKind.TRANSIENT_DISMISSED),
            filtered.events.map { it.kind },
        )

        assertNull(
            recorder.batchAfter(
                cursor = filtered.lastSequence.value,
                kinds = setOf(RuntimeEventKind.TRANSIENT_PRESENTED),
                limit = 16,
            ),
        )

        recorder.releaseThrough(sequence = 3)
        val released = recorder.epoch()
        assertEquals(4, released.oldestRetainedSequence)
        assertEquals(4, released.nextSequence)
    }

    @Test
    fun `encodes canonical wire batches`() = runBlocking {
        val recorder = RuntimeEventRecorder()
        recorder.record(
            RuntimeEventDraft(
                kind = RuntimeEventKind.TRANSIENT_PRESENTED,
                stableId = StableId("demo.toast.success"),
                durationMs = 2_000.0,
                payload = buildJsonObject { put("text", JsonPrimitive("Saved successfully")) },
            ),
        )
        val batch = assertNotNull(
            recorder.batchAfter(
                cursor = 0,
                kinds = RuntimeEventKind.entries.toSet(),
                limit = 16,
            ),
        )
        val encoded = Json.parseToJsonElement(
            Json.encodeToString(RuntimeEventBatch.serializer(), batch),
        ).jsonObject
        assertEquals(recorder.epoch().eventEpochId, encoded["event_epoch_id"]?.jsonPrimitive?.content)
        assertEquals("1", encoded["first_sequence"]?.jsonPrimitive?.content)
        assertEquals("0", encoded["dropped_event_count"]?.jsonPrimitive?.content)
        val event = encoded["events"]?.jsonArray?.first()?.jsonObject
        assertNotNull(event)
        assertEquals("transient_presented", event["kind"]?.jsonPrimitive?.content)
        assertEquals("demo.toast.success", event["stable_id"]?.jsonPrimitive?.content)
        assertEquals(
            "Saved successfully",
            event["payload"]?.jsonObject?.get("text")?.jsonPrimitive?.content,
        )

        assertTrue(
            runCatching {
                RuntimeEventBatch(
                    protocolVersion = ProtocolVersion(major = 1, minor = 0),
                    eventEpochId = batch.eventEpochId,
                    firstSequence = dev.vistrea.protocol.v1.JsonSafeUInt(2),
                    lastSequence = dev.vistrea.protocol.v1.JsonSafeUInt(1),
                    events = emptyList(),
                    droppedEventCount = batch.droppedEventCount,
                )
            }.isFailure,
        )
    }
}
