import Foundation

/// The immutable publication projection attached to one mutable Collection.
/// Editing a published Collection creates a new draft while the prior Commit
/// remains immutable in version history.
public struct KnowledgeCollectionPublication: Decodable, Equatable, Sendable {
    public let state: String
    public let commitID: String?
    public let refName: String?

    public init(state: String, commitID: String? = nil, refName: String? = nil) {
        self.state = state
        self.commitID = commitID
        self.refName = refName
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case commitID = "commit_id"
        case refName = "ref_name"
    }
}

/// Studio's complete product projection of one canonical Knowledge
/// Collection. Timestamps and actors remain stored by the Host but are not
/// required to edit membership safely.
public struct KnowledgeCollectionSummary: Decodable, Equatable, Sendable, Identifiable {
    public let collectionID: String
    public let revision: UInt64
    public let name: String
    public let summary: String?
    public let nodeIDs: [String]
    public let linkIDs: [String]
    public let entryNodeIDs: [String]
    public let publication: KnowledgeCollectionPublication

    public var id: String { collectionID }

    public init(
        collectionID: String,
        revision: UInt64,
        name: String,
        summary: String?,
        nodeIDs: [String],
        linkIDs: [String],
        entryNodeIDs: [String],
        publication: KnowledgeCollectionPublication
    ) {
        self.collectionID = collectionID
        self.revision = revision
        self.name = name
        self.summary = summary
        self.nodeIDs = nodeIDs
        self.linkIDs = linkIDs
        self.entryNodeIDs = entryNodeIDs
        self.publication = publication
    }

    private enum CodingKeys: String, CodingKey {
        case collectionID = "collection_id"
        case revision
        case name
        case summary
        case nodeIDs = "node_ids"
        case linkIDs = "link_ids"
        case entryNodeIDs = "entry_node_ids"
        case publication
    }
}

public struct KnowledgeCollectionPage: Decodable, Equatable, Sendable {
    public let items: [KnowledgeCollectionSummary]
    public let nextCursor: String?

    public init(items: [KnowledgeCollectionSummary], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}

public struct KnowledgeCollectionDraft: Encodable, Equatable, Sendable {
    public let name: String
    public let summary: String?
    public let nodeIDs: [String]
    public let linkIDs: [String]
    public let entryNodeIDs: [String]
    public let createdBy: StudioActorRef

    public init(
        name: String,
        summary: String? = nil,
        nodeIDs: [String],
        linkIDs: [String] = [],
        entryNodeIDs: [String],
        createdBy: StudioActorRef = .studio
    ) {
        self.name = name
        self.summary = summary
        self.nodeIDs = nodeIDs
        self.linkIDs = linkIDs
        self.entryNodeIDs = entryNodeIDs
        self.createdBy = createdBy
    }

    private enum CodingKeys: String, CodingKey {
        case name
        case summary
        case nodeIDs = "node_ids"
        case linkIDs = "link_ids"
        case entryNodeIDs = "entry_node_ids"
        case createdBy = "created_by"
    }
}

public struct KnowledgeCollectionRevisionDraft: Encodable, Equatable, Sendable {
    public let expectedRevision: UInt64
    public let name: String?
    public let summary: String?
    public let nodeIDs: [String]?
    public let linkIDs: [String]?
    public let entryNodeIDs: [String]?
    public let updatedBy: StudioActorRef

    public init(
        expectedRevision: UInt64,
        name: String? = nil,
        summary: String? = nil,
        nodeIDs: [String]? = nil,
        linkIDs: [String]? = nil,
        entryNodeIDs: [String]? = nil,
        updatedBy: StudioActorRef = .studio
    ) {
        self.expectedRevision = expectedRevision
        self.name = name
        self.summary = summary
        self.nodeIDs = nodeIDs
        self.linkIDs = linkIDs
        self.entryNodeIDs = entryNodeIDs
        self.updatedBy = updatedBy
    }

    private enum CodingKeys: String, CodingKey {
        case expectedRevision = "expected_revision"
        case name
        case summary
        case nodeIDs = "node_ids"
        case linkIDs = "link_ids"
        case entryNodeIDs = "entry_node_ids"
        case updatedBy = "updated_by"
    }
}
