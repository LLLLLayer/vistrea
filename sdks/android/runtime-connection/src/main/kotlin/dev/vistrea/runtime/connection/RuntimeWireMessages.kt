package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.ObjectRef
import dev.vistrea.protocol.v1.RuntimeEventBatch
import dev.vistrea.protocol.v1.RuntimeSnapshot
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

@Serializable
internal data class WireHostChallenge(
    val type: String,
    @SerialName("connection_attempt_id")
    val connectionAttemptId: String,
    val nonce: String,
    @SerialName("supported_versions")
    val supportedVersions: List<RuntimeConnectionProtocolVersion>,
    @SerialName("supported_auth_methods")
    val supportedAuthMethods: List<String>,
    @SerialName("host_identity")
    val hostIdentity: String,
)

@Serializable
internal data class WireEventEpoch(
    @SerialName("event_epoch_id")
    val eventEpochId: String,
    @SerialName("oldest_retained_sequence")
    val oldestRetainedSequence: Long,
    @SerialName("next_sequence")
    val nextSequence: Long,
)

@Serializable
internal data class WireClientHello(
    val type: String,
    @SerialName("connection_attempt_id")
    val connectionAttemptId: String,
    @SerialName("runtime_instance_id")
    val runtimeInstanceId: String,
    @SerialName("build_configuration")
    val buildConfiguration: RuntimeBuildConfiguration,
    @SerialName("supported_versions")
    val supportedVersions: List<RuntimeConnectionProtocolVersion>,
    val capabilities: List<String>,
    @SerialName("selected_auth_method")
    val selectedAuthMethod: String,
    @SerialName("client_nonce")
    val clientNonce: String,
    @SerialName("challenge_response")
    val challengeResponse: String,
    @SerialName("event_epoch")
    val eventEpoch: WireEventEpoch? = null,
)

@Serializable
internal data class WireHostWelcome(
    val type: String,
    @SerialName("connection_id")
    val connectionId: String,
    @SerialName("selected_version")
    val selectedVersion: RuntimeConnectionProtocolVersion,
    @SerialName("enabled_capabilities")
    val enabledCapabilities: List<String>,
    @SerialName("host_proof")
    val hostProof: String,
    @SerialName("session_policy")
    val sessionPolicy: WireSessionPolicy,
    @SerialName("event_epoch")
    val eventEpoch: WireEventEpoch? = null,
)

@Serializable
internal data class WireSessionPolicy(
    @SerialName("maximum_line_bytes")
    val maximumLineBytes: Long,
    @SerialName("maximum_object_bytes")
    val maximumObjectBytes: Long,
    @SerialName("maximum_chunk_bytes")
    val maximumChunkBytes: Long,
)

@Serializable
internal data class WireError(
    val type: String,
    val code: String,
    val message: String,
)

@Serializable
internal data class WireCaptureRequest(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    val command: WireCaptureCommand,
)

@Serializable
internal data class WireCaptureCommand(
    val include: WireFieldMask,
    val screenshot: RuntimeCaptureScreenshotMode,
    val reason: RuntimeCaptureReason,
)

@Serializable
internal data class WireFieldMask(
    val paths: List<String>,
)

@Serializable
internal data class WireCaptureCancel(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
)

@Serializable
internal data class WireDisconnect(
    val type: String,
)

@Serializable
internal data class WireCaptureResult(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    val snapshot: RuntimeSnapshot,
    val objects: List<ObjectRef>,
)

@Serializable
internal data class WireObjectStart(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    @SerialName("object_index")
    val objectIndex: Int,
    val hash: String,
    @SerialName("byte_size")
    val byteSize: Int,
)

@Serializable
internal data class WireObjectChunk(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    @SerialName("object_index")
    val objectIndex: Int,
    val sequence: Long,
    val data: String,
)

@Serializable
internal data class WireObjectEnd(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    @SerialName("object_index")
    val objectIndex: Int,
    @SerialName("chunk_count")
    val chunkCount: Long,
)

@Serializable
internal data class WireCaptureComplete(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
)

@Serializable
internal data class WireCaptureCancelled(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
)

@Serializable
internal data class WireCaptureError(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    val code: String,
    val message: String,
)

@Serializable
internal data class WireEventStart(
    val mode: String,
    val sequence: Long? = null,
)

@Serializable
internal data class WireSubscribeEvents(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    @SerialName("event_epoch_id")
    val eventEpochId: String,
    @SerialName("event_kinds")
    val eventKinds: List<String>,
    val start: WireEventStart,
    @SerialName("max_batch_size")
    val maxBatchSize: Int? = null,
)

@Serializable
internal data class WireAcknowledgeEvents(
    val type: String,
    @SerialName("subscription_id")
    val subscriptionId: String,
    @SerialName("event_epoch_id")
    val eventEpochId: String,
    @SerialName("durable_through_sequence")
    val durableThroughSequence: Long,
)

@Serializable
internal data class WireUnsubscribeEvents(
    val type: String,
    @SerialName("subscription_id")
    val subscriptionId: String,
)

@Serializable
internal data class WireSubscribeResult(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    @SerialName("subscription_id")
    val subscriptionId: String,
)

@Serializable
internal data class WireSubscribeError(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    val code: String,
    @SerialName("oldest_available_sequence")
    val oldestAvailableSequence: Long? = null,
    @SerialName("next_sequence")
    val nextSequence: Long? = null,
)

@Serializable
internal data class WireEventBatch(
    val type: String,
    @SerialName("subscription_id")
    val subscriptionId: String,
    val batch: RuntimeEventBatch,
)

@Serializable
internal data class WireEventsClosed(
    val type: String,
    @SerialName("subscription_id")
    val subscriptionId: String,
    val code: String? = null,
)

@Serializable
internal data class WireApplyTuning(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    val command: WireApplyTuningCommand,
)

@Serializable
internal data class WireApplyTuningCommand(
    val patch: JsonElement,
    @SerialName("expected_snapshot_id")
    val expectedSnapshotId: String,
    @SerialName("preview_ttl_ms")
    val previewTtlMs: Long? = null,
)

@Serializable
internal data class WireRevertTuning(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    @SerialName("tuning_application_id")
    val tuningApplicationId: String,
)

@Serializable
internal data class WireTuningResult(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    val application: JsonElement,
)

@Serializable
internal data class WireTuningError(
    val type: String,
    @SerialName("request_id")
    val requestId: String,
    val code: String,
)

@Serializable
internal data class WireTuningReverted(
    val type: String,
    val application: JsonElement,
)

internal object RuntimeWireCodec {
    val format = Json {
        ignoreUnknownKeys = false
        isLenient = false
        coerceInputValues = false
        explicitNulls = false
        encodeDefaults = false
        allowSpecialFloatingPointValues = false
    }

    inline fun <reified Value> decode(source: String): Value = runCatching {
        format.decodeFromString<Value>(source)
    }.getOrElse {
        throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
    }

    inline fun <reified Value> encode(value: Value): ByteArray = runCatching {
        format.encodeToString(value).toByteArray(Charsets.UTF_8)
    }.getOrElse {
        throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
    }
}
