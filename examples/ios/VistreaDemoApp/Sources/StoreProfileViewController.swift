import UIKit

/// `demo.state.store-profile` of `demo.store.navigation`. Although it looks
/// like a tab, the profile screen is a push on the same navigation stack as
/// the detail and reviews screens, so both the contracted
/// `demo.store.tab_shop` tap and the platform back gesture return to the
/// shop. Tapping the profile tab while already here is a harmless self-action.
final class StoreProfileViewController: ScenarioScreenViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Profile"
        view.accessibilityIdentifier = "demo.state.store-profile.root"
        configureContent()
    }

    private func configureContent() {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        let bar = StoreTabBarView(
            active: .profile,
            onShopTap: { [weak self] in self?.returnToShop() },
            onProfileTap: { [weak self] in self?.announceProfileSelfAction() }
        )
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        stack.addArrangedSubview(makeContractEyebrow())

        let header = UILabel()
        header.font = .preferredFont(forTextStyle: .largeTitle)
        header.text = "Demo Customer"
        header.numberOfLines = 0
        header.accessibilityIdentifier = "demo.store.profile_header"
        stack.addArrangedSubview(header)

        let membership = UILabel()
        membership.font = .preferredFont(forTextStyle: .body)
        membership.textColor = .secondaryLabel
        membership.text = "Member since fixture seed 2100."
        membership.numberOfLines = 0
        stack.addArrangedSubview(membership)
    }

    private func returnToShop() {
        navigationController?.popViewController(animated: true)
    }

    private func announceProfileSelfAction() {
        UIAccessibility.post(
            notification: .announcement,
            argument: "Profile is already the active section."
        )
    }
}
