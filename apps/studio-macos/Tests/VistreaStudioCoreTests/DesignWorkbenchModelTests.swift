import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

@MainActor
final class DesignWorkbenchModelTests: XCTestCase {
    private static let fixtureScreenshotHash =
        "sha256:f94b346f6566e57842e2911f61a85ebb8b3f56aa538c5555aae4c51fe509157e"

    func testWorkbenchComparisonFlowResolvesRegionsAndStepsReview() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let screenshotBytes = Data("screenshot-b".utf8)
        let client = FixtureHostClient(
            snapshots: [snapshot],
            objectsByHash: [Self.fixtureScreenshotHash: screenshotBytes]
        )
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        XCTAssertEqual(model.selectedSnapshotID, snapshot.snapshotID.rawValue)

        await model.loadDesignReferences()
        XCTAssertEqual(model.designReferencesPhase, .content)
        let reference = try XCTUnwrap(model.designReferences.first)
        XCTAssertEqual(reference.artifact.object.hash, Self.fixtureScreenshotHash)

        await model.selectDesignReference(id: reference.id)
        XCTAssertEqual(model.designReferencePhase, .content)
        XCTAssertEqual(model.selectedDesignReference?.id, reference.id)
        XCTAssertEqual(model.designAssetPhase, .available)
        XCTAssertEqual(model.designAssetData, screenshotBytes)
        XCTAssertEqual(model.designComparisonsPhase, .empty)

        await model.runDesignComparison(includePixel: true)
        let comparison = try XCTUnwrap(model.designComparison)
        XCTAssertNil(model.designComparisonError)
        XCTAssertEqual(comparison.quality, "complete")
        XCTAssertEqual(comparison.pixel?.status, "compared")
        XCTAssertEqual(comparison.differences.map(\.category), ["frame", "color"])
        // The run refreshed the persisted comparison list.
        XCTAssertEqual(model.designComparisons.map(\.id), [comparison.id])
        XCTAssertEqual(model.designComparisonsPhase, .content)

        // The frame difference scales from logical points into unit image
        // coordinates through the screenshot coverage (390 x 844 points).
        let regions = model.differenceRegions
        XCTAssertEqual(regions.count, 2)
        let frameRegion = regions[0]
        XCTAssertEqual(frameRegion.category, "frame")
        XCTAssertEqual(frameRegion.unitRect.x, 24.0 / 390.0, accuracy: 0.0001)
        XCTAssertEqual(frameRegion.unitRect.y, 120.0 / 844.0, accuracy: 0.0001)
        XCTAssertEqual(frameRegion.unitRect.width, 342.0 / 390.0, accuracy: 0.0001)
        XCTAssertEqual(frameRegion.unitRect.height, 52.0 / 844.0, accuracy: 0.0001)
        let expectedRect = try XCTUnwrap(frameRegion.expectedUnitRect)
        XCTAssertEqual(expectedRect.x, 32.0 / 390.0, accuracy: 0.0001)
        // The color difference locates the node frame through its stable ID.
        let colorRegion = regions[1]
        XCTAssertEqual(colorRegion.category, "color")
        XCTAssertNil(colorRegion.expectedUnitRect)
        XCTAssertEqual(colorRegion.unitRect.x, 24.0 / 390.0, accuracy: 0.0001)

        // Difference selection and review-mode stepping wrap at both ends.
        let ids = comparison.differences.map(\.differenceID)
        model.selectDifference(id: ids[0])
        XCTAssertEqual(model.selectedDifferenceID, ids[0])
        model.advanceDifferenceSelection(by: 1)
        XCTAssertEqual(model.selectedDifferenceID, ids[1])
        model.advanceDifferenceSelection(by: 1)
        XCTAssertEqual(model.selectedDifferenceID, ids[0])
        model.advanceDifferenceSelection(by: -1)
        XCTAssertEqual(model.selectedDifferenceID, ids[1])
        model.selectDifference(id: "difference_019f0000-0000-7000-8000-00000000ffff")
        XCTAssertEqual(model.selectedDifferenceID, ids[1], "Unknown IDs never select.")
    }

    func testComparisonWithoutBundledBytesDegradesToPartialPixel() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let client = FixtureHostClient(snapshots: [snapshot])
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        await model.loadDesignReferences()
        let reference = try XCTUnwrap(model.designReferences.first)
        await model.selectDesignReference(id: reference.id)

        // The fixture bundles no binary, so the asset load degrades to text.
        XCTAssertNil(model.designAssetData)
        guard case .unavailable = model.designAssetPhase else {
            return XCTFail("Expected the design asset to be unavailable.")
        }

        await model.runDesignComparison(includePixel: true)
        let comparison = try XCTUnwrap(model.designComparison)
        XCTAssertEqual(comparison.quality, "partial")
        XCTAssertEqual(comparison.pixel?.status, "unavailable")
        XCTAssertNotNil(comparison.pixel?.reason)
        // The structural frame difference needs no pixels and still resolves
        // a drawable region.
        XCTAssertEqual(comparison.differences.map(\.category), ["frame"])
        XCTAssertEqual(model.differenceRegions.count, 1)
    }

    func testSnapshotWithoutScreenshotDegradesHonestly() async throws {
        let snapshot = try StudioTestFixtures.snapshot(
            "protocol/fixtures/v1/runtime-snapshot/valid/minimal.json"
        )
        let reference = DesignReferenceDetail(
            designReferenceID: "designref_019f0000-0000-7000-8000-0000000000e1",
            revision: 1,
            kind: "design_artifact",
            name: "Baseline without a runtime screenshot",
            artifact: DesignArtifactSummary(
                object: DesignObjectSummary(
                    hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                    mediaType: "image/png"
                )
            ),
            canvasSize: SizeSummary(width: 390, height: 844),
            pixelSize: PixelSizeSummary(width: 1_170, height: 2_532)
        )
        let client = FixtureHostClient(snapshots: [snapshot], designReferences: [reference])
        let model = SnapshotWorkspaceModel(client: client)
        await model.refresh()
        XCTAssertNil(model.selectedSnapshot?.screenshot)

        await model.loadDesignReferences()
        await model.selectDesignReference(id: reference.id)
        await model.runDesignComparison(includePixel: true)

        let comparison = try XCTUnwrap(model.designComparison)
        // No measurable node and no screenshot: the comparison stays honest
        // instead of inventing differences or overlay geometry.
        XCTAssertEqual(comparison.quality, "partial")
        XCTAssertEqual(comparison.pixel?.status, "unavailable")
        XCTAssertTrue(comparison.differences.isEmpty)
        XCTAssertTrue(model.differenceRegions.isEmpty)
    }

    func testDesignReferenceLoadFailuresSurfaceInline() async throws {
        let model = SnapshotWorkspaceModel(
            client: UnavailableHostClient(message: "The Host is not configured.")
        )
        await model.loadDesignReferences()
        guard case let .failure(message) = model.designReferencesPhase else {
            return XCTFail("Expected the reference list to fail inline.")
        }
        XCTAssertEqual(message, "The Host is not configured.")

        await model.selectDesignReference(id: "designref_019f0000-0000-7000-8000-0000000000e1")
        guard case .failure = model.designReferencePhase else {
            return XCTFail("Expected the reference detail to fail inline.")
        }

        // Without a selected reference and Snapshot the compare action
        // refuses locally instead of posting.
        await model.runDesignComparison(includePixel: false)
        XCTAssertNotNil(model.designComparisonError)
        XCTAssertNil(model.designComparison)
    }
}
