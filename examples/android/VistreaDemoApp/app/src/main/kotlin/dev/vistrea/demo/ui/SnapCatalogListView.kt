package dev.vistrea.demo.ui

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The scrolling storefront catalog with whole-row snapping.
 *
 * The View always contains exactly [visibleRows] fully placed, structurally
 * identical rows of fixed height; a drag gesture only rebinds which catalog
 * items back those rows, in whole-row steps computed by [SnapCatalogWindow].
 * A scrolled catalog therefore captures as a structurally identical tree —
 * same roles, same node count, same stable identifiers — where only text
 * content differs. Rows carry no stable identifiers: row text is content,
 * not identity.
 */
internal class SnapCatalogListView(
    context: Context,
    private val items: List<StoreCatalog.Item>,
    private val visibleRows: Int,
    rowHeightDp: Int,
) : LinearLayout(context) {
    private val rowHeightPx = context.dp(rowHeightDp)
    private var firstIndex = 0
    private var gestureStartY = 0f
    private var gestureStartFirstIndex = 0

    init {
        require(visibleRows in 1..items.size) {
            "The catalog window must show between 1 and ${items.size} rows."
        }
        orientation = VERTICAL
        repeat(visibleRows) { addView(createRow()) }
        rebind()
    }

    /** The fixed viewport height: always exactly N full rows, no partial row. */
    fun viewportHeightPx(): Int = rowHeightPx * visibleRows

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                gestureStartY = event.y
                gestureStartFirstIndex = firstIndex
            }
            MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP -> {
                val settled = SnapCatalogWindow.settledFirstIndex(
                    startFirstIndex = gestureStartFirstIndex,
                    dragDistancePx = gestureStartY - event.y,
                    rowHeightPx = rowHeightPx,
                    itemCount = items.size,
                    visibleRows = visibleRows,
                )
                if (settled != firstIndex) {
                    firstIndex = settled
                    rebind()
                }
            }
            else -> Unit
        }
        return true
    }

    private fun createRow(): LinearLayout = LinearLayout(context).apply {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(context.dp(ROW_HORIZONTAL_PADDING_DP), 0, context.dp(ROW_HORIZONTAL_PADDING_DP), 0)
        layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, rowHeightPx)
        addView(
            TextView(context).apply {
                textSize = DemoMetrics.BODY_TEXT_SIZE_SP
                setTextColor(Palette.INK)
                layoutParams = LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, ROW_TITLE_WEIGHT)
            },
        )
        addView(
            TextView(context).apply {
                textSize = DemoMetrics.BODY_TEXT_SIZE_SP
                setTextColor(Palette.MUTED)
            },
        )
    }

    private fun rebind() {
        for (rowPosition in 0 until visibleRows) {
            val row = getChildAt(rowPosition) as LinearLayout
            val item = items[firstIndex + rowPosition]
            (row.getChildAt(0) as TextView).text = item.title
            (row.getChildAt(1) as TextView).text = item.price
        }
    }

    private companion object {
        const val ROW_HORIZONTAL_PADDING_DP = 12
        const val ROW_TITLE_WEIGHT = 1f
    }
}
