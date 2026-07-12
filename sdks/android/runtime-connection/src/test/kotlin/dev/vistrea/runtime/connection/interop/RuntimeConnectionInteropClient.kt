package dev.vistrea.runtime.connection.interop

import dev.vistrea.protocol.v1.ColorSpace
import dev.vistrea.protocol.v1.Compression
import dev.vistrea.protocol.v1.Extensions
import dev.vistrea.protocol.v1.JsonSafeUInt
import dev.vistrea.protocol.v1.NonEmptyRect
import dev.vistrea.protocol.v1.ObjectHash
import dev.vistrea.protocol.v1.ObjectRef
import dev.vistrea.protocol.v1.RuntimeSnapshotJson
import dev.vistrea.protocol.v1.ScreenshotEvidence
import dev.vistrea.protocol.v1.SystemChrome
import dev.vistrea.protocol.v1.RuntimeEventKind
import dev.vistrea.protocol.v1.StableId
import dev.vistrea.runtime.connection.LoopbackRuntimeClient
import dev.vistrea.runtime.connection.LoopbackRuntimeClientConfiguration
import dev.vistrea.runtime.connection.LoopbackRuntimeEndpoint
import dev.vistrea.runtime.connection.RuntimeBuildConfiguration
import dev.vistrea.runtime.connection.RuntimeCaptureReason
import dev.vistrea.runtime.connection.RuntimeEventDraft
import dev.vistrea.runtime.connection.RuntimeEventRecorder
import dev.vistrea.runtime.connection.RuntimeObjectPayload
import dev.vistrea.runtime.connection.RuntimeSnapshotCapturePayload
import dev.vistrea.runtime.connection.RuntimeSnapshotCaptureProvider
import dev.vistrea.runtime.connection.RuntimeTuningApplying
import java.nio.file.Path
import kotlin.system.exitProcess
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

private class FixtureCaptureProvider(
    private val payload: RuntimeSnapshotCapturePayload,
) : RuntimeSnapshotCaptureProvider {
    override suspend fun capture(
        request: dev.vistrea.runtime.connection.RuntimeCaptureRequest,
    ): RuntimeSnapshotCapturePayload {
        if (request.reason == RuntimeCaptureReason.VALIDATION) {
            delay(30_000)
        }
        if (request.reason == RuntimeCaptureReason.REVIEW) {
            val objectValue = payload.objects.first()
            return RuntimeSnapshotCapturePayload(
                snapshot = payload.snapshot,
                objects = listOf(
                    RuntimeObjectPayload(
                        reference = objectValue.reference,
                        bytes = "Corrupt".toByteArray(Charsets.UTF_8),
                    ),
                ),
            )
        }
        return payload
    }
}

private class ScriptedTuningController : RuntimeTuningApplying {
    private val lock = Mutex()
    private val alphaByStableId = mutableMapOf("demo.home.root" to 1.0)

    override suspend fun currentAlpha(stableId: String): Double? = lock.withLock {
        alphaByStableId[stableId]
    }

    override suspend fun setAlpha(stableId: String, value: Double) {
        lock.withLock { alphaByStableId[stableId] = value }
    }
}

fun main(arguments: Array<String>) {
    try {
        val endpoint = parseEndpoint(arguments)
        val token = System.getenv("VISTREA_RUNTIME_TOKEN")
            ?: throw IllegalArgumentException("Missing Runtime configuration.")
        val fixturePath = System.getenv("VISTREA_RUNTIME_FIXTURE")
            ?: throw IllegalArgumentException("Missing Runtime configuration.")
        val tokenBytes = token.toByteArray(Charsets.UTF_8)
        try {
            val recorder = if (System.getenv("VISTREA_RUNTIME_EVENTS") == "scripted") {
                RuntimeEventRecorder()
            } else {
                null
            }
            val client = LoopbackRuntimeClient(
                configuration = LoopbackRuntimeClientConfiguration(
                    endpoint = endpoint,
                    authorizationToken = tokenBytes,
                    runtimeInstanceId = "runtime.kotlin.interop",
                    buildConfiguration = RuntimeBuildConfiguration.DEBUG,
                ),
                captureProvider = FixtureCaptureProvider(loadPayload(Path.of(fixturePath))),
                eventRecorder = recorder,
                tuningController = if (System.getenv("VISTREA_RUNTIME_TUNING") == "scripted") {
                    ScriptedTuningController()
                } else {
                    null
                },
            )
            runBlocking {
                val script = if (recorder == null) {
                    null
                } else {
                    recorder.record(
                        RuntimeEventDraft(
                            kind = RuntimeEventKind.TRANSIENT_PRESENTED,
                            stableId = StableId("demo.toast.success"),
                            durationMs = 2_000.0,
                            payload = buildJsonObject {
                                put("text", JsonPrimitive("Saved successfully"))
                            },
                        ),
                    )
                    recorder.record(
                        RuntimeEventDraft(
                            kind = RuntimeEventKind.TRANSIENT_DISMISSED,
                            stableId = StableId("demo.toast.success"),
                        ),
                    )
                    // Keep a slow deterministic stream flowing so the Host can
                    // observe live batches after its subscription starts.
                    launch {
                        repeat(20) {
                            delay(200)
                            recorder.record(RuntimeEventDraft(kind = RuntimeEventKind.LAYOUT_CHANGED))
                        }
                    }
                }
                try {
                    client.runUntilClosed()
                } finally {
                    script?.cancel()
                }
            }
        } finally {
            tokenBytes.fill(0)
        }
    } catch (_: Exception) {
        System.err.println("Runtime interop client failed.")
        exitProcess(1)
    }
}

private fun parseEndpoint(arguments: Array<String>): LoopbackRuntimeEndpoint {
    if (arguments.size != 4 || arguments[0] != "--host" || arguments[2] != "--port") {
        throw IllegalArgumentException("Invalid Runtime endpoint arguments.")
    }
    val port = arguments[3].toIntOrNull()
        ?: throw IllegalArgumentException("Invalid Runtime endpoint arguments.")
    return LoopbackRuntimeEndpoint(arguments[1], port)
}

private fun loadPayload(path: Path): RuntimeSnapshotCapturePayload {
    val original = RuntimeSnapshotJson.decode(path.toFile().readText(Charsets.UTF_8))
    val bytes = "Vistrea".toByteArray(Charsets.UTF_8)
    val reference = ObjectRef(
        hash = ObjectHash(
            "sha256:b0cd09405ae15f1cfb3f4b291002921832c81e26ed7f308c56b5c1eb5a791de5",
        ),
        mediaType = "image/png",
        byteSize = JsonSafeUInt(bytes.size.toLong()),
        compression = Compression.NONE,
        logicalName = "kotlin-interop.png",
        extensions = Extensions.empty(),
    )
    val screenshot = ScreenshotEvidence(
        objectRef = reference,
        captureStartedAt = original.capturedAt,
        captureFinishedAt = original.capturedAt,
        treeSkewMs = 0.0,
        coverage = NonEmptyRect(
            x = 0.0,
            y = 0.0,
            width = original.display.logicalSize.width,
            height = original.display.logicalSize.height,
        ),
        pixelSize = original.display.pixelSize,
        systemChrome = SystemChrome.EXCLUDED,
        colorSpace = ColorSpace.SRGB,
        extensions = Extensions.empty(),
    )
    return RuntimeSnapshotCapturePayload(
        snapshot = original.copy(screenshot = screenshot),
        objects = listOf(RuntimeObjectPayload(reference, bytes)),
    )
}
