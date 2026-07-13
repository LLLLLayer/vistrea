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

    func testContainerViewCapturesNonViewAccessibilityElementsAsChildNodes() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        let container = UIView(frame: CGRect(x: 20, y: 100, width: 350, height: 200))
        window.addSubview(container)

        let submit = UIAccessibilityElement(accessibilityContainer: container)
        submit.accessibilityLabel = "Submit"
        submit.accessibilityTraits = .button
        submit.accessibilityIdentifier = "submit-button"
        submit.accessibilityFrame = CGRect(x: 40, y: 120, width: 120, height: 44)

        let total = UIAccessibilityElement(accessibilityContainer: container)
        total.accessibilityLabel = "Total 42"
        total.accessibilityTraits = .staticText
        total.accessibilityFrame = CGRect(x: 40, y: 180, width: 200, height: 24)

        container.accessibilityElements = [submit, total]

        let result = try makeAdapter().capture(windows: [window], includeScreenshot: false)
        let nodes = try XCTUnwrap(result.snapshot.trees.first?.payload.inlineNodes)

        let containerNode = try XCTUnwrap(nodes.first(where: {
            $0.extensions["ios.capture.semantics_source"] == .string("accessibility")
        }))
        XCTAssertEqual(containerNode.childIDs.count, 2)

        let submitNode = try XCTUnwrap(nodes.first(where: { $0.nodeID == containerNode.childIDs[0] }))
        XCTAssertEqual(submitNode.parentID, containerNode.nodeID)
        XCTAssertEqual(submitNode.role, "button")
        XCTAssertEqual(submitNode.stableID?.rawValue, "submit-button")
        XCTAssertEqual(submitNode.frame, try Rect(x: 40, y: 120, width: 120, height: 44))
        XCTAssertEqual(submitNode.hitRect, submitNode.frame)
        XCTAssertEqual(submitNode.actions, [.tap])
        XCTAssertEqual(submitNode.content.text, "Submit")
        XCTAssertEqual(submitNode.accessibility?.label, "Submit")
        XCTAssertEqual(submitNode.accessibility?.role, "button")
        XCTAssertEqual(submitNode.state.visible, true)
        XCTAssertEqual(submitNode.state.enabled, true)
        XCTAssertTrue(submitNode.nativeType.contains("UIAccessibilityElement"))

        let totalNode = try XCTUnwrap(nodes.first(where: { $0.nodeID == containerNode.childIDs[1] }))
        XCTAssertEqual(totalNode.parentID, containerNode.nodeID)
        XCTAssertEqual(totalNode.role, "text")
        XCTAssertNil(totalNode.stableID)
        XCTAssertEqual(totalNode.frame, try Rect(x: 40, y: 180, width: 200, height: 24))
        XCTAssertNil(totalNode.hitRect)
        XCTAssertEqual(totalNode.actions, [])
        XCTAssertEqual(totalNode.content.text, "Total 42")
        XCTAssertEqual(totalNode.accessibility?.role, "text")

        // Deterministic IDs come from the same factory as view nodes and
        // stay unique across the whole tree.
        XCTAssertEqual(Set(nodes.map(\.nodeID)).count, nodes.count)
    }

    func testNestedElementContainersCaptureBoundedWithACycleGuard() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        let container = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
        window.addSubview(container)

        let group = UIAccessibilityElement(accessibilityContainer: container)
        group.isAccessibilityElement = false
        group.accessibilityFrame = CGRect(x: 10, y: 10, width: 300, height: 100)

        let leaf = UIAccessibilityElement(accessibilityContainer: group)
        leaf.accessibilityLabel = "Nested"
        leaf.accessibilityTraits = .staticText
        leaf.accessibilityFrame = CGRect(x: 20, y: 20, width: 100, height: 30)

        // The self-reference forms a container cycle the walker must survive.
        group.accessibilityElements = [leaf, group]
        container.accessibilityElements = [group]

        let result = try makeAdapter().capture(windows: [window], includeScreenshot: false)
        let nodes = try XCTUnwrap(result.snapshot.trees.first?.payload.inlineNodes)

        let containerNode = try XCTUnwrap(nodes.first(where: {
            $0.extensions["ios.capture.semantics_source"] == .string("accessibility")
        }))
        XCTAssertEqual(containerNode.childIDs.count, 1)
        let groupNode = try XCTUnwrap(nodes.first(where: { $0.nodeID == containerNode.childIDs[0] }))
        XCTAssertEqual(groupNode.role, "container")
        XCTAssertEqual(groupNode.childIDs.count, 1)
        let leafNode = try XCTUnwrap(nodes.first(where: { $0.nodeID == groupNode.childIDs[0] }))
        XCTAssertEqual(leafNode.parentID, groupNode.nodeID)
        XCTAssertEqual(leafNode.role, "text")
        XCTAssertEqual(leafNode.content.text, "Nested")

        // The cycle is reported as an explicit omission, not silence.
        XCTAssertTrue(result.snapshot.captureLimitations.contains(where: {
            $0.code == "ios.capture.accessibility-elements-omitted"
                && $0.scope?.nodeID == groupNode.nodeID
        }))
    }

    func testElementWithInvalidIdentifierOmitsStableIDAndRecordsALimitation() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        let container = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
        window.addSubview(container)

        let element = UIAccessibilityElement(accessibilityContainer: container)
        element.accessibilityLabel = "Broken"
        element.accessibilityTraits = .button
        element.accessibilityIdentifier = "!not-a-stable-id"
        element.accessibilityFrame = CGRect(x: 10, y: 10, width: 100, height: 40)
        container.accessibilityElements = [element]

        let result = try makeAdapter().capture(windows: [window], includeScreenshot: false)
        let nodes = try XCTUnwrap(result.snapshot.trees.first?.payload.inlineNodes)
        let elementNode = try XCTUnwrap(nodes.first(where: {
            $0.nativeType.contains("UIAccessibilityElement")
        }))
        XCTAssertNil(elementNode.stableID)
        XCTAssertTrue(result.snapshot.captureLimitations.contains(where: {
            $0.code == "ios.capture.stable-id-invalid"
                && $0.scope?.nodeID == elementNode.nodeID
                && $0.scope?.field == "stable_id"
        }))
    }

    func testPlainUIKitViewsGainNoSynthesizedElementChildren() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        let button = UIButton(frame: CGRect(x: 20, y: 100, width: 120, height: 44))
        button.setTitle("Native", for: .normal)
        window.addSubview(button)
        // A container that only reorders its real subviews through
        // accessibilityElements must not produce synthesized nodes either.
        let reordering = UIView(frame: CGRect(x: 0, y: 200, width: 390, height: 100))
        let child = UILabel(frame: CGRect(x: 0, y: 0, width: 100, height: 30))
        child.text = "Real subview"
        reordering.addSubview(child)
        reordering.accessibilityElements = [child]
        window.addSubview(reordering)

        let result = try makeAdapter().capture(windows: [window], includeScreenshot: false)
        let nodes = try XCTUnwrap(result.snapshot.trees.first?.payload.inlineNodes)

        XCTAssertFalse(nodes.contains(where: {
            $0.extensions["ios.capture.semantics_source"] != nil
        }))
        XCTAssertFalse(nodes.contains(where: {
            $0.nativeType.contains("UIAccessibilityElement")
        }))
        // Every captured node still corresponds to a real UIView.
        XCTAssertTrue(nodes.contains(where: { $0.role == "button" }))
        XCTAssertTrue(nodes.contains(where: { $0.content.text == "Real subview" }))
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

