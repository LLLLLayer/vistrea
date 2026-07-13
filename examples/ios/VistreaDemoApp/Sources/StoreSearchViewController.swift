import UIKit

/// `demo.store.search`: one screen whose three contract states are real
/// structural variants of the same hierarchy.
///
/// - `demo.state.search`: field, browse hint, results container with every
///   catalog item, first row carrying `demo.search.result_primary`.
/// - `demo.state.search-filtered`: the browse hint leaves the tree, the
///   results container keeps only matching rows.
/// - `demo.state.search-empty`: the results container leaves the tree and the
///   `demo.search.empty_notice` label joins it.
///
/// Filtering runs on every text change, and clearing the field rebuilds the
/// exact entry structure.
final class StoreSearchViewController: ScenarioScreenViewController {
    private let searchField = UITextField()
    private let browseHint = UILabel()
    private let resultsContainer = UIScrollView()
    private let resultsStack = UIStackView()
    private let emptyNotice = UILabel()
    private let contentStack = UIStackView()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Search"
        configureContent()
        apply(query: "")
    }

    private func configureContent() {
        contentStack.axis = .vertical
        contentStack.spacing = 16
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            contentStack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            contentStack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            contentStack.bottomAnchor.constraint(
                lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: -16
            ),
        ])

        contentStack.addArrangedSubview(makeContractEyebrow())

        searchField.borderStyle = .roundedRect
        searchField.placeholder = "Search the catalog"
        searchField.autocorrectionType = .no
        searchField.autocapitalizationType = .none
        searchField.clearButtonMode = .whileEditing
        searchField.accessibilityIdentifier = "demo.search.field"
        searchField.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        searchField.addAction(
            UIAction { [weak self] _ in self?.searchFieldChanged() },
            for: .editingChanged
        )
        contentStack.addArrangedSubview(searchField)

        browseHint.font = .preferredFont(forTextStyle: .subheadline)
        browseHint.textColor = .secondaryLabel
        browseHint.numberOfLines = 0
        browseHint.text = "Browse all \(StoreCatalog.itemCount) items"

        resultsContainer.accessibilityIdentifier = "demo.search.results"
        resultsContainer.backgroundColor = .secondarySystemGroupedBackground
        resultsContainer.layer.cornerRadius = 12
        resultsContainer.layer.masksToBounds = true
        resultsContainer.showsVerticalScrollIndicator = false
        resultsContainer.heightAnchor.constraint(
            lessThanOrEqualToConstant: CGFloat(StoreCatalog.itemCount) * SearchResultRowView.rowHeight
        ).isActive = true
        resultsStack.axis = .vertical
        resultsStack.translatesAutoresizingMaskIntoConstraints = false
        resultsContainer.addSubview(resultsStack)
        NSLayoutConstraint.activate([
            resultsStack.topAnchor.constraint(equalTo: resultsContainer.contentLayoutGuide.topAnchor),
            resultsStack.leadingAnchor.constraint(equalTo: resultsContainer.contentLayoutGuide.leadingAnchor),
            resultsStack.trailingAnchor.constraint(equalTo: resultsContainer.contentLayoutGuide.trailingAnchor),
            resultsStack.bottomAnchor.constraint(equalTo: resultsContainer.contentLayoutGuide.bottomAnchor),
            resultsStack.widthAnchor.constraint(equalTo: resultsContainer.frameLayoutGuide.widthAnchor),
        ])

        emptyNotice.font = .preferredFont(forTextStyle: .headline)
        emptyNotice.numberOfLines = 0
        emptyNotice.text = "No items match this search."
        emptyNotice.accessibilityIdentifier = "demo.search.empty_notice"
    }

    private func searchFieldChanged() {
        apply(query: searchField.text ?? "")
    }

    private func apply(query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let queryIsActive = !trimmed.isEmpty
        let matches = StoreCatalog.matches(query: trimmed)

        browseHint.removeFromSuperview()
        emptyNotice.removeFromSuperview()
        resultsContainer.removeFromSuperview()
        for row in resultsStack.arrangedSubviews {
            row.removeFromSuperview()
        }

        if !queryIsActive {
            contentStack.addArrangedSubview(browseHint)
        }
        if queryIsActive && matches.isEmpty {
            contentStack.addArrangedSubview(emptyNotice)
            view.accessibilityIdentifier = "demo.state.search-empty.root"
            return
        }

        for (index, item) in matches.enumerated() {
            let row = SearchResultRowView(item: item)
            if index == 0 {
                row.accessibilityIdentifier = "demo.search.result_primary"
            }
            resultsStack.addArrangedSubview(row)
        }
        contentStack.addArrangedSubview(resultsContainer)
        view.accessibilityIdentifier = queryIsActive
            ? "demo.state.search-filtered.root"
            : "demo.state.search.root"
    }
}

/// One homogeneous search result row: identical structure for every item;
/// only the first row carries the contracted primary result ID.
final class SearchResultRowView: UIView {
    static let rowHeight: CGFloat = 48

    init(item: StoreCatalogItem) {
        super.init(frame: .zero)
        let name = UILabel()
        name.font = .preferredFont(forTextStyle: .body)
        name.text = item.name
        name.translatesAutoresizingMaskIntoConstraints = false
        let price = UILabel()
        price.font = .preferredFont(forTextStyle: .subheadline)
        price.textColor = .secondaryLabel
        price.text = item.price
        price.translatesAutoresizingMaskIntoConstraints = false
        addSubview(name)
        addSubview(price)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Self.rowHeight),
            name.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            name.centerYAnchor.constraint(equalTo: centerYAnchor),
            price.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            price.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }
}
