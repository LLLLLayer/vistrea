package dev.vistrea.runtime.android

import android.view.View
import android.view.ViewGroup
import dev.vistrea.protocol.v1.StableId
import dev.vistrea.runtime.connection.RuntimeTuningApplying
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Resolves stable identifiers to live views and previews only their alpha.
 *
 * The controller mutates exactly the allowlisted property on the main thread
 * and never invokes application business methods. Identifier resolution uses
 * the same candidate order as the capture adapter so tuning targets match the
 * observed `stable_id` values.
 */
class AndroidViewRuntimeTuningController(
    private val rootViewProvider: () -> View,
) : RuntimeTuningApplying {
    override suspend fun currentAlpha(stableId: String): Double? =
        withContext(Dispatchers.Main.immediate) {
            findView(rootViewProvider(), stableId)?.alpha?.toDouble()
        }

    override suspend fun setAlpha(stableId: String, value: Double): Boolean =
        withContext(Dispatchers.Main.immediate) {
            val view = findView(rootViewProvider(), stableId)
            view?.alpha = value.toFloat()
            view != null
        }

    private fun findView(view: View, stableId: String): View? {
        if (stableIdentifier(view)?.value == stableId) {
            return view
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findView(view.getChildAt(index), stableId)?.let { return it }
            }
        }
        return null
    }

    private fun stableIdentifier(view: View): StableId? {
        val candidates = buildList {
            (view.tag as? String)?.takeIf(String::isNotBlank)?.let(::add)
            view.transitionName?.takeIf(String::isNotBlank)?.let(::add)
            view.contentDescription?.toString()?.takeIf(String::isNotBlank)?.let(::add)
            if (view.id != View.NO_ID) {
                runCatching { view.resources.getResourceName(view.id) }.getOrNull()?.let(::add)
            }
        }
        return candidates.firstNotNullOfOrNull { candidate ->
            runCatching { StableId(candidate) }.getOrNull()
        }
    }
}
