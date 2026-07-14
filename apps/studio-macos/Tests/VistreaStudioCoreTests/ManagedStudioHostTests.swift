import Foundation
import Testing
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
}
