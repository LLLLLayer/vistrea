package dev.vistrea.demo.ui

import android.app.Activity
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import dev.vistrea.demo.contract.ScenarioFixture

internal object StaticScenarioViews {
    fun layoutOcclusion(activity: Activity, fixture: ScenarioFixture) = activity.screenColumn().apply {
        addView(activity.title(fixture.title))
        addView(activity.body(fixture.purpose))
        val stage = FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                activity.dp(OCCLUSION_STAGE_HEIGHT_DP),
            )
        }
        val covered = activity.stableButton(
            "Covered action",
            fixture.requireNodeId("demo.layout.covered_action"),
        ).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                activity.dp(COVERED_ACTION_HEIGHT_DP),
            ).apply {
                topMargin = activity.dp(COVERED_ACTION_TOP_MARGIN_DP)
            }
        }
        val panel = View(activity).apply {
            background = activity.roundedBackground(
                Palette.PANEL,
                DemoMetrics.BUTTON_CORNER_RADIUS_DP,
            )
            bindStableNode(fixture.requireNodeId("demo.layout.occluding_panel"))
            elevation = activity.dp(PANEL_ELEVATION_DP).toFloat()
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                activity.dp(PANEL_HEIGHT_DP),
            ).apply {
                topMargin = activity.dp(PANEL_TOP_MARGIN_DP)
            }
        }
        stage.addView(covered)
        stage.addView(panel)
        addView(stage)
    }

    fun accessibility(activity: Activity, fixture: ScenarioFixture, profileId: String) =
        activity.screenColumn().apply {
            addView(activity.title(fixture.title))
            addView(activity.body(fixture.purpose))
            val unlabeled = activity.stableButton(
                "Account action",
                fixture.requireNodeId("demo.accessibility.unlabeled_action"),
            )
            val small = activity.stableButton(
                "Small action",
                fixture.requireNodeId("demo.accessibility.small_action"),
            )
            if (profileId == "accessibility-regression") {
                unlabeled.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                small.minimumHeight = 0
                small.layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    activity.dp(ACCESSIBILITY_REGRESSION_HEIGHT_DP),
                )
            }
            addView(unlabeled)
            addView(small)
        }

    fun designTuning(activity: Activity, fixture: ScenarioFixture, profileId: String) =
        activity.screenColumn().apply {
            addView(activity.title(fixture.title))
            addView(activity.body(fixture.purpose))
            val isRegression = profileId == "design-regression"
            val card = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(
                    activity.dp(DESIGN_CARD_PADDING_DP),
                    activity.dp(DESIGN_CARD_PADDING_DP),
                    activity.dp(DESIGN_CARD_PADDING_DP),
                    activity.dp(DESIGN_CARD_PADDING_DP),
                )
                background = activity.roundedBackground(
                    color = Color.WHITE,
                    radiusDp = if (isRegression) {
                        DESIGN_REGRESSION_RADIUS_DP
                    } else {
                        DemoMetrics.BUTTON_CORNER_RADIUS_DP
                    },
                    strokeColor = Palette.CARD_BORDER,
                )
                bindStableNode(fixture.requireNodeId("demo.design.preview_card"))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
            }
            val title = activity.stableText(
                "Preview card",
                fixture.requireNodeId("demo.design.preview_title"),
            ).apply {
                textSize = if (isRegression) {
                    DESIGN_REGRESSION_TEXT_SIZE_SP
                } else {
                    DemoMetrics.BODY_TEXT_SIZE_SP
                }
            }
            card.addView(title)
            addView(card)
        }

    fun dynamicContent(activity: Activity, fixture: ScenarioFixture, profileId: String) =
        activity.screenColumn().apply {
            addView(activity.title(fixture.title))
            addView(activity.body("Seed ${fixture.reset.seed}; profile $profileId"))
            val changed = profileId == "dynamic-content"
            addView(
                activity.stableText(
                    if (changed) "15:42" else "12:34",
                    fixture.requireNodeId("demo.dynamic.clock"),
                ),
            )
            addView(
                activity.stableText(
                    if (changed) "Taylor" else "Alex",
                    fixture.requireNodeId("demo.dynamic.user_name"),
                ),
            )
            addView(
                activity.stableText(
                    if (changed) "Seeded item B" else "Seeded item A",
                    fixture.requireNodeId("demo.dynamic.item_primary"),
                ),
            )
        }

    fun safety(activity: Activity, fixture: ScenarioFixture) = activity.screenColumn().apply {
        addView(activity.title(fixture.title))
        addView(activity.body(fixture.purpose))
        val delete = activity.stableButton(
            "Delete account",
            fixture.requireNodeId("demo.safety.delete_account"),
        ).apply {
            background = activity.roundedBackground(
                Palette.ERROR,
                DemoMetrics.BUTTON_CORNER_RADIUS_DP,
            )
            setOnClickListener {
                Toast.makeText(
                    activity,
                    "Blocked: destructive action requires confirmation.",
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
        addView(delete)
    }

    private const val OCCLUSION_STAGE_HEIGHT_DP = 180
    private const val COVERED_ACTION_HEIGHT_DP = 56
    private const val COVERED_ACTION_TOP_MARGIN_DP = 72
    private const val PANEL_ELEVATION_DP = 8
    private const val PANEL_HEIGHT_DP = 96
    private const val PANEL_TOP_MARGIN_DP = 48
    private const val ACCESSIBILITY_REGRESSION_HEIGHT_DP = 24
    private const val DESIGN_CARD_PADDING_DP = 20
    private const val DESIGN_REGRESSION_RADIUS_DP = 4
    private const val DESIGN_REGRESSION_TEXT_SIZE_SP = 14f
}
