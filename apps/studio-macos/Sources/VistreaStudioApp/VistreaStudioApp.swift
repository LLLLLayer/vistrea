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
        case workspaceManager
    }

    private var model: SnapshotWorkspaceModel
    private var projectDocuments: StudioProjectDocuments
    private var managedHost: ManagedStudioHost?
    private let launchConfiguration: StudioLaunchConfiguration
    private let workspaceHistory: StudioWorkspaceHistory
    private let workspaceManagementEnabled: Bool
    private let workspaceMaintenanceModel: WorkspaceMaintenanceViewModel
    private var windowContent: WindowContent
    private var workspaceMessage: String?
    private var selectedManagerWorkspaceURL: URL?
    private var maintenanceWorkspacePath: String?
    private var offlineRepairEligibleWorkspaceURL: URL?
    private var offlineRepairMessage: String?
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
        workspaceMaintenanceModel = WorkspaceMaintenanceViewModel(
            client: composition.managedHost?.client
        )
        if let minimumAgeDays = launchConfiguration.garbageMinimumAgeDaysOverride {
            workspaceMaintenanceModel.garbageMinimumAgeDays = minimumAgeDays
        }
        windowContent = composition.opensWelcome ? .welcome : .workspace
        workspaceMessage = composition.startupMessage
        selectedManagerWorkspaceURL = composition.managedHost?.workspaceURL ??
            workspaceHistory.lastWorkspaceURL()
        maintenanceWorkspacePath = composition.managedHost?.workspaceURL.standardizedFileURL.path
        offlineRepairEligibleWorkspaceURL = composition.failedWorkspaceURL
        offlineRepairMessage = composition.failedWorkspaceURL == nil ? nil : composition.startupMessage
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
            newWorkspaceItem.isEnabled = !workspaceMaintenanceModel.isBusy
            fileMenu.addItem(newWorkspaceItem)

            let openWorkspaceItem = NSMenuItem(
                title: "Open Workspace…",
                action: #selector(openWorkspace(_:)),
                keyEquivalent: "o"
            )
            openWorkspaceItem.target = self
            openWorkspaceItem.isEnabled = !workspaceMaintenanceModel.isBusy
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
            manageWorkspaceItem.isEnabled = !workspaceMaintenanceModel.isBusy
            fileMenu.addItem(manageWorkspaceItem)

            let revealWorkspaceItem = NSMenuItem(
                title: "Reveal Workspace in Finder",
                action: #selector(revealWorkspace(_:)),
                keyEquivalent: ""
            )
            revealWorkspaceItem.target = self
            revealWorkspaceItem.isEnabled = managedHost != nil && !workspaceMaintenanceModel.isBusy
            fileMenu.addItem(revealWorkspaceItem)

            let closeWorkspaceItem = NSMenuItem(
                title: "Close Workspace",
                action: #selector(closeWorkspace(_:)),
                keyEquivalent: ""
            )
            closeWorkspaceItem.target = self
            closeWorkspaceItem.isEnabled = managedHost != nil && !workspaceMaintenanceModel.isBusy
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
            item.isEnabled = workspaceHistory.availability(of: workspace.url) == .available &&
                !workspaceMaintenanceModel.isBusy
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let clearItem = NSMenuItem(
            title: "Clear Recent",
            action: #selector(clearRecentWorkspaces(_:)),
            keyEquivalent: ""
        )
        clearItem.target = self
        clearItem.isEnabled = !workspaceMaintenanceModel.isBusy
        menu.addItem(clearItem)
        return menu
    }

    @objc
    private func newWorkspace(_ sender: Any?) {
        guard !workspaceMaintenanceModel.isBusy else { return }
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
        guard !workspaceMaintenanceModel.isBusy else { return }
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
        guard !workspaceMaintenanceModel.isBusy else { return }
        guard let workspaceURL = managedHost?.workspaceURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([workspaceURL])
    }

    @objc
    private func showWorkspaceManager(_ sender: Any?) {
        guard workspaceManagementEnabled, !workspaceMaintenanceModel.isBusy else { return }
        let selected = managedHost?.workspaceURL ?? offlineRepairEligibleWorkspaceURL ??
            selectedManagerWorkspaceURL ?? workspaceHistory.recentWorkspaces().first?.url
        selectedManagerWorkspaceURL = selected
        configureMaintenanceForSelectedWorkspace()
        windowContent = .workspaceManager
        workspaceMessage = nil
        replaceWindowContent()
        updateWindowTitle()
    }

    @objc
    private func closeWorkspace(_ sender: Any?) {
        guard workspaceManagementEnabled,
              managedHost != nil,
              !workspaceMaintenanceModel.isBusy
        else { return }
        model.stopExplorationPolling()
        managedHost?.stop()
        managedHost = nil
        workspaceMaintenanceModel.configure(client: nil)
        maintenanceWorkspacePath = nil
        offlineRepairEligibleWorkspaceURL = nil
        offlineRepairMessage = nil
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
        guard !workspaceMaintenanceModel.isBusy else { return }
        workspaceHistory.clearRecentWorkspaces(
            preserving: managedHost?.workspaceURL
        )
        if managedHost == nil {
            selectedManagerWorkspaceURL = nil
            offlineRepairEligibleWorkspaceURL = nil
            offlineRepairMessage = nil
            configureMaintenanceForSelectedWorkspace(force: true)
        }
        if windowContent == .welcome || windowContent == .workspaceManager {
            replaceWindowContent()
        }
        configureApplicationMenu()
    }

    private func openRecentWorkspace(at workspaceURL: URL) {
        guard !workspaceMaintenanceModel.isBusy else { return }
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

    private func switchWorkspace(
        to workspaceURL: URL,
        creating: Bool,
        managingAfterOpen: Bool = false
    ) {
        guard !workspaceMaintenanceModel.isBusy else { return }
        let workspace = workspaceHistory.normalizedURL(for: workspaceURL)
        if let current = managedHost?.workspaceURL,
           workspaceHistory.normalizedURL(for: current).path == workspace.path {
            offlineRepairEligibleWorkspaceURL = nil
            offlineRepairMessage = nil
            selectedManagerWorkspaceURL = current
            configureMaintenanceForSelectedWorkspace(force: true)
            windowContent = managingAfterOpen ? .workspaceManager : .workspace
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
            offlineRepairEligibleWorkspaceURL = nil
            offlineRepairMessage = nil
            workspaceHistory.recordOpened(nextHost.workspaceURL)
            selectedManagerWorkspaceURL = nextHost.workspaceURL
            configureMaintenanceForSelectedWorkspace(force: true)
            workspaceMessage = nil
            windowContent = managingAfterOpen ? .workspaceManager : .workspace
            replaceWindowContent()
            previousHost?.stop()
            updateWindowTitle()
            configureApplicationMenu()
        } catch {
            let action = creating ? "created" : "opened"
            let failureMessage = "The Workspace could not be \(action): \(error.localizedDescription)"
            workspaceMessage = failureMessage
            if managedHost == nil {
                selectedManagerWorkspaceURL = workspace
                offlineRepairEligibleWorkspaceURL = workspace
                offlineRepairMessage = failureMessage
                configureMaintenanceForSelectedWorkspace(force: true)
                windowContent = managingAfterOpen ? .workspaceManager : .welcome
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
                    onManageRecent: { [weak self] url in
                        self?.selectedManagerWorkspaceURL = url
                        self?.configureMaintenanceForSelectedWorkspace(force: true)
                        self?.windowContent = .workspaceManager
                        self?.workspaceMessage = nil
                        self?.replaceWindowContent()
                        self?.updateWindowTitle()
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
                        self?.closeWorkspaceManager()
                    }
                )
            )
        } else if workspaceManagementEnabled, windowContent == .workspaceManager {
            let selectedPath = selectedManagerWorkspaceURL?.standardizedFileURL.path
            let currentPath = managedHost?.workspaceURL.standardizedFileURL.path
            let repairPath = offlineRepairEligibleWorkspaceURL?.standardizedFileURL.path
            let allowsMaintenance = WorkspaceMaintenanceSelectionPolicy.allowsMaintenance(
                selectedPath: selectedPath,
                currentPath: currentPath,
                recoveryEligiblePath: repairPath
            )
            rootView = AnyView(
                WorkspaceManagerView(
                    recentWorkspaces: workspaceHistory.recentWorkspaces(),
                    currentWorkspaceURL: managedHost?.workspaceURL,
                    selectedWorkspaceURL: selectedManagerWorkspaceURL,
                    availability: { [weak self] url in
                        self?.workspaceHistory.availability(of: url) ?? .missing
                    },
                    maintenanceModel: workspaceMaintenanceModel,
                    allowsMaintenance: allowsMaintenance,
                    canRetryOpen: managedHost == nil && selectedPath == repairPath,
                    onSelect: { [weak self] url in
                        self?.selectWorkspaceForManagement(url)
                    },
                    onNewWorkspace: { [weak self] in
                        self?.newWorkspace(nil)
                    },
                    onOpenWorkspace: { [weak self] in
                        self?.openWorkspace(nil)
                    },
                    onOpenToManage: { [weak self] url in
                        self?.openWorkspaceForManagement(url)
                    },
                    onReveal: { url in
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    },
                    onRemoveRecent: { [weak self] url in
                        self?.removeRecentWorkspace(at: url)
                    },
                    onClose: { [weak self] in
                        self?.closeWorkspaceManager()
                    },
                    onOfflineMaintenance: { [weak self] action in
                        self?.performWorkspaceMaintenance(action)
                    },
                    onRetryOpen: { [weak self] in
                        self?.retryOpenManagedWorkspace()
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
        guard !workspaceMaintenanceModel.isBusy else { return }
        if let current = managedHost?.workspaceURL,
           workspaceHistory.normalizedURL(for: current).path ==
            workspaceHistory.normalizedURL(for: workspaceURL).path {
            return
        }
        workspaceHistory.remove(workspaceURL)
        if offlineRepairEligibleWorkspaceURL?.standardizedFileURL.path ==
            workspaceURL.standardizedFileURL.path {
            offlineRepairEligibleWorkspaceURL = nil
            offlineRepairMessage = nil
        }
        if selectedManagerWorkspaceURL?.standardizedFileURL.path ==
            workspaceURL.standardizedFileURL.path {
            selectedManagerWorkspaceURL = workspaceHistory.recentWorkspaces().first?.url
            configureMaintenanceForSelectedWorkspace(force: true)
        }
        if windowContent == .welcome || windowContent == .workspaceManager {
            replaceWindowContent()
        }
        configureApplicationMenu()
    }

    private func closeWorkspaceManager() {
        guard !workspaceMaintenanceModel.isBusy else { return }
        workspaceMessage = managedHost == nil ? offlineRepairMessage : nil
        windowContent = managedHost == nil ? .welcome : .workspace
        replaceWindowContent()
        updateWindowTitle()
    }

    private func selectWorkspaceForManagement(_ workspaceURL: URL) {
        guard !workspaceMaintenanceModel.isBusy else { return }
        selectedManagerWorkspaceURL = workspaceHistory.normalizedURL(for: workspaceURL)
        configureMaintenanceForSelectedWorkspace()
        replaceWindowContent()
        updateWindowTitle()
    }

    private func openWorkspaceForManagement(_ workspaceURL: URL) {
        guard !workspaceMaintenanceModel.isBusy else { return }
        switchWorkspace(
            to: workspaceURL,
            creating: false,
            managingAfterOpen: true
        )
    }

    private func configureMaintenanceForSelectedWorkspace(force: Bool = false) {
        let selectedPath = selectedManagerWorkspaceURL?.standardizedFileURL.path
        guard force || selectedPath != maintenanceWorkspacePath else { return }
        maintenanceWorkspacePath = selectedPath
        let currentPath = managedHost?.workspaceURL.standardizedFileURL.path
        let client: (any WorkspaceMaintenanceClient)? = selectedPath == currentPath ?
            managedHost?.client : nil
        workspaceMaintenanceModel.configure(client: client)
        let repairPath = offlineRepairEligibleWorkspaceURL?.standardizedFileURL.path
        if let message = WorkspaceMaintenanceSelectionPolicy.recoveryFailureMessage(
            selectedPath: selectedPath,
            recoveryEligiblePath: repairPath,
            message: offlineRepairMessage
        ) {
            workspaceMaintenanceModel.recordWorkspaceOpenFailure(message: message)
        }
    }

    private func performWorkspaceMaintenance(_ action: WorkspaceOfflineMaintenanceAction) {
        guard workspaceManagementEnabled,
              !workspaceMaintenanceModel.isBusy,
              let workspaceURL = selectedManagerWorkspaceURL,
              workspaceHistory.availability(of: workspaceURL) == .available
        else { return }

        let selectedPath = workspaceURL.standardizedFileURL.path
        let currentPath = managedHost?.workspaceURL.standardizedFileURL.path
        let repairPath = offlineRepairEligibleWorkspaceURL?.standardizedFileURL.path
        guard WorkspaceMaintenanceSelectionPolicy.allowsMaintenance(
            selectedPath: selectedPath,
            currentPath: currentPath,
            recoveryEligiblePath: repairPath
        ) else {
            workspaceMaintenanceModel.failOfflineMaintenance(
                message: "Open this Workspace before running maintenance.",
                workspaceReopened: true
            )
            return
        }

        workspaceMaintenanceModel.beginOfflineMaintenance(action)
        configureApplicationMenu()
        Task { [weak self] in
            await self?.runWorkspaceMaintenance(action, workspaceURL: workspaceURL)
        }
    }

    private func runWorkspaceMaintenance(
        _ action: WorkspaceOfflineMaintenanceAction,
        workspaceURL: URL
    ) async {
        let maintenance: ManagedWorkspaceMaintenance
        do {
            maintenance = try StudioComposition.makeManagedWorkspaceMaintenance()
        } catch {
            workspaceMaintenanceModel.failOfflineMaintenance(
                message: error.localizedDescription,
                workspaceReopened: managedHost != nil
            )
            configureApplicationMenu()
            return
        }

        let hostToStop = managedHost
        model.stopCanvasWatch()
        model.stopExplorationPolling()
        let stopHost: (() async -> Void)?
        if let hostToStop {
            stopHost = { [weak self] in
                await hostToStop.stopAsync()
                guard let self else { return }
                if self.managedHost === hostToStop {
                    self.managedHost = nil
                }
            }
        } else {
            stopHost = nil
        }

        let outcome = await WorkspaceMaintenanceCoordinator().run(
            stopHost: stopHost,
            execute: { [weak self] in
                guard let self else {
                    throw ManagedWorkspaceMaintenanceError.launchFailed
                }
                self.workspaceMaintenanceModel.replaceOnlineClient(nil)
                self.model = SnapshotWorkspaceModel(
                    client: UnavailableHostClient(
                        message: "Workspace maintenance is in progress."
                    )
                )
                self.configureApplicationMenu()
                return try await self.executeWorkspaceMaintenance(
                    action,
                    workspaceURL: workspaceURL,
                    maintenance: maintenance
                )
            },
            reopen: { [weak self] in
                guard let self else {
                    throw ManagedWorkspaceMaintenanceError.launchFailed
                }
                try await self.reopenManagedWorkspace(workspaceURL)
            },
            onStage: { [weak self] stage in
                guard let self else { return }
                switch stage {
                case .stoppingHost:
                    self.workspaceMaintenanceModel.markHostStopping()
                case .runningMaintenance:
                    self.workspaceMaintenanceModel.markOfflineMaintenanceRunning(action.operation)
                case .reopeningWorkspace:
                    self.workspaceMaintenanceModel.markWorkspaceReopening()
                }
            }
        )

        switch outcome {
        case let .succeeded(summary):
            workspaceMaintenanceModel.completeOfflineMaintenance(
                message: summary.message,
                garbageResult: summary.garbageResult
            )
            await workspaceMaintenanceModel.loadRecoveryPoints()
        case let .maintenanceFailed(operationError):
            workspaceMaintenanceModel.failOfflineMaintenance(
                message: "Maintenance failed: \(operationError.localizedDescription). The Workspace reopened successfully.",
                workspaceReopened: true
            )
            await workspaceMaintenanceModel.loadRecoveryPoints()
        case let .reopenFailed(summary, reopenError):
            recordWorkspaceReopenFailure(reopenError, workspaceURL: workspaceURL)
            workspaceMaintenanceModel.recordMaintenanceSucceededButReopenFailed(
                successMessage: summary.message,
                reopenMessage: "Maintenance succeeded, but the Workspace could not reopen: \(reopenError.localizedDescription)"
            )
        case let .maintenanceAndReopenFailed(operationError, reopenError):
            recordWorkspaceReopenFailure(reopenError, workspaceURL: workspaceURL)
            workspaceMaintenanceModel.failOfflineMaintenance(
                message: "Maintenance failed: \(operationError.localizedDescription). Reopening also failed: \(reopenError.localizedDescription)",
                workspaceReopened: false
            )
        }
        configureApplicationMenu()
    }

    private func recordWorkspaceReopenFailure(_ error: Error, workspaceURL: URL) {
        managedHost = nil
        offlineRepairEligibleWorkspaceURL = workspaceURL
        offlineRepairMessage = "The Workspace could not reopen: \(error.localizedDescription)"
        workspaceMaintenanceModel.replaceOnlineClient(nil)
        model = SnapshotWorkspaceModel(
            client: UnavailableHostClient(
                message: "The Workspace could not reopen: \(error.localizedDescription)"
            )
        )
        projectDocuments = StudioProjectDocuments(workspaceURL: workspaceURL)
        selectedManagerWorkspaceURL = workspaceURL
        maintenanceWorkspacePath = workspaceURL.standardizedFileURL.path
        windowContent = .workspaceManager
        replaceWindowContent()
        updateWindowTitle()
        configureApplicationMenu()
    }

    private func executeWorkspaceMaintenance(
        _ action: WorkspaceOfflineMaintenanceAction,
        workspaceURL: URL,
        maintenance: ManagedWorkspaceMaintenance
    ) async throws -> WorkspaceMaintenanceExecutionSummary {
        switch action {
        case let .restore(recoveryPointID):
            let result = try await maintenance.restore(
                workspaceURL: workspaceURL,
                command: RestoreWorkspaceCommand(backupHash: recoveryPointID)
            )
            return WorkspaceMaintenanceExecutionSummary(
                message: "Restored schema \(result.restoredSchemaVersion), generation \(result.restoredGeneration). Previous metadata was preserved as recovery evidence \(result.recoveryID)."
            )
        case let .analyzeGarbage(minimumAgeSeconds):
            let result = try await maintenance.collectGarbage(
                workspaceURL: workspaceURL,
                command: CollectWorkspaceGarbageCommand(
                    dryRun: true,
                    minimumAgeSeconds: minimumAgeSeconds
                )
            )
            return WorkspaceMaintenanceExecutionSummary(
                message: "Storage analysis completed: \(result.candidateObjects) object(s), \(result.candidateBytes) byte(s), and \(result.staleCatalogEntries) stale catalog record(s) are eligible.",
                garbageResult: result
            )
        case let .applyGarbage(minimumAgeSeconds, planDigest):
            let result = try await maintenance.collectGarbage(
                workspaceURL: workspaceURL,
                command: CollectWorkspaceGarbageCommand(
                    dryRun: false,
                    minimumAgeSeconds: minimumAgeSeconds,
                    expectedPlanDigest: planDigest
                )
            )
            return WorkspaceMaintenanceExecutionSummary(
                message: "Storage cleanup completed: deleted \(result.deletedObjects) object(s) and \(result.deletedBytes) byte(s); removed \(result.removedCatalogEntries) stale catalog record(s).",
                garbageResult: result
            )
        case .recoverInterruptedRestore:
            let result = try await maintenance.recoverInterruptedRestore(
                workspaceURL: workspaceURL
            )
            return WorkspaceMaintenanceExecutionSummary(
                message: "Interrupted restore recovered as \(result.recoveryID). Restored original files: \(result.restoredOriginalFiles.joined(separator: ", "))."
            )
        case .recoverStaleLock:
            let result = try await maintenance.recoverStaleLock(
                workspaceURL: workspaceURL
            )
            return WorkspaceMaintenanceExecutionSummary(
                message: "Recovered stale Host lock for process \(result.recoveredProcessID) as \(result.recoveryID)."
            )
        }
    }

    private func reopenManagedWorkspace(_ workspaceURL: URL) async throws {
        let nextHost = try await StudioComposition.makeManagedHostAsync(
            workspaceURL: workspaceURL
        )
        model = SnapshotWorkspaceModel(client: nextHost.client)
        projectDocuments = StudioProjectDocuments(workspaceURL: nextHost.workspaceURL)
        managedHost = nextHost
        offlineRepairEligibleWorkspaceURL = nil
        offlineRepairMessage = nil
        workspaceHistory.recordOpened(nextHost.workspaceURL)
        selectedManagerWorkspaceURL = nextHost.workspaceURL
        maintenanceWorkspacePath = nextHost.workspaceURL.standardizedFileURL.path
        workspaceMaintenanceModel.replaceOnlineClient(nextHost.client)
        workspaceMessage = nil
        windowContent = .workspaceManager
        replaceWindowContent()
        updateWindowTitle()
        configureApplicationMenu()
    }

    private func retryOpenManagedWorkspace() {
        guard managedHost == nil,
              !workspaceMaintenanceModel.isBusy,
              let workspaceURL = selectedManagerWorkspaceURL,
              workspaceURL.standardizedFileURL.path ==
                offlineRepairEligibleWorkspaceURL?.standardizedFileURL.path,
              workspaceHistory.availability(of: workspaceURL) == .available
        else { return }
        workspaceMaintenanceModel.markWorkspaceReopening()
        configureApplicationMenu()
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.reopenManagedWorkspace(workspaceURL)
                self.workspaceMaintenanceModel.completeOfflineMaintenance(
                    message: "The Workspace reopened successfully."
                )
                await self.workspaceMaintenanceModel.loadRecoveryPoints()
            } catch {
                self.offlineRepairMessage =
                    "The Workspace could not reopen: \(error.localizedDescription)"
                self.workspaceMaintenanceModel.failOfflineMaintenance(
                    message: self.offlineRepairMessage ?? "The Workspace could not reopen.",
                    workspaceReopened: false
                )
            }
            self.configureApplicationMenu()
        }
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
        } else if windowContent == .workspaceManager {
            window.title = "Workspace Manager — Vistrea Studio"
            window.representedURL = selectedManagerWorkspaceURL
        } else {
            window.title = "Vistrea Studio"
            window.representedURL = nil
        }
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        guard
            workspaceManagementEnabled,
            !workspaceMaintenanceModel.isBusy,
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

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !workspaceMaintenanceModel.isBusy else {
            presentError(
                title: "Workspace Maintenance Is Running",
                message: "Wait for the current maintenance operation and Workspace reopen to finish before quitting Vistrea Studio."
            )
            return .terminateCancel
        }
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        // The workspace itself is going away, so the exploration poll loop is
        // torn down here — never on a tab switch. The Host-side Operation
        // keeps running and stays cancellable from the next session.
        model.stopCanvasWatch()
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
        let failedWorkspaceURL: URL?

        init(
            client: any HostClient,
            managedHost: ManagedStudioHost? = nil,
            workspaceManagementEnabled: Bool = false,
            opensWelcome: Bool = false,
            startupMessage: String? = nil,
            failedWorkspaceURL: URL? = nil
        ) {
            self.client = client
            self.managedHost = managedHost
            self.workspaceManagementEnabled = workspaceManagementEnabled
            self.opensWelcome = opensWelcome
            self.startupMessage = startupMessage
            self.failedWorkspaceURL = failedWorkspaceURL
        }
    }

    @MainActor
    static func makeInitialClient(
        workspaceHistory: StudioWorkspaceHistory,
        launchConfiguration: StudioLaunchConfiguration = StudioLaunchConfiguration()
    ) -> Result {
        if launchConfiguration.content == .persistedWorkspace {
            do {
                let locations = try persistedUITestLocations()
                guard workspaceHistory.availability(of: locations.workspaceURL) == .available else {
                    throw ManagedStudioHostError.launchFailed
                }
                let host = try ManagedStudioHost.start(
                    workspaceURL: locations.workspaceURL,
                    resourceURL: locations.runtime.resourceURL,
                    applicationSupportURL: locations.runtime.applicationSupportURL
                )
                return Result(
                    client: host.client,
                    managedHost: host,
                    workspaceManagementEnabled: true
                )
            } catch {
                return Result(
                    client: UnavailableHostClient(
                        message: "The disposable UI-test Workspace could not start: \(error.localizedDescription)"
                    ),
                    workspaceManagementEnabled: true,
                    opensWelcome: true,
                    startupMessage: "The disposable UI-test Workspace could not start.",
                    failedWorkspaceURL: persistedUITestWorkspaceURL()
                )
            }
        }

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
                case .persistedWorkspace:
                    preconditionFailure("Persisted UI testing composes a managed Host before fixtures.")
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
                    startupMessage: "The last Workspace could not be opened: \(error.localizedDescription)",
                    failedWorkspaceURL: workspaceURL
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
        let locations = try managedHostLocations()
        return try ManagedStudioHost.start(
            workspaceURL: workspaceURL,
            resourceURL: locations.resourceURL,
            applicationSupportURL: locations.applicationSupportURL
        )
    }

    @MainActor
    static func makeManagedHostAsync(workspaceURL: URL) async throws -> ManagedStudioHost {
        let locations = try managedHostLocations()
        return try await ManagedStudioHost.startAsync(
            workspaceURL: workspaceURL,
            resourceURL: locations.resourceURL,
            applicationSupportURL: locations.applicationSupportURL
        )
    }

    static func makeManagedWorkspaceMaintenance() throws -> ManagedWorkspaceMaintenance {
        let locations = try managedHostLocations()
        return try ManagedWorkspaceMaintenance(resourceURL: locations.resourceURL)
    }

    private struct ManagedHostRuntimeLocations {
        let resourceURL: URL
        let applicationSupportURL: URL?
    }

    private struct PersistedUITestLocations {
        let workspaceURL: URL
        let runtime: ManagedHostRuntimeLocations
    }

    private static func managedHostLocations() throws -> ManagedHostRuntimeLocations {
        if StudioLaunchConfiguration().content == .persistedWorkspace {
            return try persistedUITestLocations().runtime
        }
        guard let resourceURL = Bundle.main.resourceURL else {
            throw ManagedStudioHostError.embeddedRuntimeUnavailable
        }
        return ManagedHostRuntimeLocations(
            resourceURL: resourceURL,
            applicationSupportURL: nil
        )
    }

    private static func persistedUITestWorkspaceURL() -> URL? {
        absoluteDirectoryURL(
            ProcessInfo.processInfo.environment[
                StudioLaunchConfiguration.uiTestingWorkspacePathEnvironment
            ]
        )
    }

    private static func persistedUITestLocations() throws -> PersistedUITestLocations {
        let environment = ProcessInfo.processInfo.environment
        guard
            let workspaceURL = absoluteDirectoryURL(
                environment[StudioLaunchConfiguration.uiTestingWorkspacePathEnvironment]
            ),
            let resourceURL = absoluteDirectoryURL(
                environment[StudioLaunchConfiguration.uiTestingHostResourcesEnvironment]
            ),
            let applicationSupportURL = absoluteDirectoryURL(
                environment[StudioLaunchConfiguration.uiTestingApplicationSupportEnvironment]
            )
        else {
            throw ManagedStudioHostError.launchFailed
        }
        return PersistedUITestLocations(
            workspaceURL: workspaceURL,
            runtime: ManagedHostRuntimeLocations(
                resourceURL: resourceURL,
                applicationSupportURL: applicationSupportURL
            )
        )
    }

    private static func absoluteDirectoryURL(_ path: String?) -> URL? {
        guard let path, !path.isEmpty, path.hasPrefix("/"), !path.contains("\0") else {
            return nil
        }
        return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    }
}
