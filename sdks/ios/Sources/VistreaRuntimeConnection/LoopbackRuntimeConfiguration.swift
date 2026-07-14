import CryptoKit
import Darwin
import Foundation

public enum RuntimeBuildConfiguration: String, Codable, Equatable, Sendable {
    case debug
    case `internal`
    case release
}

public enum RuntimeConnectionState: String, Equatable, Sendable {
    case disconnected
    case connecting
    case authenticating
    case ready
    case closing
    case closed
    case failed
}

public enum RuntimeConnectionBuildEligibility {
    public static func allows(_ configuration: RuntimeBuildConfiguration) -> Bool {
#if DEBUG
        configuration == .debug || configuration == .internal
#elseif VISTREA_INTERNAL_RUNTIME
        configuration == .internal
#else
        false
#endif
    }
}

public enum RuntimeConnectionError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidConfiguration
    case ineligibleBuild
    case unavailable
    case authenticationFailed
    case negotiationFailed
    case protocolViolation
    case resourceExhausted
    case timeout
    case cancelled
    case remoteError(code: String)

    public var description: String {
        switch self {
        case .invalidConfiguration:
            "The Runtime connection configuration is invalid."
        case .ineligibleBuild:
            "The Runtime connection is unavailable for this build configuration."
        case .unavailable:
            "The Runtime connection is unavailable."
        case .authenticationFailed:
            "Runtime authentication failed."
        case .negotiationFailed:
            "Runtime protocol or capability negotiation failed."
        case .protocolViolation:
            "The Runtime connection protocol was violated."
        case .resourceExhausted:
            "Runtime connection limits were exceeded."
        case .timeout:
            "The Runtime connection timed out."
        case .cancelled:
            "The Runtime connection was cancelled."
        case .remoteError:
            "The Runtime Host rejected the connection or operation."
        }
    }
}

public struct LoopbackRuntimeEndpoint: Equatable, Sendable {
    public let host: String
    public let port: UInt16

    public init(host: String = "127.0.0.1", port: UInt16) throws {
        guard host == "127.0.0.1" || host == "::1", port > 0 else {
            throw RuntimeConnectionError.invalidConfiguration
        }
        self.host = host
        self.port = port
    }
}

/// A physical-device Runtime endpoint protected by exact leaf-certificate
/// pinning. Only explicit IP literals are accepted so name resolution cannot
/// silently change the trusted peer.
public struct TlsRuntimeEndpoint: Equatable, Sendable {
    private static let sha256ByteCount = 32

    public let host: String
    public let port: UInt16
    public let pinnedCertificateSHA256: Data

    public init(
        host: String,
        port: UInt16,
        pinnedCertificateSHA256: Data
    ) throws {
        guard Self.isExplicitIPAddress(host),
              !Self.isUnspecifiedAddress(host),
              port > 0,
              pinnedCertificateSHA256.count == Self.sha256ByteCount
        else {
            throw RuntimeConnectionError.invalidConfiguration
        }
        self.host = host
        self.port = port
        self.pinnedCertificateSHA256 = pinnedCertificateSHA256
    }

    public init(
        host: String,
        port: UInt16,
        pinnedCertificateSHA256Hex: String
    ) throws {
        guard pinnedCertificateSHA256Hex.utf8.count == Self.sha256ByteCount * 2 else {
            throw RuntimeConnectionError.invalidConfiguration
        }
        var bytes = Data()
        bytes.reserveCapacity(Self.sha256ByteCount)
        var index = pinnedCertificateSHA256Hex.startIndex
        while index < pinnedCertificateSHA256Hex.endIndex {
            let next = pinnedCertificateSHA256Hex.index(index, offsetBy: 2)
            guard let byte = UInt8(pinnedCertificateSHA256Hex[index..<next], radix: 16) else {
                throw RuntimeConnectionError.invalidConfiguration
            }
            bytes.append(byte)
            index = next
        }
        try self.init(host: host, port: port, pinnedCertificateSHA256: bytes)
    }

    private static func isExplicitIPAddress(_ value: String) -> Bool {
        var ipv4 = in_addr()
        var ipv6 = in6_addr()
        return value.withCString { source in
            inet_pton(AF_INET, source, &ipv4) == 1 || inet_pton(AF_INET6, source, &ipv6) == 1
        }
    }

