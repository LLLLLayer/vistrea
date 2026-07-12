import {
  DataError,
  PROTOCOL_SCHEMA_IDS,
  type DataUnitOfWork,
  type IdGenerator,
  type JsonObject,
  type Page,
  type PageRequest,
  type ProtocolValidator,
  type ResourceRef,
  type WikiLink,
  type WikiNode,
  type WikiNodeQuery,
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

/**
 * The persistent, searchable, linked Deep Wiki over the shared knowledge
 * models. Every node revision is optimistic-concurrency guarded, every link
 * targets a validated resource, and archived knowledge stays readable instead
 * of disappearing.
 */
export class KnowledgeEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #ids: IdGenerator;

  constructor(dependencies: KnowledgeEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#validator = dependencies.validator;
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
