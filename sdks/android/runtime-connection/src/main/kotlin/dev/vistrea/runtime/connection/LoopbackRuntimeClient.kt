@file:Suppress("ComplexCondition", "MagicNumber")

package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.ObjectRef
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive

private const val READ_BUFFER_BYTES = 64 * 1_024
private const val MAXIMUM_CAPTURE_COUNT = 32
private const val MAXIMUM_CAPTURE_OBJECTS = 256
private const val MAXIMUM_OBJECT_INDEX = MAXIMUM_CAPTURE_OBJECTS - 1
private const val MAXIMUM_CHUNK_BYTES = 4 * 1_024 * 1_024
private const val MAXIMUM_JSON_SAFE_INTEGER = 9_007_199_254_740_991L
private const val MAXIMUM_REMOTE_MESSAGE_BYTES = 4_096
private const val MAXIMUM_EVENT_KINDS = 16
private const val DEFAULT_EVENT_BATCH_LIMIT = 256
private const val MAXIMUM_EVENT_BATCH_LIMIT = 1_024
private val REQUEST_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
private val EVENT_KINDS_BY_WIRE_NAME = mapOf(
    "node_appeared" to dev.vistrea.protocol.v1.RuntimeEventKind.NODE_APPEARED,
    "node_disappeared" to dev.vistrea.protocol.v1.RuntimeEventKind.NODE_DISAPPEARED,
    "layout_changed" to dev.vistrea.protocol.v1.RuntimeEventKind.LAYOUT_CHANGED,
    "state_changed" to dev.vistrea.protocol.v1.RuntimeEventKind.STATE_CHANGED,
    "transient_presented" to dev.vistrea.protocol.v1.RuntimeEventKind.TRANSIENT_PRESENTED,
    "transient_dismissed" to dev.vistrea.protocol.v1.RuntimeEventKind.TRANSIENT_DISMISSED,
    "screen_changed" to dev.vistrea.protocol.v1.RuntimeEventKind.SCREEN_CHANGED,
)

private const val MINIMUM_TUNING_TTL_MILLISECONDS = 100L
private const val MAXIMUM_TUNING_TTL_MILLISECONDS = 3_600_000L

private data class RuntimeHandshakeContext(
    val connectionAttemptId: String,
    val hostNonce: String,
    val clientNonce: String,
)

private data class ActiveTuningState(
    val application: kotlinx.serialization.json.JsonObject,
    val restoreEntries: List<RuntimeTuningRestoreEntry>,
    val ttlJob: Job?,
)

internal data class ValidatedRuntimeObject(
    val reference: ObjectRef,
    val bytes: ByteArray,
)

internal data class ValidatedRuntimeCapture(
    val snapshot: dev.vistrea.protocol.v1.RuntimeSnapshot,
    val objects: List<ValidatedRuntimeObject>,
)

/**
 * Authenticated Snapshot-only client for the Node loopback Runtime Host.
 *
 * Only literal loopback endpoints and Debug/Internal build configurations are
 * accepted. The client transports canonical protocol values produced by the
 * injected capture provider and never defines a private Snapshot model.
 */
