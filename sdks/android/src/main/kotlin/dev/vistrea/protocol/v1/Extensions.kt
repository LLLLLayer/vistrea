package dev.vistrea.protocol.v1

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement

private val EXTENSION_KEY_PATTERN = Regex("^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$")

@Serializable(with = ExtensionsSerializer::class)
class Extensions private constructor(
    values: Map<String, JsonElement>,
) {
    val values: Map<String, JsonElement> = LinkedHashMap(values)

    operator fun get(key: String): JsonElement? = values[key]

    fun isEmpty(): Boolean = values.isEmpty()

    override fun equals(other: Any?): Boolean =
        this === other || (other is Extensions && values == other.values)

    override fun hashCode(): Int = values.hashCode()

    override fun toString(): String = values.toString()

    companion object {
        fun empty(): Extensions = Extensions(emptyMap())

        fun of(values: Map<String, JsonElement>): Extensions {
            val invalidKey = values.keys.firstOrNull { !EXTENSION_KEY_PATTERN.matches(it) }
            require(invalidKey == null) {
                "Extension key '$invalidKey' is not namespaced"
            }
            return Extensions(values)
        }
    }
}

object ExtensionsSerializer : KSerializer<Extensions> {
    private val delegate = MapSerializer(String.serializer(), JsonElement.serializer())

    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: Extensions) {
        encoder.encodeSerializableValue(delegate, value.values)
    }

    override fun deserialize(decoder: Decoder): Extensions {
        val values = decoder.decodeSerializableValue(delegate)
        return try {
            Extensions.of(values)
        } catch (error: IllegalArgumentException) {
            throw SerializationException(error.message ?: "Invalid extensions", error)
        }
    }
}
