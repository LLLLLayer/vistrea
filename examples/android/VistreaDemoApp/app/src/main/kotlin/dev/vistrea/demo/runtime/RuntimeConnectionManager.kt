package dev.vistrea.demo.runtime

/** Owns at most one Debug Runtime connection across singleTop Intent updates. */
internal class RuntimeConnectionManager {
    private var active: RuntimeConnectionController? = null

    fun replaceIfRequested(
        requested: Boolean,
        create: () -> RuntimeConnectionController?,
    ) {
        if (!requested) {
            return
        }
        val replacement = create() ?: return
        active?.stop()
        active = replacement
        replacement.start()
    }

    fun stop() {
        active?.stop()
        active = null
    }
}
