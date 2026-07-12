import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
#if DEBUG
    private var runtimeConnectionController: DebugRuntimeConnectionController?
#endif

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        self.window = window
        do {
            let catalog = try ScenarioCatalog.load()
            let navigationController = UINavigationController()
            navigationController.navigationBar.prefersLargeTitles = true
            navigationController.viewControllers = [
                ScenarioListViewController(
                    catalog: catalog,
                    navigationController: navigationController
                ),
            ]
            if let requestedID = ProcessInfo.processInfo.environment["VISTREA_SCENARIO_ID"],
               let scenario = catalog.scenario(id: requestedID) {
                navigationController.pushViewController(
                    ScenarioStateViewController(
                        scenario: scenario,
                        stateID: scenario.entryStateID,
                        profile: ProcessInfo.processInfo.environment["VISTREA_SCENARIO_PROFILE"]
                            ?? "baseline"
                    ),
                    animated: false
                )
            }
            window.rootViewController = navigationController
        } catch {
            window.rootViewController = ErrorViewController(error: error)
        }
        window.makeKeyAndVisible()
#if DEBUG
        let runtimeConnectionController = DebugRuntimeConnectionController(
            windowProvider: { [weak window] in
                window.map { [$0] } ?? []
            },
            scenarioIDProvider: {
                ProcessInfo.processInfo.environment["VISTREA_SCENARIO_ID"]
            }
        )
        self.runtimeConnectionController = runtimeConnectionController
        runtimeConnectionController?.start()
#endif
        return true
    }

    func applicationWillTerminate(_ application: UIApplication) {
#if DEBUG
        runtimeConnectionController?.stop()
#endif
    }
}
