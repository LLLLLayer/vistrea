package dev.vistrea.demo.ui

import android.app.Activity
import android.graphics.Color
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.Toast
import dev.vistrea.demo.contract.ScenarioFixture

internal object VersionScenarioViews {
    fun newFeature(activity: Activity, fixture: ScenarioFixture, profileId: String) =
        activity.screenColumn().apply {
            addView(activity.title(fixture.title))
            addView(activity.body(fixture.purpose))
            if (profileId == "new-feature") {
                val open = activity.stableButton(
                    "Open insights",
                    fixture.requireNodeId("demo.feature.open_insights"),
                )
                open.setOnClickListener {
                    removeAllViews()
                    addView(activity.title("Insights"))
                    val card = activity.stableText(
                        "New-feature profile insight card",
                        fixture.requireNodeId("demo.feature.insights_card"),
                    ).apply {
                        background = activity.roundedBackground(
                            Color.WHITE,
                            DemoMetrics.BUTTON_CORNER_RADIUS_DP,
                        )
                    }
                    addView(card)
                }
                addView(open)
            } else {
                addView(activity.body("Baseline profile intentionally has no Insights path."))
            }
        }

    fun regression(activity: Activity, fixture: ScenarioFixture, profileId: String) =
        activity.screenColumn().apply {
            addView(activity.title(fixture.title))
            addView(activity.body(fixture.purpose))
            val designRegression = profileId == "design-regression"
            val card = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(
                    activity.dp(REGRESSION_CARD_PADDING_DP),
                    activity.dp(REGRESSION_CARD_PADDING_DP),
                    activity.dp(REGRESSION_CARD_PADDING_DP),
                    activity.dp(REGRESSION_CARD_PADDING_DP),
                )
                background = activity.roundedBackground(
                    Color.WHITE,
                    DemoMetrics.BUTTON_CORNER_RADIUS_DP,
                )
                bindStableNode(fixture.requireNodeId("demo.regression.checkout_card"))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
            }
            val checkout = activity.stableButton(
                "Complete checkout",
                fixture.requireNodeId("demo.regression.checkout"),
            ).apply {
                setTextColor(if (designRegression) Palette.REGRESSION_TEXT else Color.WHITE)
                setOnClickListener {
                    if (profileId == "behavior-regression") {
                        Toast.makeText(
                            activity,
                            "Behavior regression: transition intentionally blocked.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        removeAllViews()
                        addView(activity.title("Complete"))
                        addView(
                            activity.stableText(
                                "Checkout complete",
                                fixture.requireNodeId("demo.regression.complete_label"),
                            ),
                        )
                    }
                }
            }
            card.addView(checkout)
            addView(card)
        }

    private const val REGRESSION_CARD_PADDING_DP = 16
}
