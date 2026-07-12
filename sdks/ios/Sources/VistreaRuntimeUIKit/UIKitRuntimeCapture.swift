#if canImport(UIKit)
import CryptoKit
import Foundation
import UIKit
import VistreaRuntimeModels

public struct UIKitRuntimeCaptureConfiguration: Sendable {
    public let projectID: ProjectID
    public let buildID: BuildID
    public let deviceID: DeviceID?
    public let environmentID: String
    public let accountProfileID: String?
    public let featureContextRefs: [String]?
    public let sdkVersion: String
    public let adapterVersion: String

    public init(
        projectID: ProjectID,
        buildID: BuildID,
        deviceID: DeviceID? = nil,
        environmentID: String = "local",
        accountProfileID: String? = nil,
        featureContextRefs: [String]? = nil,
        sdkVersion: String,
        adapterVersion: String
    ) {
        self.projectID = projectID
        self.buildID = buildID
        self.deviceID = deviceID
        self.environmentID = environmentID
        self.accountProfileID = accountProfileID
        self.featureContextRefs = featureContextRefs
        self.sdkVersion = sdkVersion
        self.adapterVersion = adapterVersion
    }
}

public struct CapturedRuntimeObject: Sendable {
    public let reference: ObjectReference
    public let bytes: Data

    public init(reference: ObjectReference, bytes: Data) {
        self.reference = reference
        self.bytes = bytes
    }
}

public struct UIKitRuntimeCaptureResult: Sendable {
    public let snapshot: RuntimeSnapshot
    public let objects: [CapturedRuntimeObject]

    public init(snapshot: RuntimeSnapshot, objects: [CapturedRuntimeObject]) {
        self.snapshot = snapshot
        self.objects = objects
    }
}

public enum UIKitRuntimeCaptureError: Error, Equatable, Sendable {
    case noVisibleWindow
    case emptyDisplay
    case screenshotEncodingFailed
}

/// Captures UIKit state without invoking application business methods.
///
/// The adapter observes the real view hierarchy on the main actor and returns
/// the canonical Runtime Snapshot model plus encoded object bytes. Transport
/// and persistence remain separate responsibilities.
@MainActor
public final class UIKitRuntimeCaptureAdapter {
    private let configuration: UIKitRuntimeCaptureConfiguration

    public init(configuration: UIKitRuntimeCaptureConfiguration) {
        self.configuration = configuration
    }

    public func capture(
        windows: [UIWindow],
        scenarioID: String? = nil,
        includeScreenshot: Bool = true
    ) throws -> UIKitRuntimeCaptureResult {
        guard let window = Self.captureWindow(from: windows) else {
            throw UIKitRuntimeCaptureError.noVisibleWindow
        }
        guard window.bounds.width > 0, window.bounds.height > 0 else {
            throw UIKitRuntimeCaptureError.emptyDisplay
        }

        let snapshotRawID = RuntimeIdentifierFactory.make(prefix: "snapshot")
        let snapshotID = try SnapshotID(validating: snapshotRawID)
        let treeID = try TreeID(
            validating: RuntimeIdentifierFactory.deterministic(
                prefix: "tree",
                seed: "\(snapshotRawID):view-tree"
            )
        )
        let treeCapturedDate = Date()
        let capturedAt = try Self.eventTime(treeCapturedDate)
        let hierarchy = try captureHierarchy(window: window, treeID: treeID, snapshotID: snapshotRawID)
        let screenshotResult = try includeScreenshot ? captureScreenshot(window: window) : nil
        let display = try captureDisplay(window: window, screenshot: screenshotResult)
        let context = try captureRuntimeContext(window: window, scenarioID: scenarioID)
        let tree = try UiTree(
            treeID: treeID,
            kind: .view,
            rootNodeIDs: [hierarchy.rootNodeID],
            payload: .inline(nodes: hierarchy.nodes),
            captureLimitations: []
        )

        let screenshotEvidence: ScreenshotEvidence?
        let capturedObjects: [CapturedRuntimeObject]
        if let screenshotResult {
            let midpoint = screenshotResult.startedAt.addingTimeInterval(
                screenshotResult.finishedAt.timeIntervalSince(screenshotResult.startedAt) / 2
            )
            screenshotEvidence = try ScreenshotEvidence(
                object: screenshotResult.object.reference,
                captureStartedAt: Self.eventTime(screenshotResult.startedAt),
                captureFinishedAt: Self.eventTime(screenshotResult.finishedAt),
                treeSkewMilliseconds: abs(treeCapturedDate.timeIntervalSince(midpoint) * 1_000),
                coverage: NonEmptyRect(
                    x: 0,
                    y: 0,
                    width: window.bounds.width,
                    height: window.bounds.height
                ),
                pixelSize: screenshotResult.pixelSize,
                systemChrome: .excluded,
                colorSpace: .sRGB
            )
            capturedObjects = [screenshotResult.object]
        } else {
            screenshotEvidence = nil
            capturedObjects = []
        }

        let snapshotExtensions = try scenarioID.map {
            try Extensions(["vistrea.scenario_id": .string($0)])
        } ?? .empty
        let snapshot = try RuntimeSnapshot(
            snapshotID: snapshotID,
            protocolVersion: ProtocolVersion(minor: 0),
            capturedAt: capturedAt,
            runtimeContext: context,
            display: display,
            trees: [tree],
            screenshot: screenshotEvidence,
            capabilities: CapabilitySet(
                names: ["runtime.connection", "runtime.snapshot"]
            ),
            captureLimitations: [],
            extensions: snapshotExtensions
        )
        return UIKitRuntimeCaptureResult(snapshot: snapshot, objects: capturedObjects)
    }