    private static func isUnspecifiedAddress(_ value: String) -> Bool {
        value == "0.0.0.0" || value == "::" || value == "0:0:0:0:0:0:0:0"
    }
}

public enum RuntimeEndpoint: Equatable, Sendable {
    case loopback(LoopbackRuntimeEndpoint)
    case tls(TlsRuntimeEndpoint)

    public var host: String {
        switch self {
        case let .loopback(endpoint): endpoint.host
        case let .tls(endpoint): endpoint.host
        }
    }

    public var port: UInt16 {
        switch self {
        case let .loopback(endpoint): endpoint.port
        case let .tls(endpoint): endpoint.port
        }
    }
}

public struct LoopbackRuntimeClientConfiguration: Sendable {
    public let endpoint: RuntimeEndpoint
    public let runtimeInstanceID: String
    public let buildConfiguration: RuntimeBuildConfiguration
    public let maximumInboundLineBytes: Int
    public let handshakeTimeoutMilliseconds: UInt64
    let authorizationKey: SymmetricKey

    public init(
        endpoint: LoopbackRuntimeEndpoint,
        authorizationToken: Data,
        runtimeInstanceID: String = "runtime.\(UUID().uuidString.lowercased())",
        buildConfiguration: RuntimeBuildConfiguration,
        maximumInboundLineBytes: Int = 4 * 1_024 * 1_024,
        handshakeTimeoutMilliseconds: UInt64 = 5_000
    ) throws {
        try self.init(
            runtimeEndpoint: .loopback(endpoint),
            authorizationToken: authorizationToken,
            runtimeInstanceID: runtimeInstanceID,
            buildConfiguration: buildConfiguration,
            maximumInboundLineBytes: maximumInboundLineBytes,
            handshakeTimeoutMilliseconds: handshakeTimeoutMilliseconds
        )
    }

    public init(
        endpoint: TlsRuntimeEndpoint,
        authorizationToken: Data,
        runtimeInstanceID: String = "runtime.\(UUID().uuidString.lowercased())",
        buildConfiguration: RuntimeBuildConfiguration,
        maximumInboundLineBytes: Int = 4 * 1_024 * 1_024,
        handshakeTimeoutMilliseconds: UInt64 = 5_000
    ) throws {
        try self.init(
            runtimeEndpoint: .tls(endpoint),
            authorizationToken: authorizationToken,
            runtimeInstanceID: runtimeInstanceID,
            buildConfiguration: buildConfiguration,
            maximumInboundLineBytes: maximumInboundLineBytes,
            handshakeTimeoutMilliseconds: handshakeTimeoutMilliseconds
        )
    }

    private init(
        runtimeEndpoint: RuntimeEndpoint,
        authorizationToken: Data,
        runtimeInstanceID: String,
        buildConfiguration: RuntimeBuildConfiguration,
        maximumInboundLineBytes: Int,
        handshakeTimeoutMilliseconds: UInt64
    ) throws {
        guard RuntimeConnectionBuildEligibility.allows(buildConfiguration) else {
            throw RuntimeConnectionError.ineligibleBuild
        }
        guard (32...4_096).contains(authorizationToken.count),
              Self.isRuntimeInstanceID(runtimeInstanceID),
              (1_024...(64 * 1_024 * 1_024)).contains(maximumInboundLineBytes),
              (10...300_000).contains(handshakeTimeoutMilliseconds)
        else {
            throw RuntimeConnectionError.invalidConfiguration
        }
        endpoint = runtimeEndpoint
        self.runtimeInstanceID = runtimeInstanceID
        self.buildConfiguration = buildConfiguration
        self.maximumInboundLineBytes = maximumInboundLineBytes
        self.handshakeTimeoutMilliseconds = handshakeTimeoutMilliseconds
        authorizationKey = SymmetricKey(data: authorizationToken)
    }

    private static func isRuntimeInstanceID(_ value: String) -> Bool {
        guard value.utf8.count <= 256 else {
            return false
        }
        let expression = try? NSRegularExpression(
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
        )
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return expression?.firstMatch(in: value, range: range)?.range == range
    }
}

struct RuntimeSessionLimits: Equatable, Sendable {
    let maximumLineBytes: Int
    let maximumObjectBytes: Int
    let maximumChunkBytes: Int
}
