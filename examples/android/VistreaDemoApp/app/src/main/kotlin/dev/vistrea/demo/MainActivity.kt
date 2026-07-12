package dev.vistrea.demo

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import dev.vistrea.demo.contract.AndroidScenarioAssetSource
import dev.vistrea.demo.contract.LaunchArguments
import dev.vistrea.demo.contract.LaunchSelection
import dev.vistrea.demo.contract.ScenarioContractRepository
import dev.vistrea.demo.contract.ScenarioFixture
import dev.vistrea.demo.contract.ScenarioSuite
import dev.vistrea.demo.inspector.InspectorFactory
import dev.vistrea.demo.ui.Palette
import dev.vistrea.demo.ui.ScenarioContentFactory
import dev.vistrea.demo.ui.ScenarioController
import dev.vistrea.demo.ui.ScenarioRuntimeContext
import dev.vistrea.demo.ui.body
import dev.vistrea.demo.ui.dp

class MainActivity : Activity() {
    private lateinit var suite: ScenarioSuite
    private lateinit var content: FrameLayout
    private lateinit var contextLabel: TextView
    private lateinit var shell: LinearLayout
    private var controller: ScenarioController? = null
    private var activeScenarioId: String? = null
    private var predictiveBackCallback: OnBackInvokedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        suite = ScenarioContractRepository(AndroidScenarioAssetSource(assets)).load()
        createShell()
        registerPredictiveBack()
        applyLaunchSelection(selectionFrom(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyLaunchSelection(selectionFrom(intent))
    }

    @SuppressLint("GestureBackNavigation")
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        handleBackRequest()
    }

    override fun onDestroy() {
        controller?.stop()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            predictiveBackCallback?.let(onBackInvokedDispatcher::unregisterOnBackInvokedCallback)
        }
        predictiveBackCallback = null
        super.onDestroy()
    }

    private fun registerPredictiveBack() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        val callback = OnBackInvokedCallback(::handleBackRequest)
        onBackInvokedDispatcher.registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            callback,
        )
        predictiveBackCallback = callback
    }

    private fun handleBackRequest() {
        if (controller?.handleBack() == true) {
            return
        }
        if (activeScenarioId != null) {
            showChooser()
            return
        }
        finishAfterTransition()
    }

    private fun createShell() {
        shell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        contextLabel = TextView(this).apply {
            textSize = CONTEXT_TEXT_SIZE_SP
            setTextColor(Palette.MUTED)
            setPadding(
                dp(CONTEXT_HORIZONTAL_PADDING_DP),
                dp(CONTEXT_VERTICAL_PADDING_DP),
                dp(CONTEXT_HORIZONTAL_PADDING_DP),
                dp(CONTEXT_VERTICAL_PADDING_DP),
            )
            setBackgroundColor(Palette.SURFACE)
        }
        content = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                CONTENT_COLLAPSED_HEIGHT,
                CONTENT_LAYOUT_WEIGHT,
            )
        }
        shell.addView(contextLabel)
        shell.addView(content)
        InspectorFactory.create()?.let { inspector ->
            shell.addView(inspector.createEntryView(this, content))
        }
        setContentView(shell)
    }

    private fun applyLaunchSelection(selection: LaunchSelection) {
        val scenarioId = selection.scenarioId
        if (scenarioId == null) {
            showChooser()
            return
        }
        val fixture = suite.fixturesById[scenarioId]
        if (fixture == null) {
            showError("Unknown Scenario ID: $scenarioId")
            return
        }
        val profileId = selection.profileId ?: fixture.profiles.first()
        if (profileId !in fixture.profiles) {
            showError("Profile $profileId is not supported by $scenarioId")
            return
        }
        launchScenario(fixture, profileId)
    }

    private fun launchScenario(fixture: ScenarioFixture, profileId: String) {
        controller?.stop()
        activeScenarioId = fixture.scenario_id
        contextLabel.text = getString(
            R.string.scenario_context_format,
            fixture.scenario_id,
            profileId,
            fixture.reset.seed,
        )
        controller = ScenarioContentFactory.create(
            ScenarioRuntimeContext(this, content, fixture, profileId),
        ).also {
            it.start()
        }
    }

    private fun showChooser() {
        controller?.stop()
        activeScenarioId = null
        controller = null
        contextLabel.text = getString(
            R.string.scenario_launcher_context_format,
            suite.manifest.suite_id,
        )
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(
                dp(CHOOSER_HORIZONTAL_PADDING_DP),
                dp(CHOOSER_TOP_PADDING_DP),
                dp(CHOOSER_HORIZONTAL_PADDING_DP),
                dp(CHOOSER_BOTTOM_PADDING_DP),
            )
            addView(body("Choose one of the required shared Scenario IDs."))
            suite.manifest.scenarios.forEach { entry ->
                val fixture = suite.fixture(entry.scenario_id)
                addView(Button(this@MainActivity).apply {
                    text = getString(
                        R.string.scenario_chooser_item_format,
                        fixture.title,
                        fixture.scenario_id,
                    )
                    isAllCaps = false
                    contentDescription = fixture.scenario_id
                    tag = fixture.scenario_id
                    setOnClickListener { launchScenario(fixture, fixture.profiles.first()) }
                })
            }
        }
        content.removeAllViews()
        content.addView(ScrollView(this).apply { addView(list) })
    }

    private fun showError(message: String) {
        controller?.stop()
        activeScenarioId = null
        controller = null
        contextLabel.text = getString(R.string.launch_configuration_error)
        content.removeAllViews()
        content.addView(body(message))
    }

    private fun selectionFrom(intent: Intent): LaunchSelection = LaunchArguments.resolve { key ->
        intent.getStringExtra(key)
    }

    private companion object {
        const val CONTEXT_TEXT_SIZE_SP = 13f
        const val CONTEXT_HORIZONTAL_PADDING_DP = 16
        const val CONTEXT_VERTICAL_PADDING_DP = 12
        const val CONTENT_COLLAPSED_HEIGHT = 0
        const val CONTENT_LAYOUT_WEIGHT = 1f
        const val CHOOSER_HORIZONTAL_PADDING_DP = 20
        const val CHOOSER_TOP_PADDING_DP = 20
        const val CHOOSER_BOTTOM_PADDING_DP = 32
    }
}
