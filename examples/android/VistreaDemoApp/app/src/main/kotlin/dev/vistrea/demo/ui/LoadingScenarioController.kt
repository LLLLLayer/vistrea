package dev.vistrea.demo.ui

import android.app.Activity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import dev.vistrea.demo.contract.ScenarioFixture

internal class LoadingScenarioController(
    runtime: ScenarioRuntimeContext,
) : ScenarioController {
    private val activity: Activity = runtime.activity
    private val container: FrameLayout = runtime.container
    private val profileId: String = runtime.profileId
    private val fixture: ScenarioFixture = runtime.fixture
    private var state = State.IDLE
    private var renderEpoch = 0

    override fun start() {
        state = State.IDLE
        render()
    }

    override fun handleBack(): Boolean {
        if (state == State.IDLE) {
            return false
        }
        state = State.IDLE
        render()
        return true
    }

    override fun stop() {
        renderEpoch += 1
        state = State.IDLE
    }

    private fun render() {
        val epoch = ++renderEpoch
        val content = activity.screenColumn()
        content.addView(activity.title("Loading outcomes"))
        when (state) {
            State.IDLE -> renderIdle(content)
            State.ACTIVE_SUCCESS -> renderActive(content, shouldFail = false, epoch)
            State.ACTIVE_FAILURE -> renderActive(content, shouldFail = true, epoch)
            State.SUCCESS -> content.addView(
                activity.stableText(
                    "Content loaded successfully.",
                    fixture.requireNodeId("demo.loading.content"),
                ),
            )
            State.FAILURE -> renderFailure(content)
        }
        container.removeAllViews()
        container.addView(content)
    }

    private fun renderIdle(content: LinearLayout) {
        content.addView(activity.body("All outcomes are generated from local fixture state."))
        content.addView(
            activity.stableButton(
                "Load success",
                fixture.requireNodeId("demo.loading.start_success"),
            ).apply {
                setOnClickListener {
                    state = State.ACTIVE_SUCCESS
                    render()
                }
            },
        )
        content.addView(
            activity.stableButton(
                "Load failure",
                fixture.requireNodeId("demo.loading.start_failure"),
            ).apply {
                setOnClickListener {
                    state = State.ACTIVE_FAILURE
                    render()
                }
            },
        )
    }

    private fun renderActive(content: LinearLayout, shouldFail: Boolean, epoch: Int) {
        val progress = ProgressBar(activity).apply {
            isIndeterminate = true
            bindStableNode(fixture.requireNodeId("demo.loading.progress"))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        content.addView(progress)
        if (profileId != "behavior-regression") {
            progress.postDelayed(
                {
                    if (epoch != renderEpoch) {
                        return@postDelayed
                    }
                    state = if (shouldFail) State.FAILURE else State.SUCCESS
                    render()
                },
                LOADING_DELAY_MS,
            )
        } else {
            content.addView(activity.body("Behavior regression: loading intentionally times out."))
        }
    }

    private fun renderFailure(content: LinearLayout) {
        content.addView(
            activity.stableText(
                "The local request failed.",
                fixture.requireNodeId("demo.loading.error"),
                Palette.ERROR,
            ),
        )
        content.addView(
            activity.stableButton(
                "Retry",
                fixture.requireNodeId("demo.loading.retry"),
            ).apply {
                setOnClickListener {
                    state = State.ACTIVE_SUCCESS
                    render()
                }
            },
        )
    }

    private enum class State {
        IDLE,
        ACTIVE_SUCCESS,
        ACTIVE_FAILURE,
        SUCCESS,
        FAILURE,
    }

    private companion object {
        const val LOADING_DELAY_MS = 500L
    }
}