class LoopbackRuntimeClient(
    private val configuration: LoopbackRuntimeClientConfiguration,
    private val captureProvider: RuntimeSnapshotCaptureProvider,
    private val eventRecorder: RuntimeEventRecorder? = null,
    private val tuningController: RuntimeTuningApplying? = null,
) {
    @Volatile
    var state: RuntimeConnectionState = RuntimeConnectionState.DISCONNECTED
        private set

    @Volatile
    var connectionId: String? = null
        private set

    @Volatile
    var eventStreamingEnabled: Boolean = false
        private set

    @Volatile
    var tuningEnabled: Boolean = false
        private set

    private val lifecycleLock = Any()
    private val captureLock = Any()
    private val socketLock = Any()
    private val eventLock = Any()
    private val tuningLock = Any()
    private val sendMutex = Mutex()

    // Every launched coroutine already maps failures to terminal connection or
    // request states; the handler guarantees that nothing an app-implemented
    // provider or controller throws ever escapes to the process default
    // handler and crashes the host application.
    private val containedExceptionHandler = CoroutineExceptionHandler { _, _ -> }
    private val scope =
        CoroutineScope(SupervisorJob() + Dispatchers.IO + containedExceptionHandler)
    private val terminal = CompletableDeferred<Unit>()
    private val lineDecoder = BoundedStrictJsonLineDecoder(configuration.maximumInboundLineBytes)
    private val captureJobs = mutableMapOf<String, Job>()

    @Volatile
    private var eventSubscriptionId: String? = null
    private var eventPumpJob: Job? = null

    @Volatile
    private var lastCapturedSnapshotId: String? = null
    private val activeTunings = mutableMapOf<String, ActiveTuningState>()

    // Restore failures cannot travel in the schema-fixed terminal application,
    // so they are tracked here instead of being silently claimed as success.
    private val unrestoredTuningChanges = AtomicLong(0)
    internal val unrestoredTuningChangeCount: Long
        get() = unrestoredTuningChanges.get()
    @Volatile
    private var socket: Socket? = null

    @Volatile
    private var input: InputStream? = null

    @Volatile
    private var output: OutputStream? = null
    private var receiveJob: Job? = null
    private var sessionLimits: RuntimeSessionLimits? = null

    suspend fun connect() {
        synchronized(lifecycleLock) {
            if (state != RuntimeConnectionState.DISCONNECTED) {
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
            }
            state = RuntimeConnectionState.CONNECTING
        }
        try {
            establishAuthenticatedConnection()
            coroutineContext.ensureActive()
            receiveJob = scope.launch { receiveReadyMessages() }
        } catch (error: CancellationException) {
            shutdown(
                terminalState = RuntimeConnectionState.FAILED,
                error = RuntimeConnectionException(RuntimeConnectionErrorCode.CANCELLED),
            )
            // Caller cancellation must keep the coroutine cancellation contract.
            throw error
        } catch (error: RuntimeConnectionException) {
            shutdown(RuntimeConnectionState.FAILED, error)
            throw error
        }
    }

    suspend fun runUntilClosed() {
        try {
            connect()
            terminal.await()
        } catch (error: CancellationException) {
            shutdown(
                terminalState = RuntimeConnectionState.FAILED,
                error = RuntimeConnectionException(RuntimeConnectionErrorCode.CANCELLED),
            )
            // Caller cancellation must keep the coroutine cancellation contract.
            throw error
        }
    }

    suspend fun waitUntilClosed() {
        terminal.await()
    }

    fun close() {
        synchronized(lifecycleLock) {
            if (state == RuntimeConnectionState.CLOSED || state == RuntimeConnectionState.FAILED) {
                return
            }
            state = RuntimeConnectionState.CLOSING
        }
        shutdown(RuntimeConnectionState.CLOSED, error = null)
    }

    private suspend fun establishAuthenticatedConnection() {
        suspendCancellableCoroutine { continuation ->
            val resolutionClaimed = AtomicBoolean(false)
            val worker = scope.launch(Dispatchers.IO) {
                runConnectionAttempt(continuation, resolutionClaimed)
            }
            continuation.invokeOnCancellation {
                resolutionClaimed.compareAndSet(false, true)
                closeTransportSocket()
                worker.cancel()
            }
            worker.invokeOnCompletion { cause ->
                if (cause is CancellationException) {
                    resumeConnection(
                        continuation,
                        resolutionClaimed,
                        RuntimeConnectionException(RuntimeConnectionErrorCode.CANCELLED),
                    )
                }
            }
        }
    }

    @Suppress("TooGenericExceptionCaught")
    private suspend fun runConnectionAttempt(
        continuation: CancellableContinuation<Unit>,
        resolutionClaimed: AtomicBoolean,
    ) {
        val error = try {
            connectAndAuthenticate()
            null
        } catch (failure: Exception) {
            mapConnectionFailure(failure)
        }
        resumeConnection(continuation, resolutionClaimed, error)
    }

    private suspend fun connectAndAuthenticate() {
        coroutineContext.ensureActive()
        openSocket()
        synchronized(lifecycleLock) {
            if (state != RuntimeConnectionState.CONNECTING) {
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
            }
            state = RuntimeConnectionState.AUTHENTICATING
        }
        authenticate()
        coroutineContext.ensureActive()
    }

    private fun mapConnectionFailure(error: Exception): RuntimeConnectionException = when (error) {
        is CancellationException -> RuntimeConnectionException(RuntimeConnectionErrorCode.CANCELLED)
        is SocketTimeoutException -> RuntimeConnectionException(RuntimeConnectionErrorCode.TIMEOUT)
        is RuntimeConnectionException -> error
        is IOException, is SecurityException ->
            RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
        else -> RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
    }

    private fun resumeConnection(
        continuation: CancellableContinuation<Unit>,
        resolutionClaimed: AtomicBoolean,
        error: RuntimeConnectionException?,
    ) {
        if (!resolutionClaimed.compareAndSet(false, true)) {
            return
        }
        if (error == null) {
            continuation.resumeWith(Result.success(Unit))
        } else {
            continuation.resumeWith(Result.failure(error))
        }
    }

    private suspend fun openSocket() {
        val endpoint = configuration.endpoint
        val address = when (endpoint.host) {
            "127.0.0.1" -> InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
            "::1" -> InetAddress.getByAddress(ByteArray(15) + byteArrayOf(1))
            else -> throw RuntimeConnectionException(RuntimeConnectionErrorCode.INVALID_CONFIGURATION)
        }
        val created = Socket()
        synchronized(socketLock) {
            if (state != RuntimeConnectionState.CONNECTING) {
                created.close()
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
            }
            socket = created
        }
        try {
            coroutineContext.ensureActive()
            created.tcpNoDelay = true
            created.connect(
                InetSocketAddress(address, endpoint.port),
                configuration.handshakeTimeoutMilliseconds.toInt(),
            )
            created.soTimeout = configuration.handshakeTimeoutMilliseconds.toInt()
            input = BufferedInputStream(created.getInputStream(), READ_BUFFER_BYTES)
            output = BufferedOutputStream(created.getOutputStream(), READ_BUFFER_BYTES)
        } catch (error: IOException) {
            closeTransportSocket()
            throw error
        }
    }

    private suspend fun authenticate() {
        val challengeLine = readNextLine()
        if (messageType(challengeLine) == "error") {
            throw remoteConnectionError(RuntimeWireCodec.decode<WireError>(challengeLine.source))
        }
        val challenge = RuntimeWireCodec.decode<WireHostChallenge>(challengeLine.source)
        validateChallenge(challenge)

        val clientNonce = RuntimeConnectionAuthentication.makeNonce()
        val versions = listOf(RuntimeConnectionAuthentication.VERSION)
        val recorderEpoch = eventRecorder?.epoch()
        val capabilities = buildList {
            if (tuningController != null) {
                add(RuntimeConnectionAuthentication.TUNING_CAPABILITY)
            }
            if (recorderEpoch != null) {
                add(RuntimeConnectionAuthentication.EVENTS_CAPABILITY)
            }
            add(RuntimeConnectionAuthentication.SNAPSHOT_CAPABILITY)
        }.sorted()
        val proof = RuntimeConnectionAuthentication.clientProof(
            key = configuration.authorizationKey,
            connectionAttemptId = challenge.connectionAttemptId,
            hostNonce = challenge.nonce,
            clientNonce = clientNonce,
            runtimeInstanceId = configuration.runtimeInstanceId,
            buildConfiguration = configuration.buildConfiguration,
            supportedVersions = versions,
            capabilities = capabilities,
        )
        send(
            WireClientHello(
                type = "client_hello",
                connectionAttemptId = challenge.connectionAttemptId,
                runtimeInstanceId = configuration.runtimeInstanceId,
                buildConfiguration = configuration.buildConfiguration,
                supportedVersions = versions,
                capabilities = capabilities,
                selectedAuthMethod = RuntimeConnectionAuthentication.METHOD,
                clientNonce = clientNonce,
                challengeResponse = proof,
                eventEpoch = recorderEpoch?.let {
                    WireEventEpoch(
                        eventEpochId = it.eventEpochId,
                        oldestRetainedSequence = it.oldestRetainedSequence,
                        nextSequence = it.nextSequence,
                    )
                },
            ),
        )
        val context = RuntimeHandshakeContext(
            connectionAttemptId = challenge.connectionAttemptId,
            hostNonce = challenge.nonce,
            clientNonce = clientNonce,
        )

        val welcomeLine = readNextLine()
        if (messageType(welcomeLine) == "error") {
            throw remoteConnectionError(RuntimeWireCodec.decode<WireError>(welcomeLine.source))
        }
        val welcome = RuntimeWireCodec.decode<WireHostWelcome>(welcomeLine.source)
        acceptWelcome(welcome, context)
    }

    private fun validateChallenge(challenge: WireHostChallenge) {
        val versions = challenge.supportedVersions
        val authMethods = challenge.supportedAuthMethods
        val distinctVersions = versions.distinct().size == versions.size
        val distinctAuthMethods = authMethods.distinct().size == authMethods.size
        if (
            challenge.type != "host_challenge" ||
            !isBoundedString(challenge.connectionAttemptId, 128) ||
            !RuntimeConnectionAuthentication.isNonce(challenge.nonce) ||
            !isBoundedString(challenge.hostIdentity, 256) ||
            versions.size !in 1..32 ||
            !distinctVersions ||
            RuntimeConnectionAuthentication.VERSION !in versions ||
            authMethods.size !in 1..16 ||
            !distinctAuthMethods ||
            authMethods.any { !isBoundedString(it, 64) } ||
            RuntimeConnectionAuthentication.METHOD !in authMethods
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.NEGOTIATION_FAILED)
        }
    }

    private suspend fun acceptWelcome(welcome: WireHostWelcome, context: RuntimeHandshakeContext) {
        val enabledSet = RuntimeConnectionAuthentication.normalizeCapabilities(
            welcome.enabledCapabilities,
        ).toSet()
        val offered = buildSet {
            add(RuntimeConnectionAuthentication.SNAPSHOT_CAPABILITY)
            if (eventRecorder != null) {
                add(RuntimeConnectionAuthentication.EVENTS_CAPABILITY)
            }
            if (tuningController != null) {
                add(RuntimeConnectionAuthentication.TUNING_CAPABILITY)
            }
        }
        val proofIsValid = RuntimeConnectionAuthentication.verifyHostProof(
            proof = welcome.hostProof,
            key = configuration.authorizationKey,
            connectionAttemptId = context.connectionAttemptId,
            connectionId = welcome.connectionId,
            hostNonce = context.hostNonce,
            clientNonce = context.clientNonce,
            runtimeInstanceId = configuration.runtimeInstanceId,
            selectedVersion = welcome.selectedVersion,
            enabledCapabilities = welcome.enabledCapabilities,
        )
        if (
            welcome.type != "host_welcome" ||
            !isBoundedString(welcome.connectionId, 128) ||
            welcome.selectedVersion != RuntimeConnectionAuthentication.VERSION ||
            welcome.enabledCapabilities.distinct().size != welcome.enabledCapabilities.size ||
            welcome.enabledCapabilities.any { !RuntimeConnectionAuthentication.isCapability(it) } ||
            RuntimeConnectionAuthentication.SNAPSHOT_CAPABILITY !in enabledSet ||
            !offered.containsAll(enabledSet) ||
            !proofIsValid
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.AUTHENTICATION_FAILED)
        }
        val eventsEnabled = RuntimeConnectionAuthentication.EVENTS_CAPABILITY in enabledSet
        if (eventsEnabled) {
            val recorder = eventRecorder
            if (
                recorder == null ||
                welcome.eventEpoch?.eventEpochId != recorder.epoch().eventEpochId
            ) {
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.NEGOTIATION_FAILED)
            }
        } else if (welcome.eventEpoch != null) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.NEGOTIATION_FAILED)
        }
        val limits = validateSessionPolicy(welcome.sessionPolicy)
        lineDecoder.updateMaximumLineBytes(limits.maximumLineBytes)
        sessionLimits = limits
        connectionId = welcome.connectionId
        eventStreamingEnabled = eventsEnabled
        tuningEnabled = RuntimeConnectionAuthentication.TUNING_CAPABILITY in enabledSet
        socket?.soTimeout = 0
        synchronized(lifecycleLock) {
            if (state != RuntimeConnectionState.AUTHENTICATING) {
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
            }
            state = RuntimeConnectionState.READY
        }
    }

    private fun validateSessionPolicy(policy: WireSessionPolicy): RuntimeSessionLimits {
        val lineBytes = policy.maximumLineBytes
        val objectBytes = policy.maximumObjectBytes
        val chunkBytes = policy.maximumChunkBytes
        if (
            lineBytes !in 1_024L..configuration.maximumInboundLineBytes.toLong() ||
            lineBytes > Int.MAX_VALUE ||
            objectBytes !in 1..MAXIMUM_JSON_SAFE_INTEGER ||
            chunkBytes !in 1..MAXIMUM_CHUNK_BYTES.toLong() ||
            chunkBytes > objectBytes ||
            !objectChunkFitsLine(chunkBytes.toInt(), lineBytes.toInt())
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.NEGOTIATION_FAILED)
        }
        return RuntimeSessionLimits(
            maximumLineBytes = lineBytes.toInt(),
            maximumObjectBytes = objectBytes,
            maximumChunkBytes = chunkBytes.toInt(),
        )
    }

    // One exhaustive fail-closed dispatcher keeps ready-state transitions auditable.
    @Suppress("CognitiveComplexMethod", "CyclomaticComplexMethod", "NestedBlockDepth")
    private suspend fun receiveReadyMessages() {
        try {
            while (state == RuntimeConnectionState.READY) {
                val line = readNextLine()
                when (messageType(line)) {
                    "capture_request" -> startCapture(
                        RuntimeWireCodec.decode<WireCaptureRequest>(line.source),
                    )
                    "capture_cancel" -> cancelCapture(
                        RuntimeWireCodec.decode<WireCaptureCancel>(line.source),
                    )
                    "subscribe_events" -> subscribeEvents(
                        RuntimeWireCodec.decode<WireSubscribeEvents>(line.source),
                    )
                    "acknowledge_events" -> acknowledgeEvents(
                        RuntimeWireCodec.decode<WireAcknowledgeEvents>(line.source),
                    )
                    "unsubscribe_events" -> unsubscribeEvents(
                        RuntimeWireCodec.decode<WireUnsubscribeEvents>(line.source),
                    )
                    "apply_tuning" -> applyTuning(
                        RuntimeWireCodec.decode<WireApplyTuning>(line.source),
                    )
                    "revert_tuning" -> revertTuning(
                        RuntimeWireCodec.decode<WireRevertTuning>(line.source),
                    )
                    "disconnect" -> {
                        val disconnect = RuntimeWireCodec.decode<WireDisconnect>(line.source)
                        if (disconnect.type != "disconnect") {
                            throw RuntimeConnectionException(
                                RuntimeConnectionErrorCode.PROTOCOL_VIOLATION,
                            )
                        }
                        shutdown(RuntimeConnectionState.CLOSED, error = null)
                    }
                    "error" -> throw remoteConnectionError(
                        RuntimeWireCodec.decode<WireError>(line.source),
                    )
                    else -> throw RuntimeConnectionException(
                        RuntimeConnectionErrorCode.PROTOCOL_VIOLATION,
                    )
                }
            }
        } catch (_: CancellationException) {
            if (state != RuntimeConnectionState.CLOSED && state != RuntimeConnectionState.FAILED) {
                shutdown(
                    RuntimeConnectionState.FAILED,
                    RuntimeConnectionException(RuntimeConnectionErrorCode.CANCELLED),
                )
            }
        } catch (error: RuntimeConnectionException) {
            if (state != RuntimeConnectionState.CLOSED && state != RuntimeConnectionState.FAILED) {
                shutdown(RuntimeConnectionState.FAILED, error)
            }
        } catch (_: Exception) {
            if (state != RuntimeConnectionState.CLOSED && state != RuntimeConnectionState.FAILED) {
                shutdown(
                    RuntimeConnectionState.FAILED,
                    RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE),
                )
            }
        }
    }

    private fun startCapture(message: WireCaptureRequest) {
        if (message.type != "capture_request" || !REQUEST_ID_PATTERN.matches(message.requestId)) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val request = RuntimeCaptureRequest(
            includePaths = message.command.include.paths,
            screenshot = message.command.screenshot,
            reason = message.command.reason,
        )
        lateinit var job: Job
        synchronized(captureLock) {
            if (captureJobs.containsKey(message.requestId) || captureJobs.size >= MAXIMUM_CAPTURE_COUNT) {
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
            }
            job = scope.launch(start = CoroutineStart.LAZY) {
                performCapture(message.requestId, request, coroutineContext[Job]!!)
            }
            captureJobs[message.requestId] = job
        }
        job.start()
    }

    private suspend fun performCapture(requestId: String, request: RuntimeCaptureRequest, job: Job) {
        var terminalClaimed = false
        try {
            request.requireSupportedSnapshotSlice()
            val payload = captureProvider.capture(request)
            coroutineContext.ensureActive()
            val validated = RuntimeCapturePayloadValidator.validate(
                payload,
                sessionLimits ?: throw RuntimeConnectionException(
                    RuntimeConnectionErrorCode.PROTOCOL_VIOLATION,
                ),
            )
            sendCaptureBody(requestId, validated)
            if (!claimCaptureTerminal(requestId, job)) {
                return
            }
            terminalClaimed = true
            // The tuning staleness check may only reference Snapshots whose
            // capture bodies the Host fully received; a cancelled or failed
            // capture never claims the terminal and never stamps.
            lastCapturedSnapshotId = validated.snapshot.snapshotId.value
            send(WireCaptureComplete(type = "capture_complete", requestId = requestId))
        } catch (_: CancellationException) {
            // A Host cancellation already owns the claim; provider-local cancellation reports error.
            reportCaptureFailure(requestId, job)
        } catch (error: RuntimeConnectionException) {
            if (terminalClaimed) {
                shutdown(RuntimeConnectionState.FAILED, error)
            } else {
                reportCaptureFailure(requestId, job)
            }
        } catch (_: Exception) {
            if (terminalClaimed) {
                shutdown(
                    RuntimeConnectionState.FAILED,
                    RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE),
                )
            } else {
                reportCaptureFailure(requestId, job)
            }
        }
    }

    private suspend fun reportCaptureFailure(requestId: String, job: Job) {
        if (!claimCaptureTerminal(requestId, job) || state != RuntimeConnectionState.READY) {
            return
        }
        try {
            send(
                WireCaptureError(
                    type = "capture_error",
                    requestId = requestId,
                    code = "capture_failed",
                    message = "Runtime capture failed.",
                ),
            )
        } catch (error: RuntimeConnectionException) {
            shutdown(RuntimeConnectionState.FAILED, error)
        } catch (_: Exception) {
            shutdown(
                RuntimeConnectionState.FAILED,
                RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE),
            )
        }
    }

    @Suppress("CognitiveComplexMethod", "CyclomaticComplexMethod", "ReturnCount", "LongMethod")
    private suspend fun subscribeEvents(message: WireSubscribeEvents) {
        val recorder = eventRecorder
        if (
            message.type != "subscribe_events" ||
            !REQUEST_ID_PATTERN.matches(message.requestId) ||
            !eventStreamingEnabled ||
            recorder == null ||
            eventSubscriptionId != null ||
            message.eventKinds.isEmpty() ||
            message.eventKinds.size > MAXIMUM_EVENT_KINDS ||
            message.eventKinds.distinct().size != message.eventKinds.size
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val limit = message.maxBatchSize ?: DEFAULT_EVENT_BATCH_LIMIT
        if (limit !in 1..MAXIMUM_EVENT_BATCH_LIMIT) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val requestedKinds = message.eventKinds.map { EVENT_KINDS_BY_WIRE_NAME[it] }
        if (requestedKinds.any { it == null }) {
            send(
                WireSubscribeError(
                    type = "subscribe_error",
                    requestId = message.requestId,
                    code = "unsupported",
                ),
            )
            return
        }

        val epoch = recorder.epoch()
        val cursor = when (message.start.mode) {
            "after_sequence" -> message.start.sequence
                ?: throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
            "oldest_retained" -> (epoch.oldestRetainedSequence - 1).coerceAtLeast(0)
            "tail" -> epoch.nextSequence - 1
            else -> throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        if (
            message.eventEpochId != epoch.eventEpochId ||
            (message.start.mode == "after_sequence" && cursor + 1 < epoch.oldestRetainedSequence)
        ) {
            // The requested epoch or range is no longer resolvable; report the
            // recoverable boundary instead of silently skipping evidence.
            send(
                WireSubscribeError(
                    type = "subscribe_error",
                    requestId = message.requestId,
                    code = "conflict",
                    oldestAvailableSequence = epoch.oldestRetainedSequence,
                    nextSequence = epoch.nextSequence,
                ),
            )
            return
        }

        val subscriptionId = RuntimeConnectionAuthentication.makeNonce()
        val kinds = requestedKinds.filterNotNull().toSet()
        synchronized(eventLock) {
            eventSubscriptionId = subscriptionId
            eventPumpJob = scope.launch(start = CoroutineStart.LAZY) {
                pumpEvents(recorder, subscriptionId, cursor, kinds, limit)
            }
        }
        send(
            WireSubscribeResult(
                type = "subscribe_result",
                requestId = message.requestId,
                subscriptionId = subscriptionId,
            ),
        )
        synchronized(eventLock) { eventPumpJob }?.start()
    }

    @Suppress("TooGenericExceptionCaught")
    private suspend fun pumpEvents(
        recorder: RuntimeEventRecorder,
        subscriptionId: String,
        initialCursor: Long,
        kinds: Set<dev.vistrea.protocol.v1.RuntimeEventKind>,
        limit: Int,
    ) {
        var cursor = initialCursor
        try {
            while (state == RuntimeConnectionState.READY && eventSubscriptionId == subscriptionId) {
                coroutineContext.ensureActive()
                val batch = recorder.batchAfter(cursor, kinds, limit)
                if (batch == null) {
                    recorder.waitForEvents(after = cursor)
                    continue
                }
                if (state != RuntimeConnectionState.READY || eventSubscriptionId != subscriptionId) {
                    return
                }
                send(
                    WireEventBatch(
                        type = "event_batch",
                        subscriptionId = subscriptionId,
                        batch = batch,
                    ),
                )
                cursor = batch.lastSequence.value
            }
        } catch (_: CancellationException) {
            // Local unsubscribe or shutdown already owns the terminal state.
        } catch (error: RuntimeConnectionException) {
            if (state == RuntimeConnectionState.READY) {
                shutdown(RuntimeConnectionState.FAILED, error)
            }
        } catch (_: Exception) {
            if (state == RuntimeConnectionState.READY) {
                shutdown(
                    RuntimeConnectionState.FAILED,
                    RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION),
                )
            }
        }
    }

    private suspend fun acknowledgeEvents(message: WireAcknowledgeEvents) {
        val recorder = eventRecorder
        if (
            message.type != "acknowledge_events" ||
            !eventStreamingEnabled ||
            recorder == null ||
            message.subscriptionId != eventSubscriptionId ||
            message.durableThroughSequence < 0
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        if (message.eventEpochId != recorder.epoch().eventEpochId) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        recorder.releaseThrough(message.durableThroughSequence)
    }

    private fun unsubscribeEvents(message: WireUnsubscribeEvents) {
        if (message.type != "unsubscribe_events" || message.subscriptionId != eventSubscriptionId) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val job = synchronized(eventLock) {
            eventSubscriptionId = null
            eventPumpJob.also { eventPumpJob = null }
        }
        job?.cancel(CancellationException("Runtime event subscription closed by Host."))
    }

    private suspend fun applyTuning(message: WireApplyTuning) {
        val controller = tuningController
        val boundConnectionId = connectionId
        val ttl = message.command.previewTtlMs
        if (
            message.type != "apply_tuning" ||
            !REQUEST_ID_PATTERN.matches(message.requestId) ||
            !tuningEnabled ||
            controller == null ||
            boundConnectionId == null ||
            (ttl != null && ttl !in MINIMUM_TUNING_TTL_MILLISECONDS..MAXIMUM_TUNING_TTL_MILLISECONDS)
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val activeTargetStableIds = synchronized(tuningLock) {
            activeTunings.values.flatMapTo(mutableSetOf()) { state ->
                state.restoreEntries.map(RuntimeTuningRestoreEntry::stableId)
            }
        }
        val outcome = try {
            RuntimeTuningProcessor.apply(
                patch = message.command.patch,
                expectedSnapshotId = message.command.expectedSnapshotId,
                lastCapturedSnapshotId = lastCapturedSnapshotId,
                connectionId = boundConnectionId,
                controller = controller,
                activeTargetStableIds = activeTargetStableIds,
            )
        } catch (_: RuntimeConnectionException) {
            send(
                WireTuningError(
                    type = "tuning_error",
                    requestId = message.requestId,
                    code = "conflict",
                ),
            )
            return
        }
        var application = outcome.application
        if (outcome.isActive) {
            val applicationId = (application["tuning_application_id"] as? JsonPrimitive)
                ?.takeIf(JsonPrimitive::isString)?.content
                ?: throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
            var ttlJob: Job? = null
            if (ttl != null) {
                application = kotlinx.serialization.json.JsonObject(
                    application + ("preview_expires_at" to JsonPrimitive(
                        RuntimeTuningProcessor.previewExpiryTimestamp(ttl),
                    )),
                )
                ttlJob = scope.launch(start = CoroutineStart.LAZY) {
                    delay(ttl)
                    expireTuning(applicationId)
                }
            }
            synchronized(tuningLock) {
                activeTunings[applicationId] = ActiveTuningState(
                    application = application,
                    restoreEntries = outcome.restoreEntries,
                    ttlJob = ttlJob,
                )
            }
            ttlJob?.start()
        }
        send(
            WireTuningResult(
                type = "tuning_result",
                requestId = message.requestId,
                application = application,
            ),
        )
    }

    private suspend fun revertTuning(message: WireRevertTuning) {
        if (
            message.type != "revert_tuning" ||
            !REQUEST_ID_PATTERN.matches(message.requestId) ||
            !tuningEnabled
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val active = synchronized(tuningLock) {
            activeTunings.remove(message.tuningApplicationId)
        }
        if (active == null) {
            send(
                WireTuningError(
                    type = "tuning_error",
                    requestId = message.requestId,
                    code = "conflict",
                ),
            )
            return
        }
        active.ttlJob?.cancel()
        restoreTuningEntries(active.restoreEntries)
        send(
            WireTuningResult(
                type = "revert_result",
                requestId = message.requestId,
                application = RuntimeTuningProcessor.terminalApplication(
                    active.application,
                    reason = "explicit_revert",
                ),
            ),
        )
    }

    @Suppress("TooGenericExceptionCaught", "SwallowedException")
    private suspend fun expireTuning(applicationId: String) {
        if (state != RuntimeConnectionState.READY) {
            return
        }
        val active = synchronized(tuningLock) {
            activeTunings.remove(applicationId)
        } ?: return
        restoreTuningEntries(active.restoreEntries)
        try {
            send(
                WireTuningReverted(
                    type = "tuning_reverted",
                    application = RuntimeTuningProcessor.terminalApplication(
                        active.application,
                        reason = "ttl_expiry",
                    ),
                ),
            )
        } catch (error: Exception) {
            // The preview is already restored; a vanished connection needs no report.
        }
    }

    // Every override must stay reversible: restores run to completion even
    // when the owning scope is cancelled mid-restore, and one failing entry
    // never prevents the remaining originals from being restored.
    @Suppress("TooGenericExceptionCaught")
    private suspend fun restoreTuningEntries(entries: List<RuntimeTuningRestoreEntry>) {
        val controller = tuningController ?: return
        withContext(NonCancellable) {
            for (entry in entries.reversed()) {
                val restored = try {
                    controller.setAlpha(entry.stableId, entry.originalAlpha)
                } catch (_: Exception) {
                    false
                }
                if (!restored) {
                    unrestoredTuningChanges.incrementAndGet()
                }
            }
        }
    }

    private suspend fun cancelCapture(message: WireCaptureCancel) {
        if (message.type != "capture_cancel" || !REQUEST_ID_PATTERN.matches(message.requestId)) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val job = synchronized(captureLock) { captureJobs.remove(message.requestId) } ?: return
        job.cancel(CancellationException("Runtime capture cancelled by Host."))
        send(WireCaptureCancelled(type = "capture_cancelled", requestId = message.requestId))
    }

    private suspend fun sendCaptureBody(requestId: String, payload: ValidatedRuntimeCapture) {
        val limits = sessionLimits
            ?: throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        coroutineContext.ensureActive()
        send(
            WireCaptureResult(
                type = "capture_result",
                requestId = requestId,
                snapshot = payload.snapshot,
                objects = payload.objects.map(ValidatedRuntimeObject::reference),
            ),
        )
        for ((index, objectValue) in payload.objects.withIndex()) {
            coroutineContext.ensureActive()
            send(
                WireObjectStart(
                    type = "object_start",
                    requestId = requestId,
                    objectIndex = index,
                    hash = objectValue.reference.hash.value,
                    byteSize = objectValue.bytes.size,
                ),
            )
            var offset = 0
            var sequence = 0L
            while (offset < objectValue.bytes.size) {
                coroutineContext.ensureActive()
                val end = minOf(offset + limits.maximumChunkBytes, objectValue.bytes.size)
                val encoded = Base64.getEncoder().encodeToString(
                    objectValue.bytes.copyOfRange(offset, end),
                )
                send(
                    WireObjectChunk(
                        type = "object_chunk",
                        requestId = requestId,
                        objectIndex = index,
                        sequence = sequence,
                        data = encoded,
                    ),
                )
                offset = end
                sequence += 1
            }
            coroutineContext.ensureActive()
            send(
                WireObjectEnd(
                    type = "object_end",
                    requestId = requestId,
                    objectIndex = index,
                    chunkCount = sequence,
                ),
            )
        }
    }

    private suspend inline fun <reified Message> send(message: Message) {
        val encoded = RuntimeWireCodec.encode(message)
        val maximumLineBytes = sessionLimits?.maximumLineBytes
            ?: configuration.maximumInboundLineBytes
        if (encoded.isEmpty() || encoded.size > maximumLineBytes) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.RESOURCE_EXHAUSTED)
        }
        val line = encoded + byteArrayOf(0x0a)
        sendMutex.withLock {
            withContext(Dispatchers.IO) {
                val stream = output
                    ?: throw RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
                try {
                    stream.write(line)
                    stream.flush()
                } catch (_: Exception) {
                    throw RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
                }
            }
        }
    }

    private fun readNextLine(): StrictJsonLine {
        try {
            while (true) {
                lineDecoder.nextLine()?.let { return it }
                val stream = input
                    ?: throw RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
                val bytes = ByteArray(READ_BUFFER_BYTES)
                val count = stream.read(bytes)
                if (count < 0) {
                    lineDecoder.validateCompleteStream()
                    throw RuntimeConnectionException(RuntimeConnectionErrorCode.UNAVAILABLE)
                }
                if (count > 0) {
                    lineDecoder.enqueue(bytes.copyOf(count))
                }
            }
        } catch (error: StrictJsonLineException) {
            val code = if (error.failure == StrictJsonLineFailure.LINE_TOO_LARGE) {
                RuntimeConnectionErrorCode.RESOURCE_EXHAUSTED
            } else {
                RuntimeConnectionErrorCode.PROTOCOL_VIOLATION
            }
            throw RuntimeConnectionException(code)
        }
    }

    private fun messageType(line: StrictJsonLine): String {
        val value = line.value["type"]
        if (value !is JsonPrimitive || !value.isString || !isBoundedString(value.content, 64)) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        return value.content
    }

    private fun remoteConnectionError(message: WireError): RuntimeConnectionException {
        if (
            message.type != "error" ||
            !REQUEST_ID_PATTERN.matches(message.code) ||
            !isBoundedString(message.message, MAXIMUM_REMOTE_MESSAGE_BYTES)
        ) {
            return RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val code = when (message.code) {
            "unauthenticated" -> RuntimeConnectionErrorCode.AUTHENTICATION_FAILED
            "forbidden" -> RuntimeConnectionErrorCode.INELIGIBLE_BUILD
            "unsupported" -> RuntimeConnectionErrorCode.NEGOTIATION_FAILED
            "resource_exhausted" -> RuntimeConnectionErrorCode.RESOURCE_EXHAUSTED
            "timeout" -> RuntimeConnectionErrorCode.TIMEOUT
            "cancelled" -> RuntimeConnectionErrorCode.CANCELLED
            "unavailable" -> RuntimeConnectionErrorCode.UNAVAILABLE
            else -> RuntimeConnectionErrorCode.REMOTE_ERROR
        }
        return RuntimeConnectionException(code)
    }

    private fun claimCaptureTerminal(
        requestId: String,
        expected: Job,
    ): Boolean = synchronized(captureLock) {
        if (captureJobs[requestId] !== expected) {
            false
        } else {
            captureJobs.remove(requestId)
            true
        }
    }

    private fun shutdown(
        terminalState: RuntimeConnectionState,
        error: RuntimeConnectionException?,
    ) {
        val shouldShutdown = synchronized(lifecycleLock) {
            if (state == RuntimeConnectionState.CLOSED || state == RuntimeConnectionState.FAILED) {
                false
            } else {
                state = terminalState
                true
            }
        }
        if (!shouldShutdown) {
            return
        }
        receiveJob?.cancel()
        receiveJob = null
        val jobs = synchronized(captureLock) {
            captureJobs.values.toList().also { captureJobs.clear() }
        }
        jobs.forEach(Job::cancel)
        val pump = synchronized(eventLock) {
            eventSubscriptionId = null
            eventPumpJob.also { eventPumpJob = null }
        }
        pump?.cancel()
        val tunings = synchronized(tuningLock) {
            activeTunings.values.toList().also { activeTunings.clear() }
        }
        tunings.forEach { it.ttlJob?.cancel() }
        if (tuningController != null && tunings.any { it.restoreEntries.isNotEmpty() }) {
            // Restoration must outlive the cancelled connection scope so no
            // preview survives a disconnect or close. The controller owns its
            // own main-thread dispatch. Applications restore in reverse apply
            // order so captured originals win, and the handler keeps any
            // controller failure away from the process default handler.
            val restoreScope = CoroutineScope(
                SupervisorJob() + Dispatchers.Default + containedExceptionHandler,
            )
            restoreScope.launch {
                for (active in tunings.asReversed()) {
                    restoreTuningEntries(active.restoreEntries)
                }
            }
        }
        closeTransportSocket()
        sessionLimits = null
        scope.cancel()
        if (error == null) {
            terminal.complete(Unit)
        } else {
            terminal.completeExceptionally(error)
        }
    }

    private fun objectChunkFitsLine(maximumChunkBytes: Int, maximumLineBytes: Int): Boolean {
        val emptyEnvelope = RuntimeWireCodec.encode(
            WireObjectChunk(
                type = "object_chunk",
                requestId = "00000000-0000-0000-0000-000000000000",
                objectIndex = MAXIMUM_OBJECT_INDEX,
                sequence = MAXIMUM_JSON_SAFE_INTEGER,
                data = "",
            ),
        )
        val base64Characters = ((maximumChunkBytes.toLong() + 2) / 3) * 4
        return emptyEnvelope.size.toLong() + base64Characters <= maximumLineBytes
    }

    private fun isBoundedString(value: String, maximumUtf8Bytes: Int): Boolean {
        val count = value.toByteArray(Charsets.UTF_8).size
        return count in 1..maximumUtf8Bytes
    }

    private fun closeTransportSocket() {
        val current = synchronized(socketLock) {
            socket.also { socket = null }
        }
        input = null
        output = null
        runCatching { current?.close() }
    }
}

internal object RuntimeCapturePayloadValidator {
    fun validate(
        payload: RuntimeSnapshotCapturePayload,
        limits: RuntimeSessionLimits,
    ): ValidatedRuntimeCapture {
        val snapshot = payload.snapshot
        if (
            snapshot.protocolVersion.major != 1 ||
            snapshot.protocolVersion.minor != 0L ||
            payload.objects.size > MAXIMUM_CAPTURE_OBJECTS
        ) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        val expectedReferences = linkedMapOf<String, ObjectRef>()
        snapshot.screenshot?.objectRef?.let { registerExpected(expectedReferences, it) }
        snapshot.trees.forEach { tree ->
            tree.payload.nodesObject?.let { registerExpected(expectedReferences, it) }
        }

        val seen = mutableSetOf<String>()
        var aggregateBytes = 0L
        val validated = payload.objects.map { objectValue ->
            val reference = objectValue.reference
            val hash = reference.hash.value
            val bytes = objectValue.transportBytes()
            val expected = expectedReferences[hash]
            val objectBytes = bytes.size.toLong()
            val hasCapacity = objectBytes <= limits.maximumObjectBytes - aggregateBytes
            if (
                !seen.add(hash) ||
                expected != reference ||
                reference.byteSize.value != objectBytes ||
                !hasCapacity ||
                sha256Reference(bytes) != hash
            ) {
                bytes.fill(0)
                throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
            }
            aggregateBytes += objectBytes
            ValidatedRuntimeObject(reference, bytes)
        }
        if (seen != expectedReferences.keys) {
            validated.forEach { it.bytes.fill(0) }
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        return ValidatedRuntimeCapture(snapshot, validated)
    }

    private fun registerExpected(values: MutableMap<String, ObjectRef>, reference: ObjectRef) {
        val hash = reference.hash.value
        val existing = values[hash]
        if (existing != null && existing != reference) {
            throw RuntimeConnectionException(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION)
        }
        values[hash] = reference
    }

    private fun sha256Reference(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return "sha256:" + digest.joinToString(separator = "") {
            ((it.toInt() and 0xff) + 0x100).toString(16).substring(1)
        }
    }
}
