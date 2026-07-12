import AppKit
import SwiftUI
import VistreaStudioCore

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
    private let model = SnapshotWorkspaceModel(client: StudioComposition.makeHostClient())
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        showMainWindow()
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func showMainWindow() {
        guard window == nil else { return }
        let rootView = SnapshotWorkspaceView(model: model)
            .frame(minWidth: 980, minHeight: 640)
        let window = NSWindow(contentViewController: NSHostingController(rootView: rootView))
        window.title = "Vistrea Studio"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.minSize = NSSize(width: 980, height: 640)
        window.setFrameAutosaveName("VistreaStudioSnapshotWorkspace")
        window.setContentSize(NSSize(width: 1_280, height: 820))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

private enum StudioComposition {
    static func makeHostClient() -> any HostClient {
        let environment = ProcessInfo.processInfo.environment
        let hostURL = environment["VISTREA_HOST_URL"]
        let hostToken = environment["VISTREA_HOST_TOKEN"]

        if let hostURL, let hostToken {
            guard let url = URL(string: hostURL) else {
                return UnavailableHostClient(message: "VISTREA_HOST_URL is not a valid URL.")
            }
            do {
                return try HTTPHostClient(baseURL: url, bearerToken: hostToken)
            } catch {
                return UnavailableHostClient(message: error.localizedDescription)
            }
        }

        if hostURL != nil || hostToken != nil {
            return UnavailableHostClient(
                message: "Set both VISTREA_HOST_URL and VISTREA_HOST_TOKEN, or unset both to use the canonical fixture."
            )
        }

        do {
            return FixtureHostClient(snapshots: [try CanonicalFixtureLoader.loadDefaultSnapshot()])
        } catch {
            return UnavailableHostClient(message: error.localizedDescription)
        }
    }
}
