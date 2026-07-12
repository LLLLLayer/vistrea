import Foundation
import VistreaRuntimeModels

struct WireEnvelope: Decodable, Sendable {
    let type: String
}

struct WireHostChallenge: Decodable, Sendable {
    let type: String
    let connectionAttemptID: String
    let nonce: String
    let supportedVersions: [RuntimeConnectionProtocolVersion]
    let supportedAuthMethods: [String]
    let hostIdentity: String

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case connectionAttemptID = "connection_attempt_id"
        case nonce
        case supportedVersions = "supported_versions"
        case supportedAuthMethods = "supported_auth_methods"
        case hostIdentity = "host_identity"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        connectionAttemptID = try container.decode(String.self, forKey: .connectionAttemptID)
        nonce = try container.decode(String.self, forKey: .nonce)
        supportedVersions = try container.decode(
            [RuntimeConnectionProtocolVersion].self,
            forKey: .supportedVersions
        )
        supportedAuthMethods = try container.decode([String].self, forKey: .supportedAuthMethods)
        hostIdentity = try container.decode(String.self, forKey: .hostIdentity)
    }
}

struct WireEventEpoch: Codable, Equatable, Sendable {
    let eventEpochID: String
    let oldestRetainedSequence: UInt64
    let nextSequence: UInt64

    enum CodingKeys: String, CodingKey, CaseIterable {
        case eventEpochID = "event_epoch_id"
        case oldestRetainedSequence = "oldest_retained_sequence"
        case nextSequence = "next_sequence"
    }

    init(eventEpochID: String, oldestRetainedSequence: UInt64, nextSequence: UInt64) {
        self.eventEpochID = eventEpochID
        self.oldestRetainedSequence = oldestRetainedSequence
        self.nextSequence = nextSequence
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventEpochID = try container.decode(String.self, forKey: .eventEpochID)
        oldestRetainedSequence = try container.decode(UInt64.self, forKey: .oldestRetainedSequence)
        nextSequence = try container.decode(UInt64.self, forKey: .nextSequence)
    }
}

struct WireClientHello: Encodable, Sendable {
    let type = "client_hello"
    let connectionAttemptID: String
    let runtimeInstanceID: String
    let buildConfiguration: RuntimeBuildConfiguration
    let supportedVersions: [RuntimeConnectionProtocolVersion]
    let capabilities: [String]
    let selectedAuthMethod: String
    let clientNonce: String
    let challengeResponse: String
    let eventEpoch: WireEventEpoch?

    enum CodingKeys: String, CodingKey {
        case type
        case connectionAttemptID = "connection_attempt_id"
        case runtimeInstanceID = "runtime_instance_id"
        case buildConfiguration = "build_configuration"
        case supportedVersions = "supported_versions"
        case capabilities
        case selectedAuthMethod = "selected_auth_method"
        case clientNonce = "client_nonce"
        case challengeResponse = "challenge_response"
        case eventEpoch = "event_epoch"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(connectionAttemptID, forKey: .connectionAttemptID)
        try container.encode(runtimeInstanceID, forKey: .runtimeInstanceID)
        try container.encode(buildConfiguration, forKey: .buildConfiguration)
        try container.encode(supportedVersions, forKey: .supportedVersions)
        try container.encode(capabilities, forKey: .capabilities)
        try container.encode(selectedAuthMethod, forKey: .selectedAuthMethod)
        try container.encode(clientNonce, forKey: .clientNonce)
        try container.encode(challengeResponse, forKey: .challengeResponse)
        try container.encodeIfPresent(eventEpoch, forKey: .eventEpoch)
    }
}

struct WireHostWelcome: Decodable, Sendable {
    let type: String
    let connectionID: String
    let selectedVersion: RuntimeConnectionProtocolVersion
    let enabledCapabilities: [String]
    let hostProof: String
    let sessionPolicy: WireSessionPolicy
    let eventEpoch: WireEventEpoch?

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case connectionID = "connection_id"
        case selectedVersion = "selected_version"
        case enabledCapabilities = "enabled_capabilities"
        case hostProof = "host_proof"
        case sessionPolicy = "session_policy"
        case eventEpoch = "event_epoch"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        connectionID = try container.decode(String.self, forKey: .connectionID)
        selectedVersion = try container.decode(
            RuntimeConnectionProtocolVersion.self,
            forKey: .selectedVersion
        )
        enabledCapabilities = try container.decode([String].self, forKey: .enabledCapabilities)
        hostProof = try container.decode(String.self, forKey: .hostProof)
        sessionPolicy = try container.decode(WireSessionPolicy.self, forKey: .sessionPolicy)
        eventEpoch = try container.decodeIfPresent(WireEventEpoch.self, forKey: .eventEpoch)
    }
}

