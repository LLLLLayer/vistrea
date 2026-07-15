import Foundation
import Testing
@testable import VistreaStudioHostRuntime

struct StudioWorkspaceHistoryTests {
    @Test
    func migratesTheLegacySelectionWithoutPersistingCredentials() throws {
        let suiteName = "StudioWorkspaceHistoryTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let legacy = URL(fileURLWithPath: "/tmp/Legacy.vistrea", isDirectory: true)
        defaults.set(legacy.path, forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey)

        let history = StudioWorkspaceHistory(defaults: defaults)
        let recent = history.recentWorkspaces()

        #expect(recent.map(\.path) == [legacy.path])
        #expect(recent.first?.displayName == "Legacy")
        let payload = try #require(
            defaults.data(forKey: StudioWorkspaceHistory.recentWorkspacesDefaultsKey)
        )
        let serialized = String(decoding: payload, as: UTF8.self)
        #expect(!serialized.localizedCaseInsensitiveContains("token"))
        #expect(!serialized.localizedCaseInsensitiveContains("credential"))
    }

    @Test
    func recordsMostRecentFirstDeduplicatesAndBoundsHistory() throws {
        let suiteName = "StudioWorkspaceHistoryTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let history = StudioWorkspaceHistory(defaults: defaults)

        for index in 0..<14 {
            history.recordOpened(
                URL(fileURLWithPath: "/tmp/Workspace-\(index).vistrea", isDirectory: true),
                at: Date(timeIntervalSince1970: TimeInterval(index))
            )
        }
        history.recordOpened(
            URL(fileURLWithPath: "/tmp/Workspace-5.vistrea", isDirectory: true),
            at: Date(timeIntervalSince1970: 100)
        )

        let recent = history.recentWorkspaces()
        #expect(recent.count == 12)
        #expect(recent.first?.displayName == "Workspace-5")
        #expect(recent.filter { $0.displayName == "Workspace-5" }.count == 1)
        #expect(history.lastWorkspaceURL()?.path == "/tmp/Workspace-5.vistrea")
    }

    @Test
    func distinguishesMissingUnrecognizedAndExistingWorkspaces() throws {
        let suiteName = "StudioWorkspaceHistoryTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }

        let history = StudioWorkspaceHistory(defaults: defaults, fileManager: fileManager)
        #expect(history.availability(of: root) == .missing)

        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        #expect(history.availability(of: root) == .unrecognized)

        try Data().write(to: root.appendingPathComponent("metadata.sqlite"))
        #expect(history.availability(of: root) == .available)
    }

    @Test
    func removingAndClearingHistoryControlsAutomaticRestore() throws {
        let suiteName = "StudioWorkspaceHistoryTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let history = StudioWorkspaceHistory(defaults: defaults)
        let first = URL(fileURLWithPath: "/tmp/First.vistrea", isDirectory: true)
        let second = URL(fileURLWithPath: "/tmp/Second.vistrea", isDirectory: true)

        history.recordOpened(first, at: Date(timeIntervalSince1970: 1))
        history.recordOpened(second, at: Date(timeIntervalSince1970: 2))
        history.remove(second)
        #expect(history.recentWorkspaces().map(\.path) == [first.path])
        #expect(history.lastWorkspaceURL() == nil)

        history.recordOpened(first)
        history.clearRecentWorkspaces(preserving: first)
        #expect(history.recentWorkspaces().isEmpty)
        #expect(history.lastWorkspaceURL()?.path == first.path)

        history.markWorkspaceClosed()
        #expect(history.lastWorkspaceURL() == nil)
    }
}
