package dev.vistrea.demo.ui

import android.view.View
import android.widget.FrameLayout

internal interface ScenarioController {
    fun start()

    fun stop() = Unit

    fun handleBack(): Boolean = false
}

internal class SingleViewScenarioController(
    private val container: FrameLayout,
    private val content: () -> View,
) : ScenarioController {
    override fun start() {
        container.removeAllViews()
        container.addView(content())
    }
}
