@file:Suppress("ComplexCondition", "LongParameterList", "MagicNumber")

package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.ObjectRef
import dev.vistrea.protocol.v1.RuntimeSnapshot
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

private const val MINIMUM_AUTHORIZATION_TOKEN_BYTES = 32
private const val MAXIMUM_AUTHORIZATION_TOKEN_BYTES = 4_096
private const val MINIMUM_LINE_BYTES = 1_024
private const val MAXIMUM_LINE_BYTES = 64 * 1_024 * 1_024
private const val MINIMUM_HANDSHAKE_TIMEOUT_MILLISECONDS = 10L
private const val MAXIMUM_HANDSHAKE_TIMEOUT_MILLISECONDS = 300_000L
private val RUNTIME_INSTANCE_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")

@Serializable
enum class RuntimeBuildConfiguration {
    @SerialName("debug")
    DEBUG,

    @SerialName("internal")
    INTERNAL,
}

enum class RuntimeConnectionState {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATING,
    READY,
    CLOSING,
    CLOSED,
    FAILED,
}

enum class RuntimeConnectionErrorCode {
    INVALID_CONFIGURATION,
    INELIGIBLE_BUILD,
    UNAVAILABLE,
    AUTHENTICATION_FAILED,
    NEGOTIATION_FAILED,
    PROTOCOL_VIOLATION,
    RESOURCE_EXHAUSTED,
    TIMEOUT,
    CANCELLED,
    REMOTE_ERROR,
}

class RuntimeConnectionException(
    val code: RuntimeConnectionErrorCode,
) : IllegalStateException(publicMessage(code)) {
    companion object {
        private fun publicMessage(code: RuntimeConnectionErrorCode): String = when (code) {
            RuntimeConnectionErrorCode.INVALID_CONFIGURATION ->
                "The Runtime connection configuration is invalid."
            RuntimeConnectionErrorCode.INELIGIBLE_BUILD ->
                "The Runtime connection is unavailable for this build configuration."
            RuntimeConnectionErrorCode.UNAVAILABLE -> "The Runtime connection is unavailable."
            RuntimeConnectionErrorCode.AUTHENTICATION_FAILED -> "Runtime authentication failed."
            RuntimeConnectionErrorCode.NEGOTIATION_FAILED ->
                "Runtime protocol or capability negotiation failed."
            RuntimeConnectionErrorCode.PROTOCOL_VIOLATION ->
                "The Runtime connection protocol was violated."
            RuntimeConnectionErrorCode.RESOURCE_EXHAUSTED ->
                "Runtime connection limits were exceeded."
            RuntimeConnectionErrorCode.TIMEOUT -> "The Runtime connection timed out."
            RuntimeConnectionErrorCode.CANCELLED -> "The Runtime connection was cancelled."
            RuntimeConnectionErrorCode.REMOTE_ERROR ->
                "The Runtime Host rejected the connection or operation."
        }
    }
}

data class LoopbackRuntimeEndpoint(
    val host: String = "127.0.0.1",
    val port: Int,
) {
    init {
        requireConfiguration(host == "127.0.0.1" || host == "::1")
        requireConfiguration(port in 1..65_535)
    }
}

class LoopbackRuntimeClientConfiguration(
    val endpoint: LoopbackRuntimeEndpoint,
    authorizationToken: ByteArray,
    val runtimeInstanceId: String = "runtime.${java.util.UUID.randomUUID().toString().lowercase()}",
    val buildConfiguration: RuntimeBuildConfiguration,
    val maximumInboundLineBytes: Int = 4 * 1_024 * 1_024,
    val handshakeTimeoutMilliseconds: Long = 5_000,
) {
    private val authorizationKeyValue: SecretKey

    init {
        requireConfiguration(
            authorizationToken.size in
                MINIMUM_AUTHORIZATION_TOKEN_BYTES..MAXIMUM_AUTHORIZATION_TOKEN_BYTES,
        )
        requireConfiguration(
            runtimeInstanceId.toByteArray(Charsets.UTF_8).size <= 256 &&
                RUNTIME_INSTANCE_ID_PATTERN.matches(runtimeInstanceId),
        )
        requireConfiguration(maximumInboundLineBytes in MINIMUM_LINE_BYTES..MAXIMUM_LINE_BYTES)
        requireConfiguration(
            handshakeTimeoutMilliseconds in
                MINIMUM_HANDSHAKE_TIMEOUT_MILLISECONDS..MAXIMUM_HANDSHAKE_TIMEOUT_MILLISECONDS,
        )
        val isolatedToken = authorizationToken.copyOf()
        try {
            authorizationKeyValue = SecretKeySpec(isolatedToken, RuntimeConnectionAuthentication.ALGORITHM)
        } finally {
            isolatedToken.fill(0)
        }
    }

    internal val authorizationKey: SecretKey
        get() = authorizationKeyValue

    override fun toString(): String =
        "LoopbackRuntimeClientConfiguration(endpoint=$endpoint, " +
            "runtimeInstanceId=$runtimeInstanceId, buildConfiguration=$buildConfiguration)"
}

@Serializable
enum class RuntimeCaptureScreenshotMode {
    @SerialName("none")
    NONE,

    @SerialName("reference")
    REFERENCE,
}

@Serializable
enum class RuntimeCaptureReason {
    @SerialName("manual")
    MANUAL,

    @SerialName("before_action")
    BEFORE_ACTION,

    @SerialName("after_action")
    AFTER_ACTION,

    @SerialName("review")
    REVIEW,

    @SerialName("validation")
    VALIDATION,
}

data class RuntimeCaptureRequest(
    val includePaths: List<String>,
    val screenshot: RuntimeCaptureScreenshotMode,
    val reason: RuntimeCaptureReason,
) {
    init {
        if (
            includePaths.isEmpty() ||
            includePaths.size > 256 ||
            includePaths.any { it.isEmpty() || it.toByteArray(Charsets.UTF_8).size > 256 }
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
    }
}

/** Enforces the exact field-mask surface implemented by the Snapshot-only slice. */
fun RuntimeCaptureRequest.requireSupportedSnapshotSlice() {
    val expectedPaths = when (screenshot) {
        RuntimeCaptureScreenshotMode.NONE -> setOf(TREES_FIELD_PATH)
        RuntimeCaptureScreenshotMode.REFERENCE -> setOf(TREES_FIELD_PATH, SCREENSHOT_FIELD_PATH)
    }
    if (includePaths.size != expectedPaths.size || includePaths.toSet() != expectedPaths) {
        throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
    }
}

class RuntimeObjectPayload(
    val reference: ObjectRef,
    bytes: ByteArray,
) {
    private val isolatedBytes = bytes.copyOf()

    val bytes: ByteArray
        get() = isolatedBytes.copyOf()

    internal fun transportBytes(): ByteArray = isolatedBytes.copyOf()
}

data class RuntimeSnapshotCapturePayload(
    val snapshot: RuntimeSnapshot,
    val objects: List<RuntimeObjectPayload>,
)

fun interface RuntimeSnapshotCaptureProvider {
    suspend fun capture(request: RuntimeCaptureRequest): RuntimeSnapshotCapturePayload
}

internal data class RuntimeSessionLimits(
    val maximumLineBytes: Int,
    val maximumObjectBytes: Long,
    val maximumChunkBytes: Int,
)

internal fun requireConfiguration(condition: Boolean) {
    if (!condition) {
        throw RuntimeConnectionException(RuntimeConnectionErrorCode.INVALID_CONFIGURATION)
    }
}

private const val TREES_FIELD_PATH = "trees"
private const val SCREENSHOT_FIELD_PATH = "screenshot"
