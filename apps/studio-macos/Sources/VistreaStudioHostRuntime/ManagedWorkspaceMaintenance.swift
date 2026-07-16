import Foundation
import VistreaStudioCore

public enum ManagedWorkspaceMaintenanceError: Error, Equatable, Sendable {
    case embeddedRuntimeUnavailable
    case invalidWorkspace
    case invalidCommand
    case launchFailed
    case responseTooLarge(limit: Int)
    case invalidResponse
    case operationFailed(code: String, message: String, retryable: Bool)
}

extension ManagedWorkspaceMaintenanceError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .embeddedRuntimeUnavailable:
            "This Vistrea Studio build does not contain the embedded Workspace maintenance runtime."
        case .invalidWorkspace:
            "The Workspace location is invalid."
        case .invalidCommand:
            "The Workspace maintenance command is invalid."
        case .launchFailed:
            "Vistrea Studio could not launch Workspace maintenance."
        case let .responseTooLarge(limit):
            "Workspace maintenance exceeded its \(limit)-byte response limit."
        case .invalidResponse:
            "Workspace maintenance returned an invalid result."
        case let .operationFailed(_, message, _):
            message
        }
    }
}

public struct ManagedWorkspaceMaintenance: Sendable {
    static let maximumCommandBytes = 64 * 1_024
    static let maximumStdoutBytes = 64 * 1_024 * 1_024

    private let runtimeURL: URL
    private let processRunner: any WorkspaceMaintenanceProcessRunning

    public init(resourceURL: URL) throws {
        runtimeURL = try Self.runtimeURL(resourceURL: resourceURL)
        processRunner = FoundationWorkspaceMaintenanceProcessRunner()
    }

    init(
        runtimeURL: URL,
        processRunner: any WorkspaceMaintenanceProcessRunning
    ) {
        self.runtimeURL = runtimeURL
        self.processRunner = processRunner
    }

    public static func runtimeURL(resourceURL: URL) throws -> URL {
        let runtime: URL
        do {
            runtime = try ManagedStudioHost.runtimeURL(resourceURL: resourceURL)
        } catch {
            throw ManagedWorkspaceMaintenanceError.embeddedRuntimeUnavailable
        }
        let runner = runtime
            .appendingPathComponent("app", isDirectory: true)
            .appendingPathComponent(
                ".build/typescript/apps/host/workspace-maintenance.js",
                isDirectory: false
            )
        guard FileManager.default.fileExists(atPath: runner.path) else {
            throw ManagedWorkspaceMaintenanceError.embeddedRuntimeUnavailable
        }
        return runtime
    }

    public func restore(
        workspaceURL: URL,
        command: RestoreWorkspaceCommand
    ) async throws -> WorkspaceRestoreResult {
        try await execute(
            workspaceURL: workspaceURL,
            operation: .restore,
            command: command,
            result: WorkspaceRestoreResult.self
        )
    }

    public func collectGarbage(
        workspaceURL: URL,
        command: CollectWorkspaceGarbageCommand
    ) async throws -> CollectWorkspaceGarbageResult {
        try await execute(
            workspaceURL: workspaceURL,
            operation: .collectGarbage,
            command: command,
            result: CollectWorkspaceGarbageResult.self
        )
    }

    public func recoverInterruptedRestore(
        workspaceURL: URL,
        command: RecoverInterruptedRestoreCommand = RecoverInterruptedRestoreCommand()
    ) async throws -> RecoverInterruptedRestoreResult {
        try await execute(
            workspaceURL: workspaceURL,
            operation: .recoverInterruptedRestore,
            command: command,
            result: RecoverInterruptedRestoreResult.self
        )
    }

    public func recoverStaleLock(
        workspaceURL: URL,
        command: RecoverStaleLockCommand = RecoverStaleLockCommand()
    ) async throws -> RecoverStaleLockResult {
        try await execute(
            workspaceURL: workspaceURL,
            operation: .recoverStaleLock,
            command: command,
            result: RecoverStaleLockResult.self
        )
    }