    private static func captureWindow(from windows: [UIWindow]) -> UIWindow? {
        windows
            .filter { !$0.isHidden && $0.alpha > 0 && $0.windowLevel == .normal }
            .sorted { left, right in
                if left.isKeyWindow != right.isKeyWindow {
                    return left.isKeyWindow
                }
                return left.bounds.width * left.bounds.height > right.bounds.width * right.bounds.height
            }
            .first
    }

    private func captureRuntimeContext(
        window: UIWindow,
        scenarioID: String?
    ) throws -> RuntimeContext {
        let bundle = Bundle.main
        let applicationID = bundle.bundleIdentifier ?? "dev.vistrea.unknown"
        let applicationVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "0.0.0"
        let locale = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        let interfaceStyle = window.traitCollection.userInterfaceStyle
        let theme: RuntimeTheme = interfaceStyle == .dark ? .dark : .light
        let deviceKind: DeviceKind = ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] == nil
            ? .realDevice
            : .simulator
        let model = ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"]
            ?? UIDevice.current.model

        return try RuntimeContext(
            projectID: configuration.projectID,
            applicationID: applicationID,
            buildID: configuration.buildID,
            applicationVersion: applicationVersion,
            sourceGitSHA: Self.validGitSHA(
                ProcessInfo.processInfo.environment["VISTREA_SOURCE_GIT_SHA"]
            ),
            platform: .ios,
            device: DeviceDescriptor(
                deviceID: configuration.deviceID,
                kind: deviceKind,
                model: model,
                osVersion: UIDevice.current.systemVersion
            ),
            environmentID: configuration.environmentID,
            accountProfileID: configuration.accountProfileID,
            featureContextRefs: configuration.featureContextRefs ?? scenarioID.map { [$0] },
            locale: locale,
            theme: theme,
            textScale: Double(UIFontMetrics.default.scaledValue(for: 1)),
            sdkVersion: configuration.sdkVersion,
            adapterVersions: ["uikit": configuration.adapterVersion]
        )
    }

    private func captureDisplay(
        window: UIWindow,
        screenshot: ScreenshotResult?
    ) throws -> DisplayGeometry {
        let scale = window.screen.scale
        let pixelSize = try screenshot?.pixelSize ?? PixelSize(
            width: JSONSafePositiveUInt(validating: UInt64((window.bounds.width * scale).rounded())),
            height: JSONSafePositiveUInt(validating: UInt64((window.bounds.height * scale).rounded()))
        )
        let safeArea = window.safeAreaInsets
        return try DisplayGeometry(
            logicalSize: Size(width: window.bounds.width, height: window.bounds.height),
            pixelSize: pixelSize,
            pixelScaleX: Double(pixelSize.width.rawValue) / window.bounds.width,
            pixelScaleY: Double(pixelSize.height.rawValue) / window.bounds.height,
            orientation: Self.orientation(window.windowScene?.interfaceOrientation),
            safeArea: Insets(
                top: safeArea.top,
                left: safeArea.left,
                bottom: safeArea.bottom,
                right: safeArea.right
            ),
            geometryRevision: "uikit-\(Int(window.bounds.width))x\(Int(window.bounds.height))-\(Int(scale * 100))"
        )
    }

    private func captureScreenshot(window: UIWindow) throws -> ScreenshotResult {
        let startedAt = Date()
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = window.screen.scale
        format.opaque = window.isOpaque
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard let bytes = image.pngData(), let cgImage = image.cgImage else {
            throw UIKitRuntimeCaptureError.screenshotEncodingFailed
        }
        let finishedAt = Date()
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let reference = try ObjectReference(
            hash: "sha256:\(digest)",
            mediaType: "image/png",
            byteSize: JSONSafeUInt(validating: UInt64(bytes.count)),
            compression: .none,
            logicalName: "runtime-snapshot.png"
        )
        return try ScreenshotResult(
            object: CapturedRuntimeObject(reference: reference, bytes: bytes),
            pixelSize: PixelSize(
                width: JSONSafePositiveUInt(validating: UInt64(cgImage.width)),
                height: JSONSafePositiveUInt(validating: UInt64(cgImage.height))
            ),
            startedAt: startedAt,
            finishedAt: finishedAt
        )
    }

    private func captureHierarchy(
        window: UIWindow,
        treeID: TreeID,
        snapshotID: String
    ) throws -> HierarchyResult {
        var orderedViews: [(view: UIView, path: String, parentPath: String?)] = []
        var stack: [(view: UIView, path: String, parentPath: String?)] = [(window, "0", nil)]
        while let current = stack.popLast() {
            orderedViews.append(current)
            for (index, child) in current.view.subviews.enumerated().reversed() {
                stack.append((child, "\(current.path).\(index)", current.path))
            }
        }

        var idsByPath: [String: NodeID] = [:]
        for item in orderedViews {
            let stableSeed = Self.stableIdentifier(for: item.view) ?? item.path
            idsByPath[item.path] = try NodeID(
                validating: RuntimeIdentifierFactory.deterministic(
                    prefix: "node",
                    seed: "\(snapshotID):\(stableSeed):\(item.path)"
                )
            )
        }

        var nodes: [UiNode] = []
        nodes.reserveCapacity(orderedViews.count)
        for item in orderedViews {
            guard let nodeID = idsByPath[item.path] else {
                continue
            }
            let parentID = item.parentPath.flatMap { idsByPath[$0] }
            let childIDs = item.view.subviews.indices.compactMap {
                idsByPath["\(item.path).\($0)"]
            }
            nodes.append(
                try captureNode(
                    view: item.view,
                    window: window,
                    treeID: treeID,
                    nodeID: nodeID,
                    parentID: parentID,
                    childIDs: childIDs
                )
            )
        }
        guard let rootNodeID = idsByPath["0"] else {
            throw UIKitRuntimeCaptureError.noVisibleWindow
        }
        return HierarchyResult(rootNodeID: rootNodeID, nodes: nodes)
    }

    private func captureNode(
        view: UIView,
        window: UIWindow,
        treeID: TreeID,
        nodeID: NodeID,
        parentID: NodeID?,
        childIDs: [NodeID]
    ) throws -> UiNode {
        let frame = view.convert(view.bounds, to: window)
        let displayBounds = window.bounds
        let visibleFrame = frame.intersection(displayBounds)
        let control = view as? UIControl
        let role = Self.role(for: view)
        let content = try Self.content(for: view)
        let stableID = Self.stableIdentifier(for: view).flatMap { try? StableID(validating: $0) }
        let accessibility = try AccessibilityProperties(
            label: view.accessibilityLabel,
            value: view.accessibilityValue,
            role: role,
            hidden: view.accessibilityElementsHidden
        )
        let sourceContext = try SourceContext(
            controller: Self.owningViewController(for: view).map { String(reflecting: type(of: $0)) },
            component: String(reflecting: type(of: view))
        )

        return try UiNode(
            nodeID: nodeID,
            stableID: stableID,
            parentID: parentID,
            childIDs: childIDs,
            nativeType: String(reflecting: type(of: view)),
            role: role,
            frame: Self.protocolRect(frame),
            visibleRect: visibleFrame.isNull ? nil : Self.protocolRect(visibleFrame),
            hitRect: view.isUserInteractionEnabled ? Self.protocolRect(frame) : nil,
            bounds: Self.protocolRect(view.bounds),
            zIndex: Double(view.layer.zPosition),
            clipped: view.clipsToBounds,
            content: content,
            state: NodeState(
                visible: !view.isHidden && view.alpha > 0 && !visibleFrame.isNull,
                enabled: control?.isEnabled ?? view.isUserInteractionEnabled,
                selected: control?.isSelected,
                focused: view.isFirstResponder
            ),
            actions: Self.actions(for: view),
            visual: VisualProperties(
                alpha: Double(view.alpha),
                cornerRadius: Double(view.layer.cornerRadius),
                borderWidth: Double(view.layer.borderWidth)
            ),
            accessibility: accessibility,
            sourceContext: sourceContext,
            relatedNodes: [],
            captureLimitations: [],
            extensions: view === window
                ? try Extensions(["ios.uikit.window_level": .number(Double(window.windowLevel.rawValue))])
                : .empty
        )
    }

    private static func content(for view: UIView) throws -> TextContent {
        if let field = view as? UITextField {
            if field.isSecureTextEntry {
                return try TextContent(
                    placeholder: field.placeholder,
                    redactedFields: [.text, .value]
                )
            }
            return try TextContent(text: field.text, value: field.text, placeholder: field.placeholder)
        }
        if let textView = view as? UITextView {
            return try TextContent(text: textView.text, value: textView.text)
        }
        if let label = view as? UILabel {
            return try TextContent(text: label.text)
        }
        if let button = view as? UIButton {
            return try TextContent(text: button.title(for: button.state))
        }
        return try TextContent(contentDescription: view.accessibilityLabel)
    }

    private static func role(for view: UIView) -> String {
        switch view {
        case is UIWindow: "window"
        case is UIButton: "button"
        case is UITextField: "text-field"
        case is UITextView: "text-area"
        case is UILabel: "text"
        case is UIImageView: "image"
        case is UITableViewCell, is UICollectionViewCell: "list-item"
        case is UITableView, is UICollectionView: "list"
        case is UIScrollView: "scroll-view"
        case is UINavigationBar: "navigation-bar"
        default: traitRole(for: view) ?? "container"
        }
    }

    /// Hosted content (SwiftUI in particular) renders through private view
    /// classes; declared accessibility traits still carry the semantic role.
    private static func traitRole(for view: UIView) -> String? {
        let traits = view.accessibilityTraits
        if traits.contains(.button) {
            return "button"
        }
        if traits.contains(.header) {
            return "header"
        }
        if traits.contains(.link) {
            return "link"
        }
        if traits.contains(.image) {
            return "image"
        }
        if traits.contains(.staticText) {
            return "text"
        }
        if traits.contains(.searchField) {
            return "text-field"
        }
        return nil
    }

    private static func actions(for view: UIView) -> [UiAction] {
        if view is UITextField || view is UITextView {
            return [.tap, .typeText, .clearText]
        }
        if view is UIScrollView {
            return [.swipe, .scroll]
        }
        if view is UIControl || view.isAccessibilityElement {
            return [.tap]
        }
        return []
    }

    private static func stableIdentifier(for view: UIView) -> String? {
        guard let identifier = view.accessibilityIdentifier, !identifier.isEmpty else {
            return nil
        }
        return identifier
    }

    private static func owningViewController(for view: UIView) -> UIViewController? {
        var responder: UIResponder? = view
        while let current = responder {
            if let controller = current as? UIViewController {
                return controller
            }
            responder = current.next
        }
        return nil
    }

    private static func protocolRect(_ rect: CGRect) -> Rect? {
        guard [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy(\.isFinite),
              rect.width >= 0,
              rect.height >= 0
        else {
            return nil
        }
        return try? Rect(
            x: Double(rect.origin.x),
            y: Double(rect.origin.y),
            width: Double(rect.width),
            height: Double(rect.height)
        )
    }

    private static func orientation(_ orientation: UIInterfaceOrientation?) -> DisplayOrientation {
        switch orientation {
        case .landscapeLeft: .landscapeLeft
        case .landscapeRight: .landscapeRight
        case .portraitUpsideDown: .portraitUpsideDown
        default: .portrait
        }
    }

    private static func eventTime(_ date: Date) throws -> EventTime {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return EventTime(wallTime: try Timestamp(validating: formatter.string(from: date)))
    }

    private static func validGitSHA(_ value: String?) -> String? {
        guard let value,
              value.range(of: "^[0-9a-f]{40}([0-9a-f]{24})?$", options: .regularExpression) != nil
        else {
            return nil
        }
        return value
    }
}

private struct HierarchyResult {
    let rootNodeID: NodeID
    let nodes: [UiNode]
}

private struct ScreenshotResult {
    let object: CapturedRuntimeObject
    let pixelSize: PixelSize
    let startedAt: Date
    let finishedAt: Date
}

#endif
