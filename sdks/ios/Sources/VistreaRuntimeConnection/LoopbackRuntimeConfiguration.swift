import CryptoKit
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

public struct LoopbackRuntimeClientConfiguration: Sendable {
    public let endpoint: LoopbackRuntimeEndpoint
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
        self.endpoint = endpoint
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