    private func execute<Command, Result>(
        workspaceURL: URL,
        operation: WorkspaceMaintenanceOperation,
        command: Command,
        result: Result.Type
    ) async throws -> Result
    where Command: Encodable & Sendable, Result: Decodable & Sendable {
        let workspace = try canonicalWorkspaceURL(workspaceURL)
        let standardInput: Data
        do {
            var encoded = try JSONEncoder().encode(command)
            guard encoded.count < Self.maximumCommandBytes else {
                throw ManagedWorkspaceMaintenanceError.invalidCommand
            }
            encoded.append(0x0A)
            standardInput = encoded
        } catch let error as ManagedWorkspaceMaintenanceError {
            throw error
        } catch {
            throw ManagedWorkspaceMaintenanceError.invalidCommand
        }

        let applicationRoot = runtimeURL.appendingPathComponent("app", isDirectory: true)
        let executable = runtimeURL.appendingPathComponent("node", isDirectory: false)
        let runner = applicationRoot.appendingPathComponent(
            ".build/typescript/apps/host/workspace-maintenance.js",
            isDirectory: false
        )
        let request = WorkspaceMaintenanceProcessRequest(
            executableURL: executable,
            arguments: [runner.path, "--workspace", workspace.path],
            currentDirectoryURL: applicationRoot,
            environment: Self.productionEnvironment(),
            standardInput: standardInput,
            maximumStdoutBytes: Self.maximumStdoutBytes
        )
        let output: WorkspaceMaintenanceProcessResult
        do {
            output = try await processRunner.run(request)
        } catch WorkspaceMaintenanceProcessError.stdoutTooLarge {
            throw ManagedWorkspaceMaintenanceError.responseTooLarge(
                limit: Self.maximumStdoutBytes
            )
        } catch {
            throw ManagedWorkspaceMaintenanceError.launchFailed
        }

        let envelope: WorkspaceMaintenanceEnvelope<Result>
        do {
            envelope = try JSONDecoder().decode(
                WorkspaceMaintenanceEnvelope<Result>.self,
                from: output.standardOutput
            )
        } catch {
            throw ManagedWorkspaceMaintenanceError.invalidResponse
        }
        guard envelope.formatVersion == 1, envelope.operation == operation else {
            throw ManagedWorkspaceMaintenanceError.invalidResponse
        }
        switch envelope.status {
        case .succeeded:
            guard output.terminationStatus == 0,
                  envelope.error == nil,
                  let result = envelope.result
            else {
                throw ManagedWorkspaceMaintenanceError.invalidResponse
            }
            return result
        case .failed:
            guard output.terminationStatus != 0,
                  envelope.result == nil,
                  let error = envelope.error
            else {
                throw ManagedWorkspaceMaintenanceError.invalidResponse
            }
            throw ManagedWorkspaceMaintenanceError.operationFailed(
                code: error.code,
                message: error.message,
                retryable: error.retryable
            )
        }
    }

    private func canonicalWorkspaceURL(_ value: URL) throws -> URL {
        let standardized = value.standardizedFileURL
        guard standardized.isFileURL,
              standardized.path.hasPrefix("/"),
              standardized.path.utf8.count <= 4_096,
              !standardized.path.contains("\0")
        else {
            throw ManagedWorkspaceMaintenanceError.invalidWorkspace
        }
        return standardized.resolvingSymlinksInPath()
    }

    private static func productionEnvironment() -> [String: String] {
        var environment = [
            "NODE_ENV": "production",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        if let temporaryDirectory = ProcessInfo.processInfo.environment["TMPDIR"],
           temporaryDirectory.hasPrefix("/"),
           !temporaryDirectory.contains("\0") {
            environment["TMPDIR"] = temporaryDirectory
        }
        return environment
    }
}

struct WorkspaceMaintenanceProcessRequest: Equatable, Sendable {
    let executableURL: URL
    let arguments: [String]
    let currentDirectoryURL: URL
    let environment: [String: String]
    let standardInput: Data
    let maximumStdoutBytes: Int
}

struct WorkspaceMaintenanceProcessResult: Equatable, Sendable {
    let terminationStatus: Int32
    let standardOutput: Data
}

protocol WorkspaceMaintenanceProcessRunning: Sendable {
    func run(
        _ request: WorkspaceMaintenanceProcessRequest
    ) async throws -> WorkspaceMaintenanceProcessResult
}

enum WorkspaceMaintenanceProcessError: Error, Equatable, Sendable {
    case launchFailed
    case inputFailed
    case outputFailed
    case stdoutTooLarge
}

struct FoundationWorkspaceMaintenanceProcessRunner: WorkspaceMaintenanceProcessRunning {
    func run(
        _ request: WorkspaceMaintenanceProcessRequest
    ) async throws -> WorkspaceMaintenanceProcessResult {
        try await Task.detached(priority: .userInitiated) {
            try Self.runSynchronously(request)
        }.value
    }

