package dev.vistrea.demo.ui

import android.app.Activity
import android.view.View
import dev.vistrea.demo.contract.ScenarioFixture

/**
 * Release variant of `demo.mixed.declarative`: Jetpack Compose ships only in
 * the Debug variant, so this build shows an honest framework-only notice
 * instead of imitating the declarative content. It deliberately binds none
 * of the scenario's stable nodes — a native imitation would fake the
 * declarative capture path the scenario exists to prove.
 */
internal object MixedDeclarativeScenarioViews {
    fun declarative(activity: Activity, fixture: ScenarioFixture): View =
        activity.screenColumn().apply {
            addView(activity.title(fixture.title))
            addView(
                activity.body(
                    "The Jetpack Compose content for this scenario is unavailable in " +
                        "Release builds. Install the Debug Demo App to observe the " +
                        "declarative capture path.",
                ),
            )
        }
}
