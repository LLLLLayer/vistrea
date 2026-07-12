package dev.vistrea.runtime.connection

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RuntimeConnectionAuthenticationTest {
    @Test
    fun matchesNodeReferenceProofsAndIsolatesTokenBytes() {
        val token = TOKEN.toByteArray(Charsets.UTF_8)
        val configuration = LoopbackRuntimeClientConfiguration(
            endpoint = LoopbackRuntimeEndpoint(port = 4_321),
            authorizationToken = token,
            runtimeInstanceId = RUNTIME_INSTANCE_ID,
            buildConfiguration = RuntimeBuildConfiguration.DEBUG,
        )
        token.fill(0)

        val clientProof = RuntimeConnectionAuthentication.clientProof(
            key = configuration.authorizationKey,
            connectionAttemptId = CONNECTION_ATTEMPT_ID,
            hostNonce = HOST_NONCE,
            clientNonce = CLIENT_NONCE,
            runtimeInstanceId = RUNTIME_INSTANCE_ID,
            buildConfiguration = RuntimeBuildConfiguration.DEBUG,
            supportedVersions = listOf(RuntimeConnectionAuthentication.VERSION),
            capabilities = listOf(RuntimeConnectionAuthentication.SNAPSHOT_CAPABILITY),
        )
        assertEquals(EXPECTED_CLIENT_PROOF, clientProof)

        val hostProof = RuntimeConnectionAuthentication.hostProof(
            key = configuration.authorizationKey,
            connectionAttemptId = CONNECTION_ATTEMPT_ID,
            connectionId = CONNECTION_ID,
            hostNonce = HOST_NONCE,
            clientNonce = CLIENT_NONCE,
            runtimeInstanceId = RUNTIME_INSTANCE_ID,
            selectedVersion = RuntimeConnectionAuthentication.VERSION,
            enabledCapabilities = listOf(RuntimeConnectionAuthentication.SNAPSHOT_CAPABILITY),
        )
        assertEquals(EXPECTED_HOST_PROOF, hostProof)
        assertTrue(
            RuntimeConnectionAuthentication.verifyHostProof(
                proof = hostProof,
                key = configuration.authorizationKey,
                connectionAttemptId = CONNECTION_ATTEMPT_ID,
                connectionId = CONNECTION_ID,
                hostNonce = HOST_NONCE,
                clientNonce = CLIENT_NONCE,
                runtimeInstanceId = RUNTIME_INSTANCE_ID,
                selectedVersion = RuntimeConnectionAuthentication.VERSION,
                enabledCapabilities = listOf(RuntimeConnectionAuthentication.SNAPSHOT_CAPABILITY),
            ),
        )
        assertFalse(
            RuntimeConnectionAuthentication.verifyHostProof(
                proof = hostProof.uppercase(),
                key = configuration.authorizationKey,
                connectionAttemptId = CONNECTION_ATTEMPT_ID,
                connectionId = CONNECTION_ID,
                hostNonce = HOST_NONCE,
                clientNonce = CLIENT_NONCE,
                runtimeInstanceId = RUNTIME_INSTANCE_ID,
                selectedVersion = RuntimeConnectionAuthentication.VERSION,
                enabledCapabilities = listOf(RuntimeConnectionAuthentication.SNAPSHOT_CAPABILITY),
            ),
        )
    }

    @Test
    fun rejectsNonLoopbackAndShortAuthorizationConfiguration() {
        val endpointError = assertFailsWith<RuntimeConnectionException> {
            LoopbackRuntimeEndpoint(host = "localhost", port = 4_321)
        }
        assertEquals(RuntimeConnectionErrorCode.INVALID_CONFIGURATION, endpointError.code)

        val tokenError = assertFailsWith<RuntimeConnectionException> {
            LoopbackRuntimeClientConfiguration(
                endpoint = LoopbackRuntimeEndpoint(port = 4_321),
                authorizationToken = byteArrayOf(1),
                buildConfiguration = RuntimeBuildConfiguration.DEBUG,
            )
        }
        assertEquals(RuntimeConnectionErrorCode.INVALID_CONFIGURATION, tokenError.code)
    }

    @Test
    fun descriptionsNeverContainAuthorizationMaterial() {
        val configuration = LoopbackRuntimeClientConfiguration(
            endpoint = LoopbackRuntimeEndpoint(port = 4_321),
            authorizationToken = TOKEN.toByteArray(Charsets.UTF_8),
            buildConfiguration = RuntimeBuildConfiguration.INTERNAL,
        )
        assertFalse(configuration.toString().contains(TOKEN))
        RuntimeConnectionErrorCode.entries.forEach { code ->
            assertFalse(RuntimeConnectionException(code).toString().contains(TOKEN))
        }
    }

    private companion object {
        const val TOKEN = "vistrea-loopback-integration-token-0001"
        const val CONNECTION_ATTEMPT_ID = "attempt-1"
        const val CONNECTION_ID = "connection-1"
        const val HOST_NONCE = "host_nonce_123456"
        const val CLIENT_NONCE = "client_nonce_654321"
        const val RUNTIME_INSTANCE_ID = "runtime.kotlin.test"
        const val EXPECTED_CLIENT_PROOF =
            "8b503ddcac0e4315cee31bfbce630fe9aab916ad22f199a280d954ec8c94109e"
        const val EXPECTED_HOST_PROOF =
            "942b9661856d256499c3ac1c1ba2891f21094681ee6c5fe99498cbfc21167436"
    }
}
