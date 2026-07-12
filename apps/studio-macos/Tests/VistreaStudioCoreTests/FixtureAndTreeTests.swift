import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

final class FixtureAndTreeTests: XCTestCase {
    func testStrictCanonicalDecoderReadsIOSFixture() throws {
        let snapshot = try StudioTestFixtures.snapshot()

        XCTAssertEqual(snapshot.snapshotID.rawValue, "snapshot_019f0000-0000-7000-8000-000000000002")
        XCTAssertEqual(snapshot.runtimeContext.platform, .ios)
        XCTAssertEqual(snapshot.trees.first?.payload.inlineNodes?.count, 2)
        XCTAssertEqual(snapshot.screenshot?.object.logicalName, "ios-home.png")
    }

    func testStrictCanonicalDecoderRejectsUnknownCoreFieldFixture() throws {
        let data = try StudioTestFixtures.data(
            "protocol/fixtures/v1/runtime-snapshot/invalid/unknown-core-field.json"
        )

        XCTAssertThrowsError(try RuntimeSnapshotCodec.decode(data))
    }

    func testReconstructsCanonicalFlatTreeWithoutChangingNodeIdentity() throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let projection = try UiTreeProjector.preferredProjection(from: snapshot)

        XCTAssertEqual(projection.kind, "view")
        XCTAssertEqual(projection.roots.count, 1)
        XCTAssertEqual(projection.roots[0].presentation.stableID, "demo.home.root")
        XCTAssertEqual(projection.roots[0].children.count, 1)
        XCTAssertEqual(projection.roots[0].children[0].presentation.stableID, "demo.home.open_catalog")
        XCTAssertEqual(projection.nodesByID.count, 2)
    }

    func testTreeProjectionRejectsSemanticDanglingChildFixture() throws {
        let snapshot = try StudioTestFixtures.snapshot(
            "protocol/fixtures/v1/runtime-snapshot/invalid/dangling-child-reference.json"
        )

        XCTAssertThrowsError(try UiTreeProjector.preferredProjection(from: snapshot)) { error in
            guard case UiTreeProjectionError.danglingChild = error else {
                return XCTFail("Expected danglingChild, received \(error)")
            }
        }
    }
}
