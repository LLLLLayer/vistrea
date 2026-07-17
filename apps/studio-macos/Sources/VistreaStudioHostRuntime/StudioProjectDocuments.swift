import Combine
import Foundation

public enum StudioProjectDocumentsPhase: Equatable, Sendable {
    case idle
    case unconfigured
    case loading
    case empty
    case content
    case failure(String)
}

public struct StudioProjectDocumentSummary: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let sourceName: String
    public let relativePath: String
    public let byteCount: Int

    public init(
        id: String,
        title: String,
        sourceName: String,
        relativePath: String,
        byteCount: Int
    ) {
        self.id = id
        self.title = title
        self.sourceName = sourceName
        self.relativePath = relativePath
        self.byteCount = byteCount
    }
}

public struct StudioProjectDocumentDetail: Equatable, Sendable {
    public let summary: StudioProjectDocumentSummary
    public let markdown: String

    public init(summary: StudioProjectDocumentSummary, markdown: String) {
        self.summary = summary
        self.markdown = markdown
    }
}

public struct StudioProjectDocumentCatalog: Equatable, Sendable {
    public let documents: [StudioProjectDocumentSummary]
    public let warnings: [String]
    public let usesProjectConfiguration: Bool

    public init(
        documents: [StudioProjectDocumentSummary],
        warnings: [String],
        usesProjectConfiguration: Bool
    ) {
        self.documents = documents
        self.warnings = warnings
        self.usesProjectConfiguration = usesProjectConfiguration
    }
}

public enum StudioProjectDocumentError: LocalizedError, Equatable, Sendable {
    case invalidProjectRoot
    case invalidConfiguration(String)
    case configurationAlreadyExists
    case documentUnavailable
    case documentTooLarge
    case documentIsNotUTF8

    public var errorDescription: String? {
        switch self {
        case .invalidProjectRoot:
            "Choose an existing local project directory."
        case let .invalidConfiguration(message):
            "vistrea.project.json is invalid: \(message)"
        case .configurationAlreadyExists:
            "vistrea.project.json already exists."
        case .documentUnavailable:
            "The Markdown document is no longer available inside the configured project."
        case .documentTooLarge:
            "The Markdown document exceeds the 2 MiB browsing limit."
        case .documentIsNotUTF8:
            "The Markdown document is not valid UTF-8."
        }
    }
}

