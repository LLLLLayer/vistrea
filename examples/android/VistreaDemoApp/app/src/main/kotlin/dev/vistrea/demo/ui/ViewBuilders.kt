package dev.vistrea.demo.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import dev.vistrea.demo.contract.ScenarioFixture
import dev.vistrea.demo.contract.StableNodeIdentity

internal object Palette {
    const val INK = 0xFF182033.toInt()
    const val MUTED = 0xFF5F687A.toInt()
    const val PRIMARY = 0xFF3157D5.toInt()
    const val SURFACE = 0xFFF3F5FA.toInt()
    const val ERROR = 0xFFC62828.toInt()
    const val SUCCESS = 0xFF1B7F48.toInt()
    const val BORDER = 0xFFB6BDCC.toInt()
    const val PANEL = 0xE6FFFFFF.toInt()
    const val CARD_BORDER = 0xFFD7DBE5.toInt()
    const val REGRESSION_TEXT = 0xFF777777.toInt()
}

internal object DemoMetrics {
    const val SCREEN_HORIZONTAL_PADDING_DP = 24
    const val SCREEN_TOP_PADDING_DP = 24
    const val SCREEN_BOTTOM_PADDING_DP = 32
    const val TITLE_TEXT_SIZE_SP = 26f
    const val TITLE_BOTTOM_PADDING_DP = 12
    const val BODY_TEXT_SIZE_SP = 16f
    const val BODY_BOTTOM_PADDING_DP = 16
    const val BUTTON_CORNER_RADIUS_DP = 12
    const val BUTTON_MINIMUM_HEIGHT_DP = 48
    const val CONTROL_VERTICAL_MARGIN_DP = 8
    const val TEXT_SIZE_SP = 17f
    const val TEXT_PADDING_DP = 16
    const val INPUT_CORNER_RADIUS_DP = 8
    const val INPUT_HORIZONTAL_PADDING_DP = 14
    const val INPUT_VERTICAL_PADDING_DP = 12
    const val BORDER_WIDTH_DP = 1
}

internal fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

internal fun Context.screenColumn(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    setPadding(
        dp(DemoMetrics.SCREEN_HORIZONTAL_PADDING_DP),
        dp(DemoMetrics.SCREEN_TOP_PADDING_DP),
        dp(DemoMetrics.SCREEN_HORIZONTAL_PADDING_DP),
        dp(DemoMetrics.SCREEN_BOTTOM_PADDING_DP),
    )
    layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    )
}

internal fun Context.title(text: String): TextView = TextView(this).apply {
    this.text = text
    textSize = DemoMetrics.TITLE_TEXT_SIZE_SP
    setTextColor(Palette.INK)
    setTypeface(typeface, Typeface.BOLD)
    gravity = Gravity.CENTER
    setPadding(0, 0, 0, dp(DemoMetrics.TITLE_BOTTOM_PADDING_DP))
}

internal fun Context.body(text: String): TextView = TextView(this).apply {
    this.text = text
    textSize = DemoMetrics.BODY_TEXT_SIZE_SP
    setTextColor(Palette.MUTED)
    gravity = Gravity.CENTER
    setPadding(0, 0, 0, dp(DemoMetrics.BODY_BOTTOM_PADDING_DP))
}

internal fun Context.stableButton(label: String, nodeId: String): Button = Button(this).apply {
    text = label
    isAllCaps = false
    setTextColor(Color.WHITE)
    background = roundedBackground(Palette.PRIMARY, DemoMetrics.BUTTON_CORNER_RADIUS_DP)
    minimumHeight = dp(DemoMetrics.BUTTON_MINIMUM_HEIGHT_DP)
    bindStableNode(nodeId)
    layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply {
        topMargin = dp(DemoMetrics.CONTROL_VERTICAL_MARGIN_DP)
    }
}

internal fun Context.stableText(
    value: String,
    nodeId: String,
    color: Int = Palette.INK,
): TextView = TextView(this).apply {
    text = value
    textSize = DemoMetrics.TEXT_SIZE_SP
    setTextColor(color)
    setPadding(
        dp(DemoMetrics.TEXT_PADDING_DP),
        dp(DemoMetrics.TEXT_PADDING_DP),
        dp(DemoMetrics.TEXT_PADDING_DP),
        dp(DemoMetrics.TEXT_PADDING_DP),
    )
    bindStableNode(nodeId)
}

internal fun Context.stableEditText(hintValue: String, nodeId: String): EditText =
    EditText(this).apply {
        hint = hintValue
        textSize = DemoMetrics.TEXT_SIZE_SP
        setTextColor(Palette.INK)
        setHintTextColor(Palette.MUTED)
        background = roundedBackground(
            Color.WHITE,
            DemoMetrics.INPUT_CORNER_RADIUS_DP,
            strokeColor = Palette.BORDER,
        )
        setPadding(
            dp(DemoMetrics.INPUT_HORIZONTAL_PADDING_DP),
            dp(DemoMetrics.INPUT_VERTICAL_PADDING_DP),
            dp(DemoMetrics.INPUT_HORIZONTAL_PADDING_DP),
            dp(DemoMetrics.INPUT_VERTICAL_PADDING_DP),
        )
        bindStableNode(nodeId)
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            topMargin = dp(DemoMetrics.CONTROL_VERTICAL_MARGIN_DP)
            bottomMargin = dp(DemoMetrics.CONTROL_VERTICAL_MARGIN_DP)
        }
    }

internal fun View.bindStableNode(nodeId: String) {
    val identity = StableNodeIdentity.from(nodeId)
    contentDescription = identity.contentDescription
    tag = identity.tag
}

internal fun ScenarioFixture.requireNodeId(nodeId: String): String {
    require(stable_nodes.any { it.node_id == nodeId }) {
        "Scenario $scenario_id does not declare stable node $nodeId."
    }
    return nodeId
}

internal fun Context.roundedBackground(
    color: Int,
    radiusDp: Int,
    strokeColor: Int? = null,
): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    setColor(color)
    cornerRadius = dp(radiusDp).toFloat()
    strokeColor?.let { setStroke(dp(DemoMetrics.BORDER_WIDTH_DP), it) }
}
