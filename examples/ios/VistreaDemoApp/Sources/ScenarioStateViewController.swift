import UIKit
import VistreaRuntimeModels
import VistreaRuntimeUIKit
#if DEBUG
import VistreaRuntimeConnection
#endif

final class ScenarioStateViewController: ScenarioScreenViewController {
    private let stateID: String
    private let preferredWaitStepID: String?
    private var automaticTransition: DispatchWorkItem?
#if DEBUG
    private var presentedTransientNodeIDs: [String] = []
#endif

    init(
        scenario: ScenarioDefinition,
        stateID: String,
        profile: String,
        preferredWaitStepID: String? = nil
    ) {
        self.stateID = stateID
        self.preferredWaitStepID = preferredWaitStepID
        super.init(scenario: scenario, profile: profile)
        title = Self.shortStateName(stateID)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "\(stateID).root"
        configureContent()
        scheduleWaitTransitionIfNeeded()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
#if DEBUG
        recordTransientPresentation()
#endif
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
#if DEBUG
        recordTransientDismissal()
#endif
        if isMovingFromParent || navigationController?.isBeingDismissed == true {
            automaticTransition?.cancel()
        }
    }

#if DEBUG
    /// Reports transient banner appearance as canonical Runtime events.
    private func recordTransientPresentation() {
        guard let recorder = DebugRuntimeConnectionController.sharedEventRecorder,
              presentedTransientNodeIDs.isEmpty,
              let state = scenario.state(id: stateID),
              state.kind == "transient"
        else {
            return
        }
        let waitMilliseconds = scenario.steps(from: stateID, profile: profile)
            .first { $0.action.kind == "wait" }?
            .action.durationMilliseconds
        let bannerNodeIDs = state.requiredNodeIDs.filter {
            scenario.stableNode(id: $0)?.role == "banner"
        }
        presentedTransientNodeIDs = bannerNodeIDs
        for nodeID in bannerNodeIDs {
            let draft = RuntimeEventDraft(
                kind: .transientPresented,
                stableID: try? StableID(validating: nodeID),
                durationMilliseconds: waitMilliseconds.map(Double.init),
                payload: ["text": .string(Self.humanTitle(nodeID))]
            )
            Task { try? await recorder.record(draft) }
        }
    }

    private func recordTransientDismissal() {
        guard let recorder = DebugRuntimeConnectionController.sharedEventRecorder,
              !presentedTransientNodeIDs.isEmpty
        else {
            return
        }
        let nodeIDs = presentedTransientNodeIDs
        presentedTransientNodeIDs = []
        for nodeID in nodeIDs {
            let draft = RuntimeEventDraft(
                kind: .transientDismissed,
                stableID: try? StableID(validating: nodeID)
            )
            Task { try? await recorder.record(draft) }
        }
    }
#endif

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

        stack.addArrangedSubview(makeContractEyebrow())

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
}
