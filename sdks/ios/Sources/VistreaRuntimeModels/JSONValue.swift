import Foundation

/// A transport-neutral JSON value used by protocol extension points.
///
/// Extension objects are intentionally not decoded into platform-specific types. This keeps
/// unknown, namespaced values available for lossless relay through an iOS process.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case boolean(Bool)
    case integer(Int64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Int64.self) {
            let safeMaximum = Int64(ProtocolLexicalRules.jsonSafeIntegerMaximum)
            guard (-safeMaximum...safeMaximum).contains(value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "JSON integer values must stay within the interoperable safe range."
                )
            }
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            guard value.isFinite else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "JSON numbers must be finite."
                )
            }
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value."
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .boolean(value):
            try container.encode(value)
        case let .integer(value):
            let safeMaximum = Int64(ProtocolLexicalRules.jsonSafeIntegerMaximum)
            guard (-safeMaximum...safeMaximum).contains(value) else {
                throw EncodingError.invalidValue(
                    value,
                    EncodingError.Context(
                        codingPath: encoder.codingPath,
                        debugDescription: "JSON integer values must stay within the interoperable safe range."
                    )
                )
            }
            try container.encode(value)
        case let .number(value):
            guard value.isFinite else {
                throw EncodingError.invalidValue(
                    value,
                    EncodingError.Context(
                        codingPath: encoder.codingPath,
                        debugDescription: "JSON numbers must be finite."
                    )
                )
            }
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

/// A validated map of arbitrary namespaced protocol extensions.
public struct Extensions: Codable, Equatable, Sendable {
    public private(set) var values: [String: JSONValue]

    public static let empty = Extensions()

    public init() {
        values = [:]
    }

    public init(_ values: [String: JSONValue]) throws {
        try Self.validateKeys(values.keys)
        self.values = values
    }

    public subscript(key: String) -> JSONValue? {
        values[key]
    }

    public var isEmpty: Bool {
        values.isEmpty
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let values = try container.decode([String: JSONValue].self)
        do {
            try Self.validateKeys(values.keys)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: String(describing: error)
            )
        }
        self.values = values
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(values)
    }

    private static func validateKeys<S: Sequence>(_ keys: S) throws where S.Element == String {
        for key in keys where !ProtocolLexicalRules.isNamespaced(key) {
            throw ProtocolModelError.invalidNamespacedKey(key)
        }
    }
}

public enum ProtocolModelError: Error, Equatable, CustomStringConvertible, Sendable {
    case invalidIdentifier(String)
    case invalidStableIdentifier(String)
    case invalidNamespacedKey(String)
    case integerOutsideJSONSafeRange(UInt64)
    case expectedPositiveInteger(UInt64)
    case invalidTimestamp(String)
    case invalidValue(String)

    public var description: String {
        switch self {
        case let .invalidIdentifier(value):
            "Invalid typed UUIDv7 identifier: \(value)"
        case let .invalidStableIdentifier(value):
            "Invalid stable identifier: \(value)"
        case let .invalidNamespacedKey(value):
            "Invalid namespaced key: \(value)"
        case let .integerOutsideJSONSafeRange(value):
            "Integer exceeds the JSON-safe range: \(value)"
        case let .expectedPositiveInteger(value):
            "Expected a positive JSON-safe integer, received: \(value)"
        case let .invalidTimestamp(value):
            "Invalid canonical UTC timestamp: \(value)"
        case let .invalidValue(message):
            message
        }
    }
}

enum ProtocolLexicalRules {
    static let jsonSafeIntegerMaximum: UInt64 = 9_007_199_254_740_991

    static func isTypedUUIDv7(_ value: String, prefix: String) -> Bool {
        matches(
            value,
            pattern: "^\(NSRegularExpression.escapedPattern(for: prefix))_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        )
    }

    static func isStableID(_ value: String) -> Bool {
        value.unicodeScalars.count <= 256 && matches(value, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
    }

    static func isNamespaced(_ value: String) -> Bool {
        matches(value, pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$")
    }

    static func isAdapterName(_ value: String) -> Bool {
        matches(value, pattern: "^[a-z][a-z0-9._-]*$")
    }

    static func isCanonicalTimestamp(_ value: String) -> Bool {
        guard matches(
            value,
            pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$"
        ) else {
            return false
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = value.contains(".")
            ? [.withInternetDateTime, .withFractionalSeconds]
            : [.withInternetDateTime]
        return formatter.date(from: value) != nil
    }

    static func matches(_ value: String, pattern: String) -> Bool {
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            return false
        }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return expression.firstMatch(in: value, range: range)?.range == range
    }
}

struct AnyCodingKey: CodingKey {
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

extension Decoder {
    func rejectUnknownKeys<Key>(_ keyType: Key.Type) throws
    where Key: CodingKey & CaseIterable {
        let container = try container(keyedBy: AnyCodingKey.self)
        let knownKeys = Set(keyType.allCases.map(\.stringValue))
        if let unknownKey = container.allKeys.first(where: { !knownKeys.contains($0.stringValue) }) {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: codingPath + [unknownKey],
                    debugDescription: "Unknown core field '\(unknownKey.stringValue)'. Add compatible values under a namespaced extensions key."
                )
            )
        }
    }
}
