import Foundation

enum BoundedJSONLineError: Error, Equatable, Sendable {
    case lineTooLarge
    case malformedUTF8
    case invalidEnvelope
    case duplicateKey
    case truncatedLine
}

struct BoundedJSONLineDecoder: Sendable {
    private var buffer = Data()
    private var maximumLineBytes: Int

    init(maximumLineBytes: Int) {
        self.maximumLineBytes = maximumLineBytes
    }

    mutating func updateMaximumLineBytes(_ value: Int) throws {
        maximumLineBytes = value
        try validatePendingLineBound()
    }

    mutating func enqueue(_ data: Data) throws {
        buffer.append(data)
        try validatePendingLineBound()
    }

    mutating func nextLine() throws -> Data? {
        guard let newline = buffer.firstIndex(of: 0x0a) else {
            return nil
        }
        var line = Data(buffer[..<newline])
        buffer.removeSubrange(...newline)
        if line.last == 0x0d {
            line.removeLast()
        }
        guard !line.isEmpty else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        guard line.count <= maximumLineBytes else {
            throw BoundedJSONLineError.lineTooLarge
        }
        guard String(data: line, encoding: .utf8) != nil else {
            throw BoundedJSONLineError.malformedUTF8
        }
        // Enforce duplicate-key and nesting bounds before asking Foundation to
        // materialize an attacker-controlled object graph.
        var duplicateKeyValidator = StrictJSONDuplicateKeyValidator(data: line)
        try duplicateKeyValidator.validateObject()
        let value = try? JSONSerialization.jsonObject(with: line)
        guard value is [String: Any] else {
            throw BoundedJSONLineError.invalidEnvelope
        }
        try validatePendingLineBound()
        return line
    }

    mutating func append(_ data: Data) throws -> [Data] {
        try enqueue(data)
        var lines: [Data] = []
        while let line = try nextLine() {
            lines.append(line)
        }
        return lines
    }

    func validateCompleteStream() throws {
        guard buffer.isEmpty else {
            throw BoundedJSONLineError.truncatedLine
        }
    }

    private func validatePendingLineBound() throws {
        let end = buffer.firstIndex(of: 0x0a) ?? buffer.endIndex
        var length = buffer.distance(from: buffer.startIndex, to: end)
        if length > 0, buffer[buffer.index(before: end)] == 0x0d {
            length -= 1
        }
        guard length <= maximumLineBytes else {
            throw BoundedJSONLineError.lineTooLarge
        }
    }
}
