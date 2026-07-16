import Foundation
import Testing
@testable import VistreaStudioCore
@testable import VistreaStudioHostRuntime

@MainActor
struct ManagedStudioHostTests {
    @Test
    func resolvesOnlyACompleteRuntimeForTheCurrentArchitecture() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }

        #expect(throws: ManagedStudioHostError.embeddedRuntimeUnavailable) {
            try ManagedStudioHost.runtimeURL(resourceURL: root)
        }

        let architecture = try #require(ManagedStudioHost.architectureDirectoryName)
        let runtime = root
            .appendingPathComponent("HostRuntime", isDirectory: true)
            .appendingPathComponent(architecture, isDirectory: true)
        let serve = runtime
            .appendingPathComponent("app", isDirectory: true)
            .appendingPathComponent(".build/typescript/apps/host/serve.js", isDirectory: false)
        try fileManager.createDirectory(
            at: serve.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/sh\n".utf8).write(to: runtime.appendingPathComponent("node"))
        try fileManager.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: runtime.appendingPathComponent("node").path
        )
        try Data("export {};\n".utf8).write(to: serve)

        #expect(try ManagedStudioHost.runtimeURL(resourceURL: root) == runtime)
    }

    @Test
    func persistedWorkspaceSelectionWinsOverTheDefault() throws {
        let suiteName = "ManagedStudioHostTests-\(UUID())"
        let suite = try #require(UserDefaults(suiteName: suiteName))
        defer { suite.removePersistentDomain(forName: suiteName) }
        let selected = URL(fileURLWithPath: "/tmp/vistrea-selected", isDirectory: true)
        suite.set(selected.path, forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey)

        #expect(
            try StudioWorkspaceLocation.preferredWorkspaceURL(defaults: suite) ==
                selected.standardizedFileURL
        )
    }

    @Test
    func asyncStartDoesNotPollForTheDescriptorOnMainActor() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }

        let architecture = try #require(ManagedStudioHost.architectureDirectoryName)
        let runtime = root
            .appendingPathComponent("HostRuntime", isDirectory: true)
            .appendingPathComponent(architecture, isDirectory: true)
        let node = runtime.appendingPathComponent("node", isDirectory: false)
        let serve = runtime
            .appendingPathComponent("app", isDirectory: true)
            .appendingPathComponent(".build/typescript/apps/host/serve.js", isDirectory: false)
        try fileManager.createDirectory(
            at: serve.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let fakeNode = """
        #!/bin/sh
        shift
        workspace=
        descriptor=
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --workspace)
              workspace="$2"
              shift 2
              ;;
            --connection-file)
              descriptor="$2"
              shift 2
              ;;
            *)
              shift
              ;;
          esac
        done
        sleep 1
        printf '{"format_version":1,"process_id":%s,"workspace_root":"%s","api":{"base_url":"http://127.0.0.1:47831","bearer_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}\n' "$$" "$workspace" > "$descriptor"
        trap 'exit 0' TERM INT HUP
        while :; do sleep 1; done
        """
        try Data(fakeNode.utf8).write(to: node)
        try fileManager.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: node.path
        )
        try Data("export {};\n".utf8).write(to: serve)

        let workspace = root.appendingPathComponent("Workspace.vistrea", isDirectory: true)
        let support = root.appendingPathComponent("ApplicationSupport", isDirectory: true)
        let probe = AsyncStartupProbe()
        let clock = ContinuousClock()
        let startup = Task { @MainActor in
            probe.startedAt = clock.now
            return try await ManagedStudioHost.startAsync(
                workspaceURL: workspace,
                resourceURL: root,
                applicationSupportURL: support
            )
        }

        while probe.startedAt == nil {
            await Task.yield()
        }
        let startedAt = try #require(probe.startedAt)
        #expect(startedAt.duration(to: clock.now) < .milliseconds(500))

        let host = try await startup.value
        defer { host.stop() }
        #expect(host.workspaceURL == workspace.standardizedFileURL.resolvingSymlinksInPath())

        let runtimeState = support.appendingPathComponent("Runtime", isDirectory: true)
        let descriptors = try fileManager.contentsOfDirectory(
            at: runtimeState,
            includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "json" }
        #expect(descriptors.count == 1)

        await host.stopAsync()
        let remainingDescriptors = try fileManager.contentsOfDirectory(
            at: runtimeState,
            includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "json" }
        #expect(remainingDescriptors.isEmpty)
    }

    @Test
    func asyncStopDoesNotWaitForTheChildOnMainActor() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c",
            "trap 'sleep 0.25; exit 0' TERM; while :; do sleep 1; done",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            if process.isRunning {
                process.terminate()
                process.waitUntilExit()
            }
        }
        try await Task.sleep(nanoseconds: 100_000_000)

        let descriptor = FileManager.default.temporaryDirectory
            .appendingPathComponent("managed-host-\(UUID().uuidString).json")
        try Data("descriptor".utf8).write(to: descriptor)
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: String(repeating: "A", count: 43),
            transport: UnusedHostTransport()
        )
        let host = ManagedStudioHost(
            client: client,
            workspaceURL: URL(fileURLWithPath: "/tmp/managed-host-test.vistrea"),
            process: process,
            descriptorURL: descriptor
        )

        let clock = ContinuousClock()
        let started = clock.now
        let stop = Task { @MainActor in
            await host.stopAsync()
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(started.duration(to: clock.now) < .milliseconds(500))
        await stop.value
        #expect(!process.isRunning)
        #expect(!FileManager.default.fileExists(atPath: descriptor.path))
    }
}

@MainActor
private final class AsyncStartupProbe {
    var startedAt: ContinuousClock.Instant?
}

private struct UnusedHostTransport: HostHTTPTransport {
    func execute(
        _ request: URLRequest,
        maximumResponseBytes: Int
    ) async throws -> HostHTTPResponse {
        throw HostClientError.transport("The async-stop test does not perform HTTP requests.")
    }
}
