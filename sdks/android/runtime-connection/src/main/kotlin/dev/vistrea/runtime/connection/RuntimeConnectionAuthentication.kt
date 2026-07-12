@file:Suppress("LongParameterList", "MagicNumber")

package dev.vistrea.runtime.connection

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.SecretKey
import kotlinx.serialization.Serializable

private const val UINT32_MAXIMUM = 4_294_967_295L
private const val PROOF_BYTE_COUNT = 32
private const val NONCE_BYTE_COUNT = 32
private val CAPABILITY_PATTERN = Regex("^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$")
private val NONCE_PATTERN = Regex("^[A-Za-z0-9_-]{16,256}$")
private val LOWERCASE_HEX_PROOF_PATTERN = Regex("^[0-9a-f]{64}$")

@Serializable
internal data class RuntimeConnectionProtocolVersion(
    val major: Long,
    val minor: Long,
) {
    init {
        if (major !in 0..UINT32_MAXIMUM || minor !in 0..UINT32_MAXIMUM) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
    }
}

internal object RuntimeConnectionAuthentication {
    const val ALGORITHM = "HmacSHA256"
    const val METHOD = "hmac-sha256"
    const val SNAPSHOT_CAPABILITY = "runtime.snapshot"
    val VERSION = RuntimeConnectionProtocolVersion(major = 1, minor = 0)

    fun clientProof(
        key: SecretKey,
        connectionAttemptId: String,
        hostNonce: String,
        clientNonce: String,
        runtimeInstanceId: String,
        buildConfiguration: RuntimeBuildConfiguration,
        supportedVersions: List<RuntimeConnectionProtocolVersion>,
        capabilities: List<String>,
    ): String = hmacHexadecimal(
        key,
        listOf(
            "vistrea-runtime-client-v1",
            connectionAttemptId,
            hostNonce,
            clientNonce,
            runtimeInstanceId,
            buildConfiguration.name.lowercase(),
            normalizeVersions(supportedVersions).joinToString(",") { "${it.major}.${it.minor}" },
            normalizeCapabilities(capabilities).joinToString(","),
        ).joinToString("\n"),
    )

    fun hostProof(
        key: SecretKey,
        connectionAttemptId: String,
        connectionId: String,
        hostNonce: String,
        clientNonce: String,
        runtimeInstanceId: String,
        selectedVersion: RuntimeConnectionProtocolVersion,
        enabledCapabilities: List<String>,
    ): String = hmacHexadecimal(
        key,
        listOf(
            "vistrea-runtime-host-v1",
            connectionAttemptId,
            connectionId,
            hostNonce,
            clientNonce,
            runtimeInstanceId,
            "${selectedVersion.major}.${selectedVersion.minor}",
            normalizeCapabilities(enabledCapabilities).joinToString(","),
        ).joinToString("\n"),
    )

    fun verifyHostProof(
        proof: String,
        key: SecretKey,
        connectionAttemptId: String,
        connectionId: String,
        hostNonce: String,
        clientNonce: String,
        runtimeInstanceId: String,
        selectedVersion: RuntimeConnectionProtocolVersion,
        enabledCapabilities: List<String>,
    ): Boolean {
        if (!LOWERCASE_HEX_PROOF_PATTERN.matches(proof)) {
            return false
        }
        val expected = hostProof(
            key = key,
            connectionAttemptId = connectionAttemptId,
            connectionId = connectionId,
            hostNonce = hostNonce,
            clientNonce = clientNonce,
            runtimeInstanceId = runtimeInstanceId,
            selectedVersion = selectedVersion,
            enabledCapabilities = enabledCapabilities,
        )
        return MessageDigest.isEqual(proof.hexadecimalBytes(), expected.hexadecimalBytes())
    }

    fun makeNonce(): String {
        val bytes = ByteArray(NONCE_BYTE_COUNT)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    fun isNonce(value: String): Boolean = NONCE_PATTERN.matches(value)

    fun normalizeVersions(
        versions: List<RuntimeConnectionProtocolVersion>,
    ): List<RuntimeConnectionProtocolVersion> = versions.sortedWith(
        compareBy(RuntimeConnectionProtocolVersion::major, RuntimeConnectionProtocolVersion::minor),
    )

    fun normalizeCapabilities(capabilities: List<String>): List<String> = capabilities.sorted()

    fun isCapability(value: String): Boolean =
        value.toByteArray(Charsets.UTF_8).size <= 128 && CAPABILITY_PATTERN.matches(value)

    private fun hmacHexadecimal(key: SecretKey, message: String): String {
        val mac = Mac.getInstance(ALGORITHM)
        mac.init(key)
        return mac.doFinal(message.toByteArray(StandardCharsets.UTF_8)).toLowercaseHexadecimal()
    }
}

private fun ByteArray.toLowercaseHexadecimal(): String = joinToString(separator = "") {
    ((it.toInt() and 0xff) + 0x100).toString(16).substring(1)
}

private fun String.hexadecimalBytes(): ByteArray {
    val result = ByteArray(PROOF_BYTE_COUNT)
    for (index in result.indices) {
        result[index] = substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
    return result
}
