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

public struct EventListItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let sequence: UInt64
    public let kind: String
    public let stableID: String?
    public let wallTime: String
    public let summary: String?
    public let eventEpochID: String

    public init(event: RuntimeEvent) {
        id = event.eventID.rawValue
        sequence = event.sequence.rawValue
        kind = event.kind.rawValue
        stableID = event.stableID?.rawValue
        wallTime = event.time.wallTime.rawValue
        if case let .string(text)? = event.payload?["text"] {
            summary = text
        } else {
            summary = nil
        }
        eventEpochID = event.eventEpochID.rawValue
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

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
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
    /// The captured visual alpha, when the Runtime reported one.
    public let alpha: Double?
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
        alpha = node.visual?.alpha

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
        if let alpha = node.visual?.alpha {
            result.append(
                DetailField(label: "Alpha", value: alpha.formatted(.number.precision(.fractionLength(0...2))))
            )
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
    public let treeID: String
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
                treeID: tree.treeID.rawValue,
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
            treeID: tree.treeID.rawValue,
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
    /// The logical-point region the screenshot covers. Overlays convert
    /// logical frames into image coordinates through this rect: the pixel
    /// scale is `pixelWidth / coverage.width`.
    public let coverage: RectPresentation

    init(_ evidence: ScreenshotEvidence) {
        hash = evidence.object.hash
        mediaType = evidence.object.mediaType
        byteSize = evidence.object.byteSize.rawValue
        logicalName = evidence.object.logicalName
        pixelWidth = evidence.pixelSize.width.rawValue
        pixelHeight = evidence.pixelSize.height.rawValue
        coverage = RectPresentation(
            x: evidence.coverage.x,
            y: evidence.coverage.y,
            width: evidence.coverage.width,
            height: evidence.coverage.height
        )
    }
}

public struct SnapshotPresentation: Equatable, Sendable {
    public let id: String
    public let scenarioID: String?
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
        if case let .string(value) = snapshot.extensions["vistrea.scenario_id"] {
            scenarioID = value
        } else {
            scenarioID = nil
        }
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

/// One UI layer positioned for the 3D Inspector: logical frame plus depth.
public struct LayerBox3D: Equatable, Sendable, Identifiable {
    public let nodeID: String
    public let title: String
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public let depth: Int
    public let isInteractive: Bool

    public var id: String { nodeID }

    public init(
        nodeID: String,
        title: String,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        depth: Int,
        isInteractive: Bool
    ) {
        self.nodeID = nodeID
        self.title = title
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.depth = depth
        self.isInteractive = isInteractive
    }
}

/// Projects the captured tree into depth-ordered 3D layers. The hierarchy
/// depth is the z axis; geometry stays in logical points.
public enum LayerProjection {
    public static func boxes(from tree: UiTreeProjection) -> [LayerBox3D] {
        var result: [LayerBox3D] = []
        for root in tree.roots {
            append(node: root, depth: 0, into: &result)
        }
        return result
    }

    private static func append(node: UiTreeNode, depth: Int, into result: inout [LayerBox3D]) {
        if let frame = node.presentation.frame, frame.width > 0, frame.height > 0 {
            result.append(
                LayerBox3D(
                    nodeID: node.presentation.id,
                    title: node.presentation.outlineTitle,
                    x: frame.x,
                    y: frame.y,
                    width: frame.width,
                    height: frame.height,
                    depth: depth,
                    isInteractive: !node.presentation.actions.isEmpty
                )
            )
        }
        for child in node.children {
            append(node: child, depth: depth + 1, into: &result)
        }
    }
}

/// Deterministic layered layout for the Screen State Canvas: entry states in
/// the first column, then breadth-first depth columns, unreachable states last.
public enum CanvasLayout {
    public struct PositionedState: Equatable, Sendable, Identifiable {
        public let state: CanvasStateSummary
        public let column: Int
        public let row: Int

        public var id: String { state.id }

        public init(state: CanvasStateSummary, column: Int, row: Int) {
            self.state = state
            self.column = column
            self.row = row
        }
    }

    public static func positions(for graph: CanvasGraph) -> [PositionedState] {
        var columnByState: [String: Int] = [:]
        var queue: [String] = []
        for entry in graph.entryStateIDs where columnByState[entry] == nil {
            columnByState[entry] = 0
            queue.append(entry)
        }
        var outgoing: [String: [String]] = [:]
        for transition in graph.transitions {
            outgoing[transition.sourceStateID, default: []].append(transition.targetStateID)
        }
        while !queue.isEmpty {
            let current = queue.removeFirst()
            let nextColumn = (columnByState[current] ?? 0) + 1
            for target in (outgoing[current] ?? []).sorted() where columnByState[target] == nil {
                columnByState[target] = nextColumn
                queue.append(target)
            }
        }
        let unreachableColumn = (columnByState.values.max() ?? 0) + 1
        var rows: [Int: Int] = [:]
        var result: [PositionedState] = []
        for state in graph.states.sorted(by: { $0.id < $1.id }) {
            let column = columnByState[state.id] ?? unreachableColumn
            let row = rows[column, default: 0]
            rows[column] = row + 1
            result.append(PositionedState(state: state, column: column, row: row))
        }
        return result
    }
}
