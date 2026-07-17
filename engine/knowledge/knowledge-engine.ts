import {
  canonicalizeIdentityJson,
  DataError,
  PROTOCOL_SCHEMA_IDS,
  type Commit,
  type DataUnitOfWork,
  type IdGenerator,
  type JsonObject,
  type KnowledgeCollection,
  type KnowledgeCollectionQuery,
  type KnowledgeGraph,
  type ObjectRef,
  type ObjectStore,
  type Page,
  type PageRequest,
  type ProtocolValidator,
  type Ref,
  type RefUpdatePrecondition,
  type ResourceRef,
  type WikiLink,
  type WikiNode,
  type WikiNodeQuery,
  type WorkingChange,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "../design/index.js";

const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
const MAXIMUM_MARKDOWN_BYTES = 256 * 1024;

export const WIKI_NODE_KINDS = [
  "screen",
  "component",
  "path",
  "requirement",
  "test",
  "design",
  "concept",
  "note",
] as const;

export const WIKI_NODE_STATUSES = ["draft", "published", "archived"] as const;

export const WIKI_LINK_RELATIONS = [
  "relates_to",
  "documents",
  "evidence_for",
  "implements",
  "tests",
  "depends_on",
  "supersedes",
] as const;

/** The persistent Wiki lifecycle: knowledge is revised, never silently lost. */
export const WIKI_NODE_TRANSITIONS: Readonly<
  Record<(typeof WIKI_NODE_STATUSES)[number], readonly (typeof WIKI_NODE_STATUSES)[number][]>
> = {
  draft: ["published", "archived"],
  published: ["archived"],
  archived: ["published"],
};

export interface KnowledgeEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly validator: ProtocolValidator;
  /** Required only by immutable Knowledge Collection publication. */
  readonly objects?: ObjectStore;
  readonly ids?: IdGenerator;
}

export interface CreateWikiNodeCommand {
  readonly kind: (typeof WIKI_NODE_KINDS)[number];
  readonly title: string;
  readonly slug?: string;
  readonly summary?: string;
  readonly markdown: string;
  readonly labels?: readonly string[];
  readonly related_resources?: readonly { readonly kind: string; readonly id: string }[];
  readonly created_by: JsonObject;
}

export interface UpdateWikiNodeCommand {
  readonly wiki_node_id: string;
  readonly expected_revision: number;
  readonly title?: string;
  readonly summary?: string;
  readonly markdown?: string;
  readonly labels?: readonly string[];
  readonly related_resources?: readonly { readonly kind: string; readonly id: string }[];
  readonly to_status?: (typeof WIKI_NODE_STATUSES)[number];
  readonly updated_by: JsonObject;
}

export interface LinkWikiNodeCommand {
  readonly source_node_id: string;
  readonly target: { readonly kind: string; readonly id: string };
  readonly relation: (typeof WIKI_LINK_RELATIONS)[number];
  readonly label?: string;
  readonly annotation?: string;
  readonly created_by: JsonObject;
}

export interface UnlinkWikiNodeCommand {
  readonly wiki_link_id: string;
  readonly expected_revision: number;
}

export interface CreateKnowledgeCollectionCommand {
  readonly name: string;
  readonly summary?: string;
  readonly node_ids: readonly string[];
  readonly link_ids?: readonly string[];
  readonly entry_node_ids: readonly string[];
  readonly created_by: JsonObject;
}

export interface UpdateKnowledgeCollectionCommand {
  readonly collection_id: string;
  readonly expected_revision: number;
  readonly name?: string;
  readonly summary?: string;
  readonly node_ids?: readonly string[];
  readonly link_ids?: readonly string[];
  readonly entry_node_ids?: readonly string[];
  readonly updated_by: JsonObject;
}

export interface PublishKnowledgeCollectionCommand {
  readonly collection_id: string;
  readonly expected_revision: number;
  readonly base_commit_id: string;
  readonly target_ref_name: string;
  readonly ref_precondition: RefUpdatePrecondition;
  readonly published_by: JsonObject;
  readonly message?: string;
}

export interface PublishKnowledgeCollectionResult extends JsonObject {
  readonly collection: KnowledgeCollection;
  readonly commit: Commit;
  readonly ref: Ref;
  readonly bundle_root: ObjectRef;
}

/**
 * The persistent, searchable, linked Deep Wiki over the shared knowledge
 * models. Every node revision is optimistic-concurrency guarded, every link
 * targets a validated resource, and archived knowledge stays readable instead
 * of disappearing.
 */
