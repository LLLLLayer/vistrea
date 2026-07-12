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

/**
 * Bridge from Android View observation to the Runtime transport.
 *
 * Hierarchy observation and the screenshot draw stay on the main thread;
 * the CPU-heavy PNG encoding and hashing run on a background dispatcher.
 */
class AndroidViewRuntimeSnapshotCaptureProvider(
    private val adapter: AndroidViewRuntimeCaptureAdapter,
    private val rootViewProvider: () -> View,
    private val scenarioIdProvider: () -> String? = { null },
) : RuntimeSnapshotCaptureProvider {
    override suspend fun capture(request: RuntimeCaptureRequest): RuntimeSnapshotCapturePayload {
        val staged = withContext(Dispatchers.Main.immediate) {
            coroutineContext.ensureActive()
            request.requireSupportedSnapshotSlice()
            adapter.beginCapture(
                rootView = rootViewProvider(),
                scenarioId = scenarioIdProvider(),
                includeScreenshot = request.screenshot == RuntimeCaptureScreenshotMode.REFERENCE,
            )
        }
        try {
            return withContext(Dispatchers.Default) {
                coroutineContext.ensureActive()
                val result = staged.encode()
                RuntimeSnapshotCapturePayload(
                    snapshot = result.snapshot,
                    objects = result.objects.map { objectValue ->
                        RuntimeObjectPayload(
                            reference = objectValue.reference,
                            bytes = objectValue.transportBytes(),
                        )
                    },
                )
            }
        } finally {
            // A cancellation between the two halves must not leak the bitmap;
            // after a successful encode this is a no-op.
            staged.discard()
        }
    }
}