#if canImport(SwiftUI)
import SwiftUI
import VistreaRuntimeSwiftUI

/// Verifies against real SwiftUI (not fakes) that a hosting view exposes its
/// content as non-view accessibility elements the adapter synthesizes into
/// per-element child nodes, and that the `vistreaSemantics` bridge
/// round-trips stable identity and role through that path.
///
/// SwiftUI builds its accessibility node tree only while the app-level
/// accessibility runtime is active — the state that VoiceOver, the
/// Accessibility Inspector, and XCUITest/WebDriverAgent automation sessions
/// establish. The test flips the same persistent simulator runtime flag
/// those harnesses use and always restores the prior state. The toggle
/// stays strictly inside this test bundle; the SDK itself only observes.
@MainActor
final class SwiftUIHostingCaptureTests: XCTestCase {
    private typealias AXSetEnabled = @convention(c) (Bool) -> Void
    private typealias AXGetEnabled = @convention(c) () -> Bool

    private static let axRuntime: (set: AXSetEnabled, get: AXGetEnabled)? = {
        guard let handle = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let setSymbol = dlsym(handle, "_AXSApplicationAccessibilitySetEnabled"),
              let getSymbol = dlsym(handle, "_AXSApplicationAccessibilityEnabled")
        else {
            return nil
        }
        return (
            set: unsafeBitCast(setSymbol, to: AXSetEnabled.self),
            get: unsafeBitCast(getSymbol, to: AXGetEnabled.self)
        )
    }()

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

