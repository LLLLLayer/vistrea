package dev.vistrea.runtime.compose

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect as ComposeRect
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.IntSize
import dev.vistrea.protocol.v1.AccessibilityProperties
import dev.vistrea.protocol.v1.CaptureLimitation
import dev.vistrea.protocol.v1.CaptureLimitationScope
import dev.vistrea.protocol.v1.CaptureLimitationSeverity
import dev.vistrea.protocol.v1.Extensions
import dev.vistrea.protocol.v1.NodeAction
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.NodeState
import dev.vistrea.protocol.v1.RedactedContentField
import dev.vistrea.protocol.v1.Rect
import dev.vistrea.protocol.v1.StableId
import dev.vistrea.protocol.v1.TextContent
import dev.vistrea.protocol.v1.TreeId
import dev.vistrea.protocol.v1.UiNode
import dev.vistrea.runtime.android.CaptureContentLimits
import kotlinx.serialization.json.JsonPrimitive

/** The `native_type` recorded for every captured Compose semantics node. */
internal const val COMPOSE_SEMANTICS_NATIVE_TYPE = "androidx.compose.ui.semantics.SemanticsNode"

/**
 * Recorded once on the Compose host node: the semantics tree exposes no
 * rendering facts, so the whole Compose subtree carries no `visual`, no
 * `z_index`, and no `source_context`.
 */
internal const val COMPOSE_VISUAL_UNAVAILABLE_CODE = "android.capture.compose-visual-unavailable"

/** Pixel-space geometry of one Compose semantics node, host-relative. */
internal data class ComposeNodeGeometry(
    /** The unclipped node origin in root (host View) pixel coordinates. */
    val positionInRootPx: Offset,
    /** The unclipped node size in pixels. */
    val sizePx: IntSize,
    /** The ancestor-clipped bounds in root (host View) pixel coordinates. */
    val clippedBoundsInRootPx: ComposeRect,
)

/** Identity already resolved by the traversal for one semantics node. */
internal data class ComposeNodeIdentity(
    val nodeId: NodeId,
    val parentId: NodeId,
    val childIds: List<NodeId>,
    val semanticsNodeId: Int,
)

/** Capture environment shared by every node of one host View subtree. */
internal data class ComposeCaptureEnvironment(
    /** The tree the captured nodes belong to; scopes Capture Limitations. */
    val treeId: TreeId,
    /** Host View frame origin in logical points, from the walker's frame math. */
    val hostFrameOriginX: Double,
    val hostFrameOriginY: Double,
    /** The display density used for pixel-to-logical-point conversion. */
    val density: Double,
    /** Whether the host View itself is shown with a non-zero alpha. */
    val hostVisible: Boolean,
)

/**
 * States plainly that the Compose semantics tree carries no rendering facts.
 *
 * `SemanticsNode` exposes identity, structure, text, state, and geometry, but
 * no colors, fonts, alpha, drawing order, or composable source identity, and
 * the only route to text layout is invoking a semantics action, which an
 * observation-only capture must never do. Rather than inventing values, the
 * host node declares the gap so design review, pixel comparison, and tuning
 * read the absence as unavailable, not as defaults.
 */
internal fun composeVisualUnavailableLimitation(
    treeId: TreeId,
    hostNodeId: NodeId,
): CaptureLimitation = CaptureLimitation(
    code = COMPOSE_VISUAL_UNAVAILABLE_CODE,
    severity = CaptureLimitationSeverity.WARNING,
    message = "The Compose semantics tree exposes no rendering facts, so nodes below this " +
        "host carry no visual properties, no z_index, and no source_context.",
    scope = CaptureLimitationScope(treeId = treeId, nodeId = hostNodeId, field = "visual"),
    retryable = false,
    extensions = Extensions.empty(),
)

/**
 * Maps one unmerged Compose semantics configuration plus geometry into the
 * canonical `UiNode` shape. Pure logic: no Android framework or live
 * composition types, so plain JVM unit tests cover it directly.
 */
