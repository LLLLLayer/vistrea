import UIKit

/// `demo.state.store-reviews` of `demo.store.navigation`. Reached from the
/// detail screen; the standard navigation back pops to detail. Only the
/// primary review carries a stable node ID — the remaining rows are
/// deterministic content with identical structure.
final class StoreReviewsViewController: ScenarioScreenViewController {
    private static let reviews = [
        "Five stars. Arrived exactly as captured.",
        "Four stars. Deterministic delivery window.",
        "Five stars. Same structure on every visit.",
        "Four stars. The fixture warehouse never sleeps.",
    ]

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Reviews"
        view.accessibilityIdentifier = "demo.state.store-reviews.root"
        configureContent()
    }

    private func configureContent() {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
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
        heading.text = "Reviews"
        stack.addArrangedSubview(heading)

        for (index, review) in Self.reviews.enumerated() {
            let card = makeReviewCard(text: review)
            if index == 0 {
                card.accessibilityIdentifier = "demo.store.review_item_primary"
            }
            stack.addArrangedSubview(card)
        }
    }

    private func makeReviewCard(text: String) -> UILabel {
        let card = UILabel()
        card.font = .preferredFont(forTextStyle: .body)
        card.text = text
        card.numberOfLines = 0
        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 12
        card.layer.masksToBounds = true
        card.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
        return card
    }
}