export class KnowledgeEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #objects: ObjectStore | undefined;
  readonly #ids: IdGenerator;

  constructor(dependencies: KnowledgeEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#validator = dependencies.validator;
    this.#objects = dependencies.objects;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  createNode(command: CreateWikiNodeCommand): WikiNode {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    this.#assertMarkdown(command.markdown);
    const now = this.#workspace.clock.now();
    const node: JsonObject = {
      wiki_node_id: this.#ids.next("wiki"),
      protocol_version: PROTOCOL_VERSION,
      revision: 1,
      kind: command.kind,
      title: command.title,
      ...(command.slug === undefined ? {} : { slug: command.slug }),
      ...(command.summary === undefined ? {} : { summary: command.summary }),
      content: inlineMarkdown(command.markdown),
      status: "draft",
      labels: [...(command.labels ?? [])],
      related_resources: (command.related_resources ?? []).map((ref) => ({ ...ref })),
      attachments: [],
      created_at: now,
      created_by: command.created_by,
      updated_at: now,
      updated_by: command.created_by,
      extensions: {},
    };
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.wikiNode, node);
    return this.#write((unit) => unit.wiki.create(node as unknown as WikiNode));
  }

  updateNode(command: UpdateWikiNodeCommand): WikiNode {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.updated_by);
    if (command.markdown !== undefined) {
      this.#assertMarkdown(command.markdown);
    }
    return this.#write((unit) => {
      const current = unit.wiki.get(command.wiki_node_id);
      if (current.revision !== command.expected_revision) {
        throw new DataError("conflict", "The Wiki Node revision does not match.", {
          details: {
            wiki_node_id: command.wiki_node_id,
            expected_revision: command.expected_revision,
            current_revision: current.revision,
          },
        });
      }
      if (command.to_status !== undefined) {
        const from = current["status"] as (typeof WIKI_NODE_STATUSES)[number];
        if (
          from !== command.to_status &&
          !WIKI_NODE_TRANSITIONS[from].includes(command.to_status)
        ) {
          throw new DataError(
            "invalid_argument",
            "The Wiki Node status transition is not allowed.",
            { details: { from_status: from, to_status: command.to_status } },
          );
        }
      }
      const now = this.#workspace.clock.now();
      const updated: JsonObject = {
        ...current,
        revision: current.revision + 1,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.summary === undefined ? {} : { summary: command.summary }),
        ...(command.markdown === undefined ? {} : { content: inlineMarkdown(command.markdown) }),
        ...(command.labels === undefined ? {} : { labels: [...command.labels] }),
        ...(command.related_resources === undefined
          ? {}
          : { related_resources: command.related_resources.map((ref) => ({ ...ref })) }),
        ...(command.to_status === undefined ? {} : { status: command.to_status }),
        updated_at: now,
        updated_by: command.updated_by,
      };
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.wikiNode, updated);
      return unit.wiki.update(updated as unknown as WikiNode, {
        expected_revision: command.expected_revision,
      });
    });
  }

  getNode(wikiNodeId: string): WikiNode {
    return this.#read((unit) => unit.wiki.get(wikiNodeId));
  }

  listNodes(query?: WikiNodeQuery, page?: PageRequest): Page<WikiNode> {
    return this.#read((unit) => unit.wiki.listNodes(query, page));
  }

  linkNode(command: LinkWikiNodeCommand): WikiLink {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    const link: JsonObject = {
      wiki_link_id: this.#ids.next("wikilink"),
      protocol_version: PROTOCOL_VERSION,
      revision: 1,
      source_node_id: command.source_node_id,
      target: { ...command.target },
      relation: command.relation,
      ...(command.label === undefined ? {} : { label: command.label }),
      ...(command.annotation === undefined ? {} : { annotation: command.annotation }),
      created_at: this.#workspace.clock.now(),
      created_by: command.created_by,
      extensions: {},
    };
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.wikiLink, link);
    return this.#write((unit) => unit.wiki.link(link as unknown as WikiLink));
  }

  unlinkNode(command: UnlinkWikiNodeCommand): void {
    this.#write((unit) =>
      unit.wiki.unlink(command.wiki_link_id, {
        expected_revision: command.expected_revision,
      }),
    );
  }

  backlinks(wikiNodeId: string, page?: PageRequest): Page<WikiLink> {
    return this.#read((unit) => unit.wiki.backlinks(wikiNodeId, page));
  }

  relatedTo(ref: ResourceRef, page?: PageRequest): Page<WikiNode> {
    return this.#read((unit) => unit.wiki.related(ref, page));
  }

  createCollection(command: CreateKnowledgeCollectionCommand): KnowledgeCollection {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    return this.#write((unit) => {
      const now = this.#workspace.clock.now();
      const collection = {
        collection_id: this.#ids.next("collection"),
        protocol_version: PROTOCOL_VERSION,
        revision: 1,
        name: command.name,
        ...(command.summary === undefined ? {} : { summary: command.summary }),
        node_ids: [...command.node_ids],
        link_ids: [...(command.link_ids ?? [])],
        entry_node_ids: [...command.entry_node_ids],
        publication: { state: "draft", extensions: {} },
        created_at: now,
        created_by: command.created_by,
        updated_at: now,
        updated_by: command.created_by,
        extensions: {},
      } as unknown as KnowledgeCollection;
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.knowledgeCollection, collection);
      this.#assembleBundle(unit, collection);
      return unit.wiki.createCollection(collection);
    });
  }

  updateCollection(command: UpdateKnowledgeCollectionCommand): KnowledgeCollection {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.updated_by);
    return this.#write((unit) => {
      const current = unit.wiki.getCollection(command.collection_id);
      this.#assertRevision(current.revision, command.expected_revision, command.collection_id);
      const updated = {
        ...current,
        revision: current.revision + 1,
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.summary === undefined ? {} : { summary: command.summary }),
        ...(command.node_ids === undefined ? {} : { node_ids: [...command.node_ids] }),
        ...(command.link_ids === undefined ? {} : { link_ids: [...command.link_ids] }),
        ...(command.entry_node_ids === undefined
          ? {}
          : { entry_node_ids: [...command.entry_node_ids] }),
        // Any edit creates a new draft. Historical publication remains in its
        // immutable Commit instead of pointing mutable membership at old bytes.
        publication: { state: "draft", extensions: {} },
        updated_at: this.#workspace.clock.now(),
        updated_by: command.updated_by,
      } as unknown as KnowledgeCollection;
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.knowledgeCollection, updated);
      this.#assembleBundle(unit, updated);
      return unit.wiki.updateCollection(updated, {
        expected_revision: command.expected_revision,
      });
    });
  }

  getCollection(collectionId: string): KnowledgeCollection {
    return this.#read((unit) => unit.wiki.getCollection(collectionId));
  }

  listCollections(
    query?: KnowledgeCollectionQuery,
    page?: PageRequest,
  ): Page<KnowledgeCollection> {
    return this.#read((unit) => unit.wiki.listCollections(query, page));
  }

  async publishCollection(
    command: PublishKnowledgeCollectionCommand,
  ): Promise<PublishKnowledgeCollectionResult> {
    const objects = this.#objects;
    if (objects === undefined) {
      throw new DataError(
        "unsupported",
        "Knowledge Collection publication requires a configured Object Store.",
      );
    }
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.published_by);
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.refUpdatePrecondition, command.ref_precondition);
    this.#assertPublishBase(command);

    const draftBundle = this.#read((unit) => {
      const collection = unit.wiki.getCollection(command.collection_id);
      this.#assertRevision(collection.revision, command.expected_revision, command.collection_id);
      this.#assertDraftPublication(collection);
      const bundle = this.#assembleBundle(unit, collection);
      this.#assertPublishedMembers(bundle);
      // Verify the base before writing a potentially orphaned object.
      unit.versions.getCommit(command.base_commit_id);
      return bundle;
    });
    const canonicalBundle = canonicalizeIdentityJson(draftBundle);
    const bundleRoot = await objects.put(bytesOf(Buffer.from(canonicalBundle, "utf8")), {
      media_type: "application/vnd.vistrea.knowledge+json",
      compression: "none",
      logical_name: `${command.collection_id}-r${command.expected_revision}.knowledge.json`,
      extensions: {},
    });
    this.#workspace.registerVerifiedObjects([bundleRoot]);

    const unit = this.#workspace.beginUnitOfWork("write");
    try {
      const current = unit.wiki.getCollection(command.collection_id);
      this.#assertRevision(current.revision, command.expected_revision, command.collection_id);
      this.#assertDraftPublication(current);
      const currentBundle = this.#assembleBundle(unit, current);
      this.#assertPublishedMembers(currentBundle);
      if (canonicalizeIdentityJson(currentBundle) !== canonicalBundle) {
        throw new DataError(
          "conflict",
          "Knowledge Collection members changed while publication was being prepared.",
          { retryable: true, details: { collection_id: command.collection_id } },
        );
      }

      const baseCommit = unit.versions.getCommit(command.base_commit_id);
      const workingSet = unit.versions.createWorkingSet(baseCommit.commit_id);
      const change = {
        change_id: this.#ids.next("change"),
        operation: "upsert",
        resource: {
          kind: "knowledge_collection",
          id: current.collection_id,
          version: String(current.revision),
        },
        payload: bundleRoot,
        expected_revision: current.revision,
        extensions: {},
      } as unknown as WorkingChange;
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.workingChange, change);
      const changedWorkingSet = unit.versions.appendWorkingChanges(
        workingSet.working_set_id,
        [change],
        { expected_revision: workingSet.revision },
      );
      const publishedAt = this.#workspace.clock.now();
      const manifest = {
        protocol_version: PROTOCOL_VERSION,
        parents: [baseCommit.commit_id],
        created_at: publishedAt,
        author: command.published_by,
        message:
          command.message ?? `Publish Knowledge Collection ${String(current.name)}.`,
        ...(baseCommit.manifest["build_context"] === undefined
          ? {}
          : { build_context: baseCommit.manifest["build_context"] }),
        roots: { ...baseCommit.manifest.roots, wiki: bundleRoot },
        object_hashes: [...new Set([...baseCommit.manifest.object_hashes, bundleRoot.hash])].sort(),
        extensions: {},
      } as unknown as Commit["manifest"];
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.commitManifest, manifest);
      const committed = unit.versions.commitWorkingSetAndUpdateRef({
        working_set_id: changedWorkingSet.working_set_id,
        working_set_precondition: { expected_revision: changedWorkingSet.revision },
        manifest,
        target_ref_name: command.target_ref_name,
        ref_precondition: command.ref_precondition,
      });
      const published = {
        ...current,
        revision: current.revision + 1,
        publication: {
          state: "published",
          commit_id: committed.commit.commit_id,
          ref_name: committed.ref.name,
          published_at: publishedAt,
          published_by: command.published_by,
          extensions: {},
        },
        updated_at: publishedAt,
        updated_by: command.published_by,
      } as unknown as KnowledgeCollection;
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.knowledgeCollection, published);
      const collection = unit.wiki.updateCollection(published, {
        expected_revision: current.revision,
      });
      unit.commit();
      return { collection, commit: committed.commit, ref: committed.ref, bundle_root: bundleRoot };
    } catch (error) {
      try {
        unit.rollback();
      } catch {
        // Preserve the publication failure.
      }
      throw error;
    }
  }

  #assertMarkdown(markdown: string): void {
    if (
      markdown.length === 0 ||
      Buffer.byteLength(markdown, "utf8") > MAXIMUM_MARKDOWN_BYTES
    ) {
      throw new DataError(
        "invalid_argument",
        "Wiki Markdown content must be non-empty and bounded.",
      );
    }
  }

  #assembleBundle(unit: DataUnitOfWork, collection: KnowledgeCollection): KnowledgeGraph {
    const bundle = {
      protocol_version: PROTOCOL_VERSION,
      revision: collection.revision,
      nodes: collection.node_ids.map((nodeId) => unit.wiki.get(nodeId)),
      links: collection.link_ids.map((linkId) => unit.wiki.getLink(linkId)),
      collections: [collection],
      extensions: {},
    } as unknown as KnowledgeGraph;
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.knowledgeGraph, bundle);
    return bundle;
  }

  #assertRevision(current: number, expected: number, collectionId: string): void {
    if (current !== expected) {
      throw new DataError("conflict", "The Knowledge Collection revision does not match.", {
        retryable: true,
        details: { collection_id: collectionId, expected_revision: expected, current_revision: current },
      });
    }
  }

  #assertDraftPublication(collection: KnowledgeCollection): void {
    if (collection.publication["state"] !== "draft") {
      throw new DataError(
        "conflict",
        "Only a draft Knowledge Collection can be published; update it to create a new draft revision.",
        { details: { collection_id: collection.collection_id } },
      );
    }
  }

  #assertPublishedMembers(bundle: KnowledgeGraph): void {
    const unpublished = bundle.nodes
      .filter((node) => node["status"] !== "published")
      .map((node) => node.wiki_node_id);
    if (unpublished.length > 0) {
      throw new DataError(
        "invalid_argument",
        "Every Knowledge Collection member must be published before the collection is published.",
        { details: { unpublished_node_ids: unpublished } },
      );
    }
  }

  #assertPublishBase(command: PublishKnowledgeCollectionCommand): void {
    if (
      command.ref_precondition["mode"] === "must_match" &&
      command.ref_precondition["expected_commit_id"] !== command.base_commit_id
    ) {
      throw new DataError(
        "invalid_argument",
        "A must_match publication must use the expected Ref Commit as its base Commit.",
      );
    }
  }

  #read<T>(operation: (unit: DataUnitOfWork) => T): T {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      return operation(unit);
    } finally {
      unit.rollback();
    }
  }

  #write<T>(operation: (unit: DataUnitOfWork) => T): T {
    const unit = this.#workspace.beginUnitOfWork("write");
    try {
      const result = operation(unit);
      unit.commit();
      return result;
    } catch (error) {
      try {
        unit.rollback();
      } catch {
        // The original failure is the meaningful error.
      }
      throw error;
    }
  }
}

function inlineMarkdown(markdown: string): JsonObject {
  return {
    storage: "inline",
    media_type: "text/markdown",
    text: markdown,
    extensions: {},
  };
}

async function* bytesOf(bytes: Buffer): AsyncIterable<Uint8Array> {
  yield bytes;
}
