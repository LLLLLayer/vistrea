package dev.vistrea.demo.ui

import android.app.Activity
import android.app.AlertDialog
import android.text.Editable
import android.text.TextWatcher
import android.widget.TextView
import dev.vistrea.demo.contract.ScenarioFixture

internal object InteractiveScenarioViews {
    fun form(activity: Activity, fixture: ScenarioFixture) = activity.screenColumn().apply {
        addView(activity.title(fixture.title))
        addView(activity.body(fixture.purpose))
        val input = activity.stableEditText(
            "Name",
            fixture.requireNodeId("demo.form.name_input"),
        )
        var errorView: TextView? = null
        val submit = activity.stableButton(
            "Submit",
            fixture.requireNodeId("demo.form.submit"),
        )
        submit.setOnClickListener {
            if (input.text.isNullOrBlank() && errorView == null) {
                errorView = activity.stableText(
                    "Name is required.",
                    fixture.requireNodeId("demo.form.name_error"),
                    Palette.ERROR,
                )
                addView(errorView)
            }
        }
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit

            override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit

            override fun afterTextChanged(value: Editable?) {
                if (!value.isNullOrBlank()) {
                    errorView?.let(::removeView)
                    errorView = null
                }
            }
        })
        addView(input)
        addView(submit)
    }

    fun transientSuccess(activity: Activity, fixture: ScenarioFixture) = activity.screenColumn().apply {
        addView(activity.title(fixture.title))
        addView(activity.body(fixture.purpose))
        var banner: TextView? = null
        val submit = activity.stableButton(
            "Submit locally",
            fixture.requireNodeId("demo.success.submit"),
        )
        submit.setOnClickListener {
            banner?.let(::removeView)
            val visibleBanner = activity.stableText(
                "Saved successfully",
                fixture.requireNodeId("demo.toast.success"),
                Palette.SUCCESS,
            )
            banner = visibleBanner
            addView(visibleBanner, 2)
            visibleBanner.postDelayed(
                {
                    if (banner === visibleBanner) {
                        removeView(visibleBanner)
                        banner = null
                    }
                },
                SUCCESS_DURATION_MS,
            )
        }
        addView(submit)
    }

    fun modal(activity: Activity, fixture: ScenarioFixture) = activity.screenColumn().apply {
        addView(activity.title(fixture.title))
        addView(activity.body(fixture.purpose))
        val open = activity.stableButton(
            "Open dialog",
            fixture.requireNodeId("demo.modal.open"),
        )
        open.setOnClickListener {
            val dialog = AlertDialog.Builder(activity)
                .setTitle("Deterministic dialog")
                .setMessage("This modal has no external dependency.")
                .setPositiveButton("Dismiss", null)
                .create()
            dialog.setOnShowListener {
                dialog.window?.decorView?.bindStableNode(
                    fixture.requireNodeId("demo.modal.dialog"),
                )
                dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
                    bindStableNode(fixture.requireNodeId("demo.modal.dismiss"))
                    setOnClickListener { dialog.dismiss() }
                }
            }
            dialog.show()
        }
        addView(open)
    }

    private const val SUCCESS_DURATION_MS = 2_000L
}