/// Reads project-owned Markdown without importing it into the Vistrea
/// Workspace. The actor owns every filesystem operation so SwiftUI consumes
/// immutable summaries and content instead of constructing document paths.
public actor StudioProjectDocumentLibrary {
    public static let configurationFileName = "vistrea.project.json"
    public static let maximumDocumentBytes = 2 * 1_024 * 1_024
    public static let maximumDocumentCount = 5_000

    private struct Configuration: Decodable {
        let formatVersion: Int
        let documents: [Source]

        enum CodingKeys: String, CodingKey {
            case formatVersion = "format_version"
            case documents
        }
    }

    private struct Source: Decodable {
        let name: String
        let path: String
    }

    private let fileManager: FileManager
    private let ignoredDirectoryNames: Set<String> = [
        ".build", ".git", ".vistrea", "DerivedData", "build", "node_modules",
    ]

    public init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    public func scan(projectRoot: URL) throws -> StudioProjectDocumentCatalog {
        let root = try canonicalProjectRoot(projectRoot)
        let configurationURL = root.appendingPathComponent(
            Self.configurationFileName,
            isDirectory: false
        )
        let usesConfiguration = fileManager.fileExists(atPath: configurationURL.path)
        let sources: [Source]
        if usesConfiguration {
            let attributes = try fileManager.attributesOfItem(atPath: configurationURL.path)
            if (attributes[.size] as? NSNumber)?.intValue ?? 0 > 256 * 1_024 {
                throw StudioProjectDocumentError.invalidConfiguration(
                    "the configuration exceeds 256 KiB"
                )
            }
            do {
                let configuration = try JSONDecoder().decode(
                    Configuration.self,
                    from: Data(contentsOf: configurationURL)
                )
                guard configuration.formatVersion == 1 else {
                    throw StudioProjectDocumentError.invalidConfiguration(
                        "format_version must be 1"
                    )
                }
                guard !configuration.documents.isEmpty else {
                    throw StudioProjectDocumentError.invalidConfiguration(
                        "documents must contain at least one source"
                    )
                }
                sources = configuration.documents
            } catch let error as StudioProjectDocumentError {
                throw error
            } catch {
                throw StudioProjectDocumentError.invalidConfiguration(
                    "the file is not valid configuration JSON"
                )
            }
        } else {
            sources = [
                Source(name: "Project", path: "README.md"),
                Source(name: "Documentation", path: "docs"),
            ]
        }

        var warnings: [String] = []
        var documents: [StudioProjectDocumentSummary] = []
        var seenFiles = Set<String>()
        for source in sources {
            var sourceDocuments: [StudioProjectDocumentSummary] = []
            let name = source.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.count <= 100 else {
                warnings.append("A document source has an invalid name and was skipped.")
                continue
            }
            guard isSafeRelativePath(source.path) else {
                warnings.append("\(name): path must stay relative to the project root.")
                continue
            }
            let requestedURL = root.appendingPathComponent(source.path)
            guard fileManager.fileExists(atPath: requestedURL.path) else {
                warnings.append("\(name): \(source.path) does not exist.")
                continue
            }
            let target = requestedURL.resolvingSymlinksInPath().standardizedFileURL
            guard contains(target, inside: root) else {
                warnings.append("\(name): the configured path resolves outside the project.")
                continue
            }
            let values = try target.resourceValues(forKeys: [
                .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey,
            ])
            if values.isSymbolicLink == true {
                warnings.append("\(name): symbolic-link sources are not browsed.")
            } else if values.isRegularFile == true {
                appendDocument(
                    at: target,
                    sourceName: name,
                    projectRoot: root,
                    seenFiles: &seenFiles,
                    documents: &sourceDocuments,
                    warnings: &warnings
                )
            } else if values.isDirectory == true {
                scanDirectory(
                    target,
                    sourceName: name,
                    projectRoot: root,
                    seenFiles: &seenFiles,
                    documents: &sourceDocuments,
                    warnings: &warnings
                )
            } else {
                warnings.append("\(name): \(source.path) is not a file or directory.")
            }
            sourceDocuments.sort {
                $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending
            }
            documents.append(contentsOf: sourceDocuments)
            if documents.count >= Self.maximumDocumentCount {
                warnings.append(
                    "The document catalog was limited to \(Self.maximumDocumentCount) files."
                )
                break
            }
        }

        documents = Array(documents.prefix(Self.maximumDocumentCount))
        return StudioProjectDocumentCatalog(
            documents: documents,
            warnings: warnings,
            usesProjectConfiguration: usesConfiguration
        )
    }

    public func read(
        projectRoot: URL,
        document: StudioProjectDocumentSummary
    ) throws -> StudioProjectDocumentDetail {
        let root = try canonicalProjectRoot(projectRoot)
        guard isSafeRelativePath(document.relativePath) else {
            throw StudioProjectDocumentError.documentUnavailable
        }
        let requestedURL = root.appendingPathComponent(document.relativePath)
        let requestedValues = try? requestedURL.resourceValues(forKeys: [
            .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
        ])
        guard
            requestedValues?.isRegularFile == true,
            requestedValues?.isSymbolicLink != true,
            isMarkdown(requestedURL)
        else {
            throw StudioProjectDocumentError.documentUnavailable
        }
        let file = requestedURL.resolvingSymlinksInPath().standardizedFileURL
        guard contains(file, inside: root) else {
            throw StudioProjectDocumentError.documentUnavailable
        }
        let byteCount = requestedValues?.fileSize ?? 0
        guard byteCount <= Self.maximumDocumentBytes else {
            throw StudioProjectDocumentError.documentTooLarge
        }
        let data = try Data(contentsOf: file)
        guard data.count <= Self.maximumDocumentBytes else {
            throw StudioProjectDocumentError.documentTooLarge
        }
        guard let markdown = String(data: data, encoding: .utf8) else {
            throw StudioProjectDocumentError.documentIsNotUTF8
        }
        return StudioProjectDocumentDetail(summary: document, markdown: markdown)
    }

    @discardableResult
    public func createStarterConfiguration(projectRoot: URL) throws -> URL {
        let root = try canonicalProjectRoot(projectRoot)
        let configurationURL = root.appendingPathComponent(
            Self.configurationFileName,
            isDirectory: false
        )
        guard !fileManager.fileExists(atPath: configurationURL.path) else {
            throw StudioProjectDocumentError.configurationAlreadyExists
        }
        let contents = """
        {
          "format_version": 1,
          "documents": [
            { "name": "Project", "path": "README.md" },
            { "name": "Documentation", "path": "docs" }
          ]
        }

        """
        try Data(contents.utf8).write(to: configurationURL, options: .withoutOverwriting)
        return configurationURL
    }

    private func canonicalProjectRoot(_ source: URL) throws -> URL {
        let root = source.standardizedFileURL.resolvingSymlinksInPath()
        guard root.isFileURL, root.path.hasPrefix("/") else {
            throw StudioProjectDocumentError.invalidProjectRoot
        }
        let values = try? root.resourceValues(forKeys: [.isDirectoryKey])
        guard values?.isDirectory == true else {
            throw StudioProjectDocumentError.invalidProjectRoot
        }
        return root
    }

    private func scanDirectory(
        _ directory: URL,
        sourceName: String,
        projectRoot: URL,
        seenFiles: inout Set<String>,
        documents: inout [StudioProjectDocumentSummary],
        warnings: inout [String]
    ) {
        let keys: [URLResourceKey] = [
            .isDirectoryKey,
            .isRegularFileKey,
            .isSymbolicLinkKey,
            .fileSizeKey,
        ]
        guard let enumerator = fileManager.enumerator(
            at: directory,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            warnings.append("\(sourceName): the directory could not be read.")
            return
        }
        while let candidate = enumerator.nextObject() as? URL {
            if documents.count >= Self.maximumDocumentCount { return }
            guard let values = try? candidate.resourceValues(forKeys: Set(keys)) else {
                continue
            }
            if values.isSymbolicLink == true {
                if values.isDirectory == true { enumerator.skipDescendants() }
                continue
            }
            if values.isDirectory == true {
                if ignoredDirectoryNames.contains(candidate.lastPathComponent) {
                    enumerator.skipDescendants()
                }
                continue
            }
            guard values.isRegularFile == true else { continue }
            appendDocument(
                at: candidate,
                sourceName: sourceName,
                projectRoot: projectRoot,
                seenFiles: &seenFiles,
                documents: &documents,
                warnings: &warnings
            )
        }
    }

    private func appendDocument(
        at source: URL,
        sourceName: String,
        projectRoot: URL,
        seenFiles: inout Set<String>,
        documents: inout [StudioProjectDocumentSummary],
        warnings: inout [String]
    ) {
        guard isMarkdown(source) else { return }
        let file = source.standardizedFileURL.resolvingSymlinksInPath()
        guard contains(file, inside: projectRoot), seenFiles.insert(file.path).inserted else {
            return
        }
        let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values?.isRegularFile == true else { return }
        let byteCount = values?.fileSize ?? 0
        guard byteCount <= Self.maximumDocumentBytes else {
            warnings.append("\(relativePath(of: file, inside: projectRoot)) exceeds 2 MiB and was skipped.")
            return
        }
        let relativePath = relativePath(of: file, inside: projectRoot)
        let title = file.deletingPathExtension().lastPathComponent
        documents.append(
            StudioProjectDocumentSummary(
                id: relativePath,
                title: title,
                sourceName: sourceName,
                relativePath: relativePath,
                byteCount: byteCount
            )
        )
    }

    private func isMarkdown(_ url: URL) -> Bool {
        ["md", "markdown"].contains(url.pathExtension.lowercased())
    }

    private func isSafeRelativePath(_ source: String) -> Bool {
        let value = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.hasPrefix("/"), !value.hasPrefix("~") else {
            return false
        }
        let components = value.split(separator: "/", omittingEmptySubsequences: false)
        return !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
    }

    private func contains(_ candidate: URL, inside root: URL) -> Bool {
        candidate.path == root.path || candidate.path.hasPrefix(root.path + "/")
    }

    private func relativePath(of file: URL, inside root: URL) -> String {
        String(file.path.dropFirst(root.path.count + 1))
    }
}

