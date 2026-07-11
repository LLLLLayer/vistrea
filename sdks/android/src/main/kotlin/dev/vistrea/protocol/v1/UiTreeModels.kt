package dev.vistrea.protocol.v1

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class RedactedContentField {
    @SerialName("text")
    TEXT,

    @SerialName("value")
    VALUE,

    @SerialName("placeholder")
    PLACEHOLDER,

    @SerialName("content_description")
    CONTENT_DESCRIPTION,
}

@Serializable
data class TextContent(
    val text: String? = null,
    val value: String? = null,
    val placeholder: String? = null,
    @SerialName("content_description")
    val contentDescription: String? = null,
    @SerialName("redacted_fields")
    val redactedFields: List<RedactedContentField>? = null,
) {
    init {
        require(redactedFields == null || redactedFields.distinct().size == redactedFields.size) {
            "Redacted content fields must be unique"
        }
    }
}

@Serializable
data class NodeState(
    val visible: Boolean? = null,
    val enabled: Boolean? = null,
    val selected: Boolean? = null,
    val focused: Boolean? = null,
    val checked: Boolean? = null,
    val expanded: Boolean? = null,
)

@Serializable
enum class ColorSpace {
    @SerialName("srgb")
    SRGB,

    @SerialName("display_p3")
    DISPLAY_P3,

    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
data class Color(
    val red: Double,
    val green: Double,
    val blue: Double,
    val alpha: Double,
    @SerialName("color_space")
    val colorSpace: ColorSpace,
) {
    init {
        val components = listOf(red, green, blue, alpha)
        require(components.all { it.isFinite() && it in 0.0..1.0 }) {
            "Color components must be finite and between zero and one"
        }
    }
}

@Serializable
data class Font(
    val family: String,
    @SerialName("postscript_name")
    val postscriptName: String? = null,
    val size: Double,
    val weight: Double,
) {
    init {
        require(size.isFinite() && size > 0) { "Font size must be positive" }
        require(weight.isFinite() && weight in -1.0..1.0) {
            "Font weight must be between negative one and one"
        }
    }
}

@Serializable
data class VisualProperties(
    val alpha: Double? = null,
    @SerialName("foreground_color")
    val foregroundColor: Color? = null,
    @SerialName("background_color")
    val backgroundColor: Color? = null,
    val font: Font? = null,
    @SerialName("corner_radius")
    val cornerRadius: Double? = null,
    @SerialName("border_width")
    val borderWidth: Double? = null,
    @SerialName("border_color")
    val borderColor: Color? = null,
) {
    init {
        require(alpha == null || (alpha.isFinite() && alpha in 0.0..1.0)) {
            "Visual alpha must be between zero and one"
        }
        require(cornerRadius == null || (cornerRadius.isFinite() && cornerRadius >= 0)) {
            "Corner radius must be non-negative"
        }
        require(borderWidth == null || (borderWidth.isFinite() && borderWidth >= 0)) {
            "Border width must be non-negative"
        }
    }
}

@Serializable
data class AccessibilityProperties(
    val label: String? = null,
    val value: String? = null,
    val role: String? = null,
    val hidden: Boolean? = null,
    @SerialName("focus_order")
    val focusOrder: JsonSafeUInt? = null,
)

@Serializable
enum class RelatedNodeRelation {
    @SerialName("semantic_for")
    SEMANTIC_FOR,

    @SerialName("view_for")
    VIEW_FOR,

    @SerialName("layer_for")
    LAYER_FOR,

    @SerialName("source_for")
    SOURCE_FOR,
}

@Serializable
data class RelatedNodeRef(
    @SerialName("tree_id")
    val treeId: TreeId,
    @SerialName("node_id")
    val nodeId: NodeId,
    val relation: RelatedNodeRelation,
)

@Serializable
data class SourceContext(
    val route: String? = null,
    val controller: String? = null,
    val module: String? = null,
    val component: String? = null,
)

@Serializable
enum class NodeAction {
    @SerialName("tap")
    TAP,

    @SerialName("long_press")
    LONG_PRESS,

    @SerialName("type_text")
    TYPE_TEXT,

    @SerialName("clear_text")
    CLEAR_TEXT,

    @SerialName("swipe")
    SWIPE,

    @SerialName("scroll")
    SCROLL,
}

@Serializable
data class UiNode(
    @SerialName("node_id")
    val nodeId: NodeId,
    @SerialName("stable_id")
    val stableId: StableId? = null,
    @SerialName("parent_id")
    val parentId: NodeId? = null,
    @SerialName("child_ids")
    val childIds: List<NodeId>,
    @SerialName("native_type")
    val nativeType: String,
    val role: String,
    val frame: Rect? = null,
    @SerialName("visible_rect")
    val visibleRect: Rect? = null,
    @SerialName("hit_rect")
    val hitRect: Rect? = null,
    val bounds: Rect? = null,
    @SerialName("z_index")
    val zIndex: Double? = null,
    val clipped: Boolean? = null,
    val content: TextContent,
    val state: NodeState,
    val actions: List<NodeAction>,
    val visual: VisualProperties? = null,
    val accessibility: AccessibilityProperties? = null,
    @SerialName("source_context")
    val sourceContext: SourceContext? = null,
    @SerialName("related_nodes")
    val relatedNodes: List<RelatedNodeRef>,
    @SerialName("capture_limitations")
    val captureLimitations: List<CaptureLimitation>,
    val extensions: Extensions,
) {
    init {
        require(childIds.distinct().size == childIds.size) { "Child node IDs must be unique" }
        require(actions.distinct().size == actions.size) { "Node actions must be unique" }
        require(zIndex == null || zIndex.isFinite()) { "Z index must be finite" }
    }
}

@Serializable
enum class UiTreeKind {
    @SerialName("semantic")
    SEMANTIC,

    @SerialName("view")
    VIEW,

    @SerialName("layer")
    LAYER,
}

@Serializable
enum class UiNodePayloadEncoding {
    @SerialName("vistrea.ui-nodes+json")
    VISTREA_UI_NODES_JSON,
}

@Serializable
data class UiTreePayload(
    @SerialName("inline_nodes")
    val inlineNodes: List<UiNode>? = null,
    @SerialName("nodes_object")
    val nodesObject: ObjectRef? = null,
    @SerialName("node_count")
    val nodeCount: JsonSafePositiveInteger? = null,
    val encoding: UiNodePayloadEncoding? = null,
) {
    init {
        if (inlineNodes != null) {
            require(inlineNodes.isNotEmpty()) { "An inline tree payload cannot be empty" }
            require(nodesObject == null && nodeCount == null && encoding == null) {
                "A tree payload must select exactly one representation"
            }
        } else {
            require(nodesObject != null && nodeCount != null && encoding != null) {
                "An object-backed tree payload requires object, count, and encoding"
            }
        }
    }
}

@Serializable
data class UiTree(
    @SerialName("tree_id")
    val treeId: TreeId,
    val kind: UiTreeKind,
    @SerialName("root_node_ids")
    val rootNodeIds: List<NodeId>,
    val payload: UiTreePayload,
    @SerialName("capture_limitations")
    val captureLimitations: List<CaptureLimitation>,
    val extensions: Extensions,
) {
    init {
        require(rootNodeIds.isNotEmpty()) { "A UI tree requires at least one root node" }
        require(rootNodeIds.distinct().size == rootNodeIds.size) { "Root node IDs must be unique" }
    }
}
