import UIKit
import VistreaRuntimeModels
import VistreaRuntimeUIKit

final class ScenarioStateViewController: UIViewController {
    private let scenario: ScenarioDefinition
    private let stateID: String
    private let profile: String
    private let preferredWaitStepID: String?
    private var automaticTransition: DispatchWorkItem?

    init(
        scenario: ScenarioDefinition,
        stateID: String,
        profile: String,
        preferredWaitStepID: String? = nil
    ) {
        self.scenario = scenario
        self.stateID = stateID
        self.profile = profile
        self.preferredWaitStepID = preferredWaitStepID
        super.init(nibName: nil, bundle: nil)
        title = Self.shortStateName(stateID)
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        view.accessibilityIdentifier = "\(stateID).root"
        configureInspector()
        configureContent()
        scheduleWaitTransitionIfNeeded()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController?.isBeingDismissed == true {
            automaticTransition?.cancel()
        }
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

    private func configureContent() {
        guard let state = scenario.state(id: stateID) else {
            presentStateError("Unknown state \(stateID)")
            return
        }

        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = true
        view.addSubview(scrollView)

        let stack = UIStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = 16
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 24, bottom: 48, right: 24)
        scrollView.addSubview(stack)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
        ])

        let eyebrow = UILabel()
        eyebrow.font = .preferredFont(forTextStyle: .caption1)
        eyebrow.textColor = .secondaryLabel
        eyebrow.text = "\(scenario.scenarioID)  •  \(profile)"
        eyebrow.numberOfLines = 0
        stack.addArrangedSubview(eyebrow)

        let heading = UILabel()
        heading.font = .preferredFont(forTextStyle: .largeTitle)
        heading.adjustsFontForContentSizeCategory = true
        heading.text = scenario.title
        heading.numberOfLines = 0
        stack.addArrangedSubview(heading)

        let purpose = UILabel()
        purpose.font = .preferredFont(forTextStyle: .body)
        purpose.textColor = .secondaryLabel
        purpose.text = scenario.purpose
        purpose.numberOfLines = 0
        stack.addArrangedSubview(purpose)

        let divider = UIView()
        divider.backgroundColor = .separator
        divider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true
        stack.addArrangedSubview(divider)

        let outgoing = scenario.steps(from: stateID, profile: profile)
        let actionableByTarget = Dictionary(
            uniqueKeysWithValues: outgoing.compactMap { step in
                step.action.targetNodeID.map { ($0, step) }
            }
        )
        for nodeID in state.requiredNodeIDs {
            let descriptor = scenario.stableNode(id: nodeID)
            let control = makeNode(
                nodeID: nodeID,
                role: descriptor?.role ?? "container",
                step: actionableByTarget[nodeID]
            )
            stack.addArrangedSubview(control)
        }

        if state.requiredNodeIDs.isEmpty {
            let empty = UILabel()
            empty.text = "This state intentionally has no required semantic nodes."
            empty.textColor = .secondaryLabel
            empty.numberOfLines = 0
            stack.addArrangedSubview(empty)
        }
    }

    private func makeNode(
        nodeID: String,
        role: String,
        step: ScenarioStep?
    ) -> UIView {
        switch role {
        case "button", "list-item":
            let button = UIButton(type: .system)
            var configuration = UIButton.Configuration.filled()
            configuration.title = Self.humanTitle(nodeID)
            configuration.cornerStyle = .large
            configuration.contentInsets = NSDirectionalEdgeInsets(
                top: 14,
                leading: 18,
                bottom: 14,
                trailing: 18
            )
            button.configuration = configuration
            button.contentHorizontalAlignment = .leading
            button.accessibilityIdentifier = nodeID
            if let step {
                button.addAction(
                    UIAction { [weak self] _ in self?.perform(step) },
                    for: .touchUpInside
                )
            } else {
                button.isEnabled = false
            }
            return button
        case "text-field":
            let field = UITextField()
            field.borderStyle = .roundedRect
            field.placeholder = Self.humanTitle(nodeID)
            field.accessibilityIdentifier = nodeID
            if let step {
                field.addAction(
                    UIAction { [weak self] _ in self?.perform(step) },
                    for: .editingDidEnd
                )
            }
            field.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
            return field
        case "progress-indicator":
            let indicator = UIActivityIndicatorView(style: .large)
            indicator.startAnimating()
            indicator.accessibilityIdentifier = nodeID
            return indicator
        default:
            let card = UILabel()
            card.font = .preferredFont(forTextStyle: role == "label" ? .headline : .body)
            card.text = Self.humanTitle(nodeID)
            card.numberOfLines = 0
            card.backgroundColor = .secondarySystemGroupedBackground
            card.layer.cornerRadius = 12
            card.layer.masksToBounds = true
            card.accessibilityIdentifier = nodeID
            card.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
            return card
        }
    }

    private func perform(_ step: ScenarioStep) {
        automaticTransition?.cancel()
        if step.toStateID == stateID {
            UIAccessibility.post(
                notification: .announcement,
                argument: "Action \(Self.humanTitle(step.stepID)) completed without navigation."
            )
            return
        }
        let waitPreference: String?
        if step.stepID.contains("failure") {
            waitPreference = scenario.steps.first { $0.stepID.contains("finish-failure") }?.stepID
        } else if step.stepID.contains("success") {
            waitPreference = scenario.steps.first { $0.stepID.contains("finish-success") }?.stepID
        } else {
            waitPreference = nil
        }
        navigationController?.pushViewController(
            ScenarioStateViewController(
                scenario: scenario,
                stateID: step.toStateID,
                profile: profile,
                preferredWaitStepID: waitPreference
            ),
            animated: true
        )
    }

    private func scheduleWaitTransitionIfNeeded() {
        let waits = scenario.steps(from: stateID, profile: profile).filter {
            $0.action.kind == "wait" && $0.toStateID != stateID
        }
        let selected = preferredWaitStepID.flatMap { preferred in
            waits.first { $0.stepID == preferred }
        } ?? waits.first
        guard let selected, let milliseconds = selected.action.durationMilliseconds else {
            return
        }
        let work = DispatchWorkItem { [weak self] in
            self?.perform(selected)
        }
        automaticTransition = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(milliseconds),
            execute: work
        )
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

    private func presentStateError(_ message: String) {
        let alert = UIAlertController(title: "Demo state error", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    private static func shortStateName(_ value: String) -> String {
        humanTitle(value.replacingOccurrences(of: "demo.state.", with: ""))
    }

    private static func humanTitle(_ value: String) -> String {
        value
            .split(whereSeparator: { $0 == "." || $0 == "_" || $0 == "-" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
