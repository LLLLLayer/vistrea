import Foundation
import VistreaRuntimeModels

public struct SnapshotListItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let capturedAt: String
    public let applicationID: String
    public let applicationVersion: String
    public let platform: String
    public let device: String

    public init(summary: SnapshotSummary) {
        id = summary.snapshotID.rawValue
        capturedAt = summary.capturedAt.wallTime.rawValue
        applicationID = summary.runtimeContext.applicationID
        applicationVersion = summary.runtimeContext.applicationVersion
        platform = summary.runtimeContext.platform.rawValue
        device = summary.runtimeContext.device.model
    }

    public init(snapshot: RuntimeSnapshot) {
        self.init(summary: SnapshotSummary(snapshot: snapshot))
    }
}

public struct DetailField: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        id = label
        self.label = label
        self.value = value
    }
}

public struct RectPresentation: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    init(_ rect: Rect) {
        x = rect.x
        y = rect.y
        width = rect.width
        height = rect.height
    }

    public var summary: String {
        "x \(Self.format(x)), y \(Self.format(y)), w \(Self.format(width)), h \(Self.format(height))"
    }

    private static func format(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2)))
    }
}

public struct NodePresentation: Identifiable, Equatable, Sendable {
    public let id: String
    public let stableID: String?
    public let nativeType: String
    public let role: String
    public let contentSummary: String?
    public let frame: RectPresentation?
    public let accessibilityLabel: String?
    public let actions: [String]
    public let fields: [DetailField]

    init(node: UiNode) {
        id = node.nodeID.rawValue
        stableID = node.stableID?.rawValue
        nativeType = node.nativeType
        role = node.role
        contentSummary = node.content.text
            ?? node.content.value
            ?? node.content.placeholder
            ?? node.content.contentDescription
        frame = node.frame.map(RectPresentation.init)
        accessibilityLabel = node.accessibility?.label
        actions = node.actions.map(\.rawValue)

        var result = [
            DetailField(label: "Node ID", value: node.nodeID.rawValue),
            DetailField(label: "Native type", value: node.nativeType),
            DetailField(label: "Role", value: node.role),
        ]
        if let stableID = node.stableID?.rawValue {
            result.insert(DetailField(label: "Stable ID", value: stableID), at: 1)
        }
        if let frame = node.frame {
            result.append(DetailField(label: "Frame", value: RectPresentation(frame).summary))
        }
        if let contentSummary {
            result.append(DetailField(label: "Content", value: contentSummary))
        }
        if !actions.isEmpty {
            result.append(DetailField(label: "Actions", value: actions.joined(separator: ", ")))
        }
        if let visible = node.state.visible {
            result.append(DetailField(label: "Visible", value: visible ? "Yes" : "No"))
        }
        if let enabled = node.state.enabled {
            result.append(DetailField(label: "Enabled", value: enabled ? "Yes" : "No"))
        }
        if let accessibilityLabel = node.accessibility?.label {
            result.append(DetailField(label: "Accessibility", value: accessibilityLabel))
        }
        if let route = node.sourceContext?.route {
            result.append(DetailField(label: "Route", value: route))
        }
        if let controller = node.sourceContext?.controller {
            result.append(DetailField(label: "Controller", value: controller))
        }
        if let component = node.sourceContext?.component {
            result.append(DetailField(label: "Component", value: component))
        }
        fields = result
    }

    public var outlineTitle: String {
        stableID ?? contentSummary ?? nativeType
    }
}

public struct UiTreeNode: Identifiable, Equatable, Sendable {
    public let presentation: NodePresentation
    public let children: [UiTreeNode]

    public var id: String { presentation.id }
    public var outlineChildren: [UiTreeNode]? { children.isEmpty ? nil : children }
}

public struct ObjectTreePresentation: Equatable, Sendable {
    public let hash: String
    public let mediaType: String
    public let nodeCount: UInt64
    public let encoding: String
}

public struct UiTreeProjection: Equatable, Sendable {
    public let kind: String
    public let roots: [UiTreeNode]
    public let nodesByID: [String: NodePresentation]
    public let objectPayload: ObjectTreePresentation?
}

public enum UiTreeProjectionError: Error, Equatable, Sendable {
    case duplicateNode(String)
    case missingRoot(String)
    case invalidRootParent(String)
    case danglingChild(parent: String, child: String)
    case parentMismatch(parent: String, child: String)
    case danglingParent(node: String, parent: String)
    case missingParentChildLink(node: String, parent: String)
    case cycleOrMultipleReachability(String)
    case disconnectedNodes([String])
    case missingTree
}

extension UiTreeProjectionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .duplicateNode(id): return "UI Tree contains duplicate node \(id)."
        case let .missingRoot(id): return "UI Tree root \(id) is missing."
        case let .invalidRootParent(id): return "UI Tree root \(id) declares a parent."
        case let .danglingChild(parent, child): return "Node \(parent) references missing child \(child)."
        case let .parentMismatch(parent, child): return "Node \(child) does not point back to parent \(parent)."
        case let .danglingParent(node, parent): return "Node \(node) references missing parent \(parent)."
        case let .missingParentChildLink(node, parent): return "Parent \(parent) does not reference child \(node)."
        case let .cycleOrMultipleReachability(id): return "UI Tree reaches node \(id) more than once."
        case let .disconnectedNodes(ids): return "UI Tree contains disconnected nodes: \(ids.joined(separator: ", "))."
        case .missingTree: return "Runtime Snapshot contains no displayable UI Tree."
        }
    }
}

