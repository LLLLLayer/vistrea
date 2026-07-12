package dev.vistrea.demo.inspector

import android.app.Activity
import android.view.View

internal fun interface InspectorLauncher {
    fun createEntryView(activity: Activity, inspectedRoot: View): View
}
