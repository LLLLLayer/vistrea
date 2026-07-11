import Foundation

public enum ObjectCompression: String, Codable, Equatable, Sendable {
    case none
    case gzip
    case zstd
}

public struct EncryptionReference: Codable, Equatable, Sendable {
    public let algorithm: String
    public let keyID: String

    public init(algorithm: String, keyID: String) throws {
        guard !algorithm.isEmpty, algorithm.unicodeScalars.count <= 64 else {
            throw ProtocolModelError.invalidValue("Encryption algorithm must contain 1 through 64 UTF-8 bytes.")
        }
        guard !keyID.isEmpty, keyID.unicodeScalars.count <= 256 else {
            throw ProtocolModelError.invalidValue("Encryption key ID must contain 1 through 256 UTF-8 bytes.")
        }
        self.algorithm = algorithm
        self.keyID = keyID
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case algorithm
        case keyID = "key_id"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let algorithm = try container.decode(String.self, forKey: .algorithm)
        let keyID = try container.decode(String.self, forKey: .keyID)
        do {
            try self.init(algorithm: algorithm, keyID: keyID)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .algorithm,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct ObjectReference: Codable, Equatable, Sendable {
    public let hash: String
    public let mediaType: String
    public let byteSize: JSONSafeUInt
    public let decodedByteSize: JSONSafeUInt?
    public let compression: ObjectCompression
    public let encryption: EncryptionReference?
    public let redactionProfile: String?
    public let logicalName: String?
    public let extensions: Extensions

    public init(
        hash: String,
        mediaType: String,
        byteSize: JSONSafeUInt,
        decodedByteSize: JSONSafeUInt? = nil,
        compression: ObjectCompression,
        encryption: EncryptionReference? = nil,
        redactionProfile: String? = nil,
        logicalName: String? = nil,
        extensions: Extensions = .empty
    ) throws {
        guard ProtocolLexicalRules.matches(hash, pattern: "^sha256:[0-9a-f]{64}$") else {
            throw ProtocolModelError.invalidValue("Object hash must be a canonical SHA-256 reference.")
        }
        guard mediaType.unicodeScalars.count >= 3, mediaType.unicodeScalars.count <= 128,
              ProtocolLexicalRules.matches(mediaType, pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$")
        else {
            throw ProtocolModelError.invalidValue("Object media type is invalid.")
        }
        if let redactionProfile,
           redactionProfile.isEmpty || redactionProfile.unicodeScalars.count > 128 {
            throw ProtocolModelError.invalidValue("Redaction profile must contain 1 through 128 UTF-8 bytes.")
        }
        if let logicalName, logicalName.isEmpty || logicalName.unicodeScalars.count > 512 {
            throw ProtocolModelError.invalidValue("Logical name must contain 1 through 512 UTF-8 bytes.")
        }
        self.hash = hash
        self.mediaType = mediaType
        self.byteSize = byteSize
        self.decodedByteSize = decodedByteSize
        self.compression = compression
        self.encryption = encryption
        self.redactionProfile = redactionProfile
        self.logicalName = logicalName
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case hash
        case mediaType = "media_type"
        case byteSize = "byte_size"
        case decodedByteSize = "decoded_byte_size"
        case compression
        case encryption
        case redactionProfile = "redaction_profile"
        case logicalName = "logical_name"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let hash = try container.decode(String.self, forKey: .hash)
        let mediaType = try container.decode(String.self, forKey: .mediaType)
        let byteSize = try container.decode(JSONSafeUInt.self, forKey: .byteSize)
        let decodedByteSize = try container.decodeIfPresent(JSONSafeUInt.self, forKey: .decodedByteSize)
        let compression = try container.decode(ObjectCompression.self, forKey: .compression)
        let encryption = try container.decodeIfPresent(EncryptionReference.self, forKey: .encryption)
        let redactionProfile = try container.decodeIfPresent(String.self, forKey: .redactionProfile)
        let logicalName = try container.decodeIfPresent(String.self, forKey: .logicalName)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                hash: hash,
                mediaType: mediaType,
                byteSize: byteSize,
                decodedByteSize: decodedByteSize,
                compression: compression,
                encryption: encryption,
                redactionProfile: redactionProfile,
                logicalName: logicalName,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .hash,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}
