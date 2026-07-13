package dev.vistrea.demo.ui

import android.app.Activity
import android.view.View
import dev.vistrea.demo.contract.ScenarioFixture
import dev.vistrea.demo.mixed.MixedDeclarativeContent
import dev.vistrea.demo.mixed.MixedDeclarativeNodeIds

/**
 * Debug variant of `demo.mixed.declarative`: delegates to the Debug-only
 * `:mixed-declarative` module, which renders the scenario content through
 * Jetpack Compose with [MixedDeclarativeNodeIds] declared as test-tag
 * semantics for the Compose capture extension. Jetpack Compose ships only
 * in the Debug variant; the Release variant of this object shows an honest
 * framework-only fallback instead.
 */
internal object MixedDeclarativeScenarioViews {
    fun declarative(activity: Activity, fixture: ScenarioFixture): View =
        MixedDeclarativeContent.create(
            context = activity,
            nodeIds = MixedDeclarativeNodeIds(
                headerId = fixture.requireNodeId("demo.mixed.header"),
                featuredCardId = fixture.requireNodeId("demo.mixed.featured_card"),
                actionId = fixture.requireNodeId("demo.mixed.action"),
                statusId = fixture.requireNodeId("demo.mixed.status"),
            ),
            featuredTitle = StoreCatalog.items.first().title,
        )
}
