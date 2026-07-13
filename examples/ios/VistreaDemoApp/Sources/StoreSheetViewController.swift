import UIKit

/// `demo.store.sheet`: a bottom sheet built as an in-tree overlay of the same
/// window, mirroring the modal scenario's capture-visible idiom. The base
/// state is structurally free of sheet nodes; presenting adds the dimmed
/// backdrop and the contracted container, option, and dismiss nodes, and both
/// choosing and dismissing remove them again. Choosing only rewrites the sort
/// label's text — content, not structure.
final class StoreSheetViewController: ScenarioScreenViewController {
    private let sortLabel = UILabel()
    private var overlayViews: [UIView] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Sort"
        view.accessibilityIdentifier = "demo.state.sheet-base.root"
        configureContent()
    }

    private func configureContent() {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])

        stack.addArrangedSubview(makeContractEyebrow())

        let heading = UILabel()
        heading.font = .preferredFont(forTextStyle: .largeTitle)
        heading.text = scenario.title
        heading.numberOfLines = 0
        stack.addArrangedSubview(heading)

        sortLabel.font = .preferredFont(forTextStyle: .body)
        sortLabel.textColor = .secondaryLabel
        sortLabel.text = "Sort: Featured"
        stack.addArrangedSubview(sortLabel)

        let open = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Sort options"
        configuration.cornerStyle = .large
        open.configuration = configuration
        open.accessibilityIdentifier = "demo.sheet.open"
        open.addAction(
            UIAction { [weak self] _ in self?.presentSheet() },
            for: .touchUpInside
        )
        stack.addArrangedSubview(open)
    }

    private func presentSheet() {
        guard overlayViews.isEmpty else {
            return
        }

        let backdrop = UIView()
        backdrop.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        backdrop.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(backdrop)

        let sheet = UIView()
        sheet.backgroundColor = .secondarySystemGroupedBackground
        sheet.layer.cornerRadius = 16
        sheet.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        sheet.accessibilityIdentifier = "demo.sheet.container"
        sheet.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sheet)

        let sheetStack = UIStackView()
        sheetStack.axis = .vertical
        sheetStack.spacing = 12
        sheetStack.translatesAutoresizingMaskIntoConstraints = false
        sheet.addSubview(sheetStack)

        let sheetTitle = UILabel()
        sheetTitle.font = .preferredFont(forTextStyle: .headline)
        sheetTitle.text = "Sort options"
        sheetStack.addArrangedSubview(sheetTitle)

        let option = UIButton(type: .system)
        var optionConfiguration = UIButton.Configuration.filled()
        optionConfiguration.title = "Price: low to high"
        optionConfiguration.cornerStyle = .large
        option.configuration = optionConfiguration
        option.accessibilityIdentifier = "demo.sheet.option_primary"
        option.addAction(
            UIAction { [weak self] _ in self?.chooseOption() },
            for: .touchUpInside
        )
        sheetStack.addArrangedSubview(option)

        let dismiss = UIButton(type: .system)
        var dismissConfiguration = UIButton.Configuration.gray()
        dismissConfiguration.title = "Dismiss"
        dismissConfiguration.cornerStyle = .large
        dismiss.configuration = dismissConfiguration
        dismiss.accessibilityIdentifier = "demo.sheet.dismiss"
        dismiss.addAction(
            UIAction { [weak self] _ in self?.dismissSheet() },
            for: .touchUpInside
        )
        sheetStack.addArrangedSubview(dismiss)

        NSLayoutConstraint.activate([
            backdrop.topAnchor.constraint(equalTo: view.topAnchor),
            backdrop.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            backdrop.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            sheet.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sheet.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sheet.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            sheetStack.topAnchor.constraint(equalTo: sheet.topAnchor, constant: 20),
            sheetStack.leadingAnchor.constraint(equalTo: sheet.leadingAnchor, constant: 24),
            sheetStack.trailingAnchor.constraint(equalTo: sheet.trailingAnchor, constant: -24),
            sheetStack.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: -20
            ),
        ])

        overlayViews = [backdrop, sheet]
        view.accessibilityIdentifier = "demo.state.sheet-open.root"
    }

    private func chooseOption() {
        sortLabel.text = "Sort: Price low to high"
        closeSheet()
    }

    private func dismissSheet() {
        closeSheet()
    }

    private func closeSheet() {
        for overlay in overlayViews {
            overlay.removeFromSuperview()
        }
        overlayViews = []
        view.accessibilityIdentifier = "demo.state.sheet-base.root"
    }
}
