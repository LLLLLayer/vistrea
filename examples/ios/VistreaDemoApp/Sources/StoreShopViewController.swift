import UIKit

/// Entry state of `demo.store.navigation` (`demo.state.store-shop`).
///
/// The screen pins the contracted featured card above the snap-aligned
/// catalog so the state's required nodes survive any amount of scrolling,
/// and styles the two contracted tab buttons as a bottom bar. Every deeper
/// storefront screen — detail, reviews, and the profile "tab" — is a push on
/// this same navigation stack, so the platform back gesture always returns
/// within the scenario. The shop screen itself hides the back affordance and
/// disables the edge-pop gesture, so a pop attempt on the entry state is a
/// harmless no-op.
final class StoreShopViewController: ScenarioScreenViewController {
    private let catalogView = SnapCatalogView()
    private var catalogHeightConstraint: NSLayoutConstraint?
    private var featuredCard: UIButton?
    private var tabBar: StoreTabBarView?
    private var restoreInteractivePopGesture = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Shop"
        view.accessibilityIdentifier = "demo.state.store-shop.root"
        navigationItem.hidesBackButton = true
        configureContent()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let gesture = navigationController?.interactivePopGestureRecognizer, gesture.isEnabled {
            gesture.isEnabled = false
            restoreInteractivePopGesture = true
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if restoreInteractivePopGesture {
            navigationController?.interactivePopGestureRecognizer?.isEnabled = true
            restoreInteractivePopGesture = false
        }
    }

    private func configureContent() {
        let eyebrow = makeContractEyebrow()
        eyebrow.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(eyebrow)

        let featured = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Featured · \(StoreCatalog.featuredItem.name)"
        configuration.subtitle = StoreCatalog.featuredItem.price
        configuration.cornerStyle = .large
        configuration.contentInsets = NSDirectionalEdgeInsets(
            top: 14,
            leading: 18,
            bottom: 14,
            trailing: 18
        )
        featured.configuration = configuration
        featured.contentHorizontalAlignment = .leading
        featured.accessibilityIdentifier = "demo.store.catalog_item_primary"
        featured.addAction(
            UIAction { [weak self] _ in self?.openDetail() },
            for: .touchUpInside
        )
        featured.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(featured)
        featuredCard = featured

        catalogView.accessibilityIdentifier = "demo.store.catalog_list"
        catalogView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(catalogView)

        let bar = StoreTabBarView(
            active: .shop,
            onShopTap: { [weak self] in self?.announceShopSelfAction() },
            onProfileTap: { [weak self] in self?.openProfile() }
        )
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)
        tabBar = bar

        let heightConstraint = catalogView.heightAnchor.constraint(
            equalToConstant: catalogView.snapLayout.rowHeight
        )
        catalogHeightConstraint = heightConstraint

        NSLayoutConstraint.activate([
            eyebrow.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            eyebrow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            eyebrow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            featured.topAnchor.constraint(equalTo: eyebrow.bottomAnchor, constant: 12),
            featured.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            featured.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            featured.heightAnchor.constraint(equalToConstant: 72),
            catalogView.topAnchor.constraint(equalTo: featured.bottomAnchor, constant: 12),
            catalogView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            catalogView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            heightConstraint,
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let featured = featuredCard,
              let bar = tabBar,
              let heightConstraint = catalogHeightConstraint
        else {
            return
        }
        let available = bar.frame.minY - 8 - (featured.frame.maxY + 12)
        let desired = catalogView.snapLayout.viewportHeight(fitting: max(available, 0))
        if heightConstraint.constant != desired {
            heightConstraint.constant = desired
            view.setNeedsLayout()
        }
    }

    private func openDetail() {
        navigationController?.pushViewController(
            StoreDetailViewController(
                scenario: scenario,
                profile: profile,
                item: StoreCatalog.featuredItem
            ),
            animated: true
        )
    }

    private func openProfile() {
        navigationController?.pushViewController(
            StoreProfileViewController(scenario: scenario, profile: profile),
            animated: true
        )
    }

    private func announceShopSelfAction() {
        UIAccessibility.post(
            notification: .announcement,
            argument: "Shop is already the active section."
        )
    }
}
