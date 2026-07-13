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
        const val BUTTON_WIDTH_DP = 120.0
        const val BUTTON_HEIGHT_DP = 48.0
        const val GEOMETRY_EPSILON = 0.001
        const val CAPTURE_TIMEOUT_MS = 10_000L
        const val CAPTURE_POLL_MS = 50L
    }
}
