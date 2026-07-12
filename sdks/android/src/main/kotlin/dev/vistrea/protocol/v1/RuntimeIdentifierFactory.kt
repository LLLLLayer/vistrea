package dev.vistrea.protocol.v1

import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant

private const val UUID_BYTE_COUNT = 16
private const val UUID_TIMESTAMP_BYTE_COUNT = 6
private const val UUID_VERSION_BYTE_INDEX = 6
private const val UUID_VARIANT_BYTE_INDEX = 8
private const val VERSION_MASK = 0x0f
private const val VERSION_SEVEN = 0x70
private const val VARIANT_MASK = 0x3f
private const val VARIANT_RFC_4122 = 0x80
private const val BYTE_MASK = 0xff
private const val UUID_GROUP_ONE_END = 8
private const val UUID_GROUP_TWO_END = 12
private const val UUID_GROUP_THREE_END = 16
private const val UUID_GROUP_FOUR_END = 20
private const val UUID_HEX_LENGTH = 32

/** Generates canonical typed UUIDv7 identifiers for runtime-produced models. */
object RuntimeIdentifierFactory {
    private val random = SecureRandom()

    fun make(prefix: String, time: Instant = Instant.now()): String {
        val bytes = ByteArray(UUID_BYTE_COUNT)
        val milliseconds = time.toEpochMilli().coerceAtLeast(0)
        for (index in 0 until UUID_TIMESTAMP_BYTE_COUNT) {
            bytes[UUID_TIMESTAMP_BYTE_COUNT - 1 - index] =
                ((milliseconds shr (index * Byte.SIZE_BITS)) and BYTE_MASK.toLong()).toByte()
        }
        val suffix = ByteArray(UUID_BYTE_COUNT - UUID_TIMESTAMP_BYTE_COUNT)
        random.nextBytes(suffix)
        suffix.copyInto(bytes, destinationOffset = UUID_TIMESTAMP_BYTE_COUNT)
        setVersionAndVariant(bytes)
        return "${prefix}_${format(bytes)}"
    }

    fun deterministic(prefix: String, seed: String): String {
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest(seed.toByteArray(Charsets.UTF_8))
            .copyOf(UUID_BYTE_COUNT)
        setVersionAndVariant(bytes)
        return "${prefix}_${format(bytes)}"
    }

    private fun setVersionAndVariant(bytes: ByteArray) {
        bytes[UUID_VERSION_BYTE_INDEX] =
            ((bytes[UUID_VERSION_BYTE_INDEX].toInt() and VERSION_MASK) or VERSION_SEVEN).toByte()
        bytes[UUID_VARIANT_BYTE_INDEX] =
            ((bytes[UUID_VARIANT_BYTE_INDEX].toInt() and VARIANT_MASK) or VARIANT_RFC_4122).toByte()
    }

    private fun format(bytes: ByteArray): String {
        val hex = bytes.joinToString(separator = "") { byte ->
            "%02x".format(byte.toInt() and BYTE_MASK)
        }
        return listOf(
            hex.substring(0, UUID_GROUP_ONE_END),
            hex.substring(UUID_GROUP_ONE_END, UUID_GROUP_TWO_END),
            hex.substring(UUID_GROUP_TWO_END, UUID_GROUP_THREE_END),
            hex.substring(UUID_GROUP_THREE_END, UUID_GROUP_FOUR_END),
            hex.substring(UUID_GROUP_FOUR_END, UUID_HEX_LENGTH),
        ).joinToString("-")
    }
}