struct WireSessionPolicy: Decodable, Sendable {
    let maximumLineBytes: Int
    let maximumObjectBytes: Int
    let maximumChunkBytes: Int

    enum CodingKeys: String, CodingKey, CaseIterable {
        case maximumLineBytes = "maximum_line_bytes"
        case maximumObjectBytes = "maximum_object_bytes"
        case maximumChunkBytes = "maximum_chunk_bytes"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        maximumLineBytes = try container.decode(Int.self, forKey: .maximumLineBytes)
        maximumObjectBytes = try container.decode(Int.self, forKey: .maximumObjectBytes)
        maximumChunkBytes = try container.decode(Int.self, forKey: .maximumChunkBytes)
    }
}

struct WireError: Decodable, Sendable {
    let type: String
    let code: String
    let message: String

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case code
        case message
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        code = try container.decode(String.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
    }
}

struct WireCaptureRequest: Decodable, Sendable {
    let type: String
    let requestID: String
    let command: WireCaptureCommand

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case requestID = "request_id"
        case command
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestID = try container.decode(String.self, forKey: .requestID)
        command = try container.decode(WireCaptureCommand.self, forKey: .command)
    }
}

struct WireCaptureCommand: Decodable, Sendable {
    let include: WireFieldMask
    let screenshot: RuntimeCaptureScreenshotMode
    let reason: RuntimeCaptureReason

    enum CodingKeys: String, CodingKey, CaseIterable {
        case include
        case screenshot
        case reason
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        include = try container.decode(WireFieldMask.self, forKey: .include)
        screenshot = try container.decode(RuntimeCaptureScreenshotMode.self, forKey: .screenshot)
        reason = try container.decode(RuntimeCaptureReason.self, forKey: .reason)
    }
}

struct WireFieldMask: Decodable, Sendable {
    let paths: [String]

    enum CodingKeys: String, CodingKey, CaseIterable {
        case paths
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        paths = try container.decode([String].self, forKey: .paths)
    }
}

struct WireCaptureCancel: Decodable, Sendable {
    let type: String
    let requestID: String

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case requestID = "request_id"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestID = try container.decode(String.self, forKey: .requestID)
    }
}

struct WireDisconnect: Decodable, Sendable {
    let type: String

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
    }
}

struct WireCaptureResult: Encodable, Sendable {
    let type = "capture_result"
    let requestID: String
    let snapshot: RuntimeSnapshot
    let objects: [ObjectReference]

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case snapshot
        case objects
    }
}

struct WireObjectStart: Encodable, Sendable {
    let type = "object_start"
    let requestID: String
    let objectIndex: Int
    let hash: String
    let byteSize: Int

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case objectIndex = "object_index"
        case hash
        case byteSize = "byte_size"
    }
}

struct WireObjectChunk: Encodable, Sendable {
    let type = "object_chunk"
    let requestID: String
    let objectIndex: Int
    let sequence: Int
    let data: String

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case objectIndex = "object_index"
        case sequence
        case data
    }
}

struct WireObjectEnd: Encodable, Sendable {
    let type = "object_end"
    let requestID: String
    let objectIndex: Int
    let chunkCount: Int

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case objectIndex = "object_index"
        case chunkCount = "chunk_count"
    }
}

struct WireCaptureComplete: Encodable, Sendable {
    let type = "capture_complete"
    let requestID: String

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
    }
}

struct WireCaptureCancelled: Encodable, Sendable {
    let type = "capture_cancelled"
    let requestID: String

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
    }
}

struct WireCaptureError: Encodable, Sendable {
    let type = "capture_error"
    let requestID: String
    let code = "capture_failed"
    let message = "Runtime capture failed."

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case code
        case message
    }
}

struct WireSubscribeEvents: Decodable, Sendable {
    let type: String
    let requestID: String
    let eventEpochID: String
    let eventKinds: [String]
    let start: WireEventStart
    let maxBatchSize: Int?

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case requestID = "request_id"
        case eventEpochID = "event_epoch_id"
        case eventKinds = "event_kinds"
        case start
        case maxBatchSize = "max_batch_size"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestID = try container.decode(String.self, forKey: .requestID)
        eventEpochID = try container.decode(String.self, forKey: .eventEpochID)
        eventKinds = try container.decode([String].self, forKey: .eventKinds)
        start = try container.decode(WireEventStart.self, forKey: .start)
        maxBatchSize = try container.decodeIfPresent(Int.self, forKey: .maxBatchSize)
    }
}

struct WireEventStart: Decodable, Sendable {
    let mode: String
    let sequence: UInt64?

    enum CodingKeys: String, CodingKey, CaseIterable {
        case mode
        case sequence
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decode(String.self, forKey: .mode)
        sequence = try container.decodeIfPresent(UInt64.self, forKey: .sequence)
    }
}

