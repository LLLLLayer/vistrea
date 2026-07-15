import Foundation
import Testing
@testable import VistreaStudioCore
@testable import VistreaStudioHostRuntime

@MainActor
struct StudioProjectDocumentsTests {
    @Test
    func defaultInspectorKeepsDesignReviewOutOfThePrimarySurface() {
        #expect(!StudioFeaturePolicy.designReviewVisibleByDefault)
    }

    @Test
    func configuredSourcesBrowseMarkdownAndPersistPerWorkspace() async throws {
        let suiteName = "StudioProjectDocumentsTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let project = root.appendingPathComponent("Project", isDirectory: true)
        let docs = project.appendingPathComponent("docs", isDirectory: true)
        let nested = docs.appendingPathComponent("guides", isDirectory: true)
        let workspace = root.appendingPathComponent("Main.vistrea", isDirectory: true)
        let otherWorkspace = root.appendingPathComponent("Other.vistrea", isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }

        try fileManager.createDirectory(at: nested, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: workspace, withIntermediateDirectories: true)
        try write("# Project\n", to: project.appendingPathComponent("README.md"))
        try write("# Guide\nBrowse this guide.\n", to: docs.appendingPathComponent("Guide.md"))
        try write("# Flow\n", to: nested.appendingPathComponent("Flow.markdown"))
        try write("not Markdown", to: docs.appendingPathComponent("ignored.txt"))
        try write(
            """
            {
              "format_version": 1,
              "documents": [
                { "name": "Project", "path": "README.md" },
                { "name": "Guides", "path": "docs" }
              ]
            }
            """,
            to: project.appendingPathComponent("vistrea.project.json")
        )

        let model = StudioProjectDocuments(workspaceURL: workspace, defaults: defaults)
        await model.configureProjectRoot(project)

        #expect(model.phase == .content)
        #expect(model.usesProjectConfiguration)
        #expect(model.documents.map(\.relativePath) == [
            "README.md", "docs/Guide.md", "docs/guides/Flow.markdown",
        ])
        #expect(model.documents.map(\.sourceName) == ["Project", "Guides", "Guides"])

        await model.selectDocument(id: "docs/Guide.md")
        #expect(model.selectedDocument?.markdown == "# Guide\nBrowse this guide.\n")

        let restored = StudioProjectDocuments(workspaceURL: workspace, defaults: defaults)
        await restored.refresh()
        #expect(restored.projectRootURL?.path == project.path)
        #expect(restored.documents.count == 3)

        let isolated = StudioProjectDocuments(workspaceURL: otherWorkspace, defaults: defaults)
        #expect(isolated.phase == .unconfigured)
        #expect(isolated.projectRootURL == nil)
    }

    @Test
    func scannerRejectsEscapesSymlinksAndUnsupportedConfigurations() async throws {
        let suiteName = "StudioProjectDocumentsTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let project = root.appendingPathComponent("Project", isDirectory: true)
        let docs = project.appendingPathComponent("docs", isDirectory: true)
        let outside = root.appendingPathComponent("outside.md")
        defer { try? fileManager.removeItem(at: root) }

        try fileManager.createDirectory(at: docs, withIntermediateDirectories: true)
        try write("# Inside\n", to: docs.appendingPathComponent("inside.md"))
        try write("# Outside\n", to: outside)
        try fileManager.createSymbolicLink(
            at: docs.appendingPathComponent("outside.md"),
            withDestinationURL: outside
        )
        try write(
            """
            {
              "format_version": 1,
              "documents": [
                { "name": "Docs", "path": "docs" },
                { "name": "Escape", "path": "../outside.md" }
              ]
            }
            """,
            to: project.appendingPathComponent("vistrea.project.json")
        )

        let model = StudioProjectDocuments(workspaceURL: nil, defaults: defaults)
        await model.configureProjectRoot(project)
        #expect(model.phase == .content)
        #expect(model.documents.map(\.relativePath) == ["docs/inside.md"])
        #expect(model.warnings.contains(where: { $0.contains("relative") }))

        try write(
            "{\"format_version\":2,\"documents\":[{\"name\":\"Docs\",\"path\":\"docs\"}]}",
            to: project.appendingPathComponent("vistrea.project.json"),
            replacing: true
        )
        await model.refresh()
        guard case let .failure(message) = model.phase else {
            Issue.record("Unsupported project document configuration should fail closed")
            return
        }
        #expect(message.contains("format_version must be 1"))
    }

    @Test
    func automaticSourcesCanCreateARepositoryOwnedStarterConfiguration() async throws {
        let suiteName = "StudioProjectDocumentsTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let fileManager = FileManager.default
        let project = fileManager.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? fileManager.removeItem(at: project) }

        try fileManager.createDirectory(
            at: project.appendingPathComponent("docs", isDirectory: true),
            withIntermediateDirectories: true
        )
        try write("# Read me\n", to: project.appendingPathComponent("README.md"))
        try write(
            "# Architecture\n",
            to: project.appendingPathComponent("docs/ARCHITECTURE.md")
        )

        let model = StudioProjectDocuments(workspaceURL: nil, defaults: defaults)
        await model.configureProjectRoot(project)
        #expect(model.phase == .content)
        #expect(!model.usesProjectConfiguration)
        #expect(model.documents.count == 2)

        await model.createStarterConfiguration()
        #expect(model.operationError == nil)
        #expect(model.usesProjectConfiguration)
        #expect(
            fileManager.fileExists(
                atPath: project.appendingPathComponent("vistrea.project.json").path
            )
        )
    }

    private func write(_ value: String, to url: URL, replacing: Bool = false) throws {
        if replacing {
            try Data(value.utf8).write(to: url, options: .atomic)
        } else {
            try Data(value.utf8).write(to: url, options: .withoutOverwriting)
        }
    }
}
