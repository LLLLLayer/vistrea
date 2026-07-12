@file:Suppress("DEPRECATION")

package dev.vistrea.runtime.android

import android.test.InstrumentationTestCase
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import dev.vistrea.protocol.v1.BuildId
import dev.vistrea.protocol.v1.Extensions
import dev.vistrea.protocol.v1.NodeState
import dev.vistrea.protocol.v1.ProjectId
import dev.vistrea.protocol.v1.Rect
import dev.vistrea.protocol.v1.RuntimeSnapshotJson
import dev.vistrea.protocol.v1.StableId
import dev.vistrea.protocol.v1.TextContent
import dev.vistrea.protocol.v1.UiNode

/** Recognizes the tagged container and replaces its subtree with two nodes. */
private class FixtureSemanticsExtension : ViewSemanticsCaptureExtension {
    override val semanticsSource: String = "fixture"

    override fun captureSemanticChildren(
        view: View,
        context: ViewSemanticsCaptureContext,
    ): CapturedSemanticSubtree? {
        if (view.tag != HOST_TAG) {
            return null
        }
        val parentPath = context.hostPath
        val childId = context.nodeIdFactory.nodeId("fixture.child", "$parentPath.0")
        val grandchildId = context.nodeIdFactory.nodeId(null, "$parentPath.0.0")
        val child = UiNode(
            nodeId = childId,
            stableId = StableId("fixture.child"),
            parentId = context.hostNodeId,
            childIds = listOf(grandchildId),
            nativeType = "fixture.semantic",
            role = "container",
            frame = Rect(
                context.hostFrameOriginX,
                context.hostFrameOriginY,
                view.width / context.density,
                view.height / context.density,
            ),
            content = TextContent(),
            state = NodeState(visible = true),
            actions = emptyList(),
            relatedNodes = emptyList(),
            captureLimitations = emptyList(),
            extensions = Extensions.empty(),
        )
        val grandchild = child.copy(
            nodeId = grandchildId,
            stableId = null,
            parentId = childId,
            childIds = emptyList(),
            role = "text",
        )
        return CapturedSemanticSubtree(
            directChildIds = listOf(childId),
            nodes = listOf(child, grandchild),
        )
    }

    companion object {
        const val HOST_TAG = "fixture.semantics.host"
    }
}

class ViewSemanticsCaptureExtensionInstrumentedTest : InstrumentationTestCase() {
    fun testExtensionReplacesSubtreeAndRecordsProvenance() {
        lateinit var captured: AndroidViewRuntimeCaptureResult
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext
            val root = FrameLayout(context).apply { tag = "fixture.root" }
            val semanticHost = FrameLayout(context).apply {
                tag = FixtureSemanticsExtension.HOST_TAG
            }
            // A real child View that must NOT be walked once the extension
            // replaces the subtree.
            semanticHost.addView(
                Button(context).apply { tag = "fixture.hidden.button" },
                FrameLayout.LayoutParams(MATCH_PARENT, CONTROL_HEIGHT_PX),
            )
            root.addView(
                semanticHost,
                FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT),
            )
            root.measure(
                View.MeasureSpec.makeMeasureSpec(ROOT_WIDTH_PX, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(ROOT_HEIGHT_PX, View.MeasureSpec.EXACTLY),
            )
            root.layout(0, 0, ROOT_WIDTH_PX, ROOT_HEIGHT_PX)
            captured = AndroidViewRuntimeCaptureAdapter(
                configuration = configuration(),
                semanticsExtensions = listOf(FixtureSemanticsExtension()),
            ).capture(root, includeScreenshot = false)
        }

        val nodes = requireNotNull(captured.snapshot.trees.single().payload.inlineNodes)
        // Root, semantic host, fixture child, fixture grandchild; the real
        // Button below the host must be absent.
        assertEquals(4, nodes.size)
        assertTrue(nodes.none { it.stableId?.value == "fixture.hidden.button" })

        val host = nodes.single { it.stableId?.value == FixtureSemanticsExtension.HOST_TAG }
        assertEquals(
            "\"fixture\"",
            host.extensions["android.capture.semantics_source"].toString(),
        )
        assertEquals(
            "android.capture.interop-view-children-skipped",
            host.captureLimitations.single().code,
        )

        val child = nodes.single { it.stableId?.value == "fixture.child" }
        assertEquals(listOf(child.nodeId), host.childIds)
        assertEquals(host.nodeId, child.parentId)
        val grandchild = nodes.single { it.role == "text" }
        assertEquals(listOf(grandchild.nodeId), child.childIds)
        assertEquals(child.nodeId, grandchild.parentId)

        // The whole Snapshot still round-trips the canonical JSON surface.
        assertEquals(
            captured.snapshot,
            RuntimeSnapshotJson.decode(RuntimeSnapshotJson.encode(captured.snapshot)),
        )
    }

    fun testSemanticNodesCountTowardTheNodeLimit() {
        var failure: Throwable? = null
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext
            val root = FrameLayout(context).apply {
                tag = FixtureSemanticsExtension.HOST_TAG
            }
            root.measure(
                View.MeasureSpec.makeMeasureSpec(ROOT_WIDTH_PX, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(ROOT_HEIGHT_PX, View.MeasureSpec.EXACTLY),
            )
            root.layout(0, 0, ROOT_WIDTH_PX, ROOT_HEIGHT_PX)
            failure = runCatching {
                AndroidViewRuntimeCaptureAdapter(
                    configuration = configuration(maximumNodeCount = 2),
                    semanticsExtensions = listOf(FixtureSemanticsExtension()),
                ).capture(root, includeScreenshot = false)
            }.exceptionOrNull()
        }
        assertTrue(failure is AndroidRuntimeCaptureException)
        assertEquals(
            AndroidRuntimeCaptureFailure.NODE_LIMIT_EXCEEDED,
            (failure as AndroidRuntimeCaptureException).failure,
        )
    }

    private fun configuration(maximumNodeCount: Int = 100) =
        AndroidViewRuntimeCaptureConfiguration(
            projectId = ProjectId("project_019f0000-0000-7000-8000-000000000001"),
            buildId = BuildId("build_019f0000-0000-7000-8000-000000000002"),
            sdkVersion = "0.1.0",
            adapterVersion = "0.1.0",
            applicationVersionOverride = "1.0.0",
            maximumNodeCount = maximumNodeCount,
        )

    private companion object {
        const val ROOT_WIDTH_PX = 360
        const val ROOT_HEIGHT_PX = 640
        const val CONTROL_HEIGHT_PX = 96
        const val MATCH_PARENT = -1
    }
}
