package dev.vistrea.protocol.v1

import java.time.Instant
import kotlinx.serialization.Serializable

private val UUID_V7_PATTERN =
    Regex("^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
private val STABLE_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
private val TIMESTAMP_PATTERN =
    Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$")
private val OBJECT_HASH_PATTERN = Regex("^sha256:[0-9a-f]{64}$")
private const val MAX_STABLE_ID_LENGTH = 256
private const val JSON_SAFE_INTEGER_MAX = 9_007_199_254_740_991L

private fun requireTypedId(value: String, prefix: String) {
    require(UUID_V7_PATTERN.matches(value) && value.startsWith(prefix + "_")) {
        "Expected a $prefix UUIDv7 identifier"
    }
}

@Serializable
@JvmInline
value class SnapshotId(val value: String) {
    init {
        requireTypedId(value, "snapshot")
    }
}

@Serializable
@JvmInline
value class ProjectId(val value: String) {
    init {
        requireTypedId(value, "project")
    }
}

@Serializable
@JvmInline
value class BuildId(val value: String) {
    init {
        requireTypedId(value, "build")
    }
}

@Serializable
@JvmInline
value class DeviceId(val value: String) {
    init {
        requireTypedId(value, "device")
    }
}

@Serializable
@JvmInline
value class TreeId(val value: String) {
    init {
        requireTypedId(value, "tree")
    }
}

@Serializable
@JvmInline
value class NodeId(val value: String) {
    init {
        requireTypedId(value, "node")
    }
}

@Serializable
@JvmInline
value class EventEpochId(val value: String) {
    init {
        requireTypedId(value, "epoch")
    }
}

@Serializable
@JvmInline
value class StableId(val value: String) {
    init {
        require(value.length in 1..MAX_STABLE_ID_LENGTH && STABLE_ID_PATTERN.matches(value)) {
            "Invalid stable identifier"
        }
    }
}

@Serializable
@JvmInline
value class Timestamp(val value: String) {
    init {
        require(
            TIMESTAMP_PATTERN.matches(value) &&
                runCatching { Instant.parse(value) }.isSuccess,
        ) {
            "Timestamp must use canonical RFC 3339 UTC form"
        }
    }
}

@Serializable
@JvmInline
value class JsonSafeUInt(val value: Long) {
    init {
        require(value in 0..JSON_SAFE_INTEGER_MAX) {
            "Value is outside the interoperable JSON unsigned integer range"
        }
    }
}

@Serializable
@JvmInline
value class JsonSafePositiveInteger(val value: Long) {
    init {
        require(value in 1..JSON_SAFE_INTEGER_MAX) {
            "Value is outside the interoperable JSON positive integer range"
        }
    }
}

@Serializable
@JvmInline
value class ObjectHash(val value: String) {
    init {
        require(OBJECT_HASH_PATTERN.matches(value)) {
            "Object hash must be a lowercase SHA-256 identifier"
        }
    }
}
