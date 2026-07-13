package dev.vistrea.runtime.compose

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect as ComposeRect
import androidx.compose.ui.semantics.AccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.IntSize
import dev.vistrea.protocol.v1.CaptureLimitationSeverity
import dev.vistrea.protocol.v1.NodeAction
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.Rect
import dev.vistrea.protocol.v1.RedactedContentField
import dev.vistrea.protocol.v1.RuntimeIdentifierFactory
import dev.vistrea.protocol.v1.TreeId
import dev.vistrea.runtime.android.CaptureContentLimits
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonPrimitive

class ComposeSemanticsMappingTest {
    @Test
    fun `explicit vistrea role fact wins over compose role and structure`() {
        val config = SemanticsConfiguration()
        config[VistreaRoleSemanticsKey] = "link"
        config[SemanticsProperties.Role] = Role.Button
        config[SemanticsProperties.Text] = listOf(AnnotatedString("Open"))
        assertEquals("link", composeSemanticsRole(config))
    }

    @Test
    fun `compose roles and structural facts map into the canonical vocabulary`() {
        assertEquals("button", composeSemanticsRole(config { this[SemanticsProperties.Role] = Role.Button }))
        assertEquals("image", composeSemanticsRole(config { this[SemanticsProperties.Role] = Role.Image }))
        assertEquals("button", composeSemanticsRole(config { this[SemanticsProperties.Role] = Role.Checkbox }))
        assertEquals("button", composeSemanticsRole(config { this[SemanticsProperties.Role] = Role.Switch }))
        assertEquals("header", composeSemanticsRole(config { this[SemanticsProperties.Heading] = Unit }))
        assertEquals(
            "text-field",
            composeSemanticsRole(config { this[SemanticsProperties.EditableText] = AnnotatedString("draft") }),
        )
        assertEquals(
            "text",
            composeSemanticsRole(config { this[SemanticsProperties.Text] = listOf(AnnotatedString("Hello")) }),
        )
        assertEquals("container", composeSemanticsRole(SemanticsConfiguration()))
    }

    @Test
    fun `semantics actions map to observation-level node actions`() {
        assertEquals(
            listOf(NodeAction.TAP),
            composeSemanticsActions(config { this[SemanticsActions.OnClick] = AccessibilityAction(null, null) }),
        )
        assertEquals(
            listOf(NodeAction.LONG_PRESS),
            composeSemanticsActions(config { this[SemanticsActions.OnLongClick] = AccessibilityAction(null, null) }),
        )
        assertEquals(
            listOf(NodeAction.TAP, NodeAction.TYPE_TEXT, NodeAction.CLEAR_TEXT),
            composeSemanticsActions(config { this[SemanticsActions.SetText] = AccessibilityAction(null, null) }),
        )
        assertEquals(
            listOf(NodeAction.SWIPE, NodeAction.SCROLL),
            composeSemanticsActions(config { this[SemanticsActions.ScrollBy] = AccessibilityAction(null, null) }),
        )
        assertEquals(emptyList(), composeSemanticsActions(SemanticsConfiguration()))
    }

    @Test
    fun `text and content description fill the shared content fields`() {
        val content = composeSemanticsContent(
            config {
                this[SemanticsProperties.Text] = listOf(AnnotatedString("Hello"), AnnotatedString("World"))
                this[SemanticsProperties.ContentDescription] = listOf("Greeting")
            },
        )
        assertEquals("Hello\nWorld", content.text)
        assertNull(content.value)
        assertEquals("Greeting", content.contentDescription)
    }

    @Test
    fun `editable text becomes both text and value like the view walker`() {
        val content = composeSemanticsContent(
            config {
                this[SemanticsProperties.EditableText] = AnnotatedString("draft")
                this[SemanticsActions.SetText] = AccessibilityAction(null, null)
            },
        )
        assertEquals("draft", content.text)
        assertEquals("draft", content.value)
    }

    @Test
    fun `password semantics redact text and value before they enter the snapshot`() {
        val node = mapComposeSemanticsNode(
            config = config {
                this[SemanticsProperties.EditableText] = AnnotatedString("secret-value")
                this[SemanticsActions.SetText] = AccessibilityAction(null, null)
                this[SemanticsProperties.Password] = Unit
            },
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )
        assertNull(node.content.text)
        assertNull(node.content.value)
        assertNull(node.accessibility?.value)
        assertEquals(
            listOf(RedactedContentField.TEXT, RedactedContentField.VALUE),
            node.content.redactedFields,
        )
    }

