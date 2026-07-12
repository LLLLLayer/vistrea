package dev.vistrea.demo.runtime

/** Observation-only transient reporting seam; Release variants never install one. */
internal interface RuntimeEventReporter {
    fun transientPresented(stableNodeId: String, text: String, durationMs: Long)

    fun transientDismissed(stableNodeId: String)
}

internal object RuntimeEventReporting {
    @Volatile
    var reporter: RuntimeEventReporter? = null
}