    private static func runSynchronously(
        _ request: WorkspaceMaintenanceProcessRequest
    ) throws -> WorkspaceMaintenanceProcessResult {
        guard request.maximumStdoutBytes >= 0 else {
            throw WorkspaceMaintenanceProcessError.outputFailed
        }
        let input = Pipe()
        let output = Pipe()
        let process = Process()
        process.executableURL = request.executableURL
        process.arguments = request.arguments
        process.currentDirectoryURL = request.currentDirectoryURL
        process.environment = request.environment
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            throw WorkspaceMaintenanceProcessError.launchFailed
        }
        input.fileHandleForReading.closeFile()
        output.fileHandleForWriting.closeFile()

        do {
            try input.fileHandleForWriting.write(contentsOf: request.standardInput)
            try input.fileHandleForWriting.close()
        } catch {
            terminateAndWait(process)
            throw WorkspaceMaintenanceProcessError.inputFailed
        }

        var standardOutput = Data()
        var exceededLimit = false
        do {
            while let chunk = try output.fileHandleForReading.read(upToCount: 64 * 1_024),
                  !chunk.isEmpty {
                if !exceededLimit && chunk.count <= request.maximumStdoutBytes - standardOutput.count {
                    standardOutput.append(chunk)
                } else {
                    exceededLimit = true
                }
            }
            try output.fileHandleForReading.close()
        } catch {
            terminateAndWait(process)
            throw WorkspaceMaintenanceProcessError.outputFailed
        }
        process.waitUntilExit()
        guard !exceededLimit else {
            throw WorkspaceMaintenanceProcessError.stdoutTooLarge
        }
        return WorkspaceMaintenanceProcessResult(
            terminationStatus: process.terminationStatus,
            standardOutput: standardOutput
        )
    }

    private static func terminateAndWait(_ process: Process) {
        if process.isRunning {
            process.terminate()
        }
        process.waitUntilExit()
    }
}

private enum WorkspaceMaintenanceEnvelopeStatus: String, Decodable {
    case succeeded
    case failed
}

private struct WorkspaceMaintenanceEnvelope<Result: Decodable>: Decodable {
    let formatVersion: Int
    let status: WorkspaceMaintenanceEnvelopeStatus
    let operation: WorkspaceMaintenanceOperation
    let result: Result?
    let error: WorkspaceMaintenancePublicError?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case formatVersion = "format_version"
        case status
        case operation
        case result
        case error
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectMaintenanceEnvelopeUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        formatVersion = try container.decode(Int.self, forKey: .formatVersion)
        status = try container.decode(WorkspaceMaintenanceEnvelopeStatus.self, forKey: .status)
        operation = try container.decode(WorkspaceMaintenanceOperation.self, forKey: .operation)
        result = try container.decodeIfPresent(Result.self, forKey: .result)
        error = try container.decodeIfPresent(WorkspaceMaintenancePublicError.self, forKey: .error)
    }
}

private struct WorkspaceMaintenancePublicError: Decodable {
    let code: String
    let message: String
    let retryable: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case code
        case message
        case retryable
    }

    init(from decoder: Decoder) throws {
        try decoder.rejectMaintenanceEnvelopeUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        retryable = try container.decode(Bool.self, forKey: .retryable)
        guard (1...128).contains(code.utf16.count),
              (1...1_024).contains(message.utf16.count),
              !code.contains("\0"),
              !message.contains("\0")
        else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Invalid maintenance error.")
            )
        }
    }
}

private struct MaintenanceEnvelopeDynamicCodingKey: CodingKey {
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
    func rejectMaintenanceEnvelopeUnknownKeys<Keys>(_ keys: Keys.Type) throws
    where Keys: CodingKey & CaseIterable, Keys.AllCases: Collection {
        let container = try self.container(keyedBy: MaintenanceEnvelopeDynamicCodingKey.self)
        let allowed = Set(Keys.allCases.map(\.stringValue))
        let unknown = container.allKeys.map(\.stringValue).filter { !allowed.contains($0) }.sorted()
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: codingPath,
                    debugDescription: "Unknown maintenance envelope fields: \(unknown.joined(separator: ", "))"
                )
            )
        }
    }
}
