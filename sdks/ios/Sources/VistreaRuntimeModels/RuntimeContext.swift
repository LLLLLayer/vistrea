import Foundation

public enum RuntimePlatform: String, Codable, Equatable, Sendable {
    case ios
    case android
}

public enum DeviceKind: String, Codable, Equatable, Sendable {
    case simulator
    case emulator
    case realDevice = "real_device"
}

public enum RuntimeTheme: String, Codable, Equatable, Sendable {
    case light
    case dark
    case system
    case custom
}

public struct DeviceDescriptor: Codable, Equatable, Sendable {
    public let deviceID: DeviceID?
    public let kind: DeviceKind
    public let model: String
    public let osVersion: String
    public let extensions: Extensions

    public init(
        deviceID: DeviceID? = nil,
        kind: DeviceKind,
        model: String,
        osVersion: String,
        extensions: Extensions = .empty
    ) throws {
        guard !model.isEmpty, model.unicodeScalars.count <= 256 else {
            throw ProtocolModelError.invalidValue("Device model must contain 1 through 256 UTF-8 bytes.")
        }
        guard !osVersion.isEmpty, osVersion.unicodeScalars.count <= 64 else {
            throw ProtocolModelError.invalidValue("OS version must contain 1 through 64 UTF-8 bytes.")
        }
        self.deviceID = deviceID
        self.kind = kind
        self.model = model
        self.osVersion = osVersion
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case deviceID = "device_id"
        case kind
        case model
        case osVersion = "os_version"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let deviceID = try container.decodeIfPresent(DeviceID.self, forKey: .deviceID)
        let kind = try container.decode(DeviceKind.self, forKey: .kind)
        let model = try container.decode(String.self, forKey: .model)
        let osVersion = try container.decode(String.self, forKey: .osVersion)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                deviceID: deviceID,
                kind: kind,
                model: model,
                osVersion: osVersion,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .model,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct RuntimeContext: Codable, Equatable, Sendable {
    public let projectID: ProjectID
    public let applicationID: String
    public let buildID: BuildID
    public let applicationVersion: String
    public let sourceGitSHA: String?
    public let platform: RuntimePlatform
    public let device: DeviceDescriptor
    public let environmentID: String
    public let accountProfileID: String?
    public let featureContextRefs: [String]?
    public let locale: String
    public let theme: RuntimeTheme
    public let textScale: Double
    public let sdkVersion: String
    public let adapterVersions: [String: String]
    public let extensions: Extensions

    public init(
        projectID: ProjectID,
        applicationID: String,
        buildID: BuildID,
        applicationVersion: String,
        sourceGitSHA: String? = nil,
        platform: RuntimePlatform,
        device: DeviceDescriptor,
        environmentID: String,
        accountProfileID: String? = nil,
        featureContextRefs: [String]? = nil,
        locale: String,
        theme: RuntimeTheme,
        textScale: Double,
        sdkVersion: String,
        adapterVersions: [String: String],
        extensions: Extensions = .empty
    ) throws {
        guard !applicationID.isEmpty, applicationID.unicodeScalars.count <= 256 else {
            throw ProtocolModelError.invalidValue("Application ID must contain 1 through 256 UTF-8 bytes.")
        }
        guard !applicationVersion.isEmpty, applicationVersion.unicodeScalars.count <= 128 else {
            throw ProtocolModelError.invalidValue("Application version must contain 1 through 128 UTF-8 bytes.")
        }
        if let sourceGitSHA,
           !ProtocolLexicalRules.matches(sourceGitSHA, pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$") {
            throw ProtocolModelError.invalidValue("Source Git SHA must contain 40 or 64 lowercase hexadecimal characters.")
        }
        guard !environmentID.isEmpty, environmentID.unicodeScalars.count <= 128 else {
            throw ProtocolModelError.invalidValue("Environment ID must contain 1 through 128 UTF-8 bytes.")
        }
        if let featureContextRefs, Set(featureContextRefs).count != featureContextRefs.count {
            throw ProtocolModelError.invalidValue("Feature context references must be unique.")
        }
        guard locale.unicodeScalars.count >= 2, locale.unicodeScalars.count <= 64 else {
            throw ProtocolModelError.invalidValue("Locale must contain 2 through 64 UTF-8 bytes.")
        }
        guard textScale.isFinite, textScale > 0, textScale <= 10 else {
            throw ProtocolModelError.invalidValue("Text scale must be finite, positive, and at most 10.")
        }
        guard !sdkVersion.isEmpty, sdkVersion.unicodeScalars.count <= 64 else {
            throw ProtocolModelError.invalidValue("SDK version must contain 1 through 64 UTF-8 bytes.")
        }
        guard !adapterVersions.isEmpty,
              adapterVersions.keys.allSatisfy(ProtocolLexicalRules.isAdapterName),
              adapterVersions.values.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 64 })
        else {
            throw ProtocolModelError.invalidValue("Adapter versions require at least one valid adapter name and version.")
        }

        self.projectID = projectID
        self.applicationID = applicationID
        self.buildID = buildID
        self.applicationVersion = applicationVersion
        self.sourceGitSHA = sourceGitSHA
        self.platform = platform
        self.device = device
        self.environmentID = environmentID
        self.accountProfileID = accountProfileID
        self.featureContextRefs = featureContextRefs
        self.locale = locale
        self.theme = theme
        self.textScale = textScale
        self.sdkVersion = sdkVersion
        self.adapterVersions = adapterVersions
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case projectID = "project_id"
        case applicationID = "application_id"
        case buildID = "build_id"
        case applicationVersion = "application_version"
        case sourceGitSHA = "source_git_sha"
        case platform
        case device
        case environmentID = "environment_id"
        case accountProfileID = "account_profile_id"
        case featureContextRefs = "feature_context_refs"
        case locale
        case theme
        case textScale = "text_scale"
        case sdkVersion = "sdk_version"
        case adapterVersions = "adapter_versions"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let projectID = try container.decode(ProjectID.self, forKey: .projectID)
        let applicationID = try container.decode(String.self, forKey: .applicationID)
        let buildID = try container.decode(BuildID.self, forKey: .buildID)
        let applicationVersion = try container.decode(String.self, forKey: .applicationVersion)
        let sourceGitSHA = try container.decodeIfPresent(String.self, forKey: .sourceGitSHA)
        let platform = try container.decode(RuntimePlatform.self, forKey: .platform)
        let device = try container.decode(DeviceDescriptor.self, forKey: .device)
        let environmentID = try container.decode(String.self, forKey: .environmentID)
        let accountProfileID = try container.decodeIfPresent(String.self, forKey: .accountProfileID)
        let featureContextRefs = try container.decodeIfPresent([String].self, forKey: .featureContextRefs)
        let locale = try container.decode(String.self, forKey: .locale)
        let theme = try container.decode(RuntimeTheme.self, forKey: .theme)
        let textScale = try container.decode(Double.self, forKey: .textScale)
        let sdkVersion = try container.decode(String.self, forKey: .sdkVersion)
        let adapterVersions = try container.decode([String: String].self, forKey: .adapterVersions)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                projectID: projectID,
                applicationID: applicationID,
                buildID: buildID,
                applicationVersion: applicationVersion,
                sourceGitSHA: sourceGitSHA,
                platform: platform,
                device: device,
                environmentID: environmentID,
                accountProfileID: accountProfileID,
                featureContextRefs: featureContextRefs,
                locale: locale,
                theme: theme,
                textScale: textScale,
                sdkVersion: sdkVersion,
                adapterVersions: adapterVersions,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .applicationID,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }

}
