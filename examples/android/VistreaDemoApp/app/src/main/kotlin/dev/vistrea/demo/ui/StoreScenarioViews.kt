package dev.vistrea.demo.ui

import android.app.Activity
import android.graphics.Color
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import dev.vistrea.demo.contract.ScenarioFixture

/** View builders for the storefront search and bottom sheet scenarios. */
internal object StoreScenarioViews {
    /**
     * `demo.store.search`: a text field filtering the deterministic catalog
     * as text changes. A blank query shows a browse hint plus the leading
     * catalog window; an active query removes the hint, so the filtered
     * state is structurally different; an unmatched query replaces the
     * results container with the empty notice. Clearing the field re-renders
     * the exact launch structure.
     */
    fun search(activity: Activity, fixture: ScenarioFixture) = activity.screenColumn().apply {
        addView(activity.title(fixture.title))
        addView(activity.body(fixture.purpose))
        val field = activity.stableEditText(
            "Search the catalog",
            fixture.requireNodeId("demo.search.field"),
        )
        addView(field)
        val resultsNodeId = fixture.requireNodeId("demo.search.results")
        val primaryNodeId = fixture.requireNodeId("demo.search.result_primary")
        val emptyNodeId = fixture.requireNodeId("demo.search.empty_notice")
        val fixedViewCount = childCount

        fun render(query: String) {
            removeViews(fixedViewCount, childCount - fixedViewCount)
            val browsing = query.isBlank()
            val matches = StoreCatalog.search(query)
            if (matches.isEmpty()) {
                addView(
                    activity.stableText(
                        "No items match your search.",
                        emptyNodeId,
                        Palette.MUTED,
                    ),
                )
                return
            }
            if (browsing) {
                // The browse hint exists only while no query is active, so an
                // active query is structurally different from browsing.
                addView(
                    TextView(activity).apply {
                        text = "Browse the full catalog below."
                        textSize = DemoMetrics.BODY_TEXT_SIZE_SP
                        setTextColor(Palette.MUTED)
                    },
                )
            }
            val results = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                background = activity.roundedBackground(
                    Color.WHITE,
                    DemoMetrics.INPUT_CORNER_RADIUS_DP,
                    strokeColor = Palette.CARD_BORDER,
                )
                bindStableNode(resultsNodeId)
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply {
                    topMargin = activity.dp(DemoMetrics.CONTROL_VERTICAL_MARGIN_DP)
                }
            }
            matches.take(VISIBLE_RESULT_LIMIT).forEachIndexed { position, item ->
                results.addView(
                    resultRow(activity, item).apply {
                        if (position == 0) {
                            // The first visible result is always the primary
                            // result, so any matching query includes it.
                            bindStableNode(primaryNodeId)
                        }
                    },
                )
            }
            addView(results)
        }

        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit

            override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit

            override fun afterTextChanged(value: Editable?) {
                render(value?.toString().orEmpty())
            }
        })
        render("")
    }

    /**
     * `demo.store.sheet`: a bottom sheet rendered as an in-tree overlay so
     * View capture observes it. The base state is structurally free of sheet
     * nodes; while open, a full-screen touch-consuming scrim blocks the base
     * controls until the option is chosen or the sheet is dismissed.
     */
    fun sheet(activity: Activity, fixture: ScenarioFixture) = FrameLayout(activity).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        var overlay: FrameLayout? = null
        val sortStatus = activity.body("Sort: Featured")
        val openButton = activity.stableButton(
            "Sort options",
            fixture.requireNodeId("demo.sheet.open"),
        )
        val base = activity.screenColumn().apply {
            addView(activity.title(fixture.title))
            addView(sortStatus)
            addView(openButton)
        }
        addView(base)

        fun closeSheet() {
            overlay?.let(::removeView)
            overlay = null
        }

        fun openSheet() {
            if (overlay != null) {
                return
            }
            val scrim = FrameLayout(activity).apply {
                setBackgroundColor(SCRIM_COLOR)
                // Consumes every touch so the sheet blocks the frontier: taps
                // outside the panel reach neither the base controls below nor
                // any contracted action.
                isClickable = true
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
            }
            val panel = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(
                    activity.dp(SHEET_PADDING_DP),
                    activity.dp(SHEET_PADDING_DP),
                    activity.dp(SHEET_PADDING_DP),
                    activity.dp(SHEET_PADDING_DP),
                )
                background = activity.roundedBackground(
                    Color.WHITE,
                    DemoMetrics.BUTTON_CORNER_RADIUS_DP,
                    strokeColor = Palette.CARD_BORDER,
                )
                bindStableNode(fixture.requireNodeId("demo.sheet.container"))
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM,
                )
                addView(
                    TextView(activity).apply {
                        text = "Sort options"
                        textSize = DemoMetrics.TEXT_SIZE_SP
                        setTextColor(Palette.INK)
                    },
                )
                addView(
                    activity.stableButton(
                        "Price ascending",
                        fixture.requireNodeId("demo.sheet.option_primary"),
                    ).apply {
                        setOnClickListener {
                            // Selecting only changes label text, so the base
                            // screen keeps one structural identity.
                            sortStatus.text = "Sort: Price ascending"
                            closeSheet()
                        }
                    },
                )
                addView(
                    activity.stableButton(
                        "Cancel",
                        fixture.requireNodeId("demo.sheet.dismiss"),
                    ).apply {
                        setOnClickListener { closeSheet() }
                    },
                )
            }
            scrim.addView(panel)
            overlay = scrim
            addView(scrim)
        }

        openButton.setOnClickListener { openSheet() }
    }

    private fun resultRow(activity: Activity, item: StoreCatalog.Item): LinearLayout =
        LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(
                activity.dp(RESULT_ROW_PADDING_DP),
                activity.dp(RESULT_ROW_PADDING_DP),
                activity.dp(RESULT_ROW_PADDING_DP),
                activity.dp(RESULT_ROW_PADDING_DP),
            )
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            addView(
                TextView(activity).apply {
                    text = item.title
                    textSize = DemoMetrics.BODY_TEXT_SIZE_SP
                    setTextColor(Palette.INK)
                    layoutParams = LinearLayout.LayoutParams(
                        ROW_COLLAPSED_WIDTH,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ROW_TITLE_WEIGHT,
                    )
                },
            )
            addView(
                TextView(activity).apply {
                    text = item.price
                    textSize = DemoMetrics.BODY_TEXT_SIZE_SP
                    setTextColor(Palette.MUTED)
                },
            )
        }

    private const val VISIBLE_RESULT_LIMIT = 5
    private const val RESULT_ROW_PADDING_DP = 12
    private const val SHEET_PADDING_DP = 20
    private const val SCRIM_COLOR = 0x66182033
    private const val ROW_COLLAPSED_WIDTH = 0
    private const val ROW_TITLE_WEIGHT = 1f
}
