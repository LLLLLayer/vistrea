import Foundation

public protocol TypedIDKind: Sendable {
    static var prefix: String { get }
}

/// An opaque, strongly typed protocol identifier with a readable prefix and UUIDv7 payload.
public struct TypedID<Kind: TypedIDKind>: Codable, Hashable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(validating rawValue: String) throws {
        guard ProtocolLexicalRules.isTypedUUIDv7(rawValue, prefix: Kind.prefix) else {
            throw ProtocolModelError.invalidIdentifier(rawValue)
        }
        self.rawValue = rawValue
    }

    public var description: String {
        rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        do {
            try self.init(validating: rawValue)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum SnapshotIDKind: TypedIDKind { public static let prefix = "snapshot" }
public enum ProjectIDKind: TypedIDKind { public static let prefix = "project" }
public enum BuildIDKind: TypedIDKind { public static let prefix = "build" }
public enum DeviceIDKind: TypedIDKind { public static let prefix = "device" }
public enum TreeIDKind: TypedIDKind { public static let prefix = "tree" }
public enum NodeIDKind: TypedIDKind { public static let prefix = "node" }
public enum EventEpochIDKind: TypedIDKind { public static let prefix = "epoch" }

public typealias SnapshotID = TypedID<SnapshotIDKind>
public typealias ProjectID = TypedID<ProjectIDKind>
public typealias BuildID = TypedID<BuildIDKind>
public typealias DeviceID = TypedID<DeviceIDKind>
public typealias TreeID = TypedID<TreeIDKind>
public typealias NodeID = TypedID<NodeIDKind>
public typealias EventEpochID = TypedID<EventEpochIDKind>

public struct StableID: Codable, Hashable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(validating rawValue: String) throws {
        guard ProtocolLexicalRules.isStableID(rawValue) else {
            throw ProtocolModelError.invalidStableIdentifier(rawValue)
        }
        self.rawValue = rawValue
    }

    public var description: String {
        rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        do {
            try self.init(validating: rawValue)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct JSONSafeUInt: Codable, Hashable, Comparable, Sendable {
    public let rawValue: UInt64

    public init(validating rawValue: UInt64) throws {
        guard rawValue <= ProtocolLexicalRules.jsonSafeIntegerMaximum else {
            throw ProtocolModelError.integerOutsideJSONSafeRange(rawValue)
        }
        self.rawValue = rawValue
    }

    public static func < (lhs: JSONSafeUInt, rhs: JSONSafeUInt) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(UInt64.self)
        do {
            try self.init(validating: rawValue)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct JSONSafePositiveUInt: Codable, Hashable, Comparable, Sendable {
    public let rawValue: UInt64

    public init(validating rawValue: UInt64) throws {
        guard rawValue > 0 else {
            throw ProtocolModelError.expectedPositiveInteger(rawValue)
        }
        guard rawValue <= ProtocolLexicalRules.jsonSafeIntegerMaximum else {
            throw ProtocolModelError.integerOutsideJSONSafeRange(rawValue)
        }
        self.rawValue = rawValue
    }

    public static func < (lhs: JSONSafePositiveUInt, rhs: JSONSafePositiveUInt) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(UInt64.self)
        do {
            try self.init(validating: rawValue)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct Timestamp: Codable, Hashable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(validating rawValue: String) throws {
        guard ProtocolLexicalRules.isCanonicalTimestamp(rawValue) else {
            throw ProtocolModelError.invalidTimestamp(rawValue)
        }
        self.rawValue = rawValue
    }

    public var description: String {
        rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        do {
            try self.init(validating: rawValue)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct ProtocolVersion: Codable, Equatable, Sendable {
    public let major: UInt32
    public let minor: UInt32

    public init(major: UInt32 = 1, minor: UInt32) throws {
        guard major == 1 else {
            throw ProtocolModelError.invalidValue("Protocol v1 models require major version 1.")
        }
        self.major = major
        self.minor = minor
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case major
        case minor
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let major = try container.decode(UInt32.self, forKey: .major)
        let minor = try container.decode(UInt32.self, forKey: .minor)
        do {
            try self.init(major: major, minor: minor)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .major,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct EventTime: Codable, Equatable, Sendable {
    public let wallTime: Timestamp
    public let monotonicOffsetNS: JSONSafeUInt?

    public init(wallTime: Timestamp, monotonicOffsetNS: JSONSafeUInt? = nil) {
        self.wallTime = wallTime
        self.monotonicOffsetNS = monotonicOffsetNS
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case wallTime = "wall_time"
        case monotonicOffsetNS = "monotonic_offset_ns"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        wallTime = try container.decode(Timestamp.self, forKey: .wallTime)
        monotonicOffsetNS = try container.decodeIfPresent(JSONSafeUInt.self, forKey: .monotonicOffsetNS)
    }
}

public struct CapabilitySet: Codable, Equatable, Sendable {
    public let names: [String]
    public let extensions: Extensions

    public init(names: [String], extensions: Extensions = .empty) throws {
        guard Set(names).count == names.count else {
            throw ProtocolModelError.invalidValue("Capability names must be unique.")
        }
        guard names.allSatisfy(ProtocolLexicalRules.isNamespaced) else {
            throw ProtocolModelError.invalidValue("Capability names must be namespaced.")
        }
        guard names.allSatisfy({ $0.unicodeScalars.count <= 128 }) else {
            throw ProtocolModelError.invalidValue("Capability names must contain 1 through 128 UTF-8 bytes.")
        }
        self.names = names
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case names
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let names = try container.decode([String].self, forKey: .names)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(names: names, extensions: extensions)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .names,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public enum CaptureLimitationSeverity: String, Codable, Equatable, Sendable {
    case info
    case warning
    case error
}

public struct CaptureLimitationScope: Codable, Equatable, Sendable {
    public let treeID: TreeID?
    public let nodeID: NodeID?
    public let field: String?

    public init(treeID: TreeID? = nil, nodeID: NodeID? = nil, field: String? = nil) throws {
        if let field, field.isEmpty || field.unicodeScalars.count > 256 {
            throw ProtocolModelError.invalidValue("Capture limitation scope fields must contain 1 through 256 UTF-8 bytes.")
        }
        self.treeID = treeID
        self.nodeID = nodeID
        self.field = field
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case treeID = "tree_id"
        case nodeID = "node_id"
        case field
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let treeID = try container.decodeIfPresent(TreeID.self, forKey: .treeID)
        let nodeID = try container.decodeIfPresent(NodeID.self, forKey: .nodeID)
        let field = try container.decodeIfPresent(String.self, forKey: .field)
        do {
            try self.init(treeID: treeID, nodeID: nodeID, field: field)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .field,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct CaptureLimitation: Codable, Equatable, Sendable {
    public let code: String
    public let severity: CaptureLimitationSeverity
    public let message: String
    public let scope: CaptureLimitationScope?
    public let retryable: Bool
    public let extensions: Extensions

    public init(
        code: String,
        severity: CaptureLimitationSeverity,
        message: String,
        scope: CaptureLimitationScope? = nil,
        retryable: Bool,
        extensions: Extensions = .empty
    ) throws {
        guard ProtocolLexicalRules.isNamespaced(code) else {
            throw ProtocolModelError.invalidNamespacedKey(code)
        }
        guard !message.isEmpty, message.unicodeScalars.count <= 1_024 else {
            throw ProtocolModelError.invalidValue("Capture limitation messages must contain 1 through 1024 Unicode scalar values.")
        }
        self.code = code
        self.severity = severity
        self.message = message
        self.scope = scope
        self.retryable = retryable
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case code
        case severity
        case message
        case scope
        case retryable
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let code = try container.decode(String.self, forKey: .code)
        let severity = try container.decode(CaptureLimitationSeverity.self, forKey: .severity)
        let message = try container.decode(String.self, forKey: .message)
        let scope = try container.decodeIfPresent(CaptureLimitationScope.self, forKey: .scope)
        let retryable = try container.decode(Bool.self, forKey: .retryable)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                code: code,
                severity: severity,
                message: message,
                scope: scope,
                retryable: retryable,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .code,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}
