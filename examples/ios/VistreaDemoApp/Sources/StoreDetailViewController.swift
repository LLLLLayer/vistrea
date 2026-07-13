import UIKit

/// `demo.state.store-detail` of `demo.store.navigation`. Reached by tapping
/// the pinned featured card; the standard navigation back pops to the shop.
/// `demo.store.detail_add_to_cart` has no contracted step, so it follows the
/// renderer convention for step-less controls and stays disabled.
final class StoreDetailViewController: ScenarioScreenViewController {
    private let item: StoreCatalogItem

    init(scenario: ScenarioDefinition, profile: String, item: StoreCatalogItem) {
        self.item = item
        super.init(scenario: scenario, profile: profile)
        title = "Detail"
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "demo.state.store-detail.root"
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

        let name = UILabel()
        name.font = .preferredFont(forTextStyle: .largeTitle)
        name.text = item.name
        name.numberOfLines = 0
        stack.addArrangedSubview(name)

        let price = UILabel()
        price.font = .preferredFont(forTextStyle: .title2)
        price.textColor = .secondaryLabel
        price.text = item.price
        stack.addArrangedSubview(price)

        let details = UILabel()
        details.font = .preferredFont(forTextStyle: .body)
        details.textColor = .secondaryLabel
        details.numberOfLines = 0
        details.text = "Deterministic demo listing. Ships from the local fixture warehouse."
        stack.addArrangedSubview(details)

        let addToCart = UIButton(type: .system)
        var addConfiguration = UIButton.Configuration.filled()
        addConfiguration.title = "Add to cart"
        addConfiguration.cornerStyle = .large
        addToCart.configuration = addConfiguration
        addToCart.accessibilityIdentifier = "demo.store.detail_add_to_cart"
        addToCart.isEnabled = false
        stack.addArrangedSubview(addToCart)

        let openReviews = UIButton(type: .system)
        var reviewsConfiguration = UIButton.Configuration.gray()
        reviewsConfiguration.title = "Read reviews"
        reviewsConfiguration.cornerStyle = .large
        openReviews.configuration = reviewsConfiguration
        openReviews.accessibilityIdentifier = "demo.store.detail_open_reviews"
        openReviews.addAction(
            UIAction { [weak self] _ in self?.openReviews() },
            for: .touchUpInside
        )
        stack.addArrangedSubview(openReviews)
    }

    private func openReviews() {
        navigationController?.pushViewController(
            StoreReviewsViewController(scenario: scenario, profile: profile),
            animated: true
        )
    }
}