    @Test
    fun `pixel geometry converts to logical points with walker-consistent frame math`() {
        // Density 2.0, host View at logical (10, 20): a node at pixel (40, 60)
        // sized 80x100 px must land at logical (30, 50) sized 40x50.
        val node = mapComposeSemanticsNode(
            config = SemanticsConfiguration(),
            geometry = ComposeNodeGeometry(
                positionInRootPx = Offset(40f, 60f),
                sizePx = IntSize(80, 100),
                clippedBoundsInRootPx = ComposeRect(40f, 60f, 120f, 160f),
            ),
            identity = identity(),
            environment = ComposeCaptureEnvironment(
                treeId = TREE_ID,
                hostFrameOriginX = 10.0,
                hostFrameOriginY = 20.0,
                density = 2.0,
                hostVisible = true,
            ),
        )
        assertEquals(Rect(30.0, 50.0, 40.0, 50.0), node.frame)
        assertEquals(Rect(30.0, 50.0, 40.0, 50.0), node.visibleRect)
        assertEquals(Rect(0.0, 0.0, 40.0, 50.0), node.bounds)
        assertEquals(false, node.clipped)
        assertEquals(true, node.state.visible)
    }

    @Test
    fun `ancestor clipping produces a smaller visible rect and marks the node clipped`() {
        val node = mapComposeSemanticsNode(
            config = SemanticsConfiguration(),
            geometry = ComposeNodeGeometry(
                positionInRootPx = Offset(0f, 0f),
                sizePx = IntSize(100, 100),
                clippedBoundsInRootPx = ComposeRect(0f, 0f, 100f, 50f),
            ),
            identity = identity(),
            environment = environment(),
        )
        assertEquals(Rect(0.0, 0.0, 100.0, 100.0), node.frame)
        assertEquals(Rect(0.0, 0.0, 100.0, 50.0), node.visibleRect)
        assertEquals(true, node.clipped)
    }

    @Test
    fun `a fully clipped or host-hidden node is not visible`() {
        val clippedOut = mapComposeSemanticsNode(
            config = SemanticsConfiguration(),
            geometry = ComposeNodeGeometry(
                positionInRootPx = Offset(0f, 0f),
                sizePx = IntSize(100, 100),
                clippedBoundsInRootPx = ComposeRect(0f, 0f, 0f, 0f),
            ),
            identity = identity(),
            environment = environment(),
        )
        assertNull(clippedOut.visibleRect)
        assertEquals(false, clippedOut.state.visible)

        val hiddenHost = mapComposeSemanticsNode(
            config = SemanticsConfiguration(),
            geometry = geometry(),
            identity = identity(),
            environment = environment(hostVisible = false),
        )
        assertEquals(false, hiddenHost.state.visible)
    }

    @Test
    fun `state facts map to node state and hit rect follows tappability`() {
        val node = mapComposeSemanticsNode(
            config = config {
                this[SemanticsActions.OnClick] = AccessibilityAction(null, null)
                this[SemanticsProperties.Disabled] = Unit
                this[SemanticsProperties.Selected] = true
                this[SemanticsProperties.Focused] = false
                this[SemanticsProperties.ToggleableState] = ToggleableState.On
            },
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )
        assertEquals(false, node.state.enabled)
        assertEquals(true, node.state.selected)
        assertEquals(false, node.state.focused)
        assertEquals(true, node.state.checked)
        assertEquals(node.frame, node.hitRect)

        val inert = mapComposeSemanticsNode(
            config = SemanticsConfiguration(),
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )
        assertEquals(true, inert.state.enabled)
        assertNull(inert.state.checked)
        assertNull(inert.hitRect)
    }

    @Test
    fun `test tag becomes the stable identifier and invalid tags are reported`() {
        val tagged = mapComposeSemanticsNode(
            config = config { this[SemanticsProperties.TestTag] = "demo.compose.button" },
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )
        assertEquals("demo.compose.button", tagged.stableId?.value)
        assertTrue(tagged.captureLimitations.isEmpty())

        // A dropped identifier must stay diagnosable instead of vanishing.
        val invalid = mapComposeSemanticsNode(
            config = config { this[SemanticsProperties.TestTag] = " leading space" },
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )
        assertNull(invalid.stableId)
        val limitation = invalid.captureLimitations.single()
        assertEquals("android.capture.stable-id-invalid", limitation.code)
        assertEquals(CaptureLimitationSeverity.WARNING, limitation.severity)
        assertEquals(TREE_ID, limitation.scope?.treeId)
        assertEquals(identity().nodeId, limitation.scope?.nodeId)
        assertEquals("stable_id", limitation.scope?.field)
    }

