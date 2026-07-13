package dev.vistrea.demo.ui

import kotlin.math.roundToInt

/**
 * The deterministic storefront catalog shared by the store navigation and
 * store search scenarios. Every value is a pure function of the item index,
 * so repeated launches, scrolls, and queries always observe identical
 * content. Pure Kotlin: plain JVM unit tests cover it directly.
 */
internal object StoreCatalog {
    /** One deterministic catalog entry; text is content, never identity. */
    data class Item(
        val index: Int,
        val title: String,
        val price: String,
    )

    private val ADJECTIVES = listOf(
        "Aurora", "Basalt", "Cedar", "Drift", "Ember",
        "Fjord", "Glacier", "Harbor", "Iris", "Juniper",
    )

    private val PRODUCTS = listOf("Lamp", "Chair", "Kettle", "Rug", "Vase")

    /**
     * Exactly 50 items: every adjective and product combination, in order.
     * The iOS Demo App generates the identical titles and prices from the
     * same formulas, so cross-platform runs observe the same content.
     */
    val items: List<Item> = (0 until ADJECTIVES.size * PRODUCTS.size).map { index ->
        Item(
            index = index,
            title = "${ADJECTIVES[index % ADJECTIVES.size]} ${PRODUCTS[index / ADJECTIVES.size]}",
            price = "$${19 + (index * 7) % 80}.00",
        )
    }

    /**
     * Case-insensitive substring filter over item titles. A blank query
     * restores the complete catalog, so clearing the search field always
     * reproduces the exact launch structure.
     */
    fun search(query: String): List<Item> {
        val needle = query.trim()
        if (needle.isEmpty()) {
            return items
        }
        return items.filter { it.title.contains(needle, ignoreCase = true) }
    }
}

/**
 * Pure whole-row snap math for the storefront catalog window. The visible
 * window only ever moves in whole-row steps, so the rendered tree is snapped
 * at every instant of a gesture, not just after settling.
 */
internal object SnapCatalogWindow {
    /** How many whole rows a drag of [dragDistancePx] shifts the window. */
    fun rowShift(dragDistancePx: Float, rowHeightPx: Int): Int {
        require(rowHeightPx > 0) { "Row height must be positive." }
        return (dragDistancePx / rowHeightPx).roundToInt()
    }

    /** The clamped first visible index after applying a drag to a window. */
    fun settledFirstIndex(
        startFirstIndex: Int,
        dragDistancePx: Float,
        rowHeightPx: Int,
        itemCount: Int,
        visibleRows: Int,
    ): Int {
        val maximumFirstIndex = maxOf(0, itemCount - visibleRows)
        return (startFirstIndex + rowShift(dragDistancePx, rowHeightPx))
            .coerceIn(0, maximumFirstIndex)
    }
}
