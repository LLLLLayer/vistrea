import Darwin
import Foundation
import VistreaStudioCore

public enum StudioWorkspaceLocation {
    public static let lastWorkspaceDefaultsKey = "VistreaStudioLastWorkspacePath"

    public static func applicationSupportRoot(
        fileManager: FileManager = .default
    ) throws -> URL {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base.appendingPathComponent("Vistrea Studio", isDirectory: true)
    }

    public static func defaultWorkspaceURL(
        fileManager: FileManager = .default
    ) throws -> URL {
        try applicationSupportRoot(fileManager: fileManager)
            .appendingPathComponent("Workspaces", isDirectory: true)
            .appendingPathComponent("Default.vistrea", isDirectory: true)
    }

    public static func preferredWorkspaceURL(
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) throws -> URL {
        if let storedPath = defaults.string(forKey: lastWorkspaceDefaultsKey),
           !storedPath.isEmpty,
           storedPath.hasPrefix("/") {
            return URL(fileURLWithPath: storedPath, isDirectory: true).standardizedFileURL
        }
        return try defaultWorkspaceURL(fileManager: fileManager)
    }
}

public enum ManagedStudioHostError: LocalizedError, Equatable {
    case embeddedRuntimeUnavailable
    case unsupportedArchitecture
    case launchFailed
    case exitedBeforeReady
    case startupTimedOut
    case invalidDescriptor

    public var errorDescription: String? {
        switch self {
        case .embeddedRuntimeUnavailable:
            "This Vistrea Studio build does not contain the embedded Host runtime."
        case .unsupportedArchitecture:
            "This Mac architecture is not supported by the embedded Host runtime."
        case .launchFailed:
            "Vistrea Studio could not launch its local Host."
        case .exitedBeforeReady:
            "The local Host exited before its private connection became ready."
        case .startupTimedOut:
            "The local Host did not become ready within 15 seconds."
        case .invalidDescriptor:
            "The local Host produced an invalid private connection descriptor."
        }
    }
}

private struct HostConnectionDescriptor: Decodable {
    struct API: Decodable {
        let baseURL: String
        let bearerToken: String

        enum CodingKeys: String, CodingKey {
            case baseURL = "base_url"
            case bearerToken = "bearer_token"
        }
    }

    let formatVersion: Int
    let processID: Int32
    let workspaceRoot: String
    let api: API

    enum CodingKeys: String, CodingKey {
        case formatVersion = "format_version"
        case processID = "process_id"
        case workspaceRoot = "workspace_root"
        case api
    }
}

@MainActor
public final class ManagedStudioHost {
    public let client: HTTPHostClient
    public let workspaceURL: URL

    private let process: Process
    private let descriptorURL: URL
    private var stopped = false

    private init(
        client: HTTPHostClient,
        workspaceURL: URL,
        process: Process,
        descriptorURL: URL
    ) {
        self.client = client
        self.workspaceURL = workspaceURL
        self.process = process
        self.descriptorURL = descriptorURL
    }

    public static var architectureDirectoryName: String? {
#if arch(arm64)
        "arm64"
#elseif arch(x86_64)
        "x86_64"
#else
        nil
#endif
    }

    public static func runtimeURL(resourceURL: URL) throws -> URL {
        guard let architectureDirectoryName else {
            throw ManagedStudioHostError.unsupportedArchitecture
        }
        let runtime = resourceURL
            .appendingPathComponent("HostRuntime", isDirectory: true)
            .appendingPathComponent(architectureDirectoryName, isDirectory: true)
        let node = runtime.appendingPathComponent("node", isDirectory: false)
        let serve = runtime
            .appendingPathComponent("app", isDirectory: true)
            .appendingPathComponent(".build/typescript/apps/host/serve.js", isDirectory: false)
        guard
            FileManager.default.isExecutableFile(atPath: node.path),
            FileManager.default.fileExists(atPath: serve.path)
        else {
            throw ManagedStudioHostError.embeddedRuntimeUnavailable
        }
        return runtime
    }

