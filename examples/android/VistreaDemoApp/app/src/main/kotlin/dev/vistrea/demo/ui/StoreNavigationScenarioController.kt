package dev.vistrea.demo.ui

import android.app.Activity
import android.graphics.Color
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import dev.vistrea.demo.contract.ScenarioFixture

/**
 * The `demo.store.navigation` storefront: a persistent bottom tab bar over
 * one in-scenario back stack of shop, detail, reviews, and profile screens.
 *
 * System back always navigates within the scenario — reviews to detail to
 * shop, profile to shop — and is consumed as a no-op at the shop root, so
 * exploration's only return mechanism never finishes the Activity.
 */
internal class StoreNavigationScenarioController(
    private val activity: Activity,
    private val container: FrameLayout,
    private val fixture: ScenarioFixture,
) : ScenarioController {
    private var model = StorefrontNavigationModel()

    override fun start() {
        model = StorefrontNavigationModel()
        render()
    }

    override fun handleBack(): Boolean {
        if (model.back()) {
            render()
        }
        // Consumed even at the shop root: back never exits the storefront.
        return true
    }

    private fun render() {
        val shell = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        val screen = when (model.current) {
            StorefrontScreen.SHOP -> shopScreen()
            StorefrontScreen.DETAIL -> detailScreen()
            StorefrontScreen.REVIEWS -> reviewsScreen()
            StorefrontScreen.PROFILE -> profileScreen()
        }
        screen.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            CONTENT_COLLAPSED_HEIGHT,
            CONTENT_LAYOUT_WEIGHT,
        )
        shell.addView(screen)
        shell.addView(tabBar())
        container.removeAllViews()
        container.addView(shell)
    }

    private fun shopScreen(): LinearLayout = activity.screenColumn().apply {
        addView(activity.title("Shop"))
        // The featured card is pinned above the scrolling catalog, so the
        // state's required nodes survive any scroll position.
        val featured = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(
                activity.dp(FEATURED_PADDING_DP),
                activity.dp(FEATURED_PADDING_DP),
                activity.dp(FEATURED_PADDING_DP),
                activity.dp(FEATURED_PADDING_DP),
            )
            background = activity.roundedBackground(
                Palette.SURFACE,
                DemoMetrics.BUTTON_CORNER_RADIUS_DP,
                strokeColor = Palette.CARD_BORDER,
            )
            bindStableNode(fixture.requireNodeId("demo.store.catalog_item_primary"))
            isClickable = true
            setOnClickListener {
                if (model.openDetail()) {
                    render()
                }
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                bottomMargin = activity.dp(DemoMetrics.CONTROL_VERTICAL_MARGIN_DP)
            }
            addView(plainText("Featured: ${StoreCatalog.items.first().title}", Palette.INK))
            addView(plainText(StoreCatalog.items.first().price, Palette.MUTED))
        }
        addView(featured)
        val catalog = SnapCatalogListView(
            context = activity,
            items = StoreCatalog.items,
            visibleRows = CATALOG_VISIBLE_ROWS,
            rowHeightDp = CATALOG_ROW_HEIGHT_DP,
        ).apply {
            background = activity.roundedBackground(
                Color.WHITE,
                DemoMetrics.INPUT_CORNER_RADIUS_DP,
                strokeColor = Palette.CARD_BORDER,
            )
            bindStableNode(fixture.requireNodeId("demo.store.catalog_list"))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                viewportHeightPx(),
            )
        }
        addView(catalog)
    }

    private fun detailScreen(): LinearLayout = activity.screenColumn().apply {
        addView(activity.title("Detail"))
        addView(activity.body("Featured: ${StoreCatalog.items.first().title}"))
        addView(
            activity.stableButton(
                "Add to cart",
                fixture.requireNodeId("demo.store.detail_add_to_cart"),
            ).apply {
                // No contracted step taps this node, so it stays visible but
                // disabled and exploration records no uncontracted transition.
                isEnabled = false
            },
        )
        addView(
            activity.stableButton(
                "Open reviews",
                fixture.requireNodeId("demo.store.detail_open_reviews"),
            ).apply {
                setOnClickListener {
                    if (model.openReviews()) {
                        render()
                    }
                }
            },
        )
    }

    private fun reviewsScreen(): LinearLayout = activity.screenColumn().apply {
        addView(activity.title("Reviews"))
        addView(
            activity.stableText(
                "“The ${StoreCatalog.items.first().title} looks great.” — Alex",
                fixture.requireNodeId("demo.store.review_item_primary"),
            ),
        )
        addView(plainText("“Arrived quickly.” — Taylor", Palette.MUTED))
        addView(plainText("“Exactly as pictured.” — Jordan", Palette.MUTED))
    }

    private fun profileScreen(): LinearLayout = activity.screenColumn().apply {
        addView(
            activity.stableText(
                "Alex Demo",
                fixture.requireNodeId("demo.store.profile_header"),
            ),
        )
        addView(activity.body("Member since 2024. Deterministic profile data."))
    }

    private fun tabBar(): LinearLayout = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        setBackgroundColor(Palette.SURFACE)
        setPadding(
            activity.dp(TAB_BAR_PADDING_DP),
            activity.dp(TAB_BAR_PADDING_DP),
            activity.dp(TAB_BAR_PADDING_DP),
            activity.dp(TAB_BAR_PADDING_DP),
        )
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        addView(
            activity.stableButton("Shop", fixture.requireNodeId("demo.store.tab_shop")).apply {
                layoutParams = tabLayoutParams()
                setOnClickListener {
                    if (model.selectShopTab()) {
                        render()
                    }
                }
            },
        )
        addView(
            activity.stableButton("Profile", fixture.requireNodeId("demo.store.tab_profile")).apply {
                layoutParams = tabLayoutParams()
                setOnClickListener {
                    if (model.selectProfileTab()) {
                        render()
                    }
                }
            },
        )
    }

    private fun tabLayoutParams(): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        TAB_COLLAPSED_WIDTH,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        TAB_LAYOUT_WEIGHT,
    ).apply {
        marginStart = activity.dp(TAB_SPACING_DP)
        marginEnd = activity.dp(TAB_SPACING_DP)
    }

    private fun plainText(value: String, color: Int): TextView = TextView(activity).apply {
        text = value
        textSize = DemoMetrics.BODY_TEXT_SIZE_SP
        setTextColor(color)
        gravity = Gravity.START
    }

    private companion object {
        const val CATALOG_VISIBLE_ROWS = 5
        const val CATALOG_ROW_HEIGHT_DP = 56
        const val FEATURED_PADDING_DP = 16
        const val TAB_BAR_PADDING_DP = 8
        const val TAB_SPACING_DP = 8
        const val TAB_COLLAPSED_WIDTH = 0
        const val TAB_LAYOUT_WEIGHT = 1f
        const val CONTENT_COLLAPSED_HEIGHT = 0
        const val CONTENT_LAYOUT_WEIGHT = 1f
    }
}
