package dev.vistrea.runtime.android

import android.view.View
import dev.vistrea.runtime.connection.RuntimeCaptureRequest
import dev.vistrea.runtime.connection.RuntimeCaptureScreenshotMode
import dev.vistrea.runtime.connection.RuntimeObjectPayload
import dev.vistrea.runtime.connection.RuntimeSnapshotCapturePayload
import dev.vistrea.runtime.connection.RuntimeSnapshotCaptureProvider
import dev.vistrea.runtime.connection.requireSupportedSnapshotSlice
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Main-thread bridge from Android View observation to the Runtime transport. */
class AndroidViewRuntimeSnapshotCaptureProvider(
    private val adapter: AndroidViewRuntimeCaptureAdapter,
    private val rootViewProvider: () -> View,
    private val scenarioIdProvider: () -> String? = { null },
) : RuntimeSnapshotCaptureProvider {
    override suspend fun capture(request: RuntimeCaptureRequest): RuntimeSnapshotCapturePayload =
        withContext(Dispatchers.Main.immediate) {
            coroutineContext.ensureActive()
            request.requireSupportedSnapshotSlice()
            val result = adapter.capture(
                rootView = rootViewProvider(),
                scenarioId = scenarioIdProvider(),
                includeScreenshot = request.screenshot == RuntimeCaptureScreenshotMode.REFERENCE,
            )
            coroutineContext.ensureActive()
            RuntimeSnapshotCapturePayload(
                snapshot = result.snapshot,
                objects = result.objects.map { objectValue ->
                    RuntimeObjectPayload(
                        reference = objectValue.reference,
                        bytes = objectValue.bytes,
                    )
                },
            )
        }
}
