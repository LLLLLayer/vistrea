import XCTest
@testable import VistreaDemoApp

final class SnapCatalogLayoutTests: XCTestCase {
    private let layout = SnapCatalogLayout(rowHeight: 64, rowCount: 50)

    func testViewportIsAlwaysAWholeNumberOfRows() {
        XCTAssertEqual(layout.viewportHeight(fitting: 500), 448)
        XCTAssertEqual(layout.viewportHeight(fitting: 448), 448)
        XCTAssertEqual(layout.viewportHeight(fitting: 63), 64)
        XCTAssertEqual(layout.viewportHeight(fitting: 0), 64)
        XCTAssertEqual(layout.viewportHeight(fitting: 100_000), 3200)
    }

    func testRestingOffsetsSnapToWholeRows() {
        XCTAssertEqual(layout.snappedOffset(proposed: 0, viewportHeight: 448), 0)
        XCTAssertEqual(layout.snappedOffset(proposed: 130, viewportHeight: 448), 128)
        XCTAssertEqual(layout.snappedOffset(proposed: 95, viewportHeight: 448), 64)
        XCTAssertEqual(layout.snappedOffset(proposed: -50, viewportHeight: 448), 0)
        // Content is 3200pt, so the maximum offset 2752 is itself a whole-row
        // multiple whenever the viewport is one.
        XCTAssertEqual(layout.snappedOffset(proposed: 5000, viewportHeight: 448), 2752)
        XCTAssertEqual(layout.snappedOffset(proposed: 5000, viewportHeight: 448)
            .truncatingRemainder(dividingBy: 64), 0)
    }

    func testRecycledWindowAlwaysHoldsTheSameNumberOfInRangeRows() {
        XCTAssertEqual(layout.windowLength(viewportHeight: 448), 8)
        // At the top the buffer row sits below the visible rows.
        XCTAssertEqual(layout.windowStartRow(offset: 0, viewportHeight: 448), 0)
        XCTAssertEqual(layout.windowStartRow(offset: 128, viewportHeight: 448), 2)
        // At the bottom the buffer row flips above so the window stays in
        // range and the node count never changes.
        XCTAssertEqual(layout.windowStartRow(offset: 2752, viewportHeight: 448), 42)
    }

    func testSingleRowViewportStaysUsable() {
        XCTAssertEqual(layout.visibleRowCapacity(viewportHeight: 64), 1)
        XCTAssertEqual(layout.windowLength(viewportHeight: 64), 2)
        XCTAssertEqual(layout.maximumOffset(viewportHeight: 64), 3136)
        XCTAssertEqual(layout.windowStartRow(offset: 3136, viewportHeight: 64), 48)
    }
}
