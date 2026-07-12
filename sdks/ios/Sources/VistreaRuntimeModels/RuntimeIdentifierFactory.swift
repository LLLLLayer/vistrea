import CryptoKit
import Foundation

/// Generates canonical typed UUIDv7 identifiers for runtime-produced models.
public enum RuntimeIdentifierFactory {
    public static func make(prefix: String, date: Date = Date()) -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        let milliseconds = UInt64(max(0, date.timeIntervalSince1970 * 1_000))
        for index in 0..<6 {
            bytes[5 - index] = UInt8((milliseconds >> UInt64(index * 8)) & 0xff)
        }
        for index in 6..<16 {
            bytes[index] = UInt8.random(in: .min ... .max)
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x70
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return "\(prefix)_\(format(bytes))"
    }

    public static func deterministic(prefix: String, seed: String) -> String {
        var bytes = Array(SHA256.hash(data: Data(seed.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x70
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return "\(prefix)_\(format(bytes))"
    }

    private static func format(_ bytes: [UInt8]) -> String {
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return [
            String(hex.prefix(8)),
            String(hex.dropFirst(8).prefix(4)),
            String(hex.dropFirst(12).prefix(4)),
            String(hex.dropFirst(16).prefix(4)),
            String(hex.dropFirst(20).prefix(12)),
        ].joined(separator: "-")
    }
}
