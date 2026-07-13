import UIKit
import VistreaRuntimeModels
import VistreaRuntimeUIKit

/// Shared chrome for every scenario screen: the Debug-only Runtime Inspector
/// entry point, deterministic error reporting, and contract-name formatting.
/// Both the generic fixture renderer and the dedicated scenario controllers
/// build on this class so the capture entry point stays identical.
class ScenarioScreenViewController: UIViewController {
    let scenario: ScenarioDefinition
    let profile: String

    init(scenario: ScenarioDefinition, profile: String) {
        self.scenario = scenario
        self.profile = profile
        super.init(nibName: nil, bundle: nil)
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        configureInspector()
    }

    private func configureInspector() {
#if DEBUG
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "Inspect",
            style: .plain,
            target: self,
            action: #selector(showInspector)
        )
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "vistrea.inspector.capture"
#endif
    }

#if DEBUG
    @objc private func showInspector() {
        guard let window = view.window else {
            return
        }
        do {
            let adapter = UIKitRuntimeCaptureAdapter(
                configuration: UIKitRuntimeCaptureConfiguration(
                    projectID: try ProjectID(
                        validating: "project_019f0000-0000-7000-8000-000000000001"
                    ),
                    buildID: try BuildID(
                        validating: "build_019f0000-0000-7000-8000-000000000001"
                    ),
                    deviceID: try DeviceID(
                        validating: "device_019f0000-0000-7000-8000-000000000001"
                    ),
                    environmentID: "demo",
                    accountProfileID: "demo-user",
                    featureContextRefs: [profile],
                    sdkVersion: "0.1.0",
                    adapterVersion: "0.1.0"
                )
            )
            let result = try adapter.capture(
                windows: [window],
                scenarioID: scenario.scenarioID
            )
            present(
                UINavigationController(
                    rootViewController: InspectorViewController(result: result)
                ),
                animated: true
            )
        } catch {
            presentStateError(String(describing: error))
        }
    }
#endif

    func presentStateError(_ message: String) {
        let alert = UIAlertController(
            title: "Demo state error",
            message: message,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    /// A small contract eyebrow shared by every scenario screen.
    func makeContractEyebrow() -> UILabel {
        let eyebrow = UILabel()
        eyebrow.font = .preferredFont(forTextStyle: .caption1)
        eyebrow.textColor = .secondaryLabel
        eyebrow.text = "\(scenario.scenarioID)  •  \(profile)"
        eyebrow.numberOfLines = 0
        return eyebrow
    }

    static func shortStateName(_ value: String) -> String {
        humanTitle(value.replacingOccurrences(of: "demo.state.", with: ""))
    }

    static func humanTitle(_ value: String) -> String {
        value
            .split(whereSeparator: { $0 == "." || $0 == "_" || $0 == "-" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
