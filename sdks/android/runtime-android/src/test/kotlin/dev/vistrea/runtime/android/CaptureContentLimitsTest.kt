package dev.vistrea.runtime.android

import dev.vistrea.protocol.v1.CaptureLimitationSeverity
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.RuntimeIdentifierFactory
import dev.vistrea.protocol.v1.TreeId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class CaptureContentLimitsTest {
    @Test
    fun `values within the canonical limit pass through untouched`() {
        val exactly = "a".repeat(CaptureContentLimits.TEXT_CODE_POINT_LIMIT)
        val bounded = bounded(exactly, CaptureContentLimits.TEXT_CODE_POINT_LIMIT)
        assertSame(exactly, bounded.value)
        assertNull(bounded.limitation)

        val absent = bounded(null, CaptureContentLimits.TEXT_CODE_POINT_LIMIT)
        assertNull(absent.value)
        assertNull(absent.limitation)
    }

    @Test
    fun `over-limit values truncate to the canonical limit and record the loss`() {
        val bounded = bounded(
            "a".repeat(CaptureContentLimits.PLACEHOLDER_CODE_POINT_LIMIT + 1),
            CaptureContentLimits.PLACEHOLDER_CODE_POINT_LIMIT,
            field = "content.placeholder",
        )
        val value = assertNotNull(bounded.value)
        assertEquals(CaptureContentLimits.PLACEHOLDER_CODE_POINT_LIMIT, value.length)

        val limitation = assertNotNull(bounded.limitation)
        assertEquals("android.capture.text-truncated", limitation.code)
        assertEquals(CaptureLimitationSeverity.WARNING, limitation.severity)
        assertEquals(false, limitation.retryable)
        assertEquals(TREE_ID, limitation.scope?.treeId)
        assertEquals(NODE_ID, limitation.scope?.nodeId)
        assertEquals("content.placeholder", limitation.scope?.field)
    }

    @Test
    fun `truncation cuts on a code-point boundary and never splits a surrogate pair`() {
        // Every emoji is one code point but two UTF-16 units, so a UTF-16
        // length cut at an odd limit would leave a lone high surrogate.
        val emoji = "😀"
        val bounded = bounded(emoji.repeat(9), limit = 5)
        val value = assertNotNull(bounded.value)
        assertEquals(5, value.codePointCount(0, value.length))
        assertEquals(emoji.repeat(5), value)
        assertTrue(value.none(Char::isHighSurrogate) || value.last().isLowSurrogate())
        assertNotNull(bounded.limitation)
    }

    @Test
    fun `a value whose utf-16 length exceeds the limit but whose code points do not is kept`() {
        // Ten emoji are 20 UTF-16 units but only 10 code points; the canonical
        // schema counts code points, so this value is within a limit of 10.
        val bounded = bounded("😀".repeat(10), limit = 10)
        assertEquals("😀".repeat(10), bounded.value)
        assertNull(bounded.limitation)
    }

    @Test
    fun `an invalid stable identifier is reported with the node scope`() {
        val limitation = CaptureContentLimits.invalidStableIdentifier(TREE_ID, NODE_ID)
        assertEquals("android.capture.stable-id-invalid", limitation.code)
        assertEquals(CaptureLimitationSeverity.WARNING, limitation.severity)
        assertEquals(TREE_ID, limitation.scope?.treeId)
        assertEquals(NODE_ID, limitation.scope?.nodeId)
        assertEquals("stable_id", limitation.scope?.field)
    }

    private fun bounded(
        value: String?,
        limit: Int,
        field: String = "content.text",
    ): CaptureContentLimits.BoundedValue =
        CaptureContentLimits.bounded(value, limit, field, TREE_ID, NODE_ID)

    private companion object {
        val TREE_ID = TreeId(RuntimeIdentifierFactory.deterministic("tree", "content-limits-test"))
        val NODE_ID = NodeId(RuntimeIdentifierFactory.deterministic("node", "content-limits-test"))
    }
}
