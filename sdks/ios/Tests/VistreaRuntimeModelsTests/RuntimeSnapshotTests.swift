import Foundation
import XCTest
@testable import VistreaRuntimeModels

final class RuntimeSnapshotTests: XCTestCase {
    func testDecodesAndReencodesCanonicalMinimalSnapshot() throws {
        let originalData = try fixtureData("runtime-snapshot/valid/minimal.json")
        let snapshot = try RuntimeSnapshotCodec.decode(originalData)

        let typedSnapshotID: SnapshotID = snapshot.snapshotID
        let typedProjectID: ProjectID = snapshot.runtimeContext.projectID
        let typedBuildID: BuildID = snapshot.runtimeContext.buildID
        let typedTreeID: TreeID = snapshot.trees[0].treeID

        XCTAssertEqual(typedSnapshotID.rawValue, "snapshot_019f0000-0000-7000-8000-000000000001")
        XCTAssertEqual(typedProjectID.rawValue, "project_019f0000-0000-7000-8000-000000000001")
        XCTAssertEqual(typedBuildID.rawValue, "build_019f0000-0000-7000-8000-000000000001")
        XCTAssertEqual(typedTreeID.rawValue, "tree_019f0000-0000-7000-8000-000000000001")
        XCTAssertEqual(snapshot.protocolVersion, try ProtocolVersion(minor: 0))
        XCTAssertEqual(snapshot.capturedAt.wallTime.rawValue, "2026-07-12T00:00:00Z")
        XCTAssertEqual(snapshot.runtimeContext.platform, .ios)
        XCTAssertEqual(snapshot.display.coordinateUnit, .logicalPoint)
        XCTAssertEqual(snapshot.display.logicalSize.width, 390)
        XCTAssertEqual(snapshot.trees[0].kind, .semantic)

        let node = try XCTUnwrap(snapshot.trees[0].payload.inlineNodes?.first)
        let typedNodeID: NodeID = node.nodeID
        let typedStableID: StableID = try XCTUnwrap(node.stableID)
        XCTAssertEqual(typedNodeID.rawValue, "node_019f0000-0000-7000-8000-000000000001")
        XCTAssertEqual(typedStableID.rawValue, "demo.home.root")
        XCTAssertEqual(node.nativeType, "UIView")
        XCTAssertEqual(node.role, "container")

        try assertSemanticRoundTrip(originalData: originalData, snapshot: snapshot)
    }

    func testDecodesAndReencodesCanonicalIOSUIKitSnapshot() throws {
        let originalData = try fixtureData("runtime-snapshot/valid/ios-uikit.json")
        let snapshot = try RuntimeSnapshotCodec.decode(originalData)

        XCTAssertEqual(snapshot.snapshotID.rawValue, "snapshot_019f0000-0000-7000-8000-000000000002")
        XCTAssertEqual(snapshot.runtimeContext.platform, .ios)
        XCTAssertEqual(snapshot.runtimeContext.device.deviceID?.rawValue, "device_019f0000-0000-7000-8000-000000000001")
        XCTAssertEqual(snapshot.trees[0].kind, .view)
        XCTAssertEqual(snapshot.screenshot?.object.mediaType, "image/png")
        XCTAssertEqual(snapshot.screenshot?.pixelSize.width.rawValue, 1_170)
        XCTAssertEqual(snapshot.eventWindow?.firstSequence?.rawValue, 1)

        let nodes = try XCTUnwrap(snapshot.trees[0].payload.inlineNodes)
        XCTAssertEqual(nodes.count, 2)
        XCTAssertEqual(nodes[1].stableID?.rawValue, "demo.home.open_catalog")
        XCTAssertEqual(nodes[1].actions, [.tap])
        XCTAssertEqual(nodes[1].sourceContext?.controller, "DemoHomeViewController")
        XCTAssertEqual(nodes[0].extensions["ios.uikit.window_level"], .integer(0))

        try assertSemanticRoundTrip(originalData: originalData, snapshot: snapshot)
    }