struct WireAcknowledgeEvents: Decodable, Sendable {
    let type: String
    let subscriptionID: String
    let eventEpochID: String
    let durableThroughSequence: UInt64

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case subscriptionID = "subscription_id"
        case eventEpochID = "event_epoch_id"
        case durableThroughSequence = "durable_through_sequence"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        subscriptionID = try container.decode(String.self, forKey: .subscriptionID)
        eventEpochID = try container.decode(String.self, forKey: .eventEpochID)
        durableThroughSequence = try container.decode(UInt64.self, forKey: .durableThroughSequence)
    }
}

struct WireUnsubscribeEvents: Decodable, Sendable {
    let type: String
    let subscriptionID: String

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case subscriptionID = "subscription_id"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        subscriptionID = try container.decode(String.self, forKey: .subscriptionID)
    }
}

struct WireSubscribeResult: Encodable, Sendable {
    let type = "subscribe_result"
    let requestID: String
    let subscriptionID: String

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case subscriptionID = "subscription_id"
    }
}

struct WireSubscribeError: Encodable, Sendable {
    let type = "subscribe_error"
    let requestID: String
    let code: String
    let oldestAvailableSequence: UInt64?
    let nextSequence: UInt64?

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case code
        case oldestAvailableSequence = "oldest_available_sequence"
        case nextSequence = "next_sequence"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(requestID, forKey: .requestID)
        try container.encode(code, forKey: .code)
        try container.encodeIfPresent(oldestAvailableSequence, forKey: .oldestAvailableSequence)
        try container.encodeIfPresent(nextSequence, forKey: .nextSequence)
    }
}

struct WireEventBatch: Encodable, Sendable {
    let type = "event_batch"
    let subscriptionID: String
    let batch: RuntimeEventBatch

    enum CodingKeys: String, CodingKey {
        case type
        case subscriptionID = "subscription_id"
        case batch
    }
}

struct WireEventsClosed: Encodable, Sendable {
    let type = "events_closed"
    let subscriptionID: String
    let code: String?

    enum CodingKeys: String, CodingKey {
        case type
        case subscriptionID = "subscription_id"
        case code
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(subscriptionID, forKey: .subscriptionID)
        try container.encodeIfPresent(code, forKey: .code)
    }
}

struct WireApplyTuning: Decodable, Sendable {
    let type: String
    let requestID: String
    let command: WireApplyTuningCommand

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case requestID = "request_id"
        case command
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestID = try container.decode(String.self, forKey: .requestID)
        command = try container.decode(WireApplyTuningCommand.self, forKey: .command)
    }
}

struct WireApplyTuningCommand: Decodable, Sendable {
    let patch: JSONValue
    let expectedSnapshotID: String
    let previewTtlMs: UInt64?

    enum CodingKeys: String, CodingKey, CaseIterable {
        case patch
        case expectedSnapshotID = "expected_snapshot_id"
        case previewTtlMs = "preview_ttl_ms"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        patch = try container.decode(JSONValue.self, forKey: .patch)
        expectedSnapshotID = try container.decode(String.self, forKey: .expectedSnapshotID)
        previewTtlMs = try container.decodeIfPresent(UInt64.self, forKey: .previewTtlMs)
    }
}

struct WireRevertTuning: Decodable, Sendable {
    let type: String
    let requestID: String
    let tuningApplicationID: String

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case requestID = "request_id"
        case tuningApplicationID = "tuning_application_id"
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeWireUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestID = try container.decode(String.self, forKey: .requestID)
        tuningApplicationID = try container.decode(String.self, forKey: .tuningApplicationID)
    }
}

struct WireTuningResult: Encodable, Sendable {
    let type: String
    let requestID: String
    let application: JSONValue

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case application
    }
}

struct WireTuningError: Encodable, Sendable {
    let type = "tuning_error"
    let requestID: String
    let code: String

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "request_id"
        case code
    }
}

struct WireTuningReverted: Encodable, Sendable {
    let type = "tuning_reverted"
    let application: JSONValue

    enum CodingKeys: String, CodingKey {
        case type
        case application
    }
}

private struct RuntimeWireAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private extension Decoder {
    func rejectRuntimeWireUnknownKeys<Key>(_ keyType: Key.Type) throws
    where Key: CodingKey & CaseIterable {
        let container = try container(keyedBy: RuntimeWireAnyCodingKey.self)
        let knownKeys = Set(keyType.allCases.map(\.stringValue))
        guard !container.allKeys.contains(where: { !knownKeys.contains($0.stringValue) }) else {
            throw RuntimeConnectionError.protocolViolation
        }
    }
}