/// Workspace-scoped presentation state for the read-only project document
/// library. Preferences retain only the local project-folder association;
/// the repository-owned configuration remains `vistrea.project.json`.
@MainActor
public final class StudioProjectDocuments: ObservableObject {
    private static let projectRootDefaultsPrefix = "VistreaStudioProjectRoot:"

    @Published public private(set) var phase: StudioProjectDocumentsPhase
    @Published public private(set) var documents: [StudioProjectDocumentSummary] = []
    @Published public private(set) var warnings: [String] = []
    @Published public private(set) var usesProjectConfiguration = false
    @Published public private(set) var projectRootURL: URL?
    @Published public private(set) var selectedDocumentID: String?
    @Published public private(set) var selectedDocument: StudioProjectDocumentDetail?
    @Published public private(set) var operationError: String?

    private let defaults: UserDefaults
    private let projectRootDefaultsKey: String
    private let library: StudioProjectDocumentLibrary
    private var catalogGeneration = 0
    private var selectionGeneration = 0

    public init(
        workspaceURL: URL?,
        defaults: UserDefaults = .standard,
        library: StudioProjectDocumentLibrary = StudioProjectDocumentLibrary()
    ) {
        self.defaults = defaults
        self.library = library
        let identity = workspaceURL?.standardizedFileURL.path ?? "external-host"
        projectRootDefaultsKey = Self.projectRootDefaultsPrefix + identity
        if let path = defaults.string(forKey: projectRootDefaultsKey), path.hasPrefix("/") {
            projectRootURL = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
            phase = .idle
        } else {
            projectRootURL = nil
            phase = .unconfigured
        }
    }