    public static func start(
        workspaceURL: URL,
        resourceURL: URL,
        applicationSupportURL: URL? = nil,
        fileManager: FileManager = .default
    ) throws -> ManagedStudioHost {
        let runtime = try runtimeURL(resourceURL: resourceURL)
        let requestedWorkspace = workspaceURL.standardizedFileURL
        guard requestedWorkspace.isFileURL, requestedWorkspace.path.hasPrefix("/") else {
            throw ManagedStudioHostError.launchFailed
        }
        try fileManager.createDirectory(
            at: requestedWorkspace,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let workspace = requestedWorkspace.resolvingSymlinksInPath()

        let supportRoot: URL
        if let applicationSupportURL {
            supportRoot = applicationSupportURL
        } else {
            supportRoot = try StudioWorkspaceLocation.applicationSupportRoot(
                fileManager: fileManager
            )
        }
        let runtimeState = supportRoot.appendingPathComponent("Runtime", isDirectory: true)
        try fileManager.createDirectory(
            at: runtimeState,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let descriptor = runtimeState
            .appendingPathComponent("host-\(UUID().uuidString).json", isDirectory: false)
        try? fileManager.removeItem(at: descriptor)

        let node = runtime.appendingPathComponent("node", isDirectory: false)
        let applicationRoot = runtime.appendingPathComponent("app", isDirectory: true)
        let serve = applicationRoot
            .appendingPathComponent(".build/typescript/apps/host/serve.js", isDirectory: false)
        let process = Process()
        process.executableURL = node
        process.currentDirectoryURL = applicationRoot
        process.arguments = [
            serve.path,
            "--workspace", workspace.path,
            "--connection-file", descriptor.path,
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["NODE_ENV"] = "production"
        process.environment = environment
        // An unread Pipe eventually fills and suspends a long-running Host.
        // Host startup failures are deliberately generic, so discard these
        // streams instead of creating an unbounded or credential-risky log.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            throw ManagedStudioHostError.launchFailed
        }

        do {
            let connection = try waitForDescriptor(
                at: descriptor,
                process: process,
                workspaceURL: workspace,
                fileManager: fileManager
            )
            let client = try HTTPHostClient(
                baseURL: connection.baseURL,
                bearerToken: connection.token
            )
            return ManagedStudioHost(
                client: client,
                workspaceURL: workspace,
                process: process,
                descriptorURL: descriptor
            )
        } catch {
            stop(process: process, descriptorURL: descriptor, fileManager: fileManager)
            throw error
        }
    }

    public func stop(fileManager: FileManager = .default) {
        guard !stopped else { return }
        stopped = true
        Self.stop(process: process, descriptorURL: descriptorURL, fileManager: fileManager)
    }

    private static func waitForDescriptor(
        at descriptorURL: URL,
        process: Process,
        workspaceURL: URL,
        fileManager: FileManager
    ) throws -> (baseURL: URL, token: String) {
        for _ in 0..<150 {
            if fileManager.fileExists(atPath: descriptorURL.path) {
                do {
                    let data = try Data(contentsOf: descriptorURL)
                    let descriptor = try JSONDecoder().decode(
                        HostConnectionDescriptor.self,
                        from: data
                    )
                    guard
                        descriptor.formatVersion == 1,
                        descriptor.processID == process.processIdentifier,
                        URL(fileURLWithPath: descriptor.workspaceRoot).standardizedFileURL ==
                            workspaceURL,
                        let baseURL = URL(string: descriptor.api.baseURL),
                        baseURL.scheme == "http",
                        ["127.0.0.1", "::1"].contains(baseURL.host),
                        baseURL.port != nil,
                        descriptor.api.bearerToken.count >= 32
                    else {
                        throw ManagedStudioHostError.invalidDescriptor
                    }
                    return (baseURL, descriptor.api.bearerToken)
                } catch is DecodingError {
                    // The Host creates the mode-0600 descriptor before its
                    // first write is complete. Retry a transient partial JSON
                    // read while the child remains alive.
                }
            }
            guard process.isRunning else {
                throw ManagedStudioHostError.exitedBeforeReady
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw ManagedStudioHostError.startupTimedOut
    }

    nonisolated private static func stop(
        process: Process,
        descriptorURL: URL,
        fileManager: FileManager
    ) {
        if process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(5)
            while process.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning {
                process.interrupt()
            }
            let interruptDeadline = Date().addingTimeInterval(1)
            while process.isRunning && Date() < interruptDeadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning {
                Darwin.kill(process.processIdentifier, SIGKILL)
            }
            process.waitUntilExit()
        }
        try? fileManager.removeItem(at: descriptorURL)
    }

    deinit {
        if !stopped {
            Self.stop(
                process: process,
                descriptorURL: descriptorURL,
                fileManager: .default
            )
        }
    }
}
