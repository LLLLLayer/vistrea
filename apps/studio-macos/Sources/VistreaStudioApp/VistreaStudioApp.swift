import AppKit
import Sparkle
import SwiftUI
import VistreaStudioCore
import VistreaStudioHostRuntime

@main
enum VistreaStudioMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = StudioAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.finishLaunching()
        delegate.showMainWindow()
        application.activate(ignoringOtherApps: true)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
private final class StudioAppDelegate: NSObject, NSApplicationDelegate {
    private enum WindowContent {
        case welcome
        case workspace
    }

    private var model: SnapshotWorkspaceModel
    private var projectDocuments: StudioProjectDocuments
    private var managedHost: ManagedStudioHost?
    private let launchConfiguration: StudioLaunchConfiguration
    private let workspaceHistory: StudioWorkspaceHistory
    private let workspaceManagementEnabled: Bool
    private var windowContent: WindowContent
    private var workspaceMessage: String?
    private var updaterController: SPUStandardUpdaterController?
    private var window: NSWindow?

    override init() {
        let launchConfiguration = StudioLaunchConfiguration()
        let workspaceHistory = StudioWorkspaceHistory()
        let composition = StudioComposition.makeInitialClient(
            workspaceHistory: workspaceHistory,
            launchConfiguration: launchConfiguration
        )
        model = SnapshotWorkspaceModel(client: composition.client)
        projectDocuments = StudioProjectDocuments(
            workspaceURL: composition.managedHost?.workspaceURL
        )
        managedHost = composition.managedHost
        self.launchConfiguration = launchConfiguration
        self.workspaceHistory = workspaceHistory
        workspaceManagementEnabled = composition.workspaceManagementEnabled
        windowContent = composition.opensWelcome ? .welcome : .workspace
        workspaceMessage = composition.startupMessage
        if let workspaceURL = composition.managedHost?.workspaceURL {
            workspaceHistory.recordOpened(workspaceURL)
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        if !launchConfiguration.isUITesting {
            updaterController = StudioUpdates.makeUpdaterController()
        }
        configureApplicationMenu()
        showMainWindow()
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func configureApplicationMenu() {
        let mainMenu = NSMenu()
        let applicationMenuItem = NSMenuItem()
        let applicationMenu = NSMenu()

        applicationMenu.addItem(
            withTitle: "About Vistrea Studio",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )

        if let updaterController {
            let updateItem = NSMenuItem(
                title: "Check for Updates…",
                action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)),
                keyEquivalent: ""
            )
            updateItem.target = updaterController
            applicationMenu.addItem(updateItem)
        }

        applicationMenu.addItem(.separator())
        let quitItem = NSMenuItem(
            title: "Quit Vistrea Studio",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        quitItem.target = NSApplication.shared
        applicationMenu.addItem(quitItem)

        applicationMenuItem.submenu = applicationMenu
        mainMenu.addItem(applicationMenuItem)

        let fileMenuItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        let fileMenu = NSMenu(title: "File")
        if workspaceManagementEnabled {
            let newWorkspaceItem = NSMenuItem(
                title: "New Workspace…",
                action: #selector(newWorkspace(_:)),
                keyEquivalent: "n"
            )
            newWorkspaceItem.target = self
            fileMenu.addItem(newWorkspaceItem)

            let openWorkspaceItem = NSMenuItem(
                title: "Open Workspace…",
                action: #selector(openWorkspace(_:)),
                keyEquivalent: "o"
            )
            openWorkspaceItem.target = self
            fileMenu.addItem(openWorkspaceItem)

            let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
            recentItem.submenu = makeOpenRecentMenu()
            fileMenu.addItem(recentItem)
            fileMenu.addItem(.separator())

            let manageWorkspaceItem = NSMenuItem(
                title: "Manage Workspaces…",
                action: #selector(showWorkspaceManager(_:)),
                keyEquivalent: ""
            )
            manageWorkspaceItem.target = self
            fileMenu.addItem(manageWorkspaceItem)

            let revealWorkspaceItem = NSMenuItem(
                title: "Reveal Workspace in Finder",
                action: #selector(revealWorkspace(_:)),
                keyEquivalent: ""
            )
            revealWorkspaceItem.target = self
            revealWorkspaceItem.isEnabled = managedHost != nil
            fileMenu.addItem(revealWorkspaceItem)

            let closeWorkspaceItem = NSMenuItem(
                title: "Close Workspace",
                action: #selector(closeWorkspace(_:)),
                keyEquivalent: ""
            )
            closeWorkspaceItem.target = self
            closeWorkspaceItem.isEnabled = managedHost != nil
            fileMenu.addItem(closeWorkspaceItem)
        }
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        let viewMenuItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        let viewMenu = NSMenu(title: "View")
        for section in WorkspaceSection.allCases {
            let item = NSMenuItem(
                title: "Show \(section.rawValue)",
                action: #selector(selectWorkspaceSection(_:)),
                keyEquivalent: String(section.shortcutKey.character)
            )
            item.keyEquivalentModifierMask = [.command]
            item.target = self
            item.representedObject = section.rawValue
            viewMenu.addItem(item)
        }
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        NSApplication.shared.mainMenu = mainMenu
    }

    @objc
    private func selectWorkspaceSection(_ sender: NSMenuItem) {
        guard let section = sender.representedObject as? String else { return }
        NotificationCenter.default.post(
            name: StudioNavigationRequest.notification,
            object: section
        )
    }

    private func makeOpenRecentMenu() -> NSMenu {
        let menu = NSMenu(title: "Open Recent")
        let recent = workspaceHistory.recentWorkspaces()
        if recent.isEmpty {
            let empty = NSMenuItem(title: "No Recent Workspaces", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return menu
        }

        for workspace in recent {
            let item = NSMenuItem(
                title: workspace.displayName,
                action: #selector(openRecentWorkspace(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = workspace.path
            item.toolTip = workspace.path
            item.isEnabled = workspaceHistory.availability(of: workspace.url) == .available
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let clearItem = NSMenuItem(
            title: "Clear Recent",
            action: #selector(clearRecentWorkspaces(_:)),
            keyEquivalent: ""
        )
        clearItem.target = self
        menu.addItem(clearItem)
        return menu
    }

    @objc
    private func newWorkspace(_ sender: Any?) {
        let panel = NSSavePanel()
        panel.title = "New Vistrea Workspace"
        panel.message = "Choose a name and location for the local Workspace."
        panel.prompt = "Create"
        panel.nameFieldStringValue = "Untitled.vistrea"
        panel.canCreateDirectories = true
        panel.directoryURL = managedHost?.workspaceURL.deletingLastPathComponent() ??
            (try? StudioWorkspaceLocation.defaultWorkspaceURL().deletingLastPathComponent())
        guard panel.runModal() == .OK, let selectedURL = panel.url else { return }

        let workspaceURL = selectedURL.pathExtension.isEmpty ?
            selectedURL.appendingPathExtension("vistrea") : selectedURL
        let availability = workspaceHistory.availability(of: workspaceURL)
        if availability == .available || !isMissingOrEmptyDirectory(workspaceURL) {
            presentError(
                title: "Workspace Could Not Be Created",
                message: "The selected location already contains data. Open an existing Vistrea Workspace or choose a new empty location."
            )
            return
        }
        switchWorkspace(to: workspaceURL, creating: true)
    }

    @objc
    private func openWorkspace(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.title = "Open Vistrea Workspace"
        panel.message = "Choose an existing Vistrea Workspace folder."
        panel.prompt = "Open"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.treatsFilePackagesAsDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = managedHost?.workspaceURL.deletingLastPathComponent()
        guard panel.runModal() == .OK, let workspaceURL = panel.url else { return }
        guard workspaceHistory.availability(of: workspaceURL) == .available else {
            presentError(
                title: "Not a Vistrea Workspace",
                message: "This folder has no Vistrea Workspace metadata. Use New Workspace to initialize an empty location."
            )
            return
        }
        switchWorkspace(to: workspaceURL, creating: false)
    }

    @objc
    private func openRecentWorkspace(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        openRecentWorkspace(at: URL(fileURLWithPath: path, isDirectory: true))
    }

    @objc
    private func revealWorkspace(_ sender: Any?) {
        guard let workspaceURL = managedHost?.workspaceURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([workspaceURL])
    }

    @objc
    private func showWorkspaceManager(_ sender: Any?) {
        guard workspaceManagementEnabled else { return }
        windowContent = .welcome
        workspaceMessage = nil
        replaceWindowContent()
        updateWindowTitle()
    }

    @objc
    private func closeWorkspace(_ sender: Any?) {
        guard workspaceManagementEnabled, managedHost != nil else { return }
        model.stopExplorationPolling()
        managedHost?.stop()
        managedHost = nil
        model = SnapshotWorkspaceModel(
            client: UnavailableHostClient(message: "Open a Workspace to start its local Host.")
        )
        workspaceHistory.markWorkspaceClosed()
        workspaceMessage = nil
        windowContent = .welcome
        replaceWindowContent()
        updateWindowTitle()
        configureApplicationMenu()
    }

    @objc
    private func clearRecentWorkspaces(_ sender: Any?) {
        workspaceHistory.clearRecentWorkspaces(
            preserving: managedHost?.workspaceURL
        )
        if windowContent == .welcome {
            replaceWindowContent()
        }
        configureApplicationMenu()
    }

    private func openRecentWorkspace(at workspaceURL: URL) {
        switch workspaceHistory.availability(of: workspaceURL) {
        case .available:
            switchWorkspace(to: workspaceURL, creating: false)
        case .missing:
            workspaceMessage = "The Workspace location no longer exists. Remove it from Recent or locate it with Open Workspace."
            windowContent = .welcome
            replaceWindowContent()
            updateWindowTitle()
        case .unrecognized:
            workspaceMessage = "The selected folder is not a recognizable Vistrea Workspace. Its files were not modified."
            windowContent = .welcome
            replaceWindowContent()
            updateWindowTitle()
        }
    }

    private func switchWorkspace(to workspaceURL: URL, creating: Bool) {
        let workspace = workspaceHistory.normalizedURL(for: workspaceURL)
        if let current = managedHost?.workspaceURL,
           workspaceHistory.normalizedURL(for: current).path == workspace.path {
            windowContent = .workspace
            workspaceMessage = nil
            replaceWindowContent()
            updateWindowTitle()
            return
        }
        do {
            let nextHost = try StudioComposition.makeManagedHost(workspaceURL: workspace)
            let previousModel = model
            let previousHost = managedHost
            previousModel.stopExplorationPolling()
            model = SnapshotWorkspaceModel(client: nextHost.client)
            projectDocuments = StudioProjectDocuments(workspaceURL: nextHost.workspaceURL)
            managedHost = nextHost
            workspaceHistory.recordOpened(nextHost.workspaceURL)
            workspaceMessage = nil
            windowContent = .workspace
            replaceWindowContent()
            previousHost?.stop()
            updateWindowTitle()
            configureApplicationMenu()
        } catch {
            let action = creating ? "created" : "opened"
            workspaceMessage = "The Workspace could not be \(action): \(error.localizedDescription)"
            if managedHost == nil {
                windowContent = .welcome
                replaceWindowContent()
                updateWindowTitle()
            } else {
                presentError(
                    title: "Workspace Could Not Be \(creating ? "Created" : "Opened")",
                    message: error.localizedDescription
                )
            }
        }
    }

    private func isMissingOrEmptyDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            return true
        }
        guard isDirectory.boolValue else { return false }
        return (try? FileManager.default.contentsOfDirectory(atPath: url.path).isEmpty) == true
    }

    private func presentError(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    func showMainWindow() {
        guard window == nil else { return }
        // Every structural width comes from StudioLayoutMetrics so the window
        // minimum stays provably consistent with the panes it must hold.
        let window = NSWindow(contentViewController: makeContentViewController())
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.minSize = NSSize(
            width: StudioLayoutMetrics.windowMinWidth,
            height: StudioLayoutMetrics.windowMinHeight
        )
        if !launchConfiguration.isUITesting {
            window.setFrameAutosaveName("VistreaStudioSnapshotWorkspace")
        }
        window.setContentSize(
            NSSize(
                width: StudioLayoutMetrics.windowInitialWidth,
                height: StudioLayoutMetrics.windowInitialHeight
            )
        )
        window.center()
        self.window = window
        updateWindowTitle()
        window.makeKeyAndOrderFront(nil)
    }

    private func replaceWindowContent() {
        guard let window else { return }
        let frame = window.frame
        window.contentViewController = makeContentViewController()
        // Replacing an NSHostingController adopts the new root view's fitting
        // size. Workspace management is a surface switch, not a window resize.
        window.setFrame(frame, display: true)
    }

    private func makeContentViewController() -> NSViewController {
        let rootView: AnyView
        if workspaceManagementEnabled, windowContent == .welcome {
            rootView = AnyView(
                WorkspaceWelcomeView(
                    recentWorkspaces: workspaceHistory.recentWorkspaces(),
                    currentWorkspaceURL: managedHost?.workspaceURL,
                    message: workspaceMessage,
                    availability: { [weak self] url in
                        self?.workspaceHistory.availability(of: url) ?? .missing
                    },
                    onNewWorkspace: { [weak self] in
                        self?.newWorkspace(nil)
                    },
                    onOpenWorkspace: { [weak self] in
                        self?.openWorkspace(nil)
                    },
                    onOpenRecent: { [weak self] url in
                        self?.openRecentWorkspace(at: url)
                    },
                    onReveal: { url in
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    },
                    onRemoveRecent: { [weak self] url in
                        self?.removeRecentWorkspace(at: url)
                    },
                    onClearRecent: { [weak self] in
                        self?.clearRecentWorkspaces(nil)
                    },
                    onReturnToWorkspace: managedHost == nil ? nil : { [weak self] in
                        self?.returnToWorkspace()
                    }
                )
            )
        } else {
            let workspaceName = managedHost.map {
                StudioRecentWorkspace(path: $0.workspaceURL.path, lastOpenedAt: Date()).displayName
            }
            rootView = AnyView(
                SnapshotWorkspaceView(
                    model: model,
                    projectDocuments: projectDocuments,
                    workspaceName: workspaceName,
                    onManageWorkspaces: workspaceManagementEnabled ? { [weak self] in
                        self?.showWorkspaceManager(nil)
                    } : nil
                )
            )
        }

        return NSHostingController(
            rootView: rootView.frame(
                minWidth: StudioLayoutMetrics.windowMinWidth,
                minHeight: StudioLayoutMetrics.windowMinHeight
            )
        )
    }

    private func removeRecentWorkspace(at workspaceURL: URL) {
        if let current = managedHost?.workspaceURL,
           workspaceHistory.normalizedURL(for: current).path ==
            workspaceHistory.normalizedURL(for: workspaceURL).path {
            return
        }
        workspaceHistory.remove(workspaceURL)
        if windowContent == .welcome {
            replaceWindowContent()
        }
        configureApplicationMenu()
    }

    private func returnToWorkspace() {
        guard managedHost != nil else { return }
        workspaceMessage = nil
        windowContent = .workspace
        replaceWindowContent()
        updateWindowTitle()
    }

    private func updateWindowTitle() {
        guard let window else { return }
        if windowContent == .workspace, let workspaceURL = managedHost?.workspaceURL {
            let workspace = StudioRecentWorkspace(
                path: workspaceURL.path,
                lastOpenedAt: Date()
            )
            window.title = "\(workspace.displayName) — Vistrea Studio"
            window.representedURL = workspaceURL
        } else {
            window.title = "Vistrea Studio"
            window.representedURL = nil
        }
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        guard
            workspaceManagementEnabled,
            let filename = filenames.first
        else {
            sender.reply(toOpenOrPrint: .failure)
            return
        }

        let workspaceURL = URL(fileURLWithPath: filename, isDirectory: true)
        guard workspaceHistory.availability(of: workspaceURL) == .available else {
            workspaceMessage = "The opened item is not a recognizable Vistrea Workspace."
            windowContent = .welcome
            replaceWindowContent()
            updateWindowTitle()
            sender.reply(toOpenOrPrint: .failure)
            return
        }
        switchWorkspace(to: workspaceURL, creating: false)
        sender.reply(toOpenOrPrint: .success)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // The workspace itself is going away, so the exploration poll loop is
        // torn down here — never on a tab switch. The Host-side Operation
        // keeps running and stays cancellable from the next session.
        model.stopExplorationPolling()
        managedHost?.stop()
    }
}

private enum StudioUpdates {
    @MainActor
    static func makeUpdaterController(bundle: Bundle = .main) -> SPUStandardUpdaterController? {
        guard
            let feedValue = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
            let feedURL = URL(string: feedValue),
            feedURL.scheme == "https",
            feedURL.host != nil,
            let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
            Data(base64Encoded: publicKey)?.count == 32
        else {
            // `swift run` deliberately has no release metadata. Update checks
            // exist only in a packaged app with an HTTPS feed and Ed25519 key.
            return nil
        }

        return SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }
}

private enum StudioComposition {
    struct Result {
        let client: any HostClient
        let managedHost: ManagedStudioHost?
        let workspaceManagementEnabled: Bool
        let opensWelcome: Bool
        let startupMessage: String?

        init(
            client: any HostClient,
            managedHost: ManagedStudioHost? = nil,
            workspaceManagementEnabled: Bool = false,
            opensWelcome: Bool = false,
            startupMessage: String? = nil
        ) {
            self.client = client
            self.managedHost = managedHost
            self.workspaceManagementEnabled = workspaceManagementEnabled
            self.opensWelcome = opensWelcome
            self.startupMessage = startupMessage
        }
    }

    @MainActor
    static func makeInitialClient(
        workspaceHistory: StudioWorkspaceHistory,
        launchConfiguration: StudioLaunchConfiguration = StudioLaunchConfiguration()
    ) -> Result {
        if launchConfiguration.isUITesting {
            do {
                let snapshot = try CanonicalFixtureLoader.loadDefaultSnapshot()
                let client: any HostClient
                switch launchConfiguration.content {
                case .fixtureWorkspace, .fixtureWelcome:
                    client = FixtureWorkspace.makeClient(snapshot: snapshot)
                case .fixtureCanvasEmpty:
                    client = FixtureHostClient(snapshots: [snapshot])
                case .fixtureCanvasFailure:
                    client = FixtureHostClient(
                        snapshots: [snapshot],
                        canvasGraphFailureMessage: "The deterministic UI-test Screen Graph is unavailable."
                    )
                case .production:
                    preconditionFailure("Production is not a UI-testing launch mode.")
                }
                return Result(
                    client: client,
                    managedHost: nil,
                    workspaceManagementEnabled: launchConfiguration.content == .fixtureWelcome,
                    opensWelcome: launchConfiguration.content == .fixtureWelcome
                )
            } catch {
                return Result(
                    client: UnavailableHostClient(message: error.localizedDescription),
                    managedHost: nil,
                    workspaceManagementEnabled: launchConfiguration.content == .fixtureWelcome,
                    opensWelcome: launchConfiguration.content == .fixtureWelcome,
                    startupMessage: error.localizedDescription
                )
            }
        }

        let environment = ProcessInfo.processInfo.environment
        let hostURL = environment["VISTREA_HOST_URL"]
        let hostToken = environment["VISTREA_HOST_TOKEN"]

        if let hostURL, let hostToken {
            guard let url = URL(string: hostURL) else {
                return Result(
                    client: UnavailableHostClient(message: "VISTREA_HOST_URL is not a valid URL."),
                    managedHost: nil
                )
            }
            do {
                return Result(
                    client: try HTTPHostClient(baseURL: url, bearerToken: hostToken),
                    managedHost: nil
                )
            } catch {
                return Result(
                    client: UnavailableHostClient(message: error.localizedDescription),
                    managedHost: nil
                )
            }
        }

        if hostURL != nil || hostToken != nil {
            return Result(
                client: UnavailableHostClient(
                    message: "Set both VISTREA_HOST_URL and VISTREA_HOST_TOKEN, or unset both."
                ),
                managedHost: nil
            )
        }

        if Bundle.main.object(forInfoDictionaryKey: "VistreaEmbeddedHostRuntime") as? Bool == true {
            guard let workspaceURL = workspaceHistory.lastWorkspaceURL() else {
                return Result(
                    client: UnavailableHostClient(
                        message: "Open or create a Workspace to start the packaged local Host."
                    ),
                    workspaceManagementEnabled: true,
                    opensWelcome: true
                )
            }

            switch workspaceHistory.availability(of: workspaceURL) {
            case .missing:
                return Result(
                    client: UnavailableHostClient(message: "The previous Workspace is missing."),
                    workspaceManagementEnabled: true,
                    opensWelcome: true,
                    startupMessage: "The last Workspace location no longer exists. Choose another recent Workspace or locate it from disk."
                )
            case .unrecognized:
                return Result(
                    client: UnavailableHostClient(
                        message: "The previous location is not a Vistrea Workspace."
                    ),
                    workspaceManagementEnabled: true,
                    opensWelcome: true,
                    startupMessage: "The last location is not a recognizable Vistrea Workspace. No files were modified."
                )
            case .available:
                break
            }

            do {
                let host = try makeManagedHost(workspaceURL: workspaceURL)
                return Result(
                    client: host.client,
                    managedHost: host,
                    workspaceManagementEnabled: true
                )
            } catch {
                return Result(
                    client: UnavailableHostClient(
                        message: "The packaged local Host could not start: \(error.localizedDescription)"
                    ),
                    workspaceManagementEnabled: true,
                    opensWelcome: true,
                    startupMessage: "The last Workspace could not be opened: \(error.localizedDescription)"
                )
            }
        }

        do {
            // The fixture development mode composes the canonical Snapshot
            // with a materialized Screen Graph, Deep Wiki, and Review Issue so
            // the Canvas, identity curation, and knowledge links are reachable
            // without a Host.
            return Result(
                client: FixtureWorkspace.makeClient(
                    snapshot: try CanonicalFixtureLoader.loadDefaultSnapshot()
                ),
                managedHost: nil
            )
        } catch {
            return Result(
                client: UnavailableHostClient(message: error.localizedDescription),
                managedHost: nil
            )
        }
    }

    @MainActor
    static func makeManagedHost(workspaceURL: URL) throws -> ManagedStudioHost {
        guard let resourceURL = Bundle.main.resourceURL else {
            throw ManagedStudioHostError.embeddedRuntimeUnavailable
        }
        return try ManagedStudioHost.start(
            workspaceURL: workspaceURL,
            resourceURL: resourceURL
        )
    }
}
