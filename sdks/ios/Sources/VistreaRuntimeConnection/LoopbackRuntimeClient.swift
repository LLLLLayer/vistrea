import CryptoKit
import Foundation
import Network
import VistreaRuntimeModels

private enum HandshakePhase: Sendable {
    case awaitingChallenge
    case awaitingWelcome(HandshakeContext)
}

private struct HandshakeContext: Sendable {
    let connectionAttemptID: String
    let hostNonce: String
    let clientNonce: String
}

private enum NetworkStartupSignal: Sendable {
    case ready
    case failed
}

private struct ReceivedNetworkChunk: Sendable {
    let data: Data
    let isComplete: Bool
}

private struct CaptureTaskEntry: Sendable {
    let token: UUID
    let task: Task<Void, Never>
}

private struct ActiveTuningState: Sendable {
    var application: [String: JSONValue]
    let restoreEntries: [RuntimeTuningRestoreEntry]
    var ttlTask: Task<Void, Never>?
    /// Monotonic apply position so shutdown can restore applications in
    /// reverse apply order even though the dictionary itself is unordered.
    let applyOrder: UInt64
}

/// Authenticated Snapshot-only Runtime client for the Node loopback Host.
///
/// The client is intentionally limited to explicit loopback TCP endpoints and
/// Debug/Internal build configurations. It transports canonical protocol
/// Snapshots and ObjectReferences produced by an injected capture provider.
public actor LoopbackRuntimeClient {
    private nonisolated static let networkQueue = DispatchQueue(
        label: "dev.vistrea.runtime-connection",
        qos: .userInitiated
    )

    public private(set) var state: RuntimeConnectionState = .disconnected
    public private(set) var connectionID: String?
    public private(set) var eventStreamingEnabled = false
    public private(set) var tuningEnabled = false

    private let configuration: LoopbackRuntimeClientConfiguration
    private let captureProvider: any RuntimeSnapshotCaptureProvider
    private let eventRecorder: RuntimeEventRecorder?
    private let tuningController: (any RuntimeTuningApplying)?
    private var connection: NWConnection?
    private var lineDecoder: BoundedJSONLineDecoder
    private var handshakePhase: HandshakePhase = .awaitingChallenge
    private var sessionLimits: RuntimeSessionLimits?
    private var receiveTask: Task<Void, Never>?
    private var handshakeTimeoutTask: Task<Void, Never>?
    private var captureTasks: [String: CaptureTaskEntry] = [:]
    private var eventSubscriptionID: String?
    private var eventPumpTask: Task<Void, Never>?
    private var lastCapturedSnapshotID: String?
    private var activeTunings: [String: ActiveTuningState] = [:]
    private var tuningApplyCounter: UInt64 = 0
    private var closeWaiters: [CheckedContinuation<Void, any Error>] = []
    private var terminalError: RuntimeConnectionError?

    public init(
        configuration: LoopbackRuntimeClientConfiguration,
        captureProvider: any RuntimeSnapshotCaptureProvider,
        eventRecorder: RuntimeEventRecorder? = nil,
        tuningController: (any RuntimeTuningApplying)? = nil
    ) {
        self.configuration = configuration
        self.captureProvider = captureProvider
        self.eventRecorder = eventRecorder
        self.tuningController = tuningController
        lineDecoder = BoundedJSONLineDecoder(
            maximumLineBytes: configuration.maximumInboundLineBytes
        )
    }

    public func connect() async throws {
        try await withTaskCancellationHandler {
            try await connectImpl()
        } onCancel: {
            Task { await self.cancelFromCaller() }
        }
    }

    private func connectImpl() async throws {
        guard state == .disconnected else {
            throw RuntimeConnectionError.protocolViolation
        }
        try Task.checkCancellation()
        state = .connecting

        let endpoint = configuration.endpoint
        guard let port = NWEndpoint.Port(rawValue: endpoint.port) else {
            shutdown(state: .failed, error: .invalidConfiguration)
            throw RuntimeConnectionError.invalidConfiguration
        }
        let connection = NWConnection(
            host: NWEndpoint.Host(endpoint.host),
            port: port,
            using: .tcp
        )
        self.connection = connection
        installHandshakeTimeout()

        do {
            try await waitForNetworkReady(connection)
            guard state == .connecting else {
                throw terminalError ?? RuntimeConnectionError.unavailable
            }
            state = .authenticating
            installSteadyStateNetworkHandler(connection)
            try await receiveHandshake()
            guard state == .ready else {
                throw terminalError ?? RuntimeConnectionError.negotiationFailed
            }
            handshakeTimeoutTask?.cancel()
            handshakeTimeoutTask = nil
            receiveTask = Task { [weak self] in
                await self?.receiveReadyMessages()
            }
        } catch is CancellationError {
            shutdown(state: .failed, error: .cancelled)
            throw RuntimeConnectionError.cancelled
        } catch let error as RuntimeConnectionError {
            if state != .failed && state != .closed {
                shutdown(state: .failed, error: error)
            }
            throw terminalError ?? error
        } catch {
            shutdown(state: .failed, error: .unavailable)
            throw RuntimeConnectionError.unavailable
        }
    }

    public func runUntilClosed() async throws {
        try await withTaskCancellationHandler {
            try await connect()
            try await waitUntilClosed()
        } onCancel: {
            Task { await self.cancelFromCaller() }
        }
    }

    public func waitUntilClosed() async throws {
        if state == .closed || state == .failed {
            if let terminalError {
                throw terminalError
            }
            return
        }
        try await withCheckedThrowingContinuation { continuation in
            closeWaiters.append(continuation)
        }
    }

    public func close() {
        guard state != .closed && state != .failed else {
            return
        }
        state = .closing
        shutdown(state: .closed, error: nil)
    }

    private func cancelFromCaller() {
        guard state != .closed && state != .failed else {
            return
        }
        shutdown(state: .failed, error: .cancelled)
    }

    private func installHandshakeTimeout() {
        let timeoutNanoseconds = configuration.handshakeTimeoutMilliseconds * 1_000_000
        handshakeTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
            } catch {
                return
            }
            await self?.handshakeTimedOut()
        }
    }

    private func handshakeTimedOut() {
        guard state == .connecting || state == .authenticating else {
            return
        }
        shutdown(state: .failed, error: .timeout)
    }

    private func waitForNetworkReady(_ connection: NWConnection) async throws {
        let stream = AsyncStream<NetworkStartupSignal> { continuation in
            connection.stateUpdateHandler = { networkState in
                switch networkState {
                case .ready:
                    continuation.yield(.ready)
                    continuation.finish()
                case .failed, .cancelled:
                    continuation.yield(.failed)
                    continuation.finish()
                default:
                    break
                }
            }
        }
        connection.start(queue: Self.networkQueue)
        for await signal in stream {
            switch signal {
            case .ready:
                return
            case .failed:
                throw terminalError ?? RuntimeConnectionError.unavailable
            }
        }
        throw terminalError ?? RuntimeConnectionError.unavailable
    }

    private func installSteadyStateNetworkHandler(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self] networkState in
            switch networkState {
            case .failed, .cancelled:
                Task { await self?.networkTerminated() }
            default:
                break
            }
        }
    }

    private func networkTerminated() {
        guard state != .closed && state != .failed else {
            return
        }
        shutdown(state: .failed, error: .unavailable)
    }

    private func receiveHandshake() async throws {
        while state == .authenticating {
            let chunk = try await receiveNetworkChunk()
            if !chunk.data.isEmpty {
                try await processIncomingData(chunk.data)
            }
            if chunk.isComplete {
                try lineDecoder.validateCompleteStream()
                throw RuntimeConnectionError.unavailable
            }
        }
    }

    private func handleHandshakeLine(_ data: Data) async throws {
        let envelope = try decode(WireEnvelope.self, from: data)
        if envelope.type == "error" {
            let remote = try decode(WireError.self, from: data)
            throw remoteConnectionError(code: remote.code)
        }

        switch handshakePhase {
        case .awaitingChallenge:
            guard envelope.type == "host_challenge" else {
                throw RuntimeConnectionError.protocolViolation
            }
            let challenge = try decode(WireHostChallenge.self, from: data)
            try await answer(challenge)
        case let .awaitingWelcome(context):
            guard envelope.type == "host_welcome" else {
                throw RuntimeConnectionError.protocolViolation
            }
            let welcome = try decode(WireHostWelcome.self, from: data)
            try await accept(welcome, context: context)
        }
    }

    private func answer(_ challenge: WireHostChallenge) async throws {
        guard challenge.type == "host_challenge",
              isBoundedString(challenge.connectionAttemptID, maximumUTF8Bytes: 128),
              isNonce(challenge.nonce),
              isBoundedString(challenge.hostIdentity, maximumUTF8Bytes: 256),
              (1...32).contains(challenge.supportedVersions.count),
              Set(challenge.supportedVersions).count == challenge.supportedVersions.count,
              challenge.supportedVersions.contains(RuntimeConnectionAuthentication.version),
              !challenge.supportedAuthMethods.isEmpty,
              challenge.supportedAuthMethods.count <= 16,
              Set(challenge.supportedAuthMethods).count == challenge.supportedAuthMethods.count,
              challenge.supportedAuthMethods.allSatisfy({
                  isBoundedString($0, maximumUTF8Bytes: 64)
              }),
              challenge.supportedAuthMethods.contains(RuntimeConnectionAuthentication.method)
        else {
            throw RuntimeConnectionError.negotiationFailed
        }

        let clientNonce = makeNonce()
        let versions = [RuntimeConnectionAuthentication.version]
        var capabilities = [RuntimeConnectionAuthentication.snapshotCapability]
        var wireEpoch: WireEventEpoch?
        if let eventRecorder {
            let epoch = await eventRecorder.epoch
            capabilities.insert(RuntimeConnectionAuthentication.eventsCapability, at: 0)
            wireEpoch = WireEventEpoch(
                eventEpochID: epoch.eventEpochID,
                oldestRetainedSequence: epoch.oldestRetainedSequence,
                nextSequence: epoch.nextSequence
            )
        }
        if tuningController != nil {
            capabilities.insert(RuntimeConnectionAuthentication.tuningCapability, at: 0)
        }
        capabilities.sort()
        let proof = RuntimeConnectionAuthentication.clientProof(
            key: configuration.authorizationKey,
            connectionAttemptID: challenge.connectionAttemptID,
            hostNonce: challenge.nonce,
            clientNonce: clientNonce,
            runtimeInstanceID: configuration.runtimeInstanceID,
            buildConfiguration: configuration.buildConfiguration,
            supportedVersions: versions,
            capabilities: capabilities
        )
        let context = HandshakeContext(
            connectionAttemptID: challenge.connectionAttemptID,
            hostNonce: challenge.nonce,
            clientNonce: clientNonce
        )
        handshakePhase = .awaitingWelcome(context)
        try await send(
            WireClientHello(
                connectionAttemptID: challenge.connectionAttemptID,
                runtimeInstanceID: configuration.runtimeInstanceID,
                buildConfiguration: configuration.buildConfiguration,
                supportedVersions: versions,
                capabilities: capabilities,
                selectedAuthMethod: RuntimeConnectionAuthentication.method,
                clientNonce: clientNonce,
                challengeResponse: proof,
                eventEpoch: wireEpoch
            )
        )
    }

    private func accept(_ welcome: WireHostWelcome, context: HandshakeContext) async throws {
        let normalizedCapabilities = RuntimeConnectionAuthentication.normalize(
            capabilities: welcome.enabledCapabilities
        )
        var offered = Set([RuntimeConnectionAuthentication.snapshotCapability])
        if eventRecorder != nil {
            offered.insert(RuntimeConnectionAuthentication.eventsCapability)
        }
        if tuningController != nil {
            offered.insert(RuntimeConnectionAuthentication.tuningCapability)
        }
        let enabledSet = Set(normalizedCapabilities)
        guard welcome.type == "host_welcome",
              isBoundedString(welcome.connectionID, maximumUTF8Bytes: 128),
              welcome.selectedVersion == RuntimeConnectionAuthentication.version,
              enabledSet.contains(RuntimeConnectionAuthentication.snapshotCapability),
              enabledSet.isSubset(of: offered),
              RuntimeConnectionAuthentication.verifyHostProof(
                welcome.hostProof,
                key: configuration.authorizationKey,
                connectionAttemptID: context.connectionAttemptID,
                connectionID: welcome.connectionID,
                hostNonce: context.hostNonce,
                clientNonce: context.clientNonce,
                runtimeInstanceID: configuration.runtimeInstanceID,
                selectedVersion: welcome.selectedVersion,
                enabledCapabilities: welcome.enabledCapabilities
              )
        else {
            throw RuntimeConnectionError.authenticationFailed
        }
        let eventsEnabled = enabledSet.contains(RuntimeConnectionAuthentication.eventsCapability)
        if eventsEnabled {
            guard let eventRecorder,
                  let welcomeEpoch = welcome.eventEpoch,
                  await welcomeEpoch.eventEpochID == eventRecorder.epoch.eventEpochID
            else {
                throw RuntimeConnectionError.negotiationFailed
            }
        } else {
            guard welcome.eventEpoch == nil else {
                throw RuntimeConnectionError.negotiationFailed
            }
        }
        let policy = welcome.sessionPolicy
        guard (1_024...(64 * 1_024 * 1_024)).contains(policy.maximumLineBytes),
              policy.maximumLineBytes <= configuration.maximumInboundLineBytes,
              policy.maximumObjectBytes > 0,
              policy.maximumChunkBytes > 0,
              policy.maximumChunkBytes <= policy.maximumObjectBytes,
              policy.maximumChunkBytes <= 4 * 1_024 * 1_024,
              objectChunkFitsLine(
                maximumChunkBytes: policy.maximumChunkBytes,
                maximumLineBytes: policy.maximumLineBytes
              )
        else {
            throw RuntimeConnectionError.negotiationFailed
        }
        try lineDecoder.updateMaximumLineBytes(policy.maximumLineBytes)
        sessionLimits = RuntimeSessionLimits(
            maximumLineBytes: policy.maximumLineBytes,
            maximumObjectBytes: policy.maximumObjectBytes,
            maximumChunkBytes: policy.maximumChunkBytes
        )
        connectionID = welcome.connectionID
        eventStreamingEnabled = eventsEnabled
        tuningEnabled = enabledSet.contains(RuntimeConnectionAuthentication.tuningCapability)
        state = .ready
    }

    private func receiveReadyMessages() async {
        do {
            while state == .ready {
                let chunk = try await receiveNetworkChunk()
                if !chunk.data.isEmpty {
                    try await processIncomingData(chunk.data)
                }
                if chunk.isComplete {
                    try lineDecoder.validateCompleteStream()
                    throw RuntimeConnectionError.unavailable
                }
            }
        } catch is CancellationError {
            // A local close cancels the receive task after terminal state is set.
        } catch let error as RuntimeConnectionError {
            if state != .closed && state != .failed {
                shutdown(state: .failed, error: error)
            }
        } catch {
            if state != .closed && state != .failed {
                shutdown(state: .failed, error: .protocolViolation)
            }
        }
    }

    private func handleReadyLine(_ data: Data) async throws {
        let envelope = try decode(WireEnvelope.self, from: data)
        switch envelope.type {
        case "capture_request":
            try startCapture(try decode(WireCaptureRequest.self, from: data))
        case "capture_cancel":
            try await cancelCapture(try decode(WireCaptureCancel.self, from: data))
        case "subscribe_events":
            try await subscribeEvents(try decode(WireSubscribeEvents.self, from: data))
        case "acknowledge_events":
            try await acknowledgeEvents(try decode(WireAcknowledgeEvents.self, from: data))
        case "unsubscribe_events":
            try unsubscribeEvents(try decode(WireUnsubscribeEvents.self, from: data))
        case "apply_tuning":
            try await applyTuning(try decode(WireApplyTuning.self, from: data))
        case "revert_tuning":
            try await revertTuning(try decode(WireRevertTuning.self, from: data))
        case "disconnect":
            let message = try decode(WireDisconnect.self, from: data)
            guard message.type == "disconnect" else {
                throw RuntimeConnectionError.protocolViolation
            }
            shutdown(state: .closed, error: nil)
        case "error":
            let remote = try decode(WireError.self, from: data)
            throw remoteConnectionError(code: remote.code)
        default:
            throw RuntimeConnectionError.protocolViolation
        }
    }

    private func startCapture(_ message: WireCaptureRequest) throws {
        guard message.type == "capture_request",
              isRequestID(message.requestID),
              captureTasks[message.requestID] == nil,
              captureTasks.count < 32
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        let request = try RuntimeCaptureRequest(
            includePaths: message.command.include.paths,
            screenshot: message.command.screenshot,
            reason: message.command.reason
        )
        let requestID = message.requestID
        let token = UUID()
        let task = Task { [weak self] in
            guard let self else {
                return
            }
            await self.performCapture(requestID: requestID, token: token, request: request)
        }
        captureTasks[requestID] = CaptureTaskEntry(token: token, task: task)
    }

    private func performCapture(
        requestID: String,
        token: UUID,
        request: RuntimeCaptureRequest
    ) async {
        do {
            let payload = try await captureProvider.capture(request)
            try Task.checkCancellation()
            let validated = try validate(payload)
            try await sendCapture(requestID: requestID, token: token, payload: validated)
        } catch is CancellationError {
            if Task.isCancelled {
                _ = claimCaptureTerminal(requestID: requestID, token: token)
            } else {
                await reportCaptureFailure(requestID: requestID, token: token)
            }
        } catch {
            await reportCaptureFailure(requestID: requestID, token: token)
        }
    }

    private func reportCaptureFailure(requestID: String, token: UUID) async {
        guard claimCaptureTerminal(requestID: requestID, token: token),
              state == .ready
        else {
            return
        }
        do {
            try await send(WireCaptureError(requestID: requestID))
        } catch let connectionError as RuntimeConnectionError {
            shutdown(state: .failed, error: connectionError)
        } catch {
            shutdown(state: .failed, error: .unavailable)
        }
    }

    private func subscribeEvents(_ message: WireSubscribeEvents) async throws {
        guard message.type == "subscribe_events",
              isRequestID(message.requestID),
              eventStreamingEnabled,
              let eventRecorder,
              eventSubscriptionID == nil,
              !message.eventKinds.isEmpty,
              message.eventKinds.count <= 16,
              Set(message.eventKinds).count == message.eventKinds.count
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        let requestedKinds = message.eventKinds.compactMap(RuntimeEventKind.init(rawValue:))
        guard requestedKinds.count == message.eventKinds.count else {
            try await send(WireSubscribeError(
                requestID: message.requestID,
                code: "unsupported",
                oldestAvailableSequence: nil,
                nextSequence: nil
            ))
            return
        }
        let limit = message.maxBatchSize ?? 256
        guard (1...1_024).contains(limit) else {
            throw RuntimeConnectionError.protocolViolation
        }

        let epoch = await eventRecorder.epoch
        var cursor: UInt64
        switch message.start.mode {
        case "after_sequence":
            guard let sequence = message.start.sequence else {
                throw RuntimeConnectionError.protocolViolation
            }
            cursor = sequence
        case "oldest_retained":
            cursor = epoch.oldestRetainedSequence > 0 ? epoch.oldestRetainedSequence - 1 : 0
        case "tail":
            cursor = epoch.nextSequence - 1
        default:
            throw RuntimeConnectionError.protocolViolation
        }
        if message.eventEpochID != epoch.eventEpochID
            || (message.start.mode == "after_sequence" && cursor + 1 < epoch.oldestRetainedSequence) {
            // The requested epoch or range is no longer resolvable; report the
            // recoverable boundary instead of silently skipping evidence.
            try await send(WireSubscribeError(
                requestID: message.requestID,
                code: "conflict",
                oldestAvailableSequence: epoch.oldestRetainedSequence,
                nextSequence: epoch.nextSequence
            ))
            return
        }

        let subscriptionID = makeNonce()
        eventSubscriptionID = subscriptionID
        try await send(WireSubscribeResult(requestID: message.requestID, subscriptionID: subscriptionID))
        let kinds = Set(requestedKinds)
        eventPumpTask = Task { [weak self] in
            await self?.pumpEvents(
                subscriptionID: subscriptionID,
                cursor: cursor,
                kinds: kinds,
                limit: limit
            )
        }
    }

    private func pumpEvents(
        subscriptionID: String,
        cursor initialCursor: UInt64,
        kinds: Set<RuntimeEventKind>,
        limit: Int
    ) async {
        guard let eventRecorder else {
            return
        }
        var cursor = initialCursor
        while state == .ready, eventSubscriptionID == subscriptionID, !Task.isCancelled {
            do {
                if let batch = try await eventRecorder.batchAfter(
                    cursor: cursor,
                    kinds: kinds,
                    limit: limit
                ) {
                    guard state == .ready, eventSubscriptionID == subscriptionID else {
                        return
                    }
                    try await send(WireEventBatch(subscriptionID: subscriptionID, batch: batch))
                    cursor = batch.lastSequence.rawValue
                } else {
                    await eventRecorder.waitForEvents(after: cursor)
                }
            } catch is CancellationError {
                return
            } catch let error as RuntimeConnectionError {
                if state == .ready {
                    shutdown(state: .failed, error: error)
                }
                return
            } catch {
                if state == .ready {
                    shutdown(state: .failed, error: .protocolViolation)
                }
                return
            }
        }
    }

    private func acknowledgeEvents(_ message: WireAcknowledgeEvents) async throws {
        guard message.type == "acknowledge_events",
              eventStreamingEnabled,
              let eventRecorder,
              message.subscriptionID == eventSubscriptionID
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        let epoch = await eventRecorder.epoch
        guard message.eventEpochID == epoch.eventEpochID else {
            throw RuntimeConnectionError.protocolViolation
        }
        await eventRecorder.releaseThrough(sequence: message.durableThroughSequence)
    }

    private func unsubscribeEvents(_ message: WireUnsubscribeEvents) throws {
        guard message.type == "unsubscribe_events",
              message.subscriptionID == eventSubscriptionID
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        eventPumpTask?.cancel()
        eventPumpTask = nil
        eventSubscriptionID = nil
    }

    private func applyTuning(_ message: WireApplyTuning) async throws {
        guard message.type == "apply_tuning",
              isRequestID(message.requestID),
              tuningEnabled,
              let tuningController,
              let connectionID
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        if let ttl = message.command.previewTtlMs, !(100...3_600_000).contains(ttl) {
            throw RuntimeConnectionError.protocolViolation
        }
        // The actor serializes tuning state, so this set stays consistent with
        // the applications the processor could otherwise stack against.
        let activeTargetStableIDs = Set(
            activeTunings.values.flatMap { $0.restoreEntries.map(\.stableID) }
        )
        let outcome: RuntimeTuningOutcome
        do {
            outcome = try await RuntimeTuningProcessor.apply(
                patch: message.command.patch,
                expectedSnapshotID: message.command.expectedSnapshotID,
                lastCapturedSnapshotID: lastCapturedSnapshotID,
                connectionID: connectionID,
                controller: tuningController,
                activeTargetStableIDs: activeTargetStableIDs
            )
        } catch {
            try await send(WireTuningError(requestID: message.requestID, code: "conflict"))
            return
        }
        var application = outcome.application
        if outcome.isActive {
            guard case let .string(applicationID)? = application["tuning_application_id"] else {
                throw RuntimeConnectionError.protocolViolation
            }
            var ttlTask: Task<Void, Never>?
            if let ttl = message.command.previewTtlMs {
                application["preview_expires_at"] = .string(
                    Self.canonicalTimestamp(Date().addingTimeInterval(Double(ttl) / 1_000))
                )
                ttlTask = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: ttl * 1_000_000)
                    guard !Task.isCancelled else {
                        return
                    }
                    await self?.expireTuning(applicationID: applicationID)
                }
            }
            tuningApplyCounter += 1
            activeTunings[applicationID] = ActiveTuningState(
                application: application,
                restoreEntries: outcome.restoreEntries,
                ttlTask: ttlTask,
                applyOrder: tuningApplyCounter
            )
        }
        try await send(
            WireTuningResult(
                type: "tuning_result",
                requestID: message.requestID,
                application: .object(application)
            )
        )
    }

    private func revertTuning(_ message: WireRevertTuning) async throws {
        guard message.type == "revert_tuning",
              isRequestID(message.requestID),
              tuningEnabled
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        guard let active = activeTunings.removeValue(forKey: message.tuningApplicationID) else {
            try await send(WireTuningError(requestID: message.requestID, code: "conflict"))
            return
        }
        active.ttlTask?.cancel()
        await restoreEntries(active.restoreEntries)
        let terminal = RuntimeTuningProcessor.terminalApplication(
            from: active.application,
            reason: "explicit_revert"
        )
        try await send(
            WireTuningResult(
                type: "revert_result",
                requestID: message.requestID,
                application: .object(terminal)
            )
        )
    }

    private func expireTuning(applicationID: String) async {
        guard state == .ready,
              let active = activeTunings.removeValue(forKey: applicationID)
        else {
            return
        }
        await restoreEntries(active.restoreEntries)
        let terminal = RuntimeTuningProcessor.terminalApplication(
            from: active.application,
            reason: "ttl_expiry"
        )
        do {
            try await send(WireTuningReverted(application: .object(terminal)))
        } catch {
            // The preview is already restored; a vanished connection needs no report.
        }
    }

    /// Flattens active applications into one restore sequence in reverse apply
    /// order, reversing each application's own entries as well, so the first
    /// application's captured originals are written last and win.
    static func shutdownRestorePlan(
        forTuningsInApplyOrder tunings: [[RuntimeTuningRestoreEntry]]
    ) -> [RuntimeTuningRestoreEntry] {
        tunings.reversed().flatMap { $0.reversed() }
    }

    private func restoreEntries(_ entries: [RuntimeTuningRestoreEntry]) async {
        guard let tuningController else {
            return
        }
        for entry in entries.reversed() {
            await tuningController.setAlpha(stableID: entry.stableID, value: entry.originalAlpha)
        }
    }

    private nonisolated static func canonicalTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    private func cancelCapture(_ message: WireCaptureCancel) async throws {
        guard message.type == "capture_cancel",
              isRequestID(message.requestID)
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        guard let entry = captureTasks.removeValue(forKey: message.requestID) else {
            // Cancellation is best-effort. A completion or failure that already
            // claimed its terminal frame wins and a crossing late cancel is a no-op.
            return
        }
        entry.task.cancel()
        try await send(WireCaptureCancelled(requestID: message.requestID))
    }

    private func claimCaptureTerminal(requestID: String, token: UUID) -> Bool {
        guard captureTasks[requestID]?.token == token else {
            return false
        }
        captureTasks.removeValue(forKey: requestID)
        return true
    }

    private func validate(
        _ payload: RuntimeSnapshotCapturePayload
    ) throws -> RuntimeSnapshotCapturePayload {
        guard payload.snapshot.protocolVersion.major == 1,
              payload.snapshot.protocolVersion.minor == 0,
              payload.objects.count <= 256,
              let limits = sessionLimits
        else {
            throw RuntimeConnectionError.protocolViolation
        }

        var expectedReferences: [String: ObjectReference] = [:]
        if let screenshot = payload.snapshot.screenshot {
            expectedReferences[screenshot.object.hash] = screenshot.object
        }
        for tree in payload.snapshot.trees {
            if case let .object(reference, _, _) = tree.payload {
                if let existing = expectedReferences[reference.hash], existing != reference {
                    throw RuntimeConnectionError.protocolViolation
                }
                expectedReferences[reference.hash] = reference
            }
        }

        var seen = Set<String>()
        var aggregateBytes = 0
        for object in payload.objects {
            let reference = object.reference
            guard seen.insert(reference.hash).inserted,
                  expectedReferences[reference.hash] == reference,
                  reference.byteSize.rawValue <= UInt64(Int.max),
                  Int(reference.byteSize.rawValue) == object.bytes.count,
                  object.bytes.count <= limits.maximumObjectBytes - aggregateBytes,
                  sha256Reference(for: object.bytes) == reference.hash
            else {
                throw RuntimeConnectionError.protocolViolation
            }
            aggregateBytes += object.bytes.count
        }
        guard seen == Set(expectedReferences.keys) else {
            throw RuntimeConnectionError.protocolViolation
        }
        return payload
    }

    private func sendCapture(
        requestID: String,
        token: UUID,
        payload: RuntimeSnapshotCapturePayload
    ) async throws {
        guard let limits = sessionLimits else {
            throw RuntimeConnectionError.protocolViolation
        }
        try Task.checkCancellation()
        try await send(
            WireCaptureResult(
                requestID: requestID,
                snapshot: payload.snapshot,
                objects: payload.objects.map(\.reference)
            )
        )

        for (index, object) in payload.objects.enumerated() {
            try Task.checkCancellation()
            try await send(
                WireObjectStart(
                    requestID: requestID,
                    objectIndex: index,
                    hash: object.reference.hash,
                    byteSize: object.bytes.count
                )
            )
            var offset = 0
            var sequence = 0
            while offset < object.bytes.count {
                try Task.checkCancellation()
                let end = min(offset + limits.maximumChunkBytes, object.bytes.count)
                let chunk = object.bytes.subdata(in: offset..<end)
                try await send(
                    WireObjectChunk(
                        requestID: requestID,
                        objectIndex: index,
                        sequence: sequence,
                        data: chunk.base64EncodedString()
                    )
                )
                offset = end
                sequence += 1
            }
            try Task.checkCancellation()
            try await send(
                WireObjectEnd(
                    requestID: requestID,
                    objectIndex: index,
                    chunkCount: sequence
                )
            )
        }
        try Task.checkCancellation()
        guard claimCaptureTerminal(requestID: requestID, token: token) else {
            throw CancellationError()
        }
        // The tuning staleness check may only reference Snapshots whose
        // capture bodies the Host fully received; a cancelled or failed
        // capture never claims the terminal and never stamps.
        lastCapturedSnapshotID = payload.snapshot.snapshotID.rawValue
        do {
            try await send(WireCaptureComplete(requestID: requestID))
        } catch let connectionError as RuntimeConnectionError {
            shutdown(state: .failed, error: connectionError)
            throw connectionError
        } catch {
            shutdown(state: .failed, error: .unavailable)
            throw RuntimeConnectionError.unavailable
        }
    }

    private func send<Message: Encodable>(_ message: Message) async throws {
        guard let connection, state != .closed && state != .failed else {
            throw RuntimeConnectionError.unavailable
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let encoded: Data
        do {
            encoded = try encoder.encode(message)
        } catch {
            throw RuntimeConnectionError.protocolViolation
        }
        let maximumLineBytes = sessionLimits?.maximumLineBytes
            ?? configuration.maximumInboundLineBytes
        guard !encoded.isEmpty, encoded.count <= maximumLineBytes else {
            throw RuntimeConnectionError.resourceExhausted
        }
        var line = encoded
        line.append(0x0a)
        try await withCheckedThrowingContinuation { continuation in
            connection.send(content: line, completion: .contentProcessed { error in
                if error == nil {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: RuntimeConnectionError.unavailable)
                }
            })
        }
    }

    private func receiveNetworkChunk() async throws -> ReceivedNetworkChunk {
        guard let connection, state != .closed && state != .failed else {
            throw terminalError ?? RuntimeConnectionError.unavailable
        }
        return try await withCheckedThrowingContinuation { continuation in
            connection.receive(
                minimumIncompleteLength: 1,
                maximumLength: 64 * 1_024
            ) { data, _, isComplete, error in
                if error != nil {
                    continuation.resume(throwing: RuntimeConnectionError.unavailable)
                } else {
                    continuation.resume(
                        returning: ReceivedNetworkChunk(
                            data: data ?? Data(),
                            isComplete: isComplete
                        )
                    )
                }
            }
        }
    }

    private func processIncomingData(_ data: Data) async throws {
        do {
            try lineDecoder.enqueue(data)
            while state == .authenticating || state == .ready {
                guard let line = try lineDecoder.nextLine() else {
                    return
                }
                if state == .authenticating {
                    try await handleHandshakeLine(line)
                } else if state == .ready {
                    try await handleReadyLine(line)
                }
            }
        } catch BoundedJSONLineError.lineTooLarge {
            throw RuntimeConnectionError.resourceExhausted
        } catch let error as RuntimeConnectionError {
            throw error
        } catch {
            throw RuntimeConnectionError.protocolViolation
        }
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch let error as RuntimeConnectionError {
            throw error
        } catch {
            throw RuntimeConnectionError.protocolViolation
        }
    }

    private func shutdown(state terminalState: RuntimeConnectionState, error: RuntimeConnectionError?) {
        guard state != .closed && state != .failed else {
            return
        }
        state = terminalState
        terminalError = error
        handshakeTimeoutTask?.cancel()
        handshakeTimeoutTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        for entry in captureTasks.values {
            entry.task.cancel()
        }
        captureTasks.removeAll()
        eventPumpTask?.cancel()
        eventPumpTask = nil
        eventSubscriptionID = nil
        let tuningsInApplyOrder = activeTunings.values
            .sorted { $0.applyOrder < $1.applyOrder }
            .map(\.restoreEntries)
        for active in activeTunings.values {
            active.ttlTask?.cancel()
        }
        activeTunings.removeAll()
        let restorePlan = Self.shutdownRestorePlan(forTuningsInApplyOrder: tuningsInApplyOrder)
        if let tuningController, !restorePlan.isEmpty {
            // Disconnect, close, and failure always revert active previews.
            // Applications restore in reverse apply order so the earliest
            // captured originals are written last and win.
            Task {
                for entry in restorePlan {
                    await tuningController.setAlpha(
                        stableID: entry.stableID,
                        value: entry.originalAlpha
                    )
                }
            }
        }
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        sessionLimits = nil

        let waiters = closeWaiters
        closeWaiters.removeAll()
        for waiter in waiters {
            if let error {
                waiter.resume(throwing: error)
            } else {
                waiter.resume()
            }
        }
    }

    private func objectChunkFitsLine(
        maximumChunkBytes: Int,
        maximumLineBytes: Int
    ) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let emptyEnvelope = try? encoder.encode(
            WireObjectChunk(
                requestID: "00000000-0000-0000-0000-000000000000",
                objectIndex: 255,
                sequence: 9_007_199_254_740_991,
                data: ""
            )
        ) else {
            return false
        }
        let base64Characters = ((maximumChunkBytes + 2) / 3) * 4
        return emptyEnvelope.count <= maximumLineBytes - base64Characters
    }

    private func makeNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        return bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func isNonce(_ value: String) -> Bool {
        guard (16...256).contains(value.utf8.count) else {
            return false
        }
        return value.utf8.allSatisfy { byte in
            (48...57).contains(byte)
                || (65...90).contains(byte)
                || (97...122).contains(byte)
                || byte == 45
                || byte == 95
        }
    }

    private func isRequestID(_ value: String) -> Bool {
        guard isBoundedString(value, maximumUTF8Bytes: 128) else {
            return false
        }
        return value.utf8.allSatisfy { byte in
            (48...57).contains(byte)
                || (65...90).contains(byte)
                || (97...122).contains(byte)
                || byte == 45
                || byte == 46
                || byte == 58
                || byte == 95
        }
    }

    private func isBoundedString(_ value: String, maximumUTF8Bytes: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= maximumUTF8Bytes
    }

    private func remoteConnectionError(code: String) -> RuntimeConnectionError {
        guard isRequestID(code) else {
            return .protocolViolation
        }
        switch code {
        case "unauthenticated":
            return .authenticationFailed
        case "forbidden":
            return .ineligibleBuild
        case "unsupported":
            return .negotiationFailed
        case "resource_exhausted":
            return .resourceExhausted
        case "timeout":
            return .timeout
        case "cancelled":
            return .cancelled
        case "unavailable":
            return .unavailable
        default:
            return .remoteError(code: code)
        }
    }

    private func sha256Reference(for data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var hexadecimal = [UInt8]()
        hexadecimal.reserveCapacity(64)
        for byte in SHA256.hash(data: data) {
            hexadecimal.append(digits[Int(byte >> 4)])
            hexadecimal.append(digits[Int(byte & 0x0f)])
        }
        return "sha256:" + String(decoding: hexadecimal, as: UTF8.self)
    }
}
