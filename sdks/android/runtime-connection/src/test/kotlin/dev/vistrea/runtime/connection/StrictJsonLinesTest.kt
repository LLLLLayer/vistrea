package dev.vistrea.runtime.connection

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class StrictJsonLinesTest {
    @Test
    fun acceptsSplitFatalUtf8AndCoalescedCrLfObjects() {
        val decoder = BoundedStrictJsonLineDecoder(maximumLineBytes = 1_024)
        val firstPart = "{\"type\":\"disconnect\",\"label\":\"".toByteArray(Charsets.UTF_8)
        val emoji = "界".toByteArray(Charsets.UTF_8)
        decoder.enqueue(firstPart + emoji.copyOfRange(0, 1))
        assertNull(decoder.nextLine())
        decoder.enqueue(
            emoji.copyOfRange(1, emoji.size) +
                "\"}\r\n{\"type\":\"disconnect\"}\n".toByteArray(Charsets.UTF_8),
        )
        assertEquals("disconnect", decoder.nextLine()?.value?.get("type")?.toString()?.trim('"'))
        assertEquals("disconnect", decoder.nextLine()?.value?.get("type")?.toString()?.trim('"'))
        decoder.validateCompleteStream()
    }

    @Test
    fun rejectsMalformedUtf8AndTruncatedLines() {
        val malformed = BoundedStrictJsonLineDecoder(maximumLineBytes = 1_024)
        malformed.enqueue(byteArrayOf(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3.toByte(), 0x22, 0x7d, 0x0a))
        val malformedError = assertFailsWith<StrictJsonLineException> { malformed.nextLine() }
        assertEquals(StrictJsonLineFailure.MALFORMED_UTF8, malformedError.failure)

        val truncated = BoundedStrictJsonLineDecoder(maximumLineBytes = 1_024)
        truncated.enqueue("{}".toByteArray(Charsets.UTF_8))
        val truncatedError = assertFailsWith<StrictJsonLineException> {
            truncated.validateCompleteStream()
        }
        assertEquals(StrictJsonLineFailure.TRUNCATED_LINE, truncatedError.failure)
    }

    @Test
    fun rejectsRawEscapedAndNestedDuplicateKeys() {
        val values = listOf(
            "{\"type\":\"disconnect\",\"type\":\"error\"}\n",
            "{\"type\":\"disconnect\",\"\\u0074ype\":\"error\"}\n",
            "{\"type\":\"capture_request\",\"command\":{\"reason\":1,\"reason\":2}}\n",
        )
        values.forEach { value ->
            val decoder = BoundedStrictJsonLineDecoder(maximumLineBytes = 1_024)
            decoder.enqueue(value.toByteArray(Charsets.UTF_8))
            val error = assertFailsWith<StrictJsonLineException> { decoder.nextLine() }
            assertEquals(StrictJsonLineFailure.DUPLICATE_KEY, error.failure)
        }
    }

    @Test
    fun appliesNegotiatedBoundBeforeReadingCoalescedReadyLine() {
        val decoder = BoundedStrictJsonLineDecoder(maximumLineBytes = 2_048)
        val oversized = "{\"type\":\"disconnect\",\"padding\":\"${"x".repeat(100)}\"}"
        decoder.enqueue("{}\n$oversized\n".toByteArray(Charsets.UTF_8))
        assertEquals("{}", decoder.nextLine()?.source)
        val error = assertFailsWith<StrictJsonLineException> {
            decoder.updateMaximumLineBytes(64)
        }
        assertEquals(StrictJsonLineFailure.LINE_TOO_LARGE, error.failure)
    }

    @Test
    fun typedWireDecodingToleratesUnknownKeys() {
        // A newer Host may add optional fields to any frame; the client keeps
        // interoperating like iOS while duplicate keys stay rejected above.
        val decoded = RuntimeWireCodec.decode<WireDisconnect>(
            "{\"type\":\"disconnect\",\"unexpected\":true}",
        )
        assertEquals("disconnect", decoded.type)
    }
}
