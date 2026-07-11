package dev.vistrea.protocol.v1

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

private val NAMESPACED_NAME_PATTERN = Regex("^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$")
private val MEDIA_TYPE_PATTERN = Regex("^[a-z0-9.+-]+/[a-z0-9.+-]+$")
private const val UINT32_MAX = 4_294_967_295L
private const val MAX_CAPABILITY_NAME_LENGTH = 128
private const val MIN_MEDIA_TYPE_LENGTH = 3
private const val MAX_MEDIA_TYPE_LENGTH = 128

@Serializable
data class ProtocolVersion(
    val major: Int,
    val minor: Long,
) {
    init {
        require(major == 1) { "Only protocol major version 1 is supported" }
        require(minor in 0..UINT32_MAX) { "Protocol minor version is outside UInt32" }
    }
}

@Serializable
data class EventTime(
    @SerialName("wall_time")
    val wallTime: Timestamp,
    @SerialName("monotonic_offset_ns")
    val monotonicOffsetNs: JsonSafeUInt? = null,
)

@Serializable
data class CapabilitySet(
    val names: List<String>,
    val extensions: Extensions,
) {
    init {
        require(names.distinct().size == names.size) { "Capability names must be unique" }
        require(
            names.all {
                it.length in 1..MAX_CAPABILITY_NAME_LENGTH && NAMESPACED_NAME_PATTERN.matches(it)
            },
        ) {
            "Capability names must be namespaced"
        }
    }
}

@Serializable
enum class CaptureLimitationSeverity {
    @SerialName("info")
    INFO,

    @SerialName("warning")
    WARNING,

    @SerialName("error")
    ERROR,
}

@Serializable
data class CaptureLimitationScope(
    @SerialName("tree_id")
    val treeId: TreeId? = null,
    @SerialName("node_id")
    val nodeId: NodeId? = null,
    val field: String? = null,
)

@Serializable
data class CaptureLimitation(
    val code: String,
    val severity: CaptureLimitationSeverity,
    val message: String,
    val scope: CaptureLimitationScope? = null,
    val retryable: Boolean,
    val extensions: Extensions,
) {
    init {
        require(NAMESPACED_NAME_PATTERN.matches(code)) { "Limitation code must be namespaced" }
    }
}

@Serializable
enum class Compression {
    @SerialName("none")
    NONE,

    @SerialName("gzip")
    GZIP,

    @SerialName("zstd")
    ZSTD,
}

@Serializable
data class EncryptionRef(
    val algorithm: String,
    @SerialName("key_id")
    val keyId: String,
)

@Serializable
data class ObjectRef(
    val hash: ObjectHash,
    @SerialName("media_type")
    val mediaType: String,
    @SerialName("byte_size")
    val byteSize: JsonSafeUInt,
    @SerialName("decoded_byte_size")
    val decodedByteSize: JsonSafeUInt? = null,
    val compression: Compression,
    val encryption: EncryptionRef? = null,
    @SerialName("redaction_profile")
    val redactionProfile: String? = null,
    @SerialName("logical_name")
    val logicalName: String? = null,
    val extensions: Extensions,
) {
    init {
        require(
            mediaType.length in MIN_MEDIA_TYPE_LENGTH..MAX_MEDIA_TYPE_LENGTH &&
                MEDIA_TYPE_PATTERN.matches(mediaType),
        ) {
            "Invalid ObjectRef media type"
        }
    }
}
