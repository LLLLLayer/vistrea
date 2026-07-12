package dev.vistrea.runtime.compose

import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics

/**
 * The cross-platform semantic role a composable declares for capture.
 *
 * Wire names match the canonical `UiNode.role` vocabulary so annotated
 * Compose content classifies identically to native View and UIKit nodes.
 */
enum class VistreaSemanticRole(val wireName: String) {
    BUTTON("button"),
    TEXT("text"),
    IMAGE("image"),
    HEADER("header"),
    LINK("link"),
    TEXT_FIELD("text-field"),
    LIST_ITEM("list-item"),
    CONTAINER("container"),
}

/**
 * Declares Vistrea capture semantics on a composable.
 *
 * Compose renders inside one `AndroidComposeView`, so the annotation travels
 * as standard semantics facts: the stable identifier becomes the test tag
 * (exposed as the resource identifier when the application enables
 * `testTagsAsResourceId`, which UIAutomator and the future Compose semantics
 * capture adapter read as the cross-platform `stable_id`), the role becomes
 * the semantics role, and the optional label becomes the content description.
 * The modifier never invokes business logic.
 */
fun Modifier.vistreaSemantics(
    stableId: String,
    role: VistreaSemanticRole,
    label: String? = null,
): Modifier = testTag(stableId).semantics {
    if (label != null) {
        contentDescription = label
    }
    when (role) {
        VistreaSemanticRole.BUTTON -> this.role = Role.Button
        VistreaSemanticRole.IMAGE -> this.role = Role.Image
        VistreaSemanticRole.HEADER -> heading()
        VistreaSemanticRole.LINK,
        VistreaSemanticRole.TEXT,
        VistreaSemanticRole.TEXT_FIELD,
        VistreaSemanticRole.LIST_ITEM,
        VistreaSemanticRole.CONTAINER,
        -> Unit
    }
}