    private struct HostedScenario: View {
        var body: some View {
            VStack(spacing: 16) {
                Button("Submit") {}
                    .vistreaSemantics(stableID: "hosted-submit", role: .button)
                Text("Hosted Total")
            }
        }
    }

    func testHostedSwiftUIContentCapturesPerElementChildNodes() throws {
        guard let axRuntime = Self.axRuntime else {
            throw XCTSkip("The simulator accessibility runtime toggle is unavailable in this environment.")
        }
        let wasEnabled = axRuntime.get()
        defer { axRuntime.set(wasEnabled) }

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let host = UIHostingController(rootView: HostedScenario())
        window.rootViewController = host
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        host.view.layoutIfNeeded()
        // Let SwiftUI finish its render pass.
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))

        let adapter = try makeAdapter()
        // The persistent preference can lag the live accessibility cache
        // (they resync on simulator reboot), so probe the effective state
        // through the hosting view itself before asserting the dormant
        // degradation: no exposed elements must mean no synthesized nodes.
        let dormantExposure = host.view.accessibilityElementCount() > 0
            || host.view.accessibilityElements?.isEmpty == false
        if !wasEnabled, !dormantExposure {
            // Honest partial: with the accessibility runtime dormant the
            // hosting view exposes no elements, so the capture degrades to
            // the opaque container exactly as before this capability.
            let dormant = try adapter.capture(windows: [window], includeScreenshot: false)
            let dormantNodes = try XCTUnwrap(dormant.snapshot.trees.first?.payload.inlineNodes)
            XCTAssertFalse(dormantNodes.contains(where: {
                $0.extensions["ios.capture.semantics_source"] != nil
            }))
        }

        axRuntime.set(true)
        // Let SwiftUI build its accessibility node tree.
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))

        let result = try adapter.capture(windows: [window], includeScreenshot: false)
        let nodes = try XCTUnwrap(result.snapshot.trees.first?.payload.inlineNodes)

        let submitNode = try XCTUnwrap(
            nodes.first(where: { $0.stableID?.rawValue == "hosted-submit" }),
            "SwiftUI hosting view exposed no element with the bridged stable ID; captured native types: \(Set(nodes.map(\.nativeType)).sorted())"
        )
        XCTAssertFalse(submitNode.nativeType.contains("UIView"))
        XCTAssertEqual(submitNode.role, "button")
        XCTAssertEqual(submitNode.actions, [.tap])
        XCTAssertEqual(submitNode.accessibility?.label, "Submit")
        let submitFrame = try XCTUnwrap(submitNode.frame)
        XCTAssertGreaterThan(submitFrame.width, 0)
        XCTAssertGreaterThan(submitFrame.height, 0)
        // The frame must land in the same logical window space view frames use.
        XCTAssertTrue(submitFrame.x >= 0 && submitFrame.x + submitFrame.width <= 390)
        XCTAssertTrue(submitFrame.y >= 0 && submitFrame.y + submitFrame.height <= 844)

        let textNode = try XCTUnwrap(
            nodes.first(where: { $0.accessibility?.label == "Hosted Total" }),
            "SwiftUI hosting view exposed no element for the plain Text view"
        )
        XCTAssertEqual(textNode.role, "text")
        XCTAssertEqual(textNode.content.text, "Hosted Total")

        // Provenance: some ancestor view node explicitly records that these
        // children came from the accessibility tree.
        let hostingNode = try XCTUnwrap(nodes.first(where: {
            $0.extensions["ios.capture.semantics_source"] == .string("accessibility")
        }))
        var ancestorIDs: Set<NodeID> = []
        var cursor: NodeID? = submitNode.parentID
        while let current = cursor, ancestorIDs.insert(current).inserted {
            cursor = nodes.first(where: { $0.nodeID == current })?.parentID
        }
        XCTAssertTrue(ancestorIDs.contains(hostingNode.nodeID))
    }
}
#endif
#endif
