package dev.vistrea.runtime.connection

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

internal enum class StrictJsonLineFailure {
    LINE_TOO_LARGE,
    MALFORMED_UTF8,
    INVALID_ENVELOPE,
    DUPLICATE_KEY,
    TRUNCATED_LINE,
}

internal class StrictJsonLineException(
    val failure: StrictJsonLineFailure,
) : IllegalArgumentException("The bounded Runtime JSON-lines stream is invalid.")

internal data class StrictJsonLine(
    val source: String,
    val value: JsonObject,
)

internal class BoundedStrictJsonLineDecoder(
    maximumLineBytes: Int,
) {
    private var buffer = ByteArray(0)
    private var maximumLineBytesValue = maximumLineBytes

    fun updateMaximumLineBytes(value: Int) {
        maximumLineBytesValue = value
        validatePendingLineBound()
    }

    fun enqueue(bytes: ByteArray) {
        if (bytes.isEmpty()) {
            return
        }
        buffer += bytes
        validatePendingLineBound()
    }

    fun nextLine(): StrictJsonLine? {
        val newline = buffer.indexOf(NEWLINE)
        if (newline < 0) {
            return null
        }
        var end = newline
        if (end > 0 && buffer[end - 1] == CARRIAGE_RETURN) {
            end -= 1
        }
        if (end == 0) {
            throw StrictJsonLineException(StrictJsonLineFailure.INVALID_ENVELOPE)
        }
        if (end > maximumLineBytesValue) {
            throw StrictJsonLineException(StrictJsonLineFailure.LINE_TOO_LARGE)
        }
        val line = buffer.copyOfRange(0, end)
        buffer = buffer.copyOfRange(newline + 1, buffer.size)
        val source = decodeFatalUtf8(line)
        StrictJsonDuplicateKeyValidator(line).validateObject()
        val value = runCatching { STRICT_JSON.parseToJsonElement(source) }.getOrElse {
            throw StrictJsonLineException(StrictJsonLineFailure.INVALID_ENVELOPE)
        }
        if (value !is JsonObject) {
            throw StrictJsonLineException(StrictJsonLineFailure.INVALID_ENVELOPE)
        }
        validatePendingLineBound()
        return StrictJsonLine(source, value)
    }

    fun validateCompleteStream() {
        if (buffer.isNotEmpty()) {
            throw StrictJsonLineException(StrictJsonLineFailure.TRUNCATED_LINE)
        }
    }

    private fun validatePendingLineBound() {
        val newline = buffer.indexOf(NEWLINE).let { if (it < 0) buffer.size else it }
        val length = if (newline > 0 && buffer[newline - 1] == CARRIAGE_RETURN) {
            newline - 1
        } else {
            newline
        }
        if (length > maximumLineBytesValue) {
            throw StrictJsonLineException(StrictJsonLineFailure.LINE_TOO_LARGE)
        }
    }

    private fun decodeFatalUtf8(bytes: ByteArray): String = runCatching {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    }.getOrElse {
        throw StrictJsonLineException(StrictJsonLineFailure.MALFORMED_UTF8)
    }

    private companion object {
        const val NEWLINE: Byte = 0x0a
        const val CARRIAGE_RETURN: Byte = 0x0d
        val STRICT_JSON = Json {
            isLenient = false
            allowSpecialFloatingPointValues = false
        }
    }
}

