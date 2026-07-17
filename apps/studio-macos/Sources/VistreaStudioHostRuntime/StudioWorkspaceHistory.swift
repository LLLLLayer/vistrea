import Foundation

public struct StudioRecentWorkspace: Codable, Equatable, Identifiable {
    public let path: String
    public let lastOpenedAt: Date

    public var id: String { path }

    public var url: URL {
        URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    }

    public var displayName: String {
        let component = url.lastPathComponent
        guard !component.isEmpty else { return path }
        if url.pathExtension.caseInsensitiveCompare("vistrea") == .orderedSame {
            return url.deletingPathExtension().lastPathComponent
        }
        return component
    }

    public init(path: String, lastOpenedAt: Date) {
        self.path = path
        self.lastOpenedAt = lastOpenedAt
    }
}

public enum StudioWorkspaceAvailability: Equatable {
    case available
    case missing
    case unrecognized
}

/// Stores only local Workspace locations and display history. The application
/// is not sandboxed, so persistent security-scoped bookmarks are unnecessary;
/// Host and Hub credentials never enter this preference payload.
public struct StudioWorkspaceHistory {
    public static let recentWorkspacesDefaultsKey = "VistreaStudioRecentWorkspaces"

    private static let historyInitializedDefaultsKey =
        "VistreaStudioRecentWorkspacesInitialized"
    private static let maximumRecentWorkspaceCount = 12

    private let defaults: UserDefaults
    private let fileManager: FileManager

    public init(
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) {
        self.defaults = defaults
        self.fileManager = fileManager
    }

    public func recentWorkspaces() -> [StudioRecentWorkspace] {
        if !defaults.bool(forKey: Self.historyInitializedDefaultsKey) {
            migrateLegacySelectionIfNeeded()
        }
        guard
            let data = defaults.data(forKey: Self.recentWorkspacesDefaultsKey),
            let decoded = try? JSONDecoder().decode([StudioRecentWorkspace].self, from: data)
        else {
            return []
        }

        var seenPaths = Set<String>()
        return decoded
            .filter { $0.path.hasPrefix("/") }
            .sorted { $0.lastOpenedAt > $1.lastOpenedAt }
            .filter { seenPaths.insert(normalizedURL(for: $0.url).path).inserted }
            .prefix(Self.maximumRecentWorkspaceCount)
            .map { $0 }
    }

    public func recordOpened(_ workspaceURL: URL, at date: Date = Date()) {
        let workspace = normalizedURL(for: workspaceURL)
        guard workspace.isFileURL, workspace.path.hasPrefix("/") else { return }

        var recent = recentWorkspaces().filter {
            normalizedURL(for: $0.url).path != workspace.path
        }
        recent.insert(
            StudioRecentWorkspace(path: workspace.path, lastOpenedAt: date),
            at: 0
        )
        persist(Array(recent.prefix(Self.maximumRecentWorkspaceCount)))
        defaults.set(workspace.path, forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey)
    }

    public func remove(_ workspaceURL: URL) {
        let workspace = normalizedURL(for: workspaceURL)
        let remaining = recentWorkspaces().filter {
            normalizedURL(for: $0.url).path != workspace.path
        }
        persist(remaining)
        if lastWorkspaceURL().map({ normalizedURL(for: $0).path }) == workspace.path {
            defaults.removeObject(forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey)
        }
    }

    public func clearRecentWorkspaces(preserving currentWorkspaceURL: URL? = nil) {
        persist([])
        if let currentWorkspaceURL {
            defaults.set(
                normalizedURL(for: currentWorkspaceURL).path,
                forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey
            )
        } else {
            defaults.removeObject(forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey)
        }
    }

    public func markWorkspaceClosed() {
        defaults.removeObject(forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey)
    }

    public func lastWorkspaceURL() -> URL? {
        guard
            let path = defaults.string(forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey),
            path.hasPrefix("/")
        else {
            return nil
        }
        return normalizedURL(
            for: URL(fileURLWithPath: path, isDirectory: true)
        )
    }

    public func availability(of workspaceURL: URL) -> StudioWorkspaceAvailability {
        let workspace = normalizedURL(for: workspaceURL)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: workspace.path, isDirectory: &isDirectory) else {
            return .missing
        }
        guard isDirectory.boolValue else { return .unrecognized }

        let metadata = workspace.appendingPathComponent("metadata.sqlite", isDirectory: false)
        let manifest = workspace.appendingPathComponent("workspace.json", isDirectory: false)
        if fileManager.fileExists(atPath: metadata.path) ||
            fileManager.fileExists(atPath: manifest.path) {
            return .available
        }
        return .unrecognized
    }

    public func normalizedURL(for workspaceURL: URL) -> URL {
        let standardized = workspaceURL.standardizedFileURL
        if fileManager.fileExists(atPath: standardized.path) {
            return standardized.resolvingSymlinksInPath()
        }
        return standardized
    }

    private func migrateLegacySelectionIfNeeded() {
        defaults.set(true, forKey: Self.historyInitializedDefaultsKey)
        guard let workspace = lastWorkspaceURL() else {
            persist([])
            return
        }
        persist([
            StudioRecentWorkspace(path: workspace.path, lastOpenedAt: Date()),
        ])
    }

    private func persist(_ recent: [StudioRecentWorkspace]) {
        defaults.set(true, forKey: Self.historyInitializedDefaultsKey)
        guard let data = try? JSONEncoder().encode(recent) else { return }
        defaults.set(data, forKey: Self.recentWorkspacesDefaultsKey)
    }
}
