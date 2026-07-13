package dev.vistrea.runtime.compose

import android.view.View
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.UiNode
import dev.vistrea.runtime.android.CapturedSemanticSubtree
import dev.vistrea.runtime.android.ViewSemanticsCaptureContext
import dev.vistrea.runtime.android.ViewSemanticsCaptureExtension

/**
 * Captures the Jetpack Compose semantics tree behind an `AndroidComposeView`.
 *
 * Compose renders a whole composition inside one Android View, so the plain
 * View walker sees only that container. This extension recognizes the
 * container through the public [RootForTest] interface — which the platform
 * `AndroidComposeView` implements in every build variant, so no reflection or
 * test-only hook is involved — and reads its `SemanticsOwner`'s unmerged
 * semantics tree.
 *
 * Every placed unmerged semantics node maps to one canonical `UiNode`:
 * `testTag` becomes `stable_id`, the declared `VistreaRole` fact (falling back
 * to the Compose `Role` and structural facts) becomes `role`, text and content
 * description fill the shared content fields, and semantics actions become
 * observation-level node actions. Geometry converts from pixels to logical
 * points with the same density and frame origin the View walker uses, so a
 * Compose node's frame matches what an equally placed View would report.
 *
 * Only placed nodes are captured. `SemanticsNode.children` filters detached
 * and deactivated nodes but not unplaced ones, which is why Compose's own
 * accessibility bridge applies an `isPlaced` filter of its own. A node that
 * was never placed reports `Offset.Zero` for `positionInRoot`, so capturing it
 * would emit a phantom node stacked on the Compose root's top-left corner that
 * automation could target; worse, `LazyColumn` and `LazyRow` prefetch composes
 * items ahead of the viewport, so the same screen would otherwise capture a
 * different node set depending on scroll velocity and frame timing, and the
 * differing structural digest would split one Screen State into several across
 * runs. The filter keeps the captured node set — and therefore the structural
 * digest — a function of what the layout actually placed.
 *
 * The capture observes only: it never invokes semantics actions or
 * application business methods. Note the result is the semantics tree, not
 * the layout-node tree — composables without any semantics do not produce
 * nodes, and the semantics tree carries no rendering facts at all, which the
 * host node declares once as an `android.capture.compose-visual-unavailable`
 * Capture Limitation.
 */
class ComposeSemanticsCaptureExtension : ViewSemanticsCaptureExtension {
    override val semanticsSource: String = "compose"

    override fun captureSemanticChildren(
        view: View,
        context: ViewSemanticsCaptureContext,
    ): CapturedSemanticSubtree? {
        val owner = (view as? RootForTest)?.semanticsOwner ?: return null
        val environment = ComposeCaptureEnvironment(
            treeId = context.treeId,
            hostFrameOriginX = context.hostFrameOriginX,
            hostFrameOriginY = context.hostFrameOriginY,
            density = context.density,
            hostVisible = view.isShown && view.alpha > 0,
        )
        val nodes = mutableListOf<UiNode>()
        // The unmerged root node describes the composition root itself and is
        // already represented by the host View's own node; its children become
        // the host node's direct children.
        val directChildIds = appendChildren(
            children = owner.unmergedRootSemanticsNode.placedChildren(),
            parentId = context.hostNodeId,
            parentPath = context.hostPath,
            context = context,
            environment = environment,
            output = nodes,
        )
        return CapturedSemanticSubtree(
            directChildIds = directChildIds,
            nodes = nodes,
            hostLimitations = listOf(
                composeVisualUnavailableLimitation(
                    treeId = context.treeId,
                    hostNodeId = context.hostNodeId,
                ),
            ),
        )
    }

    /**
     * The semantic children the layout actually placed.
     *
     * `children` keeps measured-but-unplaced nodes — most visibly the items a
     * lazy list prefetches ahead of the viewport — and those carry no real
     * position, so they must never become captured nodes. `LayoutInfo.isPlaced`
     * is the public form of the check Compose's accessibility bridge makes.
     */
    private fun SemanticsNode.placedChildren(): List<SemanticsNode> =
        children.filter { it.layoutInfo.isPlaced }

    private fun appendChildren(
        children: List<SemanticsNode>,
        parentId: NodeId,
        parentPath: String,
        context: ViewSemanticsCaptureContext,
        environment: ComposeCaptureEnvironment,
        output: MutableList<UiNode>,
    ): List<NodeId> = children.mapIndexed { index, child ->
        appendSubtree(child, "$parentPath.$index", parentId, context, environment, output)
    }

    private fun appendSubtree(
        node: SemanticsNode,
        path: String,
        parentId: NodeId,
        context: ViewSemanticsCaptureContext,
        environment: ComposeCaptureEnvironment,
        output: MutableList<UiNode>,
    ): NodeId {
        val config = node.config
        val nodeId = context.nodeIdFactory.nodeId(
            config.getOrNull(SemanticsProperties.TestTag),
            path,
        )
        val children = node.placedChildren()
        val childIds = children.mapIndexed { index, child ->
            context.nodeIdFactory.nodeId(
                child.config.getOrNull(SemanticsProperties.TestTag),
                "$path.$index",
            )
        }
        output += mapComposeSemanticsNode(
            config = config,
            geometry = ComposeNodeGeometry(
                positionInRootPx = node.positionInRoot,
                sizePx = node.size,
                clippedBoundsInRootPx = node.boundsInRoot,
            ),
            identity = ComposeNodeIdentity(
                nodeId = nodeId,
                parentId = parentId,
                childIds = childIds,
                semanticsNodeId = node.id,
            ),
            environment = environment,
        )
        children.forEachIndexed { index, child ->
            appendSubtree(child, "$path.$index", nodeId, context, environment, output)
        }
        return nodeId
    }
}