    func testPreservesArbitraryNamespacedJSONExtensionValues() throws {
        let data = try fixtureData("runtime-snapshot/valid/minimal.json")
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        object["extensions"] = [
            "com.example.roundtrip": [
                "null": NSNull(),
                "boolean": true,
                "integer": 42,
                "number": 1.25,
                "string": "preserved",
                "array": [NSNull(), false, 7, 2.5, "value"],
                "object": ["nested": ["enabled": true]],
            ],
        ]
        let extendedData = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])

        let snapshot = try RuntimeSnapshotCodec.decode(extendedData)
        let expected: JSONValue = .object([
            "null": .null,
            "boolean": .boolean(true),
            "integer": .integer(42),
            "number": .number(1.25),
            "string": .string("preserved"),
            "array": .array([.null, .boolean(false), .integer(7), .number(2.5), .string("value")]),
            "object": .object(["nested": .object(["enabled": .boolean(true)])]),
        ])
        XCTAssertEqual(snapshot.extensions["com.example.roundtrip"], expected)

        let encoded = try RuntimeSnapshotCodec.encode(snapshot)
        XCTAssertEqual(try RuntimeSnapshotCodec.decode(encoded), snapshot)
        XCTAssertEqual(try jsonObject(from: encoded), try jsonObject(from: extendedData))
    }

    func testPreservesCanonicalHigherMinorExtensions() throws {
        let originalData = try fixtureData("compatibility/higher-minor-snapshot.json")
        let snapshot = try RuntimeSnapshotCodec.decode(originalData)

        XCTAssertEqual(snapshot.protocolVersion.minor, 1)
        XCTAssertEqual(
            snapshot.extensions["dev.vistrea.future_snapshot"],
            .object(["enabled": .boolean(true)])
        )
        XCTAssertEqual(
            snapshot.trees[0].payload.inlineNodes?.first?.extensions["dev.vistrea.future_node"],
            .object(["value": .boolean(true)])
        )

        try assertSemanticRoundTrip(originalData: originalData, snapshot: snapshot)
    }

    func testStringLimitsCountUnicodeScalarsRatherThanUTF8Bytes() throws {
        let data = try fixtureData("runtime-snapshot/valid/minimal.json")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var context = try XCTUnwrap(object["runtime_context"] as? [String: Any])
        context["application_version"] = String(repeating: "界", count: 128)
        object["runtime_context"] = context
        let validData = try JSONSerialization.data(withJSONObject: object)

        let snapshot = try RuntimeSnapshotCodec.decode(validData)

        XCTAssertEqual(snapshot.runtimeContext.applicationVersion.unicodeScalars.count, 128)
    }

    func testRejectsSyntacticallyCanonicalButInvalidTimestamp() throws {
        let data = try fixtureData("runtime-snapshot/valid/minimal.json")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var capturedAt = try XCTUnwrap(object["captured_at"] as? [String: Any])
        capturedAt["wall_time"] = "2026-99-99T00:00:00Z"
        object["captured_at"] = capturedAt
        let invalidData = try JSONSerialization.data(withJSONObject: object)

        XCTAssertThrowsError(try RuntimeSnapshotCodec.decode(invalidData))
    }

    func testRejectsCanonicalUnknownTopLevelCoreFieldFixture() throws {
        let data = try fixtureData("runtime-snapshot/invalid/unknown-core-field.json")

        XCTAssertThrowsError(try RuntimeSnapshotCodec.decode(data)) { error in
            XCTAssertTrue(String(describing: error).contains("Unknown core field 'unexpected'"))
        }
    }

    func testRejectsUnknownNestedCoreField() throws {
        let data = try fixtureData("runtime-snapshot/valid/minimal.json")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var trees = try XCTUnwrap(object["trees"] as? [[String: Any]])
        var payload = try XCTUnwrap(trees[0]["payload"] as? [String: Any])
        var nodes = try XCTUnwrap(payload["inline_nodes"] as? [[String: Any]])
        nodes[0]["unexpected"] = true
        payload["inline_nodes"] = nodes
        trees[0]["payload"] = payload
        object["trees"] = trees
        let invalidData = try JSONSerialization.data(withJSONObject: object)

        XCTAssertThrowsError(try RuntimeSnapshotCodec.decode(invalidData)) { error in
            XCTAssertTrue(String(describing: error).contains("Unknown core field 'unexpected'"))
        }
    }

    func testRejectsUnnamespacedExtensionKey() throws {
        let data = try fixtureData("runtime-snapshot/valid/minimal.json")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object["extensions"] = ["plain": true]
        let invalidData = try JSONSerialization.data(withJSONObject: object)

        XCTAssertThrowsError(try RuntimeSnapshotCodec.decode(invalidData)) { error in
            XCTAssertTrue(String(describing: error).contains("Invalid namespaced key: plain"))
        }
    }

    private func assertSemanticRoundTrip(originalData: Data, snapshot: RuntimeSnapshot) throws {
        let encoded = try RuntimeSnapshotCodec.encode(snapshot, prettyPrinted: true)
        let decodedAgain = try RuntimeSnapshotCodec.decode(encoded)
        XCTAssertEqual(decodedAgain, snapshot)
        XCTAssertEqual(try jsonObject(from: encoded), try jsonObject(from: originalData))
    }

    private func jsonObject(from data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    private func fixtureData(_ relativePath: String) throws -> Data {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fileManager = FileManager.default

        while directory.path != "/" {
            let fixture = directory
                .appendingPathComponent("protocol/fixtures/v1", isDirectory: true)
                .appendingPathComponent(relativePath)
            if fileManager.fileExists(atPath: fixture.path) {
                return try Data(contentsOf: fixture)
            }
            directory.deleteLastPathComponent()
        }

        XCTFail("Unable to locate repository fixture: \(relativePath)")
        throw CocoaError(.fileNoSuchFile)
    }
}