    @Test
    fun `over-long text truncates on a code-point boundary and records the loss`() {
        // A single astral-plane code point is two UTF-16 units, so a naive
        // length cut would split a surrogate pair.
        val emoji = "😀"
        val overLimit = emoji.repeat(CaptureContentLimits.TEXT_CODE_POINT_LIMIT + 10)
        val node = mapComposeSemanticsNode(
            config = config {
                this[SemanticsProperties.Text] = listOf(AnnotatedString(overLimit))
                this[SemanticsProperties.ContentDescription] = listOf(overLimit)
            },
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )

        val text = assertNotNull(node.content.text)
        assertEquals(
            CaptureContentLimits.TEXT_CODE_POINT_LIMIT,
            text.codePointCount(0, text.length),
        )
        assertTrue(text.endsWith(emoji))
        val description = assertNotNull(node.content.contentDescription)
        assertEquals(
            CaptureContentLimits.TEXT_CODE_POINT_LIMIT,
            description.codePointCount(0, description.length),
        )
        assertEquals(description, node.accessibility?.label)

        val fields = node.captureLimitations
            .filter { it.code == "android.capture.text-truncated" }
            .map { it.scope?.field }
        assertEquals(
            listOf("content.text", "content.content_description", "accessibility.label"),
            fields,
        )
        assertTrue(node.captureLimitations.all { it.scope?.nodeId == identity().nodeId })
    }

    @Test
    fun `in-limit text passes through untouched`() {
        val node = mapComposeSemanticsNode(
            config = config {
                this[SemanticsProperties.Text] = listOf(AnnotatedString("a".repeat(CaptureContentLimits.TEXT_CODE_POINT_LIMIT)))
            },
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )
        assertEquals(CaptureContentLimits.TEXT_CODE_POINT_LIMIT, node.content.text?.length)
        assertTrue(node.captureLimitations.isEmpty())
    }

    @Test
    fun `the host node declares that compose exposes no rendering facts`() {
        val limitation = composeVisualUnavailableLimitation(TREE_ID, nodeId("compose-host"))
        assertEquals("android.capture.compose-visual-unavailable", limitation.code)
        assertEquals(CaptureLimitationSeverity.WARNING, limitation.severity)
        assertEquals(TREE_ID, limitation.scope?.treeId)
        assertEquals(nodeId("compose-host"), limitation.scope?.nodeId)

        // No visual, z-index, or source context is invented for a Compose node.
        val node = mapComposeSemanticsNode(
            config = config { this[SemanticsProperties.Text] = listOf(AnnotatedString("Hello")) },
            geometry = geometry(),
            identity = identity(),
            environment = environment(),
        )
        assertNull(node.visual)
        assertNull(node.zIndex)
        assertNull(node.sourceContext)
    }

    @Test
    fun `identity and provenance survive the mapping`() {
        val identity = identity()
        val node = mapComposeSemanticsNode(
            config = SemanticsConfiguration(),
            geometry = geometry(),
            identity = identity,
            environment = environment(),
        )
        assertEquals(identity.nodeId, node.nodeId)
        assertEquals(identity.parentId, node.parentId)
        assertEquals(identity.childIds, node.childIds)
        assertEquals(COMPOSE_SEMANTICS_NATIVE_TYPE, node.nativeType)
        assertEquals(JsonPrimitive(7), node.extensions["android.compose.semantics_node_id"])
        assertTrue(node.relatedNodes.isEmpty())
        assertTrue(node.captureLimitations.isEmpty())
        assertFalse(node.actions.contains(NodeAction.TAP))
    }

    private fun config(build: SemanticsConfiguration.() -> Unit): SemanticsConfiguration =
        SemanticsConfiguration().apply(build)

    private fun geometry() = ComposeNodeGeometry(
        positionInRootPx = Offset(0f, 0f),
        sizePx = IntSize(10, 10),
        clippedBoundsInRootPx = ComposeRect(0f, 0f, 10f, 10f),
    )

    private fun identity() = ComposeNodeIdentity(
        nodeId = nodeId("node-under-test"),
        parentId = nodeId("parent"),
        childIds = listOf(nodeId("child-a"), nodeId("child-b")),
        semanticsNodeId = 7,
    )

    private fun environment(hostVisible: Boolean = true) = ComposeCaptureEnvironment(
        treeId = TREE_ID,
        hostFrameOriginX = 0.0,
        hostFrameOriginY = 0.0,
        density = 1.0,
        hostVisible = hostVisible,
    )

    private fun nodeId(seed: String): NodeId =
        NodeId(RuntimeIdentifierFactory.deterministic("node", seed))

    private companion object {
        val TREE_ID = TreeId(RuntimeIdentifierFactory.deterministic("tree", "compose-mapping-test"))
    }
}
