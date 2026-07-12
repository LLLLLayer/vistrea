package dev.vistrea.demo.runtime

import android.app.Activity
import android.content.Intent
import android.os.Process
import android.system.Os
import android.system.OsConstants
import dev.vistrea.demo.BuildConfig
import dev.vistrea.protocol.v1.BuildId
import dev.vistrea.protocol.v1.DeviceId
import dev.vistrea.protocol.v1.ProjectId
import dev.vistrea.runtime.android.AndroidViewRuntimeCaptureAdapter
import dev.vistrea.runtime.android.AndroidViewRuntimeCaptureConfiguration
import dev.vistrea.runtime.android.AndroidViewRuntimeSnapshotCaptureProvider
import dev.vistrea.runtime.connection.LoopbackRuntimeClient
import dev.vistrea.runtime.connection.LoopbackRuntimeClientConfiguration
import dev.vistrea.runtime.connection.LoopbackRuntimeEndpoint
import dev.vistrea.runtime.connection.RuntimeBuildConfiguration
import java.io.FileInputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

internal object RuntimeConnectionFactory {
    fun hasConfiguration(intent: Intent): Boolean =
        DebugRuntimeConnectionValues.hasAnyValue(intent)

    fun create(
        activity: Activity,
        intent: Intent,
        scenarioIdProvider: () -> String?,
    ): RuntimeConnectionController? {
        val tokenBytes = OneShotRuntimeAuthorization.read(activity) ?: return null
        return try {
            val values = DebugRuntimeConnectionValues.from(intent) ?: return null
            val adapter = AndroidViewRuntimeCaptureAdapter(
                AndroidViewRuntimeCaptureConfiguration(
                    projectId = ProjectId(PROJECT_ID),
                    buildId = BuildId(BUILD_ID),
                    deviceId = DeviceId(DEVICE_ID),
                    environmentId = "demo",
                    accountProfileId = "demo-user",
                    applicationVersionOverride = BuildConfig.VERSION_NAME,
                    sdkVersion = "0.1.0",
                    adapterVersion = "0.1.0",
                ),
            )
            val provider = AndroidViewRuntimeSnapshotCaptureProvider(
                adapter = adapter,
                rootViewProvider = { activity.window.decorView },
                scenarioIdProvider = scenarioIdProvider,
            )
            val client = LoopbackRuntimeClient(
                configuration = LoopbackRuntimeClientConfiguration(
                    endpoint = LoopbackRuntimeEndpoint(values.host, values.port),
                    authorizationToken = tokenBytes,
                    buildConfiguration = RuntimeBuildConfiguration.DEBUG,
                ),
                captureProvider = provider,
            )
            DebugRuntimeConnectionController(client)
        } catch (_: Exception) {
            null
        } finally {
            tokenBytes.fill(0)
        }
    }

    private const val PROJECT_ID = "project_019f0000-0000-7000-8000-000000000001"
    private const val BUILD_ID = "build_019f0000-0000-7000-8000-000000000001"
    private const val DEVICE_ID = "device_019f0000-0000-7000-8000-000000000001"
}

private data class DebugRuntimeConnectionValues(
    val host: String,
    val port: Int,
) {
    companion object {
        fun hasAnyValue(intent: Intent): Boolean =
            intent.hasExtra(HOST) || intent.hasExtra(PORT)

        fun from(intent: Intent): DebugRuntimeConnectionValues? {
            val host = readValue(intent, HOST) ?: return null
            val port = readValue(intent, PORT)?.toIntOrNull()?.takeIf { it in 1..MAXIMUM_PORT }
                ?: return null
            return DebugRuntimeConnectionValues(host, port)
        }

        private fun readValue(intent: Intent, key: String): String? =
            intent.getStringExtra(key)?.takeIf(String::isNotBlank)

        private const val HOST = "VISTREA_RUNTIME_HOST"
        private const val PORT = "VISTREA_RUNTIME_PORT"
        private const val MAXIMUM_PORT = 65_535
    }
}

private object OneShotRuntimeAuthorization {
    fun read(activity: Activity): ByteArray? {
        val file = activity.filesDir.resolve(RELATIVE_PATH)
        return try {
            readPrivateFile(file.absolutePath)
        } catch (_: Exception) {
            null
        } finally {
            runCatching { file.delete() }
        }
    }

    private fun readPrivateFile(path: String): ByteArray? {
        val descriptor = Os.open(
            path,
            OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW,
            0,
        )
        var streamOwnsDescriptor = false
        return try {
            val metadata = Os.fstat(descriptor)
            val isPrivateRegularFile = OsConstants.S_ISREG(metadata.st_mode) &&
                metadata.st_uid == Process.myUid() &&
                metadata.st_mode and GROUP_AND_OTHER_PERMISSION_MASK == 0 &&
                metadata.st_size in MINIMUM_TOKEN_BYTES..MAXIMUM_TOKEN_BYTES
            if (!isPrivateRegularFile) {
                null
            } else {
                val input = FileInputStream(descriptor)
                streamOwnsDescriptor = true
                input.use { readExactBytes(it, metadata.st_size.toInt()) }
            }
        } finally {
            if (!streamOwnsDescriptor) {
                runCatching { Os.close(descriptor) }
            }
        }
    }

    private fun readExactBytes(input: FileInputStream, expectedSize: Int): ByteArray? {
        val result = ByteArray(expectedSize)
        var offset = 0
        while (offset < result.size) {
            val count = input.read(result, offset, result.size - offset)
            if (count < 0) {
                result.fill(0)
                return null
            }
            offset += count
        }
        return if (input.read() != -1) {
            result.fill(0)
            null
        } else {
            result
        }
    }

    private const val RELATIVE_PATH = "vistrea/runtime-token"
    private const val GROUP_AND_OTHER_PERMISSION_MASK = 0x3f
    private const val MINIMUM_TOKEN_BYTES = 32L
    private const val MAXIMUM_TOKEN_BYTES = 4_096L
}

private class DebugRuntimeConnectionController(
    private val client: LoopbackRuntimeClient,
) : RuntimeConnectionController {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var runJob: Job? = null

    override fun start() {
        if (runJob != null) {
            return
        }
        runJob = scope.launch {
            try {
                client.runUntilClosed()
            } catch (_: Exception) {
                // Development transport failures remain local and redact credentials.
            }
        }
    }

    override fun stop() {
        client.close()
        runJob?.cancel()
        runJob = null
        scope.cancel()
    }
}
