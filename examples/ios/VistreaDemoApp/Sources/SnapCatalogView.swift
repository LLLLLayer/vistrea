import UIKit

/// Pure geometry for the snap-aligned catalog. Every rule that makes a
/// scrolled catalog structurally identical to the resting catalog lives here:
/// the viewport is always a whole number of rows, resting offsets are always
/// whole-row multiples, and the recycled row window always holds the same
/// number of consecutive in-range rows.
struct SnapCatalogLayout: Sendable {
    let rowHeight: CGFloat
    let rowCount: Int

    init(rowHeight: CGFloat = 64, rowCount: Int = StoreCatalog.itemCount) {
        self.rowHeight = rowHeight
        self.rowCount = rowCount
    }

    var contentHeight: CGFloat {
        CGFloat(rowCount) * rowHeight
    }

    /// The largest whole-row viewport that fits the available height.
    func viewportHeight(fitting available: CGFloat) -> CGFloat {
        let rows = max(1, Int(available / rowHeight))
        return CGFloat(min(rows, rowCount)) * rowHeight
    }

    /// How many complete rows the viewport shows at rest.
    func visibleRowCapacity(viewportHeight: CGFloat) -> Int {
        max(1, min(rowCount, Int((viewportHeight / rowHeight).rounded())))
    }

    /// One recycled buffer row keeps scrolling gap-free between snap points.
    func windowLength(viewportHeight: CGFloat) -> Int {
        min(rowCount, visibleRowCapacity(viewportHeight: viewportHeight) + 1)
    }

    func maximumOffset(viewportHeight: CGFloat) -> CGFloat {
        max(0, contentHeight - viewportHeight)
    }

    /// Rounds a proposed resting offset to the nearest whole-row offset.
    func snappedOffset(proposed: CGFloat, viewportHeight: CGFloat) -> CGFloat {
        let snapped = (proposed / rowHeight).rounded() * rowHeight
        return min(max(0, snapped), maximumOffset(viewportHeight: viewportHeight))
    }

    /// The first row bound into the recycled window for a content offset.
    /// The window always stays inside `0..<rowCount`, so the resting tree has
    /// the same node count whether the buffer row sits below or above the
    /// visible rows.
    func windowStartRow(offset: CGFloat, viewportHeight: CGFloat) -> Int {
        let length = windowLength(viewportHeight: viewportHeight)
        let first = Int((offset / rowHeight).rounded(.down))
        return min(max(0, first), rowCount - length)
    }
}

/// The scrolling shop catalog: fifty deterministic items rendered through a
/// fixed set of recycled, structurally identical row views. Scrolling snaps to
/// whole rows, so a captured tree after any swipe has the same roles, node
/// count, and stable IDs as the entry tree — only row text differs. Rows are
/// content, not identity, and never carry stable node IDs.
final class SnapCatalogView: UIScrollView, UIScrollViewDelegate {
    private let layout: SnapCatalogLayout
    private let items: [StoreCatalogItem]
    private var rowViews: [SnapCatalogRowView] = []

    init(layout: SnapCatalogLayout = SnapCatalogLayout(), items: [StoreCatalogItem] = StoreCatalog.items) {
        self.layout = layout
        self.items = items
        super.init(frame: .zero)
        precondition(items.count == layout.rowCount, "Catalog layout and items must agree.")
        delegate = self
        bounces = false
        decelerationRate = .fast
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        backgroundColor = .secondarySystemGroupedBackground
        layer.cornerRadius = 12
        layer.masksToBounds = true
        contentInsetAdjustmentBehavior = .never
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    var snapLayout: SnapCatalogLayout {
        layout
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        contentSize = CGSize(width: bounds.width, height: layout.contentHeight)
        reconcileRowViews()
        bindWindow()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        bindWindow()
    }

    func scrollViewWillEndDragging(
        _ scrollView: UIScrollView,
        withVelocity velocity: CGPoint,
        targetContentOffset: UnsafeMutablePointer<CGPoint>
    ) {
        targetContentOffset.pointee.y = layout.snappedOffset(
            proposed: targetContentOffset.pointee.y,
            viewportHeight: bounds.height
        )
    }

    private func reconcileRowViews() {
        let length = layout.windowLength(viewportHeight: bounds.height)
        while rowViews.count < length {
            let row = SnapCatalogRowView(rowHeight: layout.rowHeight)
            rowViews.append(row)
            addSubview(row)
        }
        while rowViews.count > length {
            rowViews.removeLast().removeFromSuperview()
        }
    }

    private func bindWindow() {
        guard !rowViews.isEmpty else {
            return
        }
        let start = layout.windowStartRow(offset: contentOffset.y, viewportHeight: bounds.height)
        for (position, row) in rowViews.enumerated() {
            let index = start + position
            row.frame = CGRect(
                x: 0,
                y: CGFloat(index) * layout.rowHeight,
                width: bounds.width,
                height: layout.rowHeight
            )
            row.configure(item: items[index])
        }
    }
}

/// One homogeneous catalog row: identical structure for every item, no
/// accessibility identifier, fixed height.
final class SnapCatalogRowView: UIView {
    private let nameLabel = UILabel()
    private let priceLabel = UILabel()

    init(rowHeight: CGFloat) {
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: rowHeight))
        nameLabel.font = .preferredFont(forTextStyle: .body)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        priceLabel.font = .preferredFont(forTextStyle: .subheadline)
        priceLabel.textColor = .secondaryLabel
        priceLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(nameLabel)
        addSubview(priceLabel)
        NSLayoutConstraint.activate([
            nameLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            nameLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            priceLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            priceLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    func configure(item: StoreCatalogItem) {
        nameLabel.text = item.name
        priceLabel.text = item.price
    }
}
