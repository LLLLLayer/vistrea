package dev.vistrea.runtime.connection

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class RuntimeWireCodecTest {
    @Test
    fun `tolerates unknown optional fields in host frames`() {
        // A newer Host may extend any host-to-runtime frame with optional
        // fields; the Android client must keep interoperating like iOS does.
        val decoded = RuntimeWireCodec.decode<WireCaptureRequest>(
            """
            {
              "type": "capture_request",
              "request_id": "req-1",
              "future_top_level_field": {"nested": [1, 2, 3]},
              "command": {
                "include": {"paths": ["trees"], "future_mask_field": true},
                "screenshot": "none",
                "reason": "manual",
                "future_command_field": "ignored"
              }
            }
            """.trimIndent().replace("\n", ""),
        )
        assertEquals("capture_request", decoded.type)
        assertEquals("req-1", decoded.requestId)
        assertEquals(listOf("trees"), decoded.command.include.paths)
        assertEquals(RuntimeCaptureScreenshotMode.NONE, decoded.command.screenshot)
        assertEquals(RuntimeCaptureReason.MANUAL, decoded.command.reason)
    }

    @Test
    fun `tolerates unknown fields in control frames`() {
        val decoded = RuntimeWireCodec.decode<WireRevertTuning>(
            """
            {
              "type": "revert_tuning",
              "request_id": "req-2",
              "tuning_application_id": "tuningapp_019f0000-0000-7000-8000-000000000001",
              "future_field": "ignored"
            }
            """.trimIndent().replace("\n", ""),
        )
        assertEquals("revert_tuning", decoded.type)
        assertEquals("req-2", decoded.requestId)
    }

    @Test
    fun `still rejects frames missing required fields`() {
        val failure = assertFailsWith<RuntimeConnectionException> {
            RuntimeWireCodec.decode<WireCaptureCancel>("""{"type":"capture_cancel"}""")
        }
        assertEquals(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION, failure.code)
    }
}
