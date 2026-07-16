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

    init(
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

    nonisolated public static var architectureDirectoryName: String? {
#if arch(arm64)
        "arm64"
#elseif arch(x86_64)
        "x86_64"
#else
        nil
#endif
    }

    nonisolated public static func runtimeURL(resourceURL: URL) throws -> URL {
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
        let launch = try launch(
            workspaceURL: workspaceURL,
            resourceURL: resourceURL,
            applicationSupportURL: applicationSupportURL,
            fileManager: fileManager
        )
        return ManagedStudioHost(
            client: launch.client,
            workspaceURL: launch.workspaceURL,
            process: launch.process,
            descriptorURL: launch.descriptorURL
        )
    }

    /// Starts the managed Host without launching the process or polling its
    /// descriptor on MainActor. The returned instance remains MainActor-owned.
    public static func startAsync(
        workspaceURL: URL,
        resourceURL: URL,
        applicationSupportURL: URL? = nil,
        fileManager: FileManager = .default
    ) async throws -> ManagedStudioHost {
        let context = ManagedStudioHostStartContext(
            workspaceURL: workspaceURL,
            resourceURL: resourceURL,
            applicationSupportURL: applicationSupportURL,
            fileManager: fileManager
        )
        let launch = try await Task.detached(priority: .userInitiated) {
            try Self.launch(
                workspaceURL: context.workspaceURL,
                resourceURL: context.resourceURL,
                applicationSupportURL: context.applicationSupportURL,
                fileManager: context.fileManager
            )
        }.value
        return ManagedStudioHost(
            client: launch.client,
            workspaceURL: launch.workspaceURL,
            process: launch.process,
            descriptorURL: launch.descriptorURL
        )
    }

    nonisolated private static func launch(
        workspaceURL: URL,
        resourceURL: URL,
        applicationSupportURL: URL?,
        fileManager: FileManager
    ) throws -> ManagedStudioHostLaunchResult {
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
            return ManagedStudioHostLaunchResult(
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

    /// Stops the managed Host without performing process waits on MainActor.
    /// App termination and deinitialization retain the synchronous path above.
    public func stopAsync(fileManager: FileManager = .default) async {
        guard !stopped else { return }
        stopped = true
        let context = ManagedStudioHostStopContext(
            process: process,
            descriptorURL: descriptorURL,
            fileManager: fileManager
        )
        await Task.detached(priority: .userInitiated) {
            Self.stop(
                process: context.process,
                descriptorURL: context.descriptorURL,
                fileManager: context.fileManager
            )
        }.value
    }

    nonisolated private static func waitForDescriptor(
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

private final class ManagedStudioHostStartContext: @unchecked Sendable {
    let workspaceURL: URL
    let resourceURL: URL
    let applicationSupportURL: URL?
    let fileManager: FileManager

    init(
        workspaceURL: URL,
        resourceURL: URL,
        applicationSupportURL: URL?,
        fileManager: FileManager
    ) {
        self.workspaceURL = workspaceURL
        self.resourceURL = resourceURL
        self.applicationSupportURL = applicationSupportURL
        self.fileManager = fileManager
    }
}

private final class ManagedStudioHostLaunchResult: @unchecked Sendable {
    let client: HTTPHostClient
    let workspaceURL: URL
    let process: Process
    let descriptorURL: URL

    init(
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
}

private final class ManagedStudioHostStopContext: @unchecked Sendable {
    let process: Process
    let descriptorURL: URL
    let fileManager: FileManager

    init(process: Process, descriptorURL: URL, fileManager: FileManager) {
        self.process = process
        self.descriptorURL = descriptorURL
        self.fileManager = fileManager
    }
}
