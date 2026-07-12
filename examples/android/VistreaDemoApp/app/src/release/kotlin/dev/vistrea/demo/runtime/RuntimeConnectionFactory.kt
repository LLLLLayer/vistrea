package dev.vistrea.demo.runtime

import android.app.Activity
import android.content.Intent

/** Release variants expose no Runtime transport configuration or implementation. */
internal object RuntimeConnectionFactory {
    @Suppress("UNUSED_PARAMETER")
    fun hasConfiguration(intent: Intent): Boolean = false

    @Suppress("UNUSED_PARAMETER")
    fun create(
        activity: Activity,
        intent: Intent,
        scenarioIdProvider: () -> String?,
    ): RuntimeConnectionController? = null
}
