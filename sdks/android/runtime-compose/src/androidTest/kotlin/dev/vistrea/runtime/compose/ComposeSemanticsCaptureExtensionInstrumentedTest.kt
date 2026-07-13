package dev.vistrea.runtime.compose

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.vistrea.protocol.v1.BuildId
import dev.vistrea.protocol.v1.NodeAction
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.ProjectId
import dev.vistrea.protocol.v1.RuntimeSnapshot
import dev.vistrea.protocol.v1.RuntimeSnapshotJson
import dev.vistrea.protocol.v1.UiNode
import dev.vistrea.runtime.android.AndroidViewRuntimeCaptureAdapter
import dev.vistrea.runtime.android.AndroidViewRuntimeCaptureConfiguration
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Measures its content and deliberately never places it — exactly the state a
 * lazy list leaves a prefetched item in. The child stays attached and active,
 * so `SemanticsNode.children` still reports it, but it has no real position.
 */
@Composable
private fun NeverPlaced(content: @Composable () -> Unit) {
    Layout(content = content) { measurables, constraints ->
        measurables.forEach { it.measure(constraints) }
        layout(0, 0) { /* Intentionally place nothing. */ }
    }
}

@RunWith(AndroidJUnit4::class)
class ComposeSemanticsCaptureExtensionInstrumentedTest {
    @Test
    fun capturesAnnotatedComposeContentAsRealSemanticNodes() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    Column(Modifier.fillMaxSize()) {
                        BasicText(
                            text = "Welcome",
                            modifier = Modifier.vistreaSemantics(
                                stableId = TITLE_ID,
                                role = VistreaSemanticRole.HEADER,
                            ),
                        )
                        Box(
                            Modifier
                                .size(BUTTON_WIDTH_DP.dp, BUTTON_HEIGHT_DP.dp)
                                .clickable { }
                                .vistreaSemantics(
                                    stableId = BUTTON_ID,
                                    role = VistreaSemanticRole.BUTTON,
                                    label = "Open catalog",
                                ),
                        ) {
                            BasicText("Open")
                        }
                    }
                }
            }

            val snapshot = captureUntilComposeNodesAppear(scenario)
            val nodes = snapshot.trees.single().payload.inlineNodes.orEmpty()
            val host = nodes.single { it.extensions["android.capture.semantics_source"] != null }
            assertEquals("\"compose\"", host.extensions["android.capture.semantics_source"].toString())
            assertTrue(host.childIds.isNotEmpty())

            val title = nodes.single { it.stableId?.value == TITLE_ID }
            assertEquals("header", title.role)
            assertEquals("Welcome", title.content.text)

            val button = nodes.single { it.stableId?.value == BUTTON_ID }
            assertEquals("button", button.role)
            assertTrue(button.actions.contains(NodeAction.TAP))
            assertEquals("Open catalog", button.content.contentDescription)
            assertEquals(true, button.state.visible)
            assertEquals(true, button.state.enabled)

            // The declared 120x48dp size must round-trip through the walker's
            // pixel-to-logical conversion within one physical pixel.
            val frame = assertNotNull(button.frame)
            val pixelTolerance = 1.0 / snapshot.display.pixelScaleX + GEOMETRY_EPSILON
            assertTrue(kotlin.math.abs(frame.width - BUTTON_WIDTH_DP) <= pixelTolerance)
            assertTrue(kotlin.math.abs(frame.height - BUTTON_HEIGHT_DP) <= pixelTolerance)
            val hostFrame = assertNotNull(host.frame)
            assertTrue(frame.x >= hostFrame.x - GEOMETRY_EPSILON)
            assertTrue(frame.y >= hostFrame.y - GEOMETRY_EPSILON)
            assertTrue(frame.x + frame.width <= hostFrame.x + hostFrame.width + GEOMETRY_EPSILON)
            assertTrue(frame.y + frame.height <= hostFrame.y + hostFrame.height + GEOMETRY_EPSILON)

            // The button's plain-text child is a real child node of the button.
            val label = nodes.single { it.content.text == "Open" }
            assertEquals(button.nodeId, label.parentId)
            assertTrue(button.childIds.contains(label.nodeId))
            assertEquals("text", label.role)

            // Parent/child identifier links stay internally consistent and the
            // Snapshot round-trips through the canonical JSON surface.
            val byId = nodes.associateBy(UiNode::nodeId)
            for (node in nodes) {
                node.parentId?.let { parent ->
                    assertTrue(byId.getValue(parent).childIds.contains(node.nodeId))
                }
                for (childId in node.childIds) {
                    assertEquals(node.nodeId, byId.getValue(childId).parentId)
                }
            }
            assertEquals(snapshot, RuntimeSnapshotJson.decode(RuntimeSnapshotJson.encode(snapshot)))
        }
    }

    @Test
    fun capturesPlainComposeTextWithoutAnnotations() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    Box(Modifier.fillMaxSize()) {
                        BasicText("Plain content")
                    }
                }
            }

            val snapshot = captureUntilComposeNodesAppear(scenario)
            val nodes = snapshot.trees.single().payload.inlineNodes.orEmpty()
            val text = nodes.single { it.content.text == "Plain content" }
            assertEquals("text", text.role)
            assertEquals(COMPOSE_SEMANTICS_NATIVE_TYPE, text.nativeType)
        }
    }

    @Test
    fun unplacedComposeNodesNeverBecomeCapturedNodes() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    Column(Modifier.fillMaxSize()) {
                        BasicText(
                            text = PLACED_TEXT,
                            modifier = Modifier.vistreaSemantics(
                                stableId = PLACED_ID,
                                role = VistreaSemanticRole.TEXT,
                            ),
                        )
                        NeverPlaced {
                            BasicText(
                                text = GHOST_TEXT,
                                modifier = Modifier.vistreaSemantics(
                                    stableId = GHOST_ID,
                                    role = VistreaSemanticRole.TEXT,
                                ),
                            )
                        }
                    }
                }
            }

            val snapshot = captureUntilComposeNodesAppear(scenario)
            val nodes = snapshot.trees.single().payload.inlineNodes.orEmpty()
            // The placed sibling is the control: the walk really did reach here.
            assertNotNull(nodes.singleOrNull { it.stableId?.value == PLACED_ID })
            // The measured-but-never-placed node reports Offset.Zero, so
            // capturing it would stack a phantom node on the Compose root's
            // top-left corner that automation could target.
            assertTrue(nodes.none { it.stableId?.value == GHOST_ID })
            assertTrue(nodes.none { it.content.text == GHOST_TEXT })

            // The host node states plainly that Compose exposes no rendering
            // facts, so consumers read the absent visual as unavailable.
            val host = nodes.single { it.extensions["android.capture.semantics_source"] != null }
            assertTrue(
                host.captureLimitations.any {
                    it.code == "android.capture.compose-visual-unavailable"
                },
            )
            val composeNodes = nodes.filter { it.nativeType == COMPOSE_SEMANTICS_NATIVE_TYPE }
            assertTrue(composeNodes.isNotEmpty())
            assertTrue(composeNodes.all { it.visual == null && it.zIndex == null && it.sourceContext == null })
        }
    }

    @Test
    fun lazyListStructuralIdentitySurvivesScrollingAwayAndBack() {
        val listState = AtomicReference<LazyListState>()
        val listScope = AtomicReference<CoroutineScope>()
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    listState.set(rememberLazyListState())
                    listScope.set(rememberCoroutineScope())
                    LazyColumn(
                        state = checkNotNull(listState.get()),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(LAZY_ITEM_COUNT) { index ->
                            BasicText(
                                text = "Item $index",
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(LAZY_ITEM_HEIGHT_DP.dp)
                                    .vistreaSemantics(
                                        stableId = "$LAZY_ITEM_ID_PREFIX$index",
                                        role = VistreaSemanticRole.LIST_ITEM,
                                    ),
                            )
                        }
                    }
                }
            }

            val before = captureUntilComposeNodesAppear(scenario)
            val beforeNodes = before.trees.single().payload.inlineNodes.orEmpty()
            // Only the viewport's worth of items is composed, never all thirty.
            assertTrue(itemIds(beforeNodes).isNotEmpty())
            assertTrue(itemIds(beforeNodes).size < LAZY_ITEM_COUNT)

            val scope = checkNotNull(listScope.get())
            val state = checkNotNull(listState.get())
            // Scroll away by real deltas, not an instant jump: only a consumed
            // scroll delta makes the lazy layout prefetch the item beyond the
            // viewport, which is the composed-but-unplaced node this guards.
            repeat(SCROLL_STEPS) { scrollBy(scope, state, SCROLL_STEP_PIXELS) }
            repeat(SCROLL_STEPS) { scrollBy(scope, state, -SCROLL_STEP_PIXELS) }
            scrollToItem(scope, state, 0)

            val after = captureUntilComposeNodesAppear(scenario)
            val afterNodes = after.trees.single().payload.inlineNodes.orEmpty()

            // Prefetch composes items ahead of the viewport, so an unfiltered
            // walk captures a different node set depending on scroll velocity
            // and frame timing, and the same screen splits into several Screen
            // States run to run. Capturing only placed nodes keeps the
            // structural digest — computed exactly as the exploration engine's
            // computeStructuralIdentity does, over [role, native_type,
            // stable_id, children] — a function of what is on screen.
            assertEquals(itemIds(beforeNodes), itemIds(afterNodes))
            assertEquals(beforeNodes.size, afterNodes.size)
            assertEquals(structuralDigest(before), structuralDigest(after))

            // A never-placed node reports the Compose root's origin, so no two
            // captured item nodes may share a frame origin.
            for (nodes in listOf(beforeNodes, afterNodes)) {
                val origins = nodes
                    .filter { it.stableId?.value?.startsWith(LAZY_ITEM_ID_PREFIX) == true }
                    .map { assertNotNull(it.frame).let { frame -> frame.x to frame.y } }
                assertEquals(origins.size, origins.distinct().size)
            }
        }
    }

    /** The captured lazy item identifiers, in traversal order. */
    private fun itemIds(nodes: List<UiNode>): List<String> = nodes
        .mapNotNull { it.stableId?.value }
        .filter { it.startsWith(LAZY_ITEM_ID_PREFIX) }

    /**
     * The structural digest of one Snapshot, computed the same way
     * `engine/exploration/screen-graph-engine.ts` `computeStructuralIdentity`
     * does: the canonical `[role, native_type, stable_id, children]` tuple per
     * node, recursed from the tree roots, then SHA-256 over the canonical form.
     * Node identifiers and geometry deliberately do not participate.
     */
    private fun structuralDigest(snapshot: RuntimeSnapshot): String {
        val builder = StringBuilder()
        for (tree in snapshot.trees) {
            val nodesById = tree.payload.inlineNodes.orEmpty().associateBy(UiNode::nodeId)
            fun sign(nodeId: NodeId) {
                val node = nodesById[nodeId]
                if (node == null) {
                    builder.append("null")
                    return
                }
                builder.append('[')
                    .append(quoted(node.role)).append(',')
                    .append(quoted(node.nativeType)).append(',')
                    .append(quoted(node.stableId?.value ?: "")).append(",[")
                node.childIds.forEachIndexed { index, childId ->
                    if (index > 0) {
                        builder.append(',')
                    }
                    sign(childId)
                }
                builder.append("]]")
            }
            builder.append('[').append(quoted(tree.kind.name)).append(",[")
            tree.rootNodeIds.forEachIndexed { index, rootId ->
                if (index > 0) {
                    builder.append(',')
                }
                sign(rootId)
            }
            builder.append("]]")
        }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(builder.toString().toByteArray(Charsets.UTF_8))
        return "sha256:" + digest.joinToString(separator = "") { "%02x".format(it.toInt() and BYTE_MASK) }
    }

    private fun quoted(value: String): String = "\"" + value.replace("\"", "\\\"") + "\""

    /** Jumps to an item on the composition's own scope, then lets it settle. */
    private fun scrollToItem(scope: CoroutineScope, state: LazyListState, index: Int) {
        runOnComposition(scope) { state.scrollToItem(index) }
    }

    /** Consumes a real scroll delta, the only thing that triggers prefetch. */
    private fun scrollBy(scope: CoroutineScope, state: LazyListState, pixels: Float) {
        runOnComposition(scope) { state.scroll { scrollBy(pixels) } }
    }

    private fun runOnComposition(scope: CoroutineScope, block: suspend () -> Unit) {
        val settled = CountDownLatch(1)
        scope.launch {
            block()
            settled.countDown()
        }
        assertTrue(settled.await(SCROLL_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        // Prefetch composes from the idle handler, so let it run ahead before
        // the next capture; that is precisely the phantom this test rules out.
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        SystemClock.sleep(PREFETCH_SETTLE_MS)
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun captureUntilComposeNodesAppear(
        scenario: ActivityScenario<ComponentActivity>,
    ): RuntimeSnapshot {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val adapter = AndroidViewRuntimeCaptureAdapter(
            configuration = AndroidViewRuntimeCaptureConfiguration(
                projectId = ProjectId("project_019f0000-0000-7000-8000-000000000001"),
                buildId = BuildId("build_019f0000-0000-7000-8000-000000000002"),
                sdkVersion = "0.1.0",
                adapterVersion = "0.1.0",
                applicationVersionOverride = "1.0.0",
            ),
            semanticsExtensions = listOf(ComposeSemanticsCaptureExtension()),
        )
        val deadline = SystemClock.uptimeMillis() + CAPTURE_TIMEOUT_MS
        var lastSnapshot: RuntimeSnapshot? = null
        while (SystemClock.uptimeMillis() < deadline) {
            instrumentation.waitForIdleSync()
            var snapshot: RuntimeSnapshot? = null
            scenario.onActivity { activity ->
                snapshot = runCatching {
                    adapter.capture(
                        rootView = activity.window.decorView,
                        includeScreenshot = false,
                    ).snapshot
                }.getOrNull()
            }
            lastSnapshot = snapshot ?: lastSnapshot
            val composed = snapshot?.trees?.single()?.payload?.inlineNodes.orEmpty()
                .any { it.extensions["android.capture.semantics_source"] != null && it.childIds.isNotEmpty() }
            if (composed) {
                return checkNotNull(snapshot)
            }
            SystemClock.sleep(CAPTURE_POLL_MS)
        }
        throw AssertionError(
            "Compose semantic nodes never appeared; last snapshot: " +
                (lastSnapshot?.trees?.single()?.payload?.inlineNodes?.size ?: 0) + " nodes",
        )
    }

    private companion object {
        const val TITLE_ID = "demo.compose.title"
        const val BUTTON_ID = "demo.compose.open"
        const val PLACED_ID = "demo.compose.placed"
        const val GHOST_ID = "demo.compose.ghost"
        const val PLACED_TEXT = "Placed"
        const val GHOST_TEXT = "Ghost"
        const val LAZY_ITEM_ID_PREFIX = "demo.compose.item."
        const val LAZY_ITEM_COUNT = 30
        const val LAZY_ITEM_HEIGHT_DP = 64.0
        const val BUTTON_WIDTH_DP = 120.0
        const val BUTTON_HEIGHT_DP = 48.0
        const val GEOMETRY_EPSILON = 0.001
        const val CAPTURE_TIMEOUT_MS = 10_000L
        const val CAPTURE_POLL_MS = 50L
        const val SCROLL_TIMEOUT_SECONDS = 10L
        const val PREFETCH_SETTLE_MS = 250L
        const val SCROLL_STEPS = 6
        const val SCROLL_STEP_PIXELS = 400f
        const val BYTE_MASK = 0xff
    }
}
