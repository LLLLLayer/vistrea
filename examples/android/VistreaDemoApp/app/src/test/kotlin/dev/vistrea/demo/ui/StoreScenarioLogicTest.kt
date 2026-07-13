package dev.vistrea.demo.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class StoreCatalogTest {
    @Test
    fun catalogHasFiftyDeterministicUniqueItemsMatchingTheSharedFormulas() {
        assertEquals(50, StoreCatalog.items.size)
        assertEquals(50, StoreCatalog.items.map { it.title }.toSet().size)
        assertEquals(StoreCatalog.items, StoreCatalog.items.map { it.copy() })
        assertEquals("Aurora Lamp", StoreCatalog.items.first().title)
        assertEquals("$19.00", StoreCatalog.items.first().price)
        assertEquals("Basalt Lamp", StoreCatalog.items[1].title)
        assertEquals("$26.00", StoreCatalog.items[1].price)
        assertEquals("Juniper Vase", StoreCatalog.items.last().title)
        assertEquals("$42.00", StoreCatalog.items.last().price)
        assertTrue(StoreCatalog.items.all { it.title.isNotBlank() && it.price.isNotBlank() })
    }

    @Test
    fun matchingQueryAliasFiltersToFiveResultsLedByThePrimaryResult() {
        // QUERY_MATCHING resolves to "Aurora" on both platforms.
        val matches = StoreCatalog.search("Aurora")
        assertEquals(5, matches.size)
        assertTrue(matches.all { it.title.contains("Aurora") })
        assertEquals("Aurora Lamp", matches.first().title)
        assertEquals(matches, StoreCatalog.search("aurora"))
    }

    @Test
    fun unmatchedQueryAliasReturnsNoResults() {
        // QUERY_UNMATCHED resolves to "Obsidian" on both platforms.
        assertTrue(StoreCatalog.search("Obsidian").isEmpty())
    }

    @Test
    fun blankAndClearedQueriesRestoreTheCompleteCatalog() {
        assertEquals(StoreCatalog.items, StoreCatalog.search(""))
        assertEquals(StoreCatalog.items, StoreCatalog.search("   "))
        assertEquals(StoreCatalog.search("Cedar"), StoreCatalog.search(" Cedar "))
    }
}

class SnapCatalogWindowTest {
    @Test
    fun dragsSnapToWholeRowShifts() {
        assertEquals(0, SnapCatalogWindow.rowShift(0f, 100))
        assertEquals(1, SnapCatalogWindow.rowShift(80f, 100))
        assertEquals(2, SnapCatalogWindow.rowShift(240f, 100))
        assertEquals(-1, SnapCatalogWindow.rowShift(-120f, 100))
    }

    @Test
    fun settledWindowClampsToCatalogBounds() {
        assertEquals(
            0,
            SnapCatalogWindow.settledFirstIndex(0, -500f, 100, 50, 5),
        )
        assertEquals(
            3,
            SnapCatalogWindow.settledFirstIndex(1, 200f, 100, 50, 5),
        )
        assertEquals(
            45,
            SnapCatalogWindow.settledFirstIndex(40, 5_000f, 100, 50, 5),
        )
    }
}

class StorefrontNavigationModelTest {
    @Test
    fun launchStartsOnTheShopRoot() {
        assertEquals(StorefrontScreen.SHOP, StorefrontNavigationModel().current)
    }

    @Test
    fun detailAndReviewsPushAndPopThroughSystemBack() {
        val model = StorefrontNavigationModel()
        assertTrue(model.openDetail())
        assertEquals(StorefrontScreen.DETAIL, model.current)
        assertTrue(model.openReviews())
        assertEquals(StorefrontScreen.REVIEWS, model.current)
        assertTrue(model.back())
        assertEquals(StorefrontScreen.DETAIL, model.current)
        assertTrue(model.back())
        assertEquals(StorefrontScreen.SHOP, model.current)
    }

    @Test
    fun backAtTheShopRootIsConsumedWithoutLeaving() {
        val model = StorefrontNavigationModel()
        assertFalse(model.back())
        assertEquals(StorefrontScreen.SHOP, model.current)
    }

    @Test
    fun profileTabIsAPushedStackEntryThatBackReturnsToShop() {
        val model = StorefrontNavigationModel()
        assertTrue(model.selectProfileTab())
        assertEquals(StorefrontScreen.PROFILE, model.current)
        assertTrue(model.back())
        assertEquals(StorefrontScreen.SHOP, model.current)
    }

    @Test
    fun shopTabReturnsFromProfileAndIsHarmlessOnShop() {
        val model = StorefrontNavigationModel()
        assertTrue(model.selectProfileTab())
        assertTrue(model.selectShopTab())
        assertEquals(StorefrontScreen.SHOP, model.current)
        assertFalse(model.selectShopTab())
        assertEquals(StorefrontScreen.SHOP, model.current)
        assertFalse(model.back())
    }

    @Test
    fun tabsResetTheStackDeterministicallyFromPushedScreens() {
        val model = StorefrontNavigationModel()
        assertTrue(model.openDetail())
        assertTrue(model.selectProfileTab())
        assertEquals(StorefrontScreen.PROFILE, model.current)
        assertTrue(model.back())
        assertEquals(StorefrontScreen.SHOP, model.current)
        assertTrue(model.openDetail())
        assertTrue(model.selectShopTab())
        assertEquals(StorefrontScreen.SHOP, model.current)
        assertFalse(model.openReviews())
    }
}
