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
import dev.vistrea.runtime.connection.LoopbackRuntimeClient
import dev.vistrea.runtime.connection.LoopbackRuntimeClientConfiguration
import dev.vistrea.runtime.connection.LoopbackRuntimeEndpoint
import dev.vistrea.runtime.connection.RuntimeBuildConfiguration
import dev.vistrea.runtime.connection.RuntimeCaptureReason
import dev.vistrea.runtime.connection.RuntimeObjectPayload
import dev.vistrea.runtime.connection.RuntimeSnapshotCapturePayload
import dev.vistrea.runtime.connection.RuntimeSnapshotCaptureProvider
import java.nio.file.Path
import kotlin.system.exitProcess
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking

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

fun main(arguments: Array<String>) {
    try {
        val endpoint = parseEndpoint(arguments)
        val token = System.getenv("VISTREA_RUNTIME_TOKEN")
            ?: throw IllegalArgumentException("Missing Runtime configuration.")
        val fixturePath = System.getenv("VISTREA_RUNTIME_FIXTURE")
            ?: throw IllegalArgumentException("Missing Runtime configuration.")
        val tokenBytes = token.toByteArray(Charsets.UTF_8)
        try {
            val client = LoopbackRuntimeClient(
                configuration = LoopbackRuntimeClientConfiguration(
                    endpoint = endpoint,
                    authorizationToken = tokenBytes,
                    runtimeInstanceId = "runtime.kotlin.interop",
                    buildConfiguration = RuntimeBuildConfiguration.DEBUG,
                ),
                captureProvider = FixtureCaptureProvider(loadPayload(Path.of(fixturePath))),
            )
            runBlocking { client.runUntilClosed() }
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
