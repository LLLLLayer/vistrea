package dev.vistrea.protocol.v1

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

object RuntimeSnapshotJson {
    val format: Json = Json {
        ignoreUnknownKeys = false
        isLenient = false
        coerceInputValues = false
        explicitNulls = false
        encodeDefaults = false
        allowSpecialFloatingPointValues = false
    }

    fun decode(value: String): RuntimeSnapshot =
        format.decodeFromString<RuntimeSnapshot>(value)

    fun encode(value: RuntimeSnapshot): String =
        format.encodeToString(value)
}
