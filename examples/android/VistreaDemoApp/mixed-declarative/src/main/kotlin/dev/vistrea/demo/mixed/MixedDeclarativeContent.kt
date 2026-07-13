package dev.vistrea.demo.mixed

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.AndroidUiDispatcher
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import dev.vistrea.runtime.compose.VistreaSemanticRole
import dev.vistrea.runtime.compose.vistreaSemantics
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** The contracted stable node identifiers of `demo.mixed.declarative`. */
data class MixedDeclarativeNodeIds(
    val headerId: String,
    val featuredCardId: String,
    val actionId: String,
    val statusId: String,
)

/**
 * The `demo.mixed.declarative` scenario content, rendered by Jetpack Compose
 * inside the native shell. Every contracted stable node declares
 * [vistreaSemantics], so the Compose semantics capture extension maps its
 * test tag to the cross-platform `stable_id`. Tapping the action toggles
 * only the status text; the semantics structure never changes.
 */
object MixedDeclarativeContent {
    fun create(
        context: Context,
        nodeIds: MixedDeclarativeNodeIds,
        featuredTitle: String,
    ): View = ComposeHostView(context) {
        MixedDeclarativeScreen(nodeIds, featuredTitle)
    }
}

@Composable
private fun MixedDeclarativeScreen(
    nodeIds: MixedDeclarativeNodeIds,
    featuredTitle: String,
) {
    var toggled by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.White)
            .padding(SCREEN_PADDING_DP.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BasicText(
            text = "Declarative storefront",
            style = TextStyle(
                color = INK,
                fontSize = TITLE_FONT_SIZE_SP.sp,
                fontWeight = FontWeight.Bold,
            ),
            modifier = Modifier
                .padding(bottom = ELEMENT_SPACING_DP.dp)
                .vistreaSemantics(nodeIds.headerId, VistreaSemanticRole.TEXT),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = ELEMENT_SPACING_DP.dp)
                .background(SURFACE, RoundedCornerShape(CORNER_RADIUS_DP.dp))
                .vistreaSemantics(nodeIds.featuredCardId, VistreaSemanticRole.CONTAINER)
                .padding(CARD_PADDING_DP.dp),
        ) {
            BasicText(
                text = "Featured: $featuredTitle",
                style = TextStyle(color = INK, fontSize = BODY_FONT_SIZE_SP.sp),
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = ELEMENT_SPACING_DP.dp)
                .background(PRIMARY, RoundedCornerShape(CORNER_RADIUS_DP.dp))
                .clickable { toggled = !toggled }
                .vistreaSemantics(nodeIds.actionId, VistreaSemanticRole.BUTTON)
                .padding(CARD_PADDING_DP.dp),
            contentAlignment = Alignment.Center,
        ) {
            BasicText(
                text = "Toggle status",
                style = TextStyle(color = Color.White, fontSize = BODY_FONT_SIZE_SP.sp),
            )
        }
        BasicText(
            text = if (toggled) "Status: engaged" else "Status: ready",
            style = TextStyle(color = MUTED, fontSize = BODY_FONT_SIZE_SP.sp),
            modifier = Modifier.vistreaSemantics(nodeIds.statusId, VistreaSemanticRole.TEXT),
        )
    }
}

/**
 * Hosts a [ComposeView] under a plain framework Activity by providing the
 * view-tree Lifecycle and SavedStateRegistry owners Compose requires, plus a
 * self-managed [Recomposer] scoped to this View's attachment, so the demo
 * shell does not need an AndroidX ComponentActivity.
 */
private class ComposeHostView(
    context: Context,
    content: @Composable () -> Unit,
) : FrameLayout(context), LifecycleOwner, SavedStateRegistryOwner {
    private val lifecycleRegistry = LifecycleRegistry(this)
    private val savedStateRegistryController = SavedStateRegistryController.create(this)
    private val recomposer = Recomposer(AndroidUiDispatcher.CurrentThread)
    private val recomposerScope = CoroutineScope(AndroidUiDispatcher.CurrentThread)

    override val lifecycle: Lifecycle
        get() = lifecycleRegistry

    override val savedStateRegistry: SavedStateRegistry
        get() = savedStateRegistryController.savedStateRegistry

    init {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        savedStateRegistryController.performAttach()
        savedStateRegistryController.performRestore(null)
        setViewTreeLifecycleOwner(this)
        setViewTreeSavedStateRegistryOwner(this)
        addView(
            ComposeView(context).apply {
                setParentCompositionContext(recomposer)
                setContent(content)
            },
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        recomposerScope.launch { recomposer.runRecomposeAndApplyChanges() }
        lifecycleRegistry.currentState = Lifecycle.State.RESUMED
    }

    override fun onDetachedFromWindow() {
        // Children detach (and dispose their composition) before the host,
        // so the lifecycle and recomposer shut down last.
        lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        recomposer.cancel()
        recomposerScope.cancel()
        super.onDetachedFromWindow()
    }
}

private val INK = Color(0xFF182033)
private val MUTED = Color(0xFF5F687A)
private val PRIMARY = Color(0xFF3157D5)
private val SURFACE = Color(0xFFF3F5FA)
private const val SCREEN_PADDING_DP = 24
private const val CARD_PADDING_DP = 16
private const val CORNER_RADIUS_DP = 12
private const val ELEMENT_SPACING_DP = 16
private const val TITLE_FONT_SIZE_SP = 26
private const val BODY_FONT_SIZE_SP = 16