internal fun mapComposeSemanticsNode(
    config: SemanticsConfiguration,
    geometry: ComposeNodeGeometry,
    identity: ComposeNodeIdentity,
    environment: ComposeCaptureEnvironment,
): UiNode {
    val density = environment.density
    val frame = Rect(
        x = environment.hostFrameOriginX + geometry.positionInRootPx.x / density,
        y = environment.hostFrameOriginY + geometry.positionInRootPx.y / density,
        width = geometry.sizePx.width / density,
        height = geometry.sizePx.height / density,
    )
    val clipped = geometry.clippedBoundsInRootPx
    val visibleRect = if (clipped.width > 0 && clipped.height > 0) {
        Rect(
            x = environment.hostFrameOriginX + clipped.left / density,
            y = environment.hostFrameOriginY + clipped.top / density,
            width = clipped.width / density,
            height = clipped.height / density,
        )
    } else {
        null
    }
    val role = composeSemanticsRole(config)
    val actions = composeSemanticsActions(config)
    val invisibleToUser = config.contains(SemanticsProperties.InvisibleToUser)

    // Every observed string is bounded against the canonical field limits and
    // every loss is recorded, so one over-long Compose text node degrades to a
    // flagged value instead of failing the whole Snapshot at Host validation.
    val limitations = mutableListOf<CaptureLimitation>()
    fun bounded(
        value: String?,
        field: String,
        limit: Int = CaptureContentLimits.TEXT_CODE_POINT_LIMIT,
    ): String? {
        val result = CaptureContentLimits.bounded(
            value = value,
            limit = limit,
            field = field,
            treeId = environment.treeId,
            nodeId = identity.nodeId,
        )
        result.limitation?.let(limitations::add)
        return result.value
    }

    val observed = composeSemanticsContent(config)
    val content = TextContent(
        text = bounded(observed.text, "content.text"),
        value = bounded(observed.value, "content.value"),
        placeholder = bounded(
            observed.placeholder,
            "content.placeholder",
            CaptureContentLimits.PLACEHOLDER_CODE_POINT_LIMIT,
        ),
        contentDescription = bounded(observed.contentDescription, "content.content_description"),
        redactedFields = observed.redactedFields,
    )
    val stableId = config.getOrNull(SemanticsProperties.TestTag)?.let { tag ->
        val parsed = runCatching { StableId(tag) }.getOrNull()
        if (parsed == null) {
            // A present but nonconforming testTag must not silently erase
            // stable identity; report why it vanished.
            limitations += CaptureContentLimits.invalidStableIdentifier(
                treeId = environment.treeId,
                nodeId = identity.nodeId,
            )
        }
        parsed
    }

    return UiNode(
        nodeId = identity.nodeId,
        stableId = stableId,
        parentId = identity.parentId,
        childIds = identity.childIds,
        nativeType = COMPOSE_SEMANTICS_NATIVE_TYPE,
        role = role,
        frame = frame,
        visibleRect = visibleRect,
        hitRect = if (actions.contains(NodeAction.TAP) || actions.contains(NodeAction.LONG_PRESS)) {
            frame
        } else {
            null
        },
        bounds = Rect(0.0, 0.0, geometry.sizePx.width / density, geometry.sizePx.height / density),
        clipped = visibleRect?.let { it != frame },
        content = content,
        state = NodeState(
            visible = environment.hostVisible && visibleRect != null && !invisibleToUser,
            enabled = !config.contains(SemanticsProperties.Disabled),
            selected = config.getOrNull(SemanticsProperties.Selected),
            focused = config.getOrNull(SemanticsProperties.Focused),
            checked = when (config.getOrNull(SemanticsProperties.ToggleableState)) {
                ToggleableState.On -> true
                ToggleableState.Off -> false
                else -> null
            },
        ),
        actions = actions,
        // The semantics tree exposes no colors, fonts, alpha, drawing order,
        // or composable source identity, so `visual`, `z_index`, and
        // `source_context` stay absent instead of being invented; the host
        // node declares that gap once, as a Capture Limitation.
        accessibility = AccessibilityProperties(
            label = bounded(observed.contentDescription, "accessibility.label"),
            value = if (config.contains(SemanticsProperties.Password)) {
                null
            } else {
                bounded(observed.value, "accessibility.value")
            },
            role = role,
            hidden = invisibleToUser,
        ),
        relatedNodes = emptyList(),
        captureLimitations = limitations.toList(),
        extensions = Extensions.of(
            mapOf(
                "android.compose.semantics_node_id" to JsonPrimitive(identity.semanticsNodeId),
            ),
        ),
    )
}

