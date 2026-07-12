import Foundation

private struct StrictJSONKeyIdentity: Hashable {
    let scalars: [UInt32]

    init(_ value: String) {
        scalars = value.unicodeScalars.map(\.value)
    }
}

/// Rejects duplicate object keys after JSON escape decoding.
///
/// Foundation decoders accept duplicate keys using last-value-wins behavior.
/// Authentication and message dispatch must not depend on that ambiguity, so
/// every object scope is checked before a wire value reaches `JSONDecoder`.
struct StrictJSONDuplicateKeyValidator {
    private static let maximumNestingDepth = 256

    private let bytes: [UInt8]
    private var index = 0

    init(data: Data) {
        bytes = Array(data)
    }

    mutating func validateObject() throws {
        skipWhitespace()
        guard peek() == 0x7b else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        try parseObject(depth: 0)
        skipWhitespace()
        guard index == bytes.count else {
            throw BoundedJSONLineError.invalidEnvelope
        }
    }

    private mutating func parseValue(depth: Int) throws {
        skipWhitespace()
        guard let byte = peek() else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        switch byte {
        case 0x7b:
            try parseObject(depth: depth)
        case 0x5b:
            try parseArray(depth: depth)
        case 0x22:
            _ = try scanString()
        case 0x74:
            try consumeLiteral("true")
        case 0x66:
            try consumeLiteral("false")
        case 0x6e:
            try consumeLiteral("null")
        case 0x2d, 0x30...0x39:
            try parseNumber()
        default:
            throw BoundedJSONLineError.invalidEnvelope
        }
    }

    private mutating func parseObject(depth: Int) throws {
        guard depth < Self.maximumNestingDepth, consume(0x7b) else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        skipWhitespace()
        if consume(0x7d) {
            return
        }

        var keys = Set<StrictJSONKeyIdentity>()
        while true {
            skipWhitespace()
            let keyRange = try scanString()
            let keyData = Data(bytes[keyRange])
            let key: String
            do {
                key = try JSONDecoder().decode(String.self, from: keyData)
            } catch {
                throw BoundedJSONLineError.invalidEnvelope
            }
            guard keys.insert(StrictJSONKeyIdentity(key)).inserted else {
                throw BoundedJSONLineError.duplicateKey
            }
            skipWhitespace()
            guard consume(0x3a) else {
                throw BoundedJSONLineError.invalidEnvelope
            }
            try parseValue(depth: depth + 1)
            skipWhitespace()
            if consume(0x7d) {
                return
            }
            guard consume(0x2c) else {
                throw BoundedJSONLineError.invalidEnvelope
            }
        }
    }

    private mutating func parseArray(depth: Int) throws {
        guard depth < Self.maximumNestingDepth, consume(0x5b) else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        skipWhitespace()
        if consume(0x5d) {
            return
        }
        while true {
            try parseValue(depth: depth + 1)
            skipWhitespace()
            if consume(0x5d) {
                return
            }
            guard consume(0x2c) else {
                throw BoundedJSONLineError.invalidEnvelope
            }
        }
    }

    private mutating func scanString() throws -> Range<Int> {
        guard peek() == 0x22 else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        let start = index
        index += 1
        while index < bytes.count {
            let byte = bytes[index]
            index += 1
            if byte == 0x22 {
                return start..<index
            }
            if byte == 0x5c {
                guard index < bytes.count else {
                    throw BoundedJSONLineError.invalidEnvelope
                }
                let escape = bytes[index]
                index += 1
                if escape == 0x75 {
                    guard index <= bytes.count - 4,
                          bytes[index..<(index + 4)].allSatisfy(Self.isHexadecimalDigit)
                    else {
                        throw BoundedJSONLineError.invalidEnvelope
                    }
                    index += 4
                } else if ![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].contains(escape) {
                    throw BoundedJSONLineError.invalidEnvelope
                }
            } else if byte < 0x20 {
                throw BoundedJSONLineError.invalidEnvelope
            }
        }
        throw BoundedJSONLineError.invalidEnvelope
    }

    private mutating func parseNumber() throws {
        _ = consume(0x2d)
        if consume(0x30) {
            if let byte = peek(), (0x30...0x39).contains(byte) {
                throw BoundedJSONLineError.invalidEnvelope
            }
        } else {
            guard let first = peek(), (0x31...0x39).contains(first) else {
                throw BoundedJSONLineError.invalidEnvelope
            }
            index += 1
            while let byte = peek(), (0x30...0x39).contains(byte) {
                index += 1
            }
        }
        if consume(0x2e) {
            try consumeDigits()
        }
        if consume(0x65) || consume(0x45) {
            _ = consume(0x2b) || consume(0x2d)
            try consumeDigits()
        }
    }

    private mutating func consumeDigits() throws {
        guard let first = peek(), (0x30...0x39).contains(first) else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        repeat {
            index += 1
        } while peek().map { (0x30...0x39).contains($0) } == true
    }

    private mutating func consumeLiteral(_ literal: String) throws {
        let expected = Array(literal.utf8)
        guard index <= bytes.count - expected.count,
              Array(bytes[index..<(index + expected.count)]) == expected
        else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        index += expected.count
    }

    private mutating func skipWhitespace() {
        while let byte = peek(), [0x20, 0x09, 0x0a, 0x0d].contains(byte) {
            index += 1
        }
    }

    private func peek() -> UInt8? {
        index < bytes.count ? bytes[index] : nil
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        guard peek() == byte else {
            return false
        }
        index += 1
        return true
    }

    private static func isHexadecimalDigit(_ byte: UInt8) -> Bool {
        (0x30...0x39).contains(byte)
            || (0x41...0x46).contains(byte)
            || (0x61...0x66).contains(byte)
    }
}
