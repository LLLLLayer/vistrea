import CryptoKit
import Foundation

struct RuntimeConnectionProtocolVersion: Codable, Equatable, Hashable, Sendable {
    let major: UInt32
    let minor: UInt32

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case major
        case minor
    }

    init(major: UInt32, minor: UInt32) {
        self.major = major
        self.minor = minor
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectRuntimeAuthenticationUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        major = try container.decode(UInt32.self, forKey: .major)
        minor = try container.decode(UInt32.self, forKey: .minor)
    }
}

private struct RuntimeAuthenticationAnyCodingKey: CodingKey {
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
    func rejectRuntimeAuthenticationUnknownKeys<Key>(_ keyType: Key.Type) throws
    where Key: CodingKey & CaseIterable {
        let container = try container(keyedBy: RuntimeAuthenticationAnyCodingKey.self)
        let knownKeys = Set(keyType.allCases.map(\.stringValue))
        guard !container.allKeys.contains(where: { !knownKeys.contains($0.stringValue) }) else {
            throw RuntimeConnectionError.protocolViolation
        }
    }
}

enum RuntimeConnectionAuthentication {
    static let method = "hmac-sha256"
    static let snapshotCapability = "runtime.snapshot"
    static let eventsCapability = "runtime.events"
    static let version = RuntimeConnectionProtocolVersion(major: 1, minor: 0)

    static func clientProof(
        key: SymmetricKey,
        connectionAttemptID: String,
        hostNonce: String,
        clientNonce: String,
        runtimeInstanceID: String,
        buildConfiguration: RuntimeBuildConfiguration,
        supportedVersions: [RuntimeConnectionProtocolVersion],
        capabilities: [String]
    ) -> String {
        let message = [
            "vistrea-runtime-client-v1",
            connectionAttemptID,
            hostNonce,
            clientNonce,
            runtimeInstanceID,
            buildConfiguration.rawValue,
            normalize(versions: supportedVersions)
                .map { "\($0.major).\($0.minor)" }
                .joined(separator: ","),
            normalize(capabilities: capabilities).joined(separator: ","),
        ].joined(separator: "\n")
        return hexadecimalHMAC(key: key, message: message)
    }

    static func hostProofMessage(
        connectionAttemptID: String,
        connectionID: String,
        hostNonce: String,
        clientNonce: String,
        runtimeInstanceID: String,
        selectedVersion: RuntimeConnectionProtocolVersion,
        enabledCapabilities: [String]
    ) -> Data {
        Data(
            [
                "vistrea-runtime-host-v1",
                connectionAttemptID,
                connectionID,
                hostNonce,
                clientNonce,
                runtimeInstanceID,
                "\(selectedVersion.major).\(selectedVersion.minor)",
                normalize(capabilities: enabledCapabilities).joined(separator: ","),
            ].joined(separator: "\n").utf8
        )
    }

    static func hostProof(
        key: SymmetricKey,
        connectionAttemptID: String,
        connectionID: String,
        hostNonce: String,
        clientNonce: String,
        runtimeInstanceID: String,
        selectedVersion: RuntimeConnectionProtocolVersion,
        enabledCapabilities: [String]
    ) -> String {
        let message = hostProofMessage(
            connectionAttemptID: connectionAttemptID,
            connectionID: connectionID,
            hostNonce: hostNonce,
            clientNonce: clientNonce,
            runtimeInstanceID: runtimeInstanceID,
            selectedVersion: selectedVersion,
            enabledCapabilities: enabledCapabilities
        )
        let authenticationCode = HMAC<SHA256>.authenticationCode(for: message, using: key)
        return hexadecimal(authenticationCode)
    }

    static func verifyHostProof(
        _ proof: String,
        key: SymmetricKey,
        connectionAttemptID: String,
        connectionID: String,
        hostNonce: String,
        clientNonce: String,
        runtimeInstanceID: String,
        selectedVersion: RuntimeConnectionProtocolVersion,
        enabledCapabilities: [String]
    ) -> Bool {
        guard let proofBytes = data(fromLowercaseHexadecimal: proof), proofBytes.count == 32 else {
            return false
        }
        return HMAC<SHA256>.isValidAuthenticationCode(
            proofBytes,
            authenticating: hostProofMessage(
                connectionAttemptID: connectionAttemptID,
                connectionID: connectionID,
                hostNonce: hostNonce,
                clientNonce: clientNonce,
                runtimeInstanceID: runtimeInstanceID,
                selectedVersion: selectedVersion,
                enabledCapabilities: enabledCapabilities
            ),
            using: key
        )
    }

    static func normalize(
        versions: [RuntimeConnectionProtocolVersion]
    ) -> [RuntimeConnectionProtocolVersion] {
        versions.sorted { left, right in
            left.major == right.major ? left.minor < right.minor : left.major < right.major
        }
    }

    static func normalize(capabilities: [String]) -> [String] {
        capabilities.sorted()
    }

    private static func hexadecimalHMAC(key: SymmetricKey, message: String) -> String {
        let authenticationCode = HMAC<SHA256>.authenticationCode(
            for: Data(message.utf8),
            using: key
        )
        return hexadecimal(authenticationCode)
    }

    private static func hexadecimal<Bytes: Sequence>(_ bytes: Bytes) -> String
    where Bytes.Element == UInt8 {
        let digits = Array("0123456789abcdef".utf8)
        var result = [UInt8]()
        result.reserveCapacity(64)
        for byte in bytes {
            result.append(digits[Int(byte >> 4)])
            result.append(digits[Int(byte & 0x0f)])
        }
        return String(decoding: result, as: UTF8.self)
    }

    private static func data(fromLowercaseHexadecimal value: String) -> Data? {
        guard value.utf8.count == 64 else {
            return nil
        }
        let bytes = Array(value.utf8)
        var result = Data(capacity: 32)
        for index in stride(from: 0, to: bytes.count, by: 2) {
            guard let high = hexadecimalValue(bytes[index]),
                  let low = hexadecimalValue(bytes[index + 1])
            else {
                return nil
            }
            result.append((high << 4) | low)
        }
        return result
    }

    private static func hexadecimalValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57:
            byte - 48
        case 97...102:
            byte - 87
        default:
            nil
        }
    }
}
