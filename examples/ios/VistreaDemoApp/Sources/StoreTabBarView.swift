import UIKit

/// The storefront's visual tab bar. It is deliberately not a
/// `UITabBarController`: every storefront screen lives on one navigation
/// stack so the platform back gesture always pops within the scenario, and
/// this bar only styles the two contracted tab buttons.
final class StoreTabBarView: UIView {
    enum Tab {
        case shop
        case profile
    }

    static let barHeight: CGFloat = 56

    private let shopButton = UIButton(type: .system)
    private let profileButton = UIButton(type: .system)

    init(
        active: Tab,
        onShopTap: @escaping () -> Void,
        onProfileTap: @escaping () -> Void
    ) {
        super.init(frame: .zero)
        backgroundColor = .secondarySystemGroupedBackground

        let hairline = UIView()
        hairline.backgroundColor = .separator
        hairline.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hairline)

        configure(
            button: shopButton,
            title: "Shop",
            nodeID: "demo.store.tab_shop",
            isActive: active == .shop,
            handler: onShopTap
        )
        configure(
            button: profileButton,
            title: "Profile",
            nodeID: "demo.store.tab_profile",
            isActive: active == .profile,
            handler: onProfileTap
        )

        let stack = UIStackView(arrangedSubviews: [shopButton, profileButton])
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            hairline.topAnchor.constraint(equalTo: topAnchor),
            hairline.leadingAnchor.constraint(equalTo: leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: trailingAnchor),
            hairline.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: Self.barHeight),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    private func configure(
        button: UIButton,
        title: String,
        nodeID: String,
        isActive: Bool,
        handler: @escaping () -> Void
    ) {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        button.configuration = configuration
        button.tintColor = isActive ? .systemBlue : .secondaryLabel
        button.accessibilityIdentifier = nodeID
        button.addAction(UIAction { _ in handler() }, for: .touchUpInside)
    }
}