/**
 * Resolves the canonical role: the explicit `VistreaRole` semantics fact
 * first, then the closest Compose `Role`, then structural fallbacks, then
 * `container`.
 */
internal fun composeSemanticsRole(config: SemanticsConfiguration): String {
    config.getOrNull(VistreaRoleSemanticsKey)?.takeIf(String::isNotEmpty)?.let { return it }
    when (config.getOrNull(SemanticsProperties.Role)) {
        Role.Button -> return VistreaSemanticRole.BUTTON.wireName
        Role.Image -> return VistreaSemanticRole.IMAGE.wireName
        // Toggleable controls are actionable tap targets; their toggle state
        // travels separately in NodeState.checked / NodeState.selected.
        Role.Checkbox, Role.Switch, Role.RadioButton, Role.Tab, Role.DropdownList ->
            return VistreaSemanticRole.BUTTON.wireName
        else -> Unit
    }
    if (config.contains(SemanticsProperties.Heading)) {
        return VistreaSemanticRole.HEADER.wireName
    }
    if (isTextField(config)) {
        return VistreaSemanticRole.TEXT_FIELD.wireName
    }
    if (config.contains(SemanticsProperties.Text)) {
        return VistreaSemanticRole.TEXT.wireName
    }
    return VistreaSemanticRole.CONTAINER.wireName
}

internal fun composeSemanticsActions(config: SemanticsConfiguration): List<NodeAction> {
    val actions = linkedSetOf<NodeAction>()
    if (isTextField(config)) {
        actions += NodeAction.TAP
        actions += NodeAction.TYPE_TEXT
        actions += NodeAction.CLEAR_TEXT
    }
    if (config.contains(SemanticsActions.ScrollBy)) {
        actions += NodeAction.SWIPE
        actions += NodeAction.SCROLL
    }
    if (config.contains(SemanticsActions.OnClick)) {
        actions += NodeAction.TAP
    }
    if (config.contains(SemanticsActions.OnLongClick)) {
        actions += NodeAction.LONG_PRESS
    }
    return actions.toList()
}

internal fun composeSemanticsContent(config: SemanticsConfiguration): TextContent {
    val description = config.getOrNull(SemanticsProperties.ContentDescription)
        ?.joinToString(separator = "\n")
        ?.takeIf(String::isNotEmpty)
    if (config.contains(SemanticsProperties.Password)) {
        return TextContent(
            contentDescription = description,
            redactedFields = listOf(RedactedContentField.TEXT, RedactedContentField.VALUE),
        )
    }
    val editableText = config.getOrNull(SemanticsProperties.EditableText)?.text
    if (isTextField(config)) {
        return TextContent(
            text = editableText,
            value = editableText,
            contentDescription = description,
        )
    }
    val text = config.getOrNull(SemanticsProperties.Text)
        ?.joinToString(separator = "\n") { it.text }
        ?.takeIf(String::isNotEmpty)
    return TextContent(text = text, contentDescription = description)
}

private fun isTextField(config: SemanticsConfiguration): Boolean =
    config.contains(SemanticsActions.SetText) ||
        config.contains(SemanticsProperties.EditableText)