    public var configurationURL: URL? {
        projectRootURL?.appendingPathComponent(
            StudioProjectDocumentLibrary.configurationFileName,
            isDirectory: false
        )
    }

    public func configureProjectRoot(_ projectRoot: URL) async {
        let root = projectRoot.standardizedFileURL.resolvingSymlinksInPath()
        projectRootURL = root
        defaults.set(root.path, forKey: projectRootDefaultsKey)
        await refresh()
    }

    public func clearProjectRoot() {
        catalogGeneration += 1
        selectionGeneration += 1
        defaults.removeObject(forKey: projectRootDefaultsKey)
        projectRootURL = nil
        documents = []
        warnings = []
        usesProjectConfiguration = false
        selectedDocumentID = nil
        selectedDocument = nil
        operationError = nil
        phase = .unconfigured
    }

    public func refresh() async {
        catalogGeneration += 1
        let generation = catalogGeneration
        guard let projectRootURL else {
            phase = .unconfigured
            return
        }
        phase = .loading
        operationError = nil
        do {
            let catalog = try await library.scan(projectRoot: projectRootURL)
            guard generation == catalogGeneration else { return }
            let previousSelection = selectedDocumentID
            documents = catalog.documents
            warnings = catalog.warnings
            usesProjectConfiguration = catalog.usesProjectConfiguration
            phase = documents.isEmpty ? .empty : .content
            let nextSelection = documents.contains(where: { $0.id == previousSelection })
                ? previousSelection
                : documents.first?.id
            if let nextSelection {
                await selectDocument(id: nextSelection)
            } else {
                selectedDocumentID = nil
                selectedDocument = nil
            }
        } catch {
            guard generation == catalogGeneration else { return }
            documents = []
            warnings = []
            usesProjectConfiguration = false
            selectedDocumentID = nil
            selectedDocument = nil
            phase = .failure(error.localizedDescription)
        }
    }

    public func selectDocument(id: String) async {
        selectionGeneration += 1
        let generation = selectionGeneration
        guard
            let projectRootURL,
            let document = documents.first(where: { $0.id == id })
        else {
            return
        }
        selectedDocumentID = id
        operationError = nil
        do {
            let detail = try await library.read(
                projectRoot: projectRootURL,
                document: document
            )
            guard generation == selectionGeneration else { return }
            selectedDocument = detail
        } catch {
            guard generation == selectionGeneration else { return }
            selectedDocument = nil
            operationError = error.localizedDescription
        }
    }

    public func createStarterConfiguration() async {
        guard let projectRootURL else { return }
        operationError = nil
        do {
            _ = try await library.createStarterConfiguration(projectRoot: projectRootURL)
            await refresh()
        } catch {
            operationError = error.localizedDescription
        }
    }

    public func dismissOperationError() {
        operationError = nil
    }
}