public enum UiTreeProjector {
    public static func preferredProjection(from snapshot: RuntimeSnapshot) throws -> UiTreeProjection {
        let tree = snapshot.trees.first(where: { $0.kind == .view })
            ?? snapshot.trees.first(where: { $0.kind == .semantic })
            ?? snapshot.trees.first
        guard let tree else {
            throw UiTreeProjectionError.missingTree
        }
        return try project(tree)
    }

    public static func project(_ tree: UiTree) throws -> UiTreeProjection {
        switch tree.payload {
        case let .object(reference, nodeCount, encoding):
            return UiTreeProjection(
                kind: tree.kind.rawValue,
                roots: [],
                nodesByID: [:],
                objectPayload: ObjectTreePresentation(
                    hash: reference.hash,
                    mediaType: reference.mediaType,
                    nodeCount: nodeCount.rawValue,
                    encoding: encoding.rawValue
                )
            )
        case let .inline(nodes):
            return try projectInline(tree: tree, nodes: nodes)
        }
    }

    private static func projectInline(tree: UiTree, nodes: [UiNode]) throws -> UiTreeProjection {
        var nodesByID: [String: UiNode] = [:]
        for node in nodes {
            let id = node.nodeID.rawValue
            guard nodesByID.updateValue(node, forKey: id) == nil else {
                throw UiTreeProjectionError.duplicateNode(id)
            }
        }

        let rootIDs = tree.rootNodeIDs.map(\.rawValue)
        let rootSet = Set(rootIDs)
        for rootID in rootIDs {
            guard let root = nodesByID[rootID] else {
                throw UiTreeProjectionError.missingRoot(rootID)
            }
            guard root.parentID == nil else {
                throw UiTreeProjectionError.invalidRootParent(rootID)
            }
        }

        for node in nodes {
            let nodeID = node.nodeID.rawValue
            for childReference in node.childIDs {
                let childID = childReference.rawValue
                guard let child = nodesByID[childID] else {
                    throw UiTreeProjectionError.danglingChild(parent: nodeID, child: childID)
                }
                guard child.parentID?.rawValue == nodeID else {
                    throw UiTreeProjectionError.parentMismatch(parent: nodeID, child: childID)
                }
            }
            if let parentID = node.parentID?.rawValue {
                guard let parent = nodesByID[parentID] else {
                    throw UiTreeProjectionError.danglingParent(node: nodeID, parent: parentID)
                }
                guard parent.childIDs.contains(where: { $0.rawValue == nodeID }) else {
                    throw UiTreeProjectionError.missingParentChildLink(node: nodeID, parent: parentID)
                }
            } else if !rootSet.contains(nodeID) {
                throw UiTreeProjectionError.disconnectedNodes([nodeID])
            }
        }

        var traversal: [String] = []
        var visited = Set<String>()
        var stack = Array(rootIDs.reversed())
        while let nodeID = stack.popLast() {
            guard visited.insert(nodeID).inserted else {
                throw UiTreeProjectionError.cycleOrMultipleReachability(nodeID)
            }
            traversal.append(nodeID)
            guard let node = nodesByID[nodeID] else {
                throw UiTreeProjectionError.missingRoot(nodeID)
            }
            for child in node.childIDs.reversed() {
                stack.append(child.rawValue)
            }
        }

        if visited.count != nodes.count {
            let disconnected = Set(nodesByID.keys).subtracting(visited).sorted()
            throw UiTreeProjectionError.disconnectedNodes(disconnected)
        }

        let presentations = nodesByID.mapValues(NodePresentation.init(node:))
        var built: [String: UiTreeNode] = [:]
        for nodeID in traversal.reversed() {
            guard let node = nodesByID[nodeID], let presentation = presentations[nodeID] else {
                continue
            }
            let children = node.childIDs.compactMap { built[$0.rawValue] }
            built[nodeID] = UiTreeNode(presentation: presentation, children: children)
        }

        return UiTreeProjection(
            kind: tree.kind.rawValue,
            roots: rootIDs.compactMap { built[$0] },
            nodesByID: presentations,
            objectPayload: nil
        )
    }
}

public struct ScreenshotPresentation: Equatable, Sendable {
    public let hash: String
    public let mediaType: String
    public let byteSize: UInt64
    public let logicalName: String?
    public let pixelWidth: UInt64
    public let pixelHeight: UInt64

    init(_ evidence: ScreenshotEvidence) {
        hash = evidence.object.hash
        mediaType = evidence.object.mediaType
        byteSize = evidence.object.byteSize.rawValue
        logicalName = evidence.object.logicalName
        pixelWidth = evidence.pixelSize.width.rawValue
        pixelHeight = evidence.pixelSize.height.rawValue
    }
}

public struct SnapshotPresentation: Equatable, Sendable {
    public let id: String
    public let capturedAt: String
    public let applicationID: String
    public let applicationVersion: String
    public let buildID: String
    public let sourceGitSHA: String?
    public let device: String
    public let platform: String
    public let environment: String
    public let screenshot: ScreenshotPresentation?
    public let tree: UiTreeProjection

    public init(snapshot: RuntimeSnapshot) throws {
        id = snapshot.snapshotID.rawValue
        capturedAt = snapshot.capturedAt.wallTime.rawValue
        applicationID = snapshot.runtimeContext.applicationID
        applicationVersion = snapshot.runtimeContext.applicationVersion
        buildID = snapshot.runtimeContext.buildID.rawValue
        sourceGitSHA = snapshot.runtimeContext.sourceGitSHA
        device = "\(snapshot.runtimeContext.device.model) · \(snapshot.runtimeContext.device.osVersion)"
        platform = snapshot.runtimeContext.platform.rawValue
        environment = snapshot.runtimeContext.environmentID
        screenshot = snapshot.screenshot.map(ScreenshotPresentation.init)
        tree = try UiTreeProjector.preferredProjection(from: snapshot)
    }
}
