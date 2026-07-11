import Foundation

public struct UiNode: Codable, Equatable, Sendable {
    public let nodeID: NodeID
    public let stableID: StableID?
    public let parentID: NodeID?
    public let childIDs: [NodeID]
    public let nativeType: String
    public let role: String
    public let frame: Rect?
    public let visibleRect: Rect?
    public let hitRect: Rect?
    public let bounds: Rect?
    public let zIndex: Double?
    public let clipped: Bool?
    public let content: TextContent
    public let state: NodeState
    public let actions: [UiAction]
    public let visual: VisualProperties?
    public let accessibility: AccessibilityProperties?
    public let sourceContext: SourceContext?
    public let relatedNodes: [RelatedNodeReference]
    public let captureLimitations: [CaptureLimitation]
    public let extensions: Extensions

    public init(
        nodeID: NodeID,
        stableID: StableID? = nil,
        parentID: NodeID? = nil,
        childIDs: [NodeID],
        nativeType: String,
        role: String,
        frame: Rect? = nil,
        visibleRect: Rect? = nil,
        hitRect: Rect? = nil,
        bounds: Rect? = nil,
        zIndex: Double? = nil,
        clipped: Bool? = nil,
        content: TextContent,
        state: NodeState,
        actions: [UiAction],
        visual: VisualProperties? = nil,
        accessibility: AccessibilityProperties? = nil,
        sourceContext: SourceContext? = nil,
        relatedNodes: [RelatedNodeReference],
        captureLimitations: [CaptureLimitation],
        extensions: Extensions = .empty
    ) throws {
        guard Set(childIDs).count == childIDs.count else {
            throw ProtocolModelError.invalidValue("UI node child IDs must be unique.")
        }
        guard !nativeType.isEmpty, nativeType.unicodeScalars.count <= 512 else {
            throw ProtocolModelError.invalidValue("Native type must contain 1 through 512 UTF-8 bytes.")
        }
        guard !role.isEmpty, role.unicodeScalars.count <= 128 else {
            throw ProtocolModelError.invalidValue("UI role must contain 1 through 128 UTF-8 bytes.")
        }
        if let zIndex, !zIndex.isFinite {
            throw ProtocolModelError.invalidValue("Z-index must be finite.")
        }
        guard Set(actions).count == actions.count else {
            throw ProtocolModelError.invalidValue("UI node actions must be unique.")
        }
        self.nodeID = nodeID
        self.stableID = stableID
        self.parentID = parentID
        self.childIDs = childIDs
        self.nativeType = nativeType
        self.role = role
        self.frame = frame
        self.visibleRect = visibleRect
        self.hitRect = hitRect
        self.bounds = bounds
        self.zIndex = zIndex
        self.clipped = clipped
        self.content = content
        self.state = state
        self.actions = actions
        self.visual = visual
        self.accessibility = accessibility
        self.sourceContext = sourceContext
        self.relatedNodes = relatedNodes
        self.captureLimitations = captureLimitations
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case nodeID = "node_id"
        case stableID = "stable_id"
        case parentID = "parent_id"
        case childIDs = "child_ids"
        case nativeType = "native_type"
        case role
        case frame
        case visibleRect = "visible_rect"
        case hitRect = "hit_rect"
        case bounds
        case zIndex = "z_index"
        case clipped
        case content
        case state
        case actions
        case visual
        case accessibility
        case sourceContext = "source_context"
        case relatedNodes = "related_nodes"
        case captureLimitations = "capture_limitations"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let nodeID = try container.decode(NodeID.self, forKey: .nodeID)
        let stableID = try container.decodeIfPresent(StableID.self, forKey: .stableID)
        let parentID = try container.decodeIfPresent(NodeID.self, forKey: .parentID)
        let childIDs = try container.decode([NodeID].self, forKey: .childIDs)
        let nativeType = try container.decode(String.self, forKey: .nativeType)
        let role = try container.decode(String.self, forKey: .role)
        let frame = try container.decodeIfPresent(Rect.self, forKey: .frame)
        let visibleRect = try container.decodeIfPresent(Rect.self, forKey: .visibleRect)
        let hitRect = try container.decodeIfPresent(Rect.self, forKey: .hitRect)
        let bounds = try container.decodeIfPresent(Rect.self, forKey: .bounds)
        let zIndex = try container.decodeIfPresent(Double.self, forKey: .zIndex)
        let clipped = try container.decodeIfPresent(Bool.self, forKey: .clipped)
        let content = try container.decode(TextContent.self, forKey: .content)
        let state = try container.decode(NodeState.self, forKey: .state)
        let actions = try container.decode([UiAction].self, forKey: .actions)
        let visual = try container.decodeIfPresent(VisualProperties.self, forKey: .visual)
        let accessibility = try container.decodeIfPresent(AccessibilityProperties.self, forKey: .accessibility)
        let sourceContext = try container.decodeIfPresent(SourceContext.self, forKey: .sourceContext)
        let relatedNodes = try container.decode([RelatedNodeReference].self, forKey: .relatedNodes)
        let captureLimitations = try container.decode([CaptureLimitation].self, forKey: .captureLimitations)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                nodeID: nodeID,
                stableID: stableID,
                parentID: parentID,
                childIDs: childIDs,
                nativeType: nativeType,
                role: role,
                frame: frame,
                visibleRect: visibleRect,
                hitRect: hitRect,
                bounds: bounds,
                zIndex: zIndex,
                clipped: clipped,
                content: content,
                state: state,
                actions: actions,
                visual: visual,
                accessibility: accessibility,
                sourceContext: sourceContext,
                relatedNodes: relatedNodes,
                captureLimitations: captureLimitations,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .nodeID,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public enum UiTreeKind: String, Codable, Equatable, Sendable {
    case semantic
    case view
    case layer
}

public enum UiNodeEncoding: String, Codable, Equatable, Sendable {
    case json = "vistrea.ui-nodes+json"
}

public enum UiTreePayload: Codable, Equatable, Sendable {
    case inline(nodes: [UiNode])
    case object(reference: ObjectReference, nodeCount: JSONSafePositiveUInt, encoding: UiNodeEncoding)

    public var inlineNodes: [UiNode]? {
        guard case let .inline(nodes) = self else {
            return nil
        }
        return nodes
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case inlineNodes = "inline_nodes"
        case nodesObject = "nodes_object"
        case nodeCount = "node_count"
        case encoding
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let hasInlineNodes = container.contains(.inlineNodes)
        let hasNodesObject = container.contains(.nodesObject)
        let hasNodeCount = container.contains(.nodeCount)
        let hasEncoding = container.contains(.encoding)

        if hasInlineNodes, !hasNodesObject, !hasNodeCount, !hasEncoding {
            let nodes = try container.decode([UiNode].self, forKey: .inlineNodes)
            guard !nodes.isEmpty else {
                throw DecodingError.dataCorruptedError(
                    forKey: .inlineNodes,
                    in: container,
                    debugDescription: "An inline UI tree payload must contain at least one node."
                )
            }
            self = .inline(nodes: nodes)
        } else if !hasInlineNodes, hasNodesObject, hasNodeCount, hasEncoding {
            self = .object(
                reference: try container.decode(ObjectReference.self, forKey: .nodesObject),
                nodeCount: try container.decode(JSONSafePositiveUInt.self, forKey: .nodeCount),
                encoding: try container.decode(UiNodeEncoding.self, forKey: .encoding)
            )
        } else {
            throw DecodingError.dataCorruptedError(
                forKey: hasInlineNodes ? .inlineNodes : .nodesObject,
                in: container,
                debugDescription: "A UI tree payload must use exactly one complete inline or object representation."
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .inline(nodes):
            guard !nodes.isEmpty else {
                throw EncodingError.invalidValue(
                    nodes,
                    EncodingError.Context(
                        codingPath: encoder.codingPath,
                        debugDescription: "An inline UI tree payload must contain at least one node."
                    )
                )
            }
            try container.encode(nodes, forKey: .inlineNodes)
        case let .object(reference, nodeCount, encoding):
            try container.encode(reference, forKey: .nodesObject)
            try container.encode(nodeCount, forKey: .nodeCount)
            try container.encode(encoding, forKey: .encoding)
        }
    }
}

public struct UiTree: Codable, Equatable, Sendable {
    public let treeID: TreeID
    public let kind: UiTreeKind
    public let rootNodeIDs: [NodeID]
    public let payload: UiTreePayload
    public let captureLimitations: [CaptureLimitation]
    public let extensions: Extensions

    public init(
        treeID: TreeID,
        kind: UiTreeKind,
        rootNodeIDs: [NodeID],
        payload: UiTreePayload,
        captureLimitations: [CaptureLimitation],
        extensions: Extensions = .empty
    ) throws {
        guard !rootNodeIDs.isEmpty, Set(rootNodeIDs).count == rootNodeIDs.count else {
            throw ProtocolModelError.invalidValue("A UI tree requires one or more unique root node IDs.")
        }
        self.treeID = treeID
        self.kind = kind
        self.rootNodeIDs = rootNodeIDs
        self.payload = payload
        self.captureLimitations = captureLimitations
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case treeID = "tree_id"
        case kind
        case rootNodeIDs = "root_node_ids"
        case payload
        case captureLimitations = "capture_limitations"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let treeID = try container.decode(TreeID.self, forKey: .treeID)
        let kind = try container.decode(UiTreeKind.self, forKey: .kind)
        let rootNodeIDs = try container.decode([NodeID].self, forKey: .rootNodeIDs)
        let payload = try container.decode(UiTreePayload.self, forKey: .payload)
        let captureLimitations = try container.decode([CaptureLimitation].self, forKey: .captureLimitations)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                treeID: treeID,
                kind: kind,
                rootNodeIDs: rootNodeIDs,
                payload: payload,
                captureLimitations: captureLimitations,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .rootNodeIDs,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}
