import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

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
        return true
    }
}
