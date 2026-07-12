import Foundation
import VistreaRuntimeModels
import XCTest
@testable import VistreaRuntimeUIKit

final class CaptureContentLimitsTests: XCTestCase {
    private func makeScopeIDs() throws -> (treeID: TreeID, nodeID: NodeID) {
        (
            try TreeID(validating: "tree_019f0000-0000-7000-8000-000000000001"),
            try NodeID(validating: "node_019f0000-0000-7000-8000-000000000001")
        )
    }

    func testOverLimitTextTruncatesAndRecordsANodeScopedLimitation() throws {
        let (treeID, nodeID) = try makeScopeIDs()
        let oversized = String(repeating: "a", count: CaptureContentLimits.textScalarLimit + 1)
        let bounded = try CaptureContentLimits.bounded(
            oversized,
            limit: CaptureContentLimits.textScalarLimit,
            field: "content.text",
            treeID: treeID,
            nodeID: nodeID
        )

        XCTAssertEqual(bounded.value?.unicodeScalars.count, CaptureContentLimits.textScalarLimit)
        let limitation = try XCTUnwrap(bounded.limitation)
        XCTAssertEqual(limitation.code, "ios.capture.text-truncated")
        XCTAssertEqual(limitation.severity, .warning)
        XCTAssertFalse(limitation.retryable)
        XCTAssertEqual(limitation.scope?.treeID, treeID)
        XCTAssertEqual(limitation.scope?.nodeID, nodeID)
        XCTAssertEqual(limitation.scope?.field, "content.text")
        // The truncated value must satisfy the canonical model unchanged.
        XCTAssertNoThrow(try TextContent(text: bounded.value))
    }

    func testTruncationCutsOnUnicodeScalarBoundaries() throws {
        let (treeID, nodeID) = try makeScopeIDs()
        let oversized = String(repeating: "🙂", count: CaptureContentLimits.placeholderScalarLimit + 8)
        let bounded = try CaptureContentLimits.bounded(
            oversized,
            limit: CaptureContentLimits.placeholderScalarLimit,
            field: "content.placeholder",
            treeID: treeID,
            nodeID: nodeID
        )
        XCTAssertEqual(bounded.value?.unicodeScalars.count, CaptureContentLimits.placeholderScalarLimit)
        XCTAssertNotNil(bounded.limitation)
        XCTAssertNoThrow(try TextContent(placeholder: bounded.value))
    }

    func testInLimitValuesPassThroughWithoutLimitations() throws {
        let (treeID, nodeID) = try makeScopeIDs()
        let value = String(repeating: "b", count: CaptureContentLimits.textScalarLimit)
        let bounded = try CaptureContentLimits.bounded(
            value,
            limit: CaptureContentLimits.textScalarLimit,
            field: "content.text",
            treeID: treeID,
            nodeID: nodeID
        )
        XCTAssertEqual(bounded.value, value)
        XCTAssertNil(bounded.limitation)

        let missing = try CaptureContentLimits.bounded(
            nil,
            limit: CaptureContentLimits.textScalarLimit,
            field: "content.text",
            treeID: treeID,
            nodeID: nodeID
        )
        XCTAssertNil(missing.value)
        XCTAssertNil(missing.limitation)
    }

    func testInvalidStableIdentifierLimitationNamesTheNodeAndField() throws {
        let (treeID, nodeID) = try makeScopeIDs()
        let limitation = try CaptureContentLimits.invalidStableIdentifier(
            treeID: treeID,
            nodeID: nodeID
        )
        XCTAssertEqual(limitation.code, "ios.capture.stable-id-invalid")
        XCTAssertEqual(limitation.severity, .warning)
        XCTAssertFalse(limitation.retryable)
        XCTAssertEqual(limitation.scope?.treeID, treeID)
        XCTAssertEqual(limitation.scope?.nodeID, nodeID)
        XCTAssertEqual(limitation.scope?.field, "stable_id")
    }
}

#if canImport(UIKit)
import UIKit

@MainActor
final class UIKitRuntimeCaptureAdapterTests: XCTestCase {
    private func makeAdapter() throws -> UIKitRuntimeCaptureAdapter {
        UIKitRuntimeCaptureAdapter(
            configuration: UIKitRuntimeCaptureConfiguration(
                projectID: try ProjectID(validating: "project_019f0000-0000-7000-8000-000000000001"),
                buildID: try BuildID(validating: "build_019f0000-0000-7000-8000-000000000001"),
                sdkVersion: "0.1.0",
                adapterVersion: "0.1.0"
            )
        )
    }

    func testOversizedLabelTextCapturesTruncatedWithASnapshotLimitation() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        let label = UILabel(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
        label.text = String(repeating: "a", count: CaptureContentLimits.textScalarLimit + 1)
        window.addSubview(label)

        let result = try makeAdapter().capture(
            windows: [window],
            includeScreenshot: false
        )

        let nodes = try XCTUnwrap(result.snapshot.trees.first?.payload.inlineNodes)
        let labelNode = try XCTUnwrap(nodes.first(where: { $0.role == "text" }))
        XCTAssertEqual(
            labelNode.content.text?.unicodeScalars.count,
            CaptureContentLimits.textScalarLimit
        )
        let truncations = result.snapshot.captureLimitations.filter {
            $0.code == "ios.capture.text-truncated"
        }
        XCTAssertFalse(truncations.isEmpty)
        XCTAssertTrue(truncations.contains(where: {
            $0.scope?.nodeID == labelNode.nodeID && $0.scope?.field == "content.text"
        }))
    }

    func testInvalidAccessibilityIdentifierRecordsAStableIDLimitation() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        let label = UILabel(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
        label.text = "Bounded"
        label.accessibilityIdentifier = "!not-a-stable-id"
        window.addSubview(label)

        let result = try makeAdapter().capture(
            windows: [window],
            includeScreenshot: false
        )

        let nodes = try XCTUnwrap(result.snapshot.trees.first?.payload.inlineNodes)
        let labelNode = try XCTUnwrap(nodes.first(where: { $0.role == "text" }))
        XCTAssertNil(labelNode.stableID)
        XCTAssertTrue(result.snapshot.captureLimitations.contains(where: {
            $0.code == "ios.capture.stable-id-invalid"
                && $0.scope?.nodeID == labelNode.nodeID
                && $0.scope?.field == "stable_id"
        }))
    }
}
#endif
