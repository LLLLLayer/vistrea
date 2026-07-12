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
    }
}

struct WireHostWelcome: Decodable, Sendable {
    let type: String
    let connectionID: String
    let selectedVersion: RuntimeConnectionProtocolVersion
    let enabledCapabilities: [String]
    let hostProof: String
    let sessionPolicy: WireSessionPolicy

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case connectionID = "connection_id"
        case selectedVersion = "selected_version"
        case enabledCapabilities = "enabled_capabilities"
        case hostProof = "host_proof"
        case sessionPolicy = "session_policy"
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
