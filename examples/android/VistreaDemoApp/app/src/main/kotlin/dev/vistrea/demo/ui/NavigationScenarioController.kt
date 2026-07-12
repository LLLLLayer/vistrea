package dev.vistrea.demo.ui

import android.app.Activity
import android.widget.FrameLayout
import dev.vistrea.demo.contract.ScenarioFixture

internal class NavigationScenarioController(
    private val activity: Activity,
    private val container: FrameLayout,
    private val fixture: ScenarioFixture,
) : ScenarioController {
    private var state = State.HOME

    override fun start() {
        state = State.HOME
        render()
    }

    override fun handleBack(): Boolean = when (state) {
        State.DETAIL -> {
            state = State.CATALOG
            render()
            true
        }
        State.CATALOG -> {
            state = State.HOME
            render()
            true
        }
        State.HOME -> false
    }

    private fun render() {
        val content = activity.screenColumn()
        when (state) {
            State.HOME -> {
                content.addView(activity.title("Home"))
                content.addView(activity.body("A deterministic entry state for path exploration."))
                content.addView(
                    activity.stableButton(
                        "Open catalog",
                        fixture.requireNodeId("demo.home.open_catalog"),
                    ).apply {
                        setOnClickListener {
                            state = State.CATALOG
                            render()
                        }
                    },
                )
            }
            State.CATALOG -> {
                content.addView(activity.title("Catalog"))
                content.addView(activity.body("One stable item keeps the scenario deterministic."))
                content.addView(
                    activity.stableButton(
                        "Primary item",
                        fixture.requireNodeId("demo.catalog.item_primary"),
                    ).apply {
                        setOnClickListener {
                            state = State.DETAIL
                            render()
                        }
                    },
                )
            }
            State.DETAIL -> {
                content.addView(activity.title("Detail"))
                content.addView(activity.body("System Back returns to Catalog, then Home."))
                content.addView(
                    activity.stableButton(
                        "Open form",
                        fixture.requireNodeId("demo.detail.open_form"),
                    ),
                )
            }
        }
        container.removeAllViews()
        container.addView(content)
    }

    private enum class State {
        HOME,
        CATALOG,
        DETAIL,
    }
}
