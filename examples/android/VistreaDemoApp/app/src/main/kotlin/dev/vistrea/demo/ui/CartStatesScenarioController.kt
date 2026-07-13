package dev.vistrea.demo.ui

import android.app.Activity
import android.widget.FrameLayout
import dev.vistrea.demo.contract.ScenarioFixture

/**
 * The `demo.store.cart-states` scenario: one cart screen whose empty and
 * populated structures are legitimately different Screen States. Adding the
 * sample item and removing it are pure in-memory toggles — deterministic,
 * with no persistence across launches.
 */
internal class CartStatesScenarioController(
    runtime: ScenarioRuntimeContext,
) : ScenarioController {
    private val activity: Activity = runtime.activity
    private val container: FrameLayout = runtime.container
    private val fixture: ScenarioFixture = runtime.fixture
    private var populated = false

    override fun start() {
        populated = false
        render()
    }

    override fun handleBack(): Boolean {
        if (!populated) {
            return false
        }
        populated = false
        render()
        return true
    }

    private fun render() {
        val content = activity.screenColumn()
        content.addView(activity.title("Cart"))
        if (populated) {
            content.addView(
                activity.stableText(
                    "${StoreCatalog.items.first().title} · " +
                        "${StoreCatalog.items.first().price} — tap to remove",
                    fixture.requireNodeId("demo.cart.item_primary"),
                ).apply {
                    setOnClickListener {
                        populated = false
                        render()
                    }
                },
            )
            content.addView(
                activity.stableButton(
                    "Checkout",
                    fixture.requireNodeId("demo.cart.checkout"),
                ).apply {
                    // No contracted step taps this node, so it stays visible
                    // but disabled and exploration skips it.
                    isEnabled = false
                },
            )
        } else {
            content.addView(
                activity.stableText(
                    "Your cart is empty.",
                    fixture.requireNodeId("demo.cart.empty_notice"),
                    Palette.MUTED,
                ),
            )
            content.addView(
                activity.stableButton(
                    "Add sample item",
                    fixture.requireNodeId("demo.cart.add_sample"),
                ).apply {
                    setOnClickListener {
                        populated = true
                        render()
                    }
                },
            )
        }
        container.removeAllViews()
        container.addView(content)
    }
}
