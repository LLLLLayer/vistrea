package dev.vistrea.runtime.connection

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicReference
import kotlin.system.measureTimeMillis
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

class LoopbackRuntimeClientCancellationTest {
    @Test
    fun callerCancellationClosesSocketDuringStalledHandshake() = runBlocking {
        val address = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        val server = ServerSocket(0, 1, address)
        val accepted = CompletableDeferred<Unit>()
        val peerClosed = CompletableDeferred<Unit>()
        val peerReference = AtomicReference<Socket?>()
        val serverJob = launch(Dispatchers.IO) {
            server.accept().use { peer ->
                peerReference.set(peer)
                accepted.complete(Unit)
                try {
                    peer.getInputStream().read()
                } catch (_: IOException) {
                    // A reset is equivalent to EOF for this cancellation assertion.
                } finally {
                    peerClosed.complete(Unit)
                }
            }
        }
        val client = LoopbackRuntimeClient(
            configuration = LoopbackRuntimeClientConfiguration(
                endpoint = LoopbackRuntimeEndpoint(port = server.localPort),
                authorizationToken = TOKEN.toByteArray(Charsets.UTF_8),
                runtimeInstanceId = "runtime.kotlin.cancellation",
                buildConfiguration = RuntimeBuildConfiguration.DEBUG,
                handshakeTimeoutMilliseconds = 300_000,
            ),
            captureProvider = RuntimeSnapshotCaptureProvider {
                throw AssertionError("Capture cannot run before the stalled handshake completes.")
            },
        )
        var failure: Throwable? = null
        val connectJob = launch {
            try {
                client.connect()
            } catch (error: Throwable) {
                failure = error
            }
        }

        try {
            withTimeout(5_000) { accepted.await() }
            val cancellationMilliseconds = measureTimeMillis {
                connectJob.cancel()
                withTimeout(5_000) {
                    connectJob.join()
                    peerClosed.await()
                }
            }

            assertTrue(cancellationMilliseconds < 2_000)
            assertTrue(failure is RuntimeConnectionException)
            assertEquals(
                RuntimeConnectionErrorCode.CANCELLED,
                (failure as RuntimeConnectionException).code,
            )
            assertEquals(RuntimeConnectionState.FAILED, client.state)
        } finally {
            client.close()
            peerReference.get()?.close()
            server.close()
            serverJob.cancelAndJoin()
        }
    }

    @Test
    fun closeResumesCallerDuringStalledHandshake() = runBlocking {
        val address = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        val server = ServerSocket(0, 1, address)
        val accepted = CompletableDeferred<Unit>()
        val peerClosed = CompletableDeferred<Unit>()
        val serverJob = launch(Dispatchers.IO) {
            server.accept().use { peer ->
                accepted.complete(Unit)
                try {
                    peer.getInputStream().read()
                } catch (_: IOException) {
                    // Socket close and reset are equivalent for this lifecycle assertion.
                } finally {
                    peerClosed.complete(Unit)
                }
            }
        }
        val client = LoopbackRuntimeClient(
            configuration = LoopbackRuntimeClientConfiguration(
                endpoint = LoopbackRuntimeEndpoint(port = server.localPort),
                authorizationToken = TOKEN.toByteArray(Charsets.UTF_8),
                runtimeInstanceId = "runtime.kotlin.close",
                buildConfiguration = RuntimeBuildConfiguration.DEBUG,
                handshakeTimeoutMilliseconds = 300_000,
            ),
            captureProvider = RuntimeSnapshotCaptureProvider {
                throw AssertionError("Capture cannot run before the stalled handshake completes.")
            },
        )
        var failure: Throwable? = null
        val connectJob = launch {
            try {
                client.connect()
            } catch (error: Throwable) {
                failure = error
            }
        }

        try {
            withTimeout(5_000) { accepted.await() }
            client.close()
            withTimeout(5_000) {
                connectJob.join()
                peerClosed.await()
            }

            assertTrue(failure is RuntimeConnectionException)
            assertTrue(
                (failure as RuntimeConnectionException).code in setOf(
                    RuntimeConnectionErrorCode.CANCELLED,
                    RuntimeConnectionErrorCode.UNAVAILABLE,
                ),
            )
            assertEquals(RuntimeConnectionState.CLOSED, client.state)
        } finally {
            client.close()
            server.close()
            serverJob.cancelAndJoin()
        }
    }

    private companion object {
        const val TOKEN = "vistrea-loopback-integration-token-0001"
    }
}
