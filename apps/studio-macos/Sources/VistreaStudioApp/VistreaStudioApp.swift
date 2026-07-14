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
    private var model: SnapshotWorkspaceModel
    private var managedHost: ManagedStudioHost?
    private var updaterController: SPUStandardUpdaterController?
    private var window: NSWindow?

    override init() {
        let composition = StudioComposition.makeInitialClient()
        model = SnapshotWorkspaceModel(client: composition.client)
        managedHost = composition.managedHost
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        updaterController = StudioUpdates.makeUpdaterController()
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
        let openWorkspaceItem = NSMenuItem(
            title: "Open Workspace…",
            action: #selector(openWorkspace(_:)),
            keyEquivalent: "o"
        )
        openWorkspaceItem.target = self
        fileMenu.addItem(openWorkspaceItem)
        let revealWorkspaceItem = NSMenuItem(
            title: "Reveal Workspace in Finder",
            action: #selector(revealWorkspace(_:)),
            keyEquivalent: ""
        )
        revealWorkspaceItem.target = self
        revealWorkspaceItem.isEnabled = managedHost != nil
        fileMenu.addItem(revealWorkspaceItem)
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        NSApplication.shared.mainMenu = mainMenu
    }

    @objc
    private func openWorkspace(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.title = "Open Vistrea Workspace"
        panel.message = "Choose or create a folder for Vistrea's local Workspace data."
        panel.prompt = "Open"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = managedHost?.workspaceURL.deletingLastPathComponent()
        guard panel.runModal() == .OK, let workspaceURL = panel.url else { return }
        switchWorkspace(to: workspaceURL)
    }

    @objc
    private func revealWorkspace(_ sender: Any?) {
        guard let workspaceURL = managedHost?.workspaceURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([workspaceURL])
    }

    private func switchWorkspace(to workspaceURL: URL) {
        let workspace = workspaceURL.standardizedFileURL
        if managedHost?.workspaceURL.standardizedFileURL == workspace {
            return
        }
        do {
            let nextHost = try StudioComposition.makeManagedHost(workspaceURL: workspace)
            let previousModel = model
            let previousHost = managedHost
            previousModel.stopExplorationPolling()
            model = SnapshotWorkspaceModel(client: nextHost.client)
            managedHost = nextHost
            UserDefaults.standard.set(
                nextHost.workspaceURL.path,
                forKey: StudioWorkspaceLocation.lastWorkspaceDefaultsKey
            )
            replaceWindowContent()
            previousHost?.stop()
            configureApplicationMenu()
        } catch {
            presentError(title: "Workspace Could Not Be Opened", message: error.localizedDescription)
        }
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
        window.title = "Vistrea Studio"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.minSize = NSSize(
            width: StudioLayoutMetrics.windowMinWidth,
            height: StudioLayoutMetrics.windowMinHeight
        )
        window.setFrameAutosaveName("VistreaStudioSnapshotWorkspace")
        window.setContentSize(
            NSSize(
                width: StudioLayoutMetrics.windowInitialWidth,
                height: StudioLayoutMetrics.windowInitialHeight
            )
        )
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    private func replaceWindowContent() {
        window?.contentViewController = makeContentViewController()
    }

    private func makeContentViewController() -> NSViewController {
        let rootView = SnapshotWorkspaceView(model: model)
            .frame(
                minWidth: StudioLayoutMetrics.windowMinWidth,
                minHeight: StudioLayoutMetrics.windowMinHeight
            )
        return NSHostingController(rootView: rootView)
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
    }

    @MainActor
    static func makeInitialClient() -> Result {
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
            do {
                let host = try makeManagedHost(
                    workspaceURL: StudioWorkspaceLocation.preferredWorkspaceURL()
                )
                return Result(client: host.client, managedHost: host)
            } catch {
                return Result(
                    client: UnavailableHostClient(
                        message: "The packaged local Host could not start: \(error.localizedDescription)"
                    ),
                    managedHost: nil
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
