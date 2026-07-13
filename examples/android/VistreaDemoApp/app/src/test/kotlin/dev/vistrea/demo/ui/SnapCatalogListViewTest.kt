package dev.vistrea.demo.ui

import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Proves the load-bearing structural invariant of the storefront catalog on
 * the real View class: at any snapped offset the (class + stable-id)
 * structure signature is identical — same node count, same classes, no
 * per-row stable identifiers — and only row texts differ.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SnapCatalogListViewTest {
    @Test
    fun windowAlwaysContainsExactlyTheVisibleRowsWithNoStableIds() {
        val view = catalogView()
        assertEquals(VISIBLE_ROWS, view.childCount)
        assertEquals(VISIBLE_ROWS * view.rowHeightPx(), view.viewportHeightPx())
        structureSignature(view).drop(1).forEach { entry ->
            assertTrue(entry.endsWith(":-"), "Rows must carry no stable ids, found $entry")
        }
    }

    @Test
    fun scrolledCatalogKeepsOneStructuralIdentityWhileTextsRebind() {
        val view = catalogView()
        val initialSignature = structureSignature(view)
        val initialTexts = texts(view)
        assertEquals(StoreCatalog.items.take(VISIBLE_ROWS).map { it.title }, titles(view))

        drag(view, distancePx = 2.4f * view.rowHeightPx())

        assertEquals(initialSignature, structureSignature(view))
        assertNotEquals(initialTexts, texts(view))
        assertEquals(
            StoreCatalog.items.drop(2).take(VISIBLE_ROWS).map { it.title },
            titles(view),
        )
    }

    @Test
    fun dragsClampToTheCatalogBoundsAndStaySnapped() {
        val view = catalogView()
        val signature = structureSignature(view)

        drag(view, distancePx = 500f * view.rowHeightPx())
        assertEquals(
            StoreCatalog.items.takeLast(VISIBLE_ROWS).map { it.title },
            titles(view),
        )
        assertEquals(signature, structureSignature(view))

        drag(view, distancePx = -500f * view.rowHeightPx())
        assertEquals(
            StoreCatalog.items.take(VISIBLE_ROWS).map { it.title },
            titles(view),
        )
        assertEquals(signature, structureSignature(view))
    }

    @Test
    fun structureStaysConstantAtEveryInstantOfAGesture() {
        val view = catalogView()
        val signature = structureSignature(view)
        val downTime = SystemClock.uptimeMillis()
        view.onTouchEvent(motionEvent(MotionEvent.ACTION_DOWN, downTime, y = 400f))
        var y = 400f
        repeat(10) {
            y -= view.rowHeightPx() * 0.7f
            view.onTouchEvent(motionEvent(MotionEvent.ACTION_MOVE, downTime, y))
            assertEquals(VISIBLE_ROWS, view.childCount)
            assertEquals(signature, structureSignature(view))
        }
        view.onTouchEvent(motionEvent(MotionEvent.ACTION_UP, downTime, y))
        assertEquals(signature, structureSignature(view))
    }

    private fun catalogView(): SnapCatalogListView = SnapCatalogListView(
        context = RuntimeEnvironment.getApplication(),
        items = StoreCatalog.items,
        visibleRows = VISIBLE_ROWS,
        rowHeightDp = ROW_HEIGHT_DP,
    )

    private fun SnapCatalogListView.rowHeightPx(): Int = viewportHeightPx() / VISIBLE_ROWS

    private fun drag(view: SnapCatalogListView, distancePx: Float) {
        val downTime = SystemClock.uptimeMillis()
        val startY = 10_000f
        view.onTouchEvent(motionEvent(MotionEvent.ACTION_DOWN, downTime, startY))
        view.onTouchEvent(motionEvent(MotionEvent.ACTION_MOVE, downTime, startY - distancePx))
        view.onTouchEvent(motionEvent(MotionEvent.ACTION_UP, downTime, startY - distancePx))
    }

    private fun motionEvent(action: Int, downTime: Long, y: Float): MotionEvent =
        MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 100f, y, 0)

    /** Depth-first (class simple name + stable id) signature of a View tree. */
    private fun structureSignature(view: View): List<String> {
        val signature = mutableListOf("${view.javaClass.simpleName}:${view.tag ?: "-"}")
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                signature += structureSignature(view.getChildAt(index))
            }
        }
        return signature
    }

    private fun texts(view: View): List<String> {
        val collected = mutableListOf<String>()
        if (view is TextView) {
            collected += view.text.toString()
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                collected += texts(view.getChildAt(index))
            }
        }
        return collected
    }

    /** Row titles: the first text of each row. */
    private fun titles(view: SnapCatalogListView): List<String> =
        (0 until view.childCount).map { index ->
            val row = view.getChildAt(index) as ViewGroup
            (row.getChildAt(0) as TextView).text.toString()
        }

    private companion object {
        const val VISIBLE_ROWS = 5
        const val ROW_HEIGHT_DP = 56
    }
}
