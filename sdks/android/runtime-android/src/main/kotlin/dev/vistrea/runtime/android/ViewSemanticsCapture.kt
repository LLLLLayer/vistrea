package dev.vistrea.runtime.android

import android.view.View
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.UiNode

/**
 * Creates node identifiers that follow the exact deterministic scheme of the
 * View walker, so semantic nodes and View nodes share one identity space.
 */
fun interface ViewSemanticsNodeIdFactory {
    /**
     * Returns the deterministic node identifier for one captured node.
     *
     * [stableSeed] is the node's stable identifier when one exists; when it is
     * null the [path] seeds the identifier, exactly as for View nodes. [path]
     * is the dot-separated traversal path and must extend the host path from
     * [ViewSemanticsCaptureContext.hostPath].
     */
    fun nodeId(stableSeed: String?, path: String): NodeId
}

/** Everything a semantics capture extension needs from the View walker. */
class ViewSemanticsCaptureContext(
    /** The identifier the walker assigned to the host View's own node. */
    val hostNodeId: NodeId,
    /** The host View's traversal path; semantic child paths must extend it. */
    val hostPath: String,
    /**
     * The host View frame origin in logical points, produced by the walker's
     * own frame math so semantic frames stay consistent with View frames.
     */
    val hostFrameOriginX: Double,
    val hostFrameOriginY: Double,
    /** The display density used for every pixel-to-logical-point conversion. */
    val density: Double,
    val nodeIdFactory: ViewSemanticsNodeIdFactory,
) {
    init {
        require(density > 0) { "The capture density must be positive." }
    }
}

/**
 * A captured semantic subtree that replaces the host View's child subtree.
 *
 * [directChildIds] identifies the host node's immediate semantic children in
 * order; [nodes] carries the whole flattened subtree in pre-order, with
 * parent and child identifiers already linked.
 */
class CapturedSemanticSubtree(
    val directChildIds: List<NodeId>,
    val nodes: List<UiNode>,
) {
    init {
        val nodeIds = nodes.map(UiNode::nodeId)
        require(nodeIds.distinct().size == nodeIds.size) {
            "Captured semantic node identifiers must be unique."
        }
        require(directChildIds.distinct().size == directChildIds.size) {
            "Direct semantic child identifiers must be unique."
        }
        require(directChildIds.all(nodeIds.toSet()::contains)) {
            "Every direct semantic child must be one of the captured nodes."
        }
    }
}

/**
 * Replaces one View's child subtree with capture-time semantic nodes.
 *
 * The View walker consults registered extensions for every View before
 * recursing into its children. The first extension returning a non-null
 * subtree wins: its nodes become the View node's children, the View subtree
 * below that node is not walked, and the walker records the extension's
 * [semanticsSource] on the host node as the
 * `android.capture.semantics_source` extension value.
 *
 * Extensions observe only; they must never invoke application business
 * methods. Registration is explicit through the
 * [AndroidViewRuntimeCaptureAdapter] constructor.
 */
interface ViewSemanticsCaptureExtension {
    /** A short provenance name such as `compose`, recorded on the host node. */
    val semanticsSource: String

    /**
     * Returns the semantic subtree for [view], or null when this extension
     * does not apply to that view.
     */
    fun captureSemanticChildren(
        view: View,
        context: ViewSemanticsCaptureContext,
    ): CapturedSemanticSubtree?
}