/** Rejects duplicate object keys after JSON escape decoding. */
private class StrictJsonDuplicateKeyValidator(
    private val bytes: ByteArray,
) {
    private var index = 0

    fun validateObject() {
        skipWhitespace()
        if (peek() != OBJECT_START) {
            invalidEnvelope()
        }
        parseObject(depth = 0)
        skipWhitespace()
        if (index != bytes.size) {
            invalidEnvelope()
        }
    }

    private fun parseValue(depth: Int) {
        skipWhitespace()
        when (peek()) {
            OBJECT_START -> parseObject(depth)
            ARRAY_START -> parseArray(depth)
            QUOTE -> scanString()
            TRUE_START -> consumeLiteral(TRUE_BYTES)
            FALSE_START -> consumeLiteral(FALSE_BYTES)
            NULL_START -> consumeLiteral(NULL_BYTES)
            MINUS, in DIGIT_ZERO..DIGIT_NINE -> parseNumber()
            else -> invalidEnvelope()
        }
    }

    private fun parseObject(depth: Int) {
        if (depth >= MAXIMUM_NESTING_DEPTH || !consume(OBJECT_START)) {
            invalidEnvelope()
        }
        skipWhitespace()
        if (consume(OBJECT_END)) {
            return
        }
        val keys = mutableSetOf<String>()
        while (true) {
            skipWhitespace()
            val keyRange = scanString()
            val keySource = bytes.copyOfRange(keyRange.first, keyRange.last + 1)
                .toString(Charsets.UTF_8)
            val key = runCatching { KEY_JSON.decodeFromString<String>(keySource) }.getOrElse {
                invalidEnvelope()
            }
            if (!keys.add(key)) {
                throw StrictJsonLineException(StrictJsonLineFailure.DUPLICATE_KEY)
            }
            skipWhitespace()
            if (!consume(COLON)) {
                invalidEnvelope()
            }
            parseValue(depth + 1)
            skipWhitespace()
            if (consume(OBJECT_END)) {
                return
            }
            if (!consume(COMMA)) {
                invalidEnvelope()
            }
        }
    }

    private fun parseArray(depth: Int) {
        if (depth >= MAXIMUM_NESTING_DEPTH || !consume(ARRAY_START)) {
            invalidEnvelope()
        }
        skipWhitespace()
        if (consume(ARRAY_END)) {
            return
        }
        while (true) {
            parseValue(depth + 1)
            skipWhitespace()
            if (consume(ARRAY_END)) {
                return
            }
            if (!consume(COMMA)) {
                invalidEnvelope()
            }
        }
    }

    private fun scanString(): IntRange {
        if (peek() != QUOTE) {
            invalidEnvelope()
        }
        val start = index
        index += 1
        while (index < bytes.size) {
            val byte = bytes[index]
            index += 1
            when {
                byte == QUOTE -> return start until index
                byte == ESCAPE -> scanEscape()
                (byte.toInt() and BYTE_MASK) < SPACE -> invalidEnvelope()
            }
        }
        invalidEnvelope()
    }

    private fun scanEscape() {
        if (index >= bytes.size) {
            invalidEnvelope()
        }
        val escape = bytes[index]
        index += 1
        if (escape == UNICODE_ESCAPE) {
            if (index > bytes.size - UNICODE_HEX_DIGITS) {
                invalidEnvelope()
            }
            repeat(UNICODE_HEX_DIGITS) {
                if (!isHexadecimalDigit(bytes[index])) {
                    invalidEnvelope()
                }
                index += 1
            }
        } else if (escape !in SIMPLE_ESCAPES) {
            invalidEnvelope()
        }
    }

    private fun parseNumber() {
        consume(MINUS)
        if (consume(DIGIT_ZERO)) {
            if (peek() in DIGIT_ZERO..DIGIT_NINE) {
                invalidEnvelope()
            }
        } else {
            val first = peek()
            if (first !in DIGIT_ONE..DIGIT_NINE) {
                invalidEnvelope()
            }
            index += 1
            while (peek() in DIGIT_ZERO..DIGIT_NINE) {
                index += 1
            }
        }
        if (consume(DECIMAL_POINT)) {
            consumeDigits()
        }
        if (consume(LOWERCASE_E) || consume(UPPERCASE_E)) {
            consume(PLUS) || consume(MINUS)
            consumeDigits()
        }
    }

    private fun consumeDigits() {
        if (peek() !in DIGIT_ZERO..DIGIT_NINE) {
            invalidEnvelope()
        }
        do {
            index += 1
        } while (peek() in DIGIT_ZERO..DIGIT_NINE)
    }

    private fun consumeLiteral(expected: ByteArray) {
        if (index > bytes.size - expected.size) {
            invalidEnvelope()
        }
        for (offset in expected.indices) {
            if (bytes[index + offset] != expected[offset]) {
                invalidEnvelope()
            }
        }
        index += expected.size
    }

    private fun skipWhitespace() {
        while (peek() in WHITESPACE) {
            index += 1
        }
    }

    private fun peek(): Byte = if (index < bytes.size) bytes[index] else END_OF_INPUT

    private fun consume(value: Byte): Boolean {
        if (peek() != value) {
            return false
        }
        index += 1
        return true
    }

    private fun invalidEnvelope(): Nothing =
        throw StrictJsonLineException(StrictJsonLineFailure.INVALID_ENVELOPE)

    private fun isHexadecimalDigit(value: Byte): Boolean =
        value in DIGIT_ZERO..DIGIT_NINE ||
            value in UPPERCASE_A..UPPERCASE_F ||
            value in LOWERCASE_A..LOWERCASE_F

    private companion object {
        const val MAXIMUM_NESTING_DEPTH = 256
        const val UNICODE_HEX_DIGITS = 4
        const val END_OF_INPUT: Byte = -1
        const val BYTE_MASK = 0xff
        const val SPACE = 0x20
        const val QUOTE: Byte = 0x22
        const val PLUS: Byte = 0x2b
        const val COMMA: Byte = 0x2c
        const val MINUS: Byte = 0x2d
        const val DECIMAL_POINT: Byte = 0x2e
        const val DIGIT_ZERO: Byte = 0x30
        const val DIGIT_ONE: Byte = 0x31
        const val DIGIT_NINE: Byte = 0x39
        const val COLON: Byte = 0x3a
        const val UPPERCASE_A: Byte = 0x41
        const val UPPERCASE_E: Byte = 0x45
        const val UPPERCASE_F: Byte = 0x46
        const val ARRAY_START: Byte = 0x5b
        const val ESCAPE: Byte = 0x5c
        const val ARRAY_END: Byte = 0x5d
        const val LOWERCASE_A: Byte = 0x61
        const val LOWERCASE_E: Byte = 0x65
        const val FALSE_START: Byte = 0x66
        const val LOWERCASE_F: Byte = 0x66
        const val NULL_START: Byte = 0x6e
        const val TRUE_START: Byte = 0x74
        const val UNICODE_ESCAPE: Byte = 0x75
        const val OBJECT_START: Byte = 0x7b
        const val OBJECT_END: Byte = 0x7d
        val SIMPLE_ESCAPES = setOf<Byte>(0x22, 0x2f, 0x5c, 0x62, 0x66, 0x6e, 0x72, 0x74)
        val WHITESPACE = setOf<Byte>(0x20, 0x09, 0x0a, 0x0d)
        val TRUE_BYTES = "true".toByteArray(Charsets.UTF_8)
        val FALSE_BYTES = "false".toByteArray(Charsets.UTF_8)
        val NULL_BYTES = "null".toByteArray(Charsets.UTF_8)
        val KEY_JSON = Json { isLenient = false }
    }
}
