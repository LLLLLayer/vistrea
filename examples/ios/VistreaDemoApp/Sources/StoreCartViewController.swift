import UIKit

/// `demo.store.cart-states`: one screen whose empty and populated structures
/// are legitimately different states. Adding the sample item swaps the empty
/// notice and add button for the item row and checkout button; tapping the
/// item row removes it again. The toggle is purely in-memory, so every launch
/// enters the empty state. `demo.cart.checkout` has no contracted step, so it
/// follows the renderer convention for step-less controls and stays disabled.
final class StoreCartViewController: ScenarioScreenViewController {
    private let cartStack = UIStackView()
    private var hasSampleItem = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Cart"
        configureContent()
        renderCart()
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
        heading.text = "Cart"
        stack.addArrangedSubview(heading)

        cartStack.axis = .vertical
        cartStack.spacing = 16
        stack.addArrangedSubview(cartStack)
    }

    private func renderCart() {
        for arranged in cartStack.arrangedSubviews {
            arranged.removeFromSuperview()
        }
        if hasSampleItem {
            renderPopulated()
            view.accessibilityIdentifier = "demo.state.cart-populated.root"
        } else {
            renderEmpty()
            view.accessibilityIdentifier = "demo.state.cart-empty.root"
        }
    }

    private func renderEmpty() {
        let notice = UILabel()
        notice.font = .preferredFont(forTextStyle: .headline)
        notice.text = "Your cart is empty."
        notice.numberOfLines = 0
        notice.backgroundColor = .secondarySystemGroupedBackground
        notice.layer.cornerRadius = 12
        notice.layer.masksToBounds = true
        notice.accessibilityIdentifier = "demo.cart.empty_notice"
        notice.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
        cartStack.addArrangedSubview(notice)

        let addSample = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Add sample item"
        configuration.cornerStyle = .large
        addSample.configuration = configuration
        addSample.accessibilityIdentifier = "demo.cart.add_sample"
        addSample.addAction(
            UIAction { [weak self] _ in self?.setSampleItem(present: true) },
            for: .touchUpInside
        )
        cartStack.addArrangedSubview(addSample)
    }

    private func renderPopulated() {
        let item = UIButton(type: .system)
        var itemConfiguration = UIButton.Configuration.gray()
        itemConfiguration.title = "\(StoreCatalog.featuredItem.name) · \(StoreCatalog.featuredItem.price)"
        itemConfiguration.subtitle = "Tap to remove"
        itemConfiguration.cornerStyle = .large
        item.configuration = itemConfiguration
        item.contentHorizontalAlignment = .leading
        item.accessibilityIdentifier = "demo.cart.item_primary"
        item.addAction(
            UIAction { [weak self] _ in self?.setSampleItem(present: false) },
            for: .touchUpInside
        )
        cartStack.addArrangedSubview(item)

        let checkout = UIButton(type: .system)
        var checkoutConfiguration = UIButton.Configuration.filled()
        checkoutConfiguration.title = "Checkout"
        checkoutConfiguration.cornerStyle = .large
        checkout.configuration = checkoutConfiguration
        checkout.accessibilityIdentifier = "demo.cart.checkout"
        checkout.isEnabled = false
        cartStack.addArrangedSubview(checkout)
    }

    private func setSampleItem(present: Bool) {
        hasSampleItem = present
        renderCart()
    }
}
