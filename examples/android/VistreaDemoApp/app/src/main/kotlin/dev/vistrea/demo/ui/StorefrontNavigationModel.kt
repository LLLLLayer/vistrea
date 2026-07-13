package dev.vistrea.demo.ui

/** The four structural storefront screens of `demo.store.navigation`. */
internal enum class StorefrontScreen {
    SHOP,
    DETAIL,
    REVIEWS,
    PROFILE,
}

/**
 * The storefront back stack: visually a tab bar plus pushed screens, but
 * structurally one in-scenario stack rooted at the shop screen. Exploration
 * uses system back as its only return mechanism, so every screen except the
 * root pops back toward the shop, and back at the root is consumed without
 * leaving the scenario. Pure Kotlin: plain JVM unit tests cover it directly.
 */
internal class StorefrontNavigationModel {
    private val stack = ArrayDeque<StorefrontScreen>().apply { addLast(StorefrontScreen.SHOP) }

    val current: StorefrontScreen
        get() = stack.last()

    /** Tapping the pinned featured card on the shop screen pushes detail. */
    fun openDetail(): Boolean {
        if (current != StorefrontScreen.SHOP) {
            return false
        }
        stack.addLast(StorefrontScreen.DETAIL)
        return true
    }

    /** Tapping the reviews button on the detail screen pushes reviews. */
    fun openReviews(): Boolean {
        if (current != StorefrontScreen.DETAIL) {
            return false
        }
        stack.addLast(StorefrontScreen.REVIEWS)
        return true
    }

    /**
     * The shop tab resets the stack to its root. Tapping it while already on
     * the shop screen is a harmless self-action.
     */
    fun selectShopTab(): Boolean {
        if (stack.size == 1) {
            return false
        }
        stack.clear()
        stack.addLast(StorefrontScreen.SHOP)
        return true
    }

    /**
     * The profile tab is a pushed entry on the same stack, so system back
     * from profile always returns to the shop screen. Selecting it again
     * while on profile is a harmless self-action.
     */
    fun selectProfileTab(): Boolean {
        if (current == StorefrontScreen.PROFILE) {
            return false
        }
        stack.clear()
        stack.addLast(StorefrontScreen.SHOP)
        stack.addLast(StorefrontScreen.PROFILE)
        return true
    }

    /**
     * Pops one stack entry. Returns whether the screen changed; the caller
     * consumes back either way so the scenario never exits through back.
     */
    fun back(): Boolean {
        if (stack.size == 1) {
            return false
        }
        stack.removeLast()
        return true
    }
}
