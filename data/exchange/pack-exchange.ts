import { createHash, type Hash } from "node:crypto";
import { TextDecoder } from "node:util";

import { DataError, isDataError } from "../api/errors.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type Commit,
  type ExportPackCommand,
  type ExportReadableCommand,
  type ImportPackCommand,
  type ImportPackResult,
  type JsonObject,
  type KnowledgeCollection,
  type KnowledgeGraph,
  type ObjectPutMetadata,
  type ObjectRef,
  type PackRefConflict,
  type ProtocolValidator,
  type Ref,
  type RefUpdatePrecondition,
  type ReadableKnowledgeFormat,
} from "../api/models.js";
import type {
  ByteStream,
  DataUnitOfWork,
  ExchangeService,
  ObjectStore,
  WorkspaceDataSource,
} from "../api/ports.js";
import { canonicalizeIdentityJson } from "../internal/support.js";

export const PACK_FORMAT = "vistrea-pack";
export const PACK_FORMAT_VERSION = 1;
export const PACK_MEDIA_TYPE = "application/vnd.vistrea-pack";
export const PACK_LOGICAL_NAME = "workspace-export.vistrea-pack";

const EXPORTED_OBJECT_RETENTION_REASON =
  "Preserve an explicitly exported artifact until a future user-managed retention workflow releases it.";

const HEADER_LINE_LIMIT = 4_096;
const TRAILER_LINE_LIMIT = 4_096;
const MANIFEST_BYTE_LIMIT = 64 * 1024 * 1024;
const KNOWLEDGE_BUNDLE_BYTE_LIMIT = 64 * 1024 * 1024;
const LINE_FEED = 0x0a;

interface PackRefWire extends JsonObject {
  readonly name: string;
  readonly commit_id: string;
}

interface PackManifestWire extends JsonObject {
  readonly format: typeof PACK_FORMAT;
  readonly format_version: typeof PACK_FORMAT_VERSION;
  readonly protocol_version: { readonly major: number; readonly minor: number };
  readonly mode: "full" | "thin";
  readonly created_at: string;
  readonly created_by: JsonObject;
  readonly message?: string;
  readonly commits: readonly Commit[];
  readonly refs: readonly PackRefWire[];
  readonly objects: readonly ObjectRef[];
  readonly omitted_objects: readonly ObjectRef[];
  readonly prerequisite_commit_ids: readonly string[];
  readonly extensions: JsonObject;
}

export interface PackExchangeServiceOptions {
  readonly data: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly validator: ProtocolValidator;
}

/**
 * Portable `.vistrea-pack` exchange over the public Data ports.
 *
 * The container layout is one PackHeader line, the canonical PackManifest
 * bytes plus one line feed, every included object's encoded payload bytes in
 * manifest order, and one PackTrailer line whose SHA-256 covers every
 * preceding byte. Identity semantics follow ADR-0003: included object hashes
 * and canonical commit identity are verified before any ref may advance.
 */
export class PackExchangeService implements ExchangeService {
  readonly #data: WorkspaceDataSource;
  readonly #objects: ObjectStore;
  readonly #validator: ProtocolValidator;

  constructor(options: PackExchangeServiceOptions) {
    this.#data = options.data;
    this.#objects = options.objects;
    this.#validator = options.validator;
  }

  /**
   * The pack bytes for a set of refs WITHOUT persisting the pack as an
   * object. Relays stream exports to callers; persisting one object per
   * request would let a read-only caller grow the store without bound, since
   * every export carries a fresh creation time and message.
   */
  async exportPackBytes(command: ExportPackCommand): Promise<ByteStream> {
    const manifest = await this.#buildPackManifest(command);
    return this.#packByteStream(manifest);
  }

  async #buildPackManifest(command: ExportPackCommand): Promise<PackManifestWire> {
    const refNames = uniqueSorted(command.ref_names ?? []);
    const headCommitIds = uniqueSorted(command.commit_ids ?? []);
    const prerequisiteHeadIds = uniqueSorted(command.prerequisite_commit_ids ?? []);
    if (refNames.length === 0 && headCommitIds.length === 0) {
      throw new DataError(
        "invalid_argument",
        "Pack export requires at least one ref name or head commit.",
      );
    }
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);

    const unit = this.#data.beginUnitOfWork("read");
    let manifest: PackManifestWire;
    try {
      const refs: PackRefWire[] = refNames.map((name) => {
        const resolved = unit.versions.resolveRef(name);
        return { name: resolved.name, commit_id: resolved.commit_id };
      });
      const heads = uniqueSorted([...headCommitIds, ...refs.map((ref) => ref.commit_id)]);
      const headClosure = collectCommitClosure(unit, heads);
      const prerequisiteClosure = collectCommitClosure(unit, prerequisiteHeadIds);

      const included = [...headClosure.values()].filter(
        (commit) => !prerequisiteClosure.has(commit.commit_id),
      );
      if (included.length === 0) {
        throw new DataError(
          "invalid_argument",
          "Every requested head is already reachable from the pack prerequisites.",
        );
      }
      const orderedCommits = orderParentFirst(included);
      const includedIds = new Set(orderedCommits.map((commit) => commit.commit_id));
      const boundaryParentIds = uniqueSorted(
        orderedCommits
          .flatMap((commit) => commit.manifest.parents)
          .filter((parent) => !includedIds.has(parent)),
      );

      const objectsByHash = new Map<string, ObjectRef>();
      for (const object of unit.versions.reachableObjects(heads)) {
        objectsByHash.set(object.hash, object);
      }
      const prerequisiteHashes = new Set(
        [...prerequisiteClosure.values()].flatMap((commit) => commit.manifest.object_hashes),
      );
      const neededHashes = uniqueSorted(
        orderedCommits.flatMap((commit) => commit.manifest.object_hashes),
      );
      const includedObjects: ObjectRef[] = [];
      const omittedObjects: ObjectRef[] = [];
      for (const hash of neededHashes) {
        const object = objectsByHash.get(hash);
        if (object === undefined) {
          throw new DataError("integrity_error", "A reachable Commit object is unavailable.", {
            details: { hash },
          });
        }
        (prerequisiteHashes.has(hash) ? omittedObjects : includedObjects).push(object);
      }

      manifest = {
        format: PACK_FORMAT,
        format_version: PACK_FORMAT_VERSION,
        protocol_version: packProtocolVersion(orderedCommits),
        mode: prerequisiteHeadIds.length === 0 ? "full" : "thin",
        created_at: this.#data.clock.now(),
        created_by: command.created_by,
        ...(command.message === undefined ? {} : { message: command.message }),
        commits: orderedCommits,
        refs,
        objects: includedObjects,
        omitted_objects: omittedObjects,
        prerequisite_commit_ids: boundaryParentIds,
        extensions: {},
      };
    } finally {
      unit.rollback();
    }
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.exchangePackManifest, manifest);

    return manifest;
  }

  async exportPack(command: ExportPackCommand): Promise<ObjectRef> {
    const manifest = await this.#buildPackManifest(command);
    const packRef = await this.#objects.put(this.#packByteStream(manifest), {
      media_type: PACK_MEDIA_TYPE,
      compression: "none",
      logical_name: PACK_LOGICAL_NAME,
    });
    await this.#objects.pin(packRef.hash, {
      policy_id: `workspace-export:${packRef.hash}`,
      reason: EXPORTED_OBJECT_RETENTION_REASON,
    });
    this.#data.registerVerifiedObjects([packRef]);
    return packRef;
  }

  async importPack(command: ImportPackCommand): Promise<ImportPackResult> {
    const packRef = command.pack;
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, packRef);
    if (packRef.media_type !== PACK_MEDIA_TYPE) {
      throw new DataError("invalid_argument", "The object is not a `.vistrea-pack` payload.", {
        details: { hash: packRef.hash, media_type: packRef.media_type },
      });
    }
    if (packRef.compression !== "none") {
      throw new DataError("unsupported", "Version 1 packs must use compression \"none\".", {
        details: { hash: packRef.hash, compression: packRef.compression },
      });
    }

    const reader = new PackByteReader(await this.#objects.open(packRef.hash));
    let manifest: PackManifestWire;
    let preExisting: ReadonlySet<string>;
    const verifiedObjects: ObjectRef[] = [];
    try {
      const header = this.#readCanonicalLine(
        await reader.readLine(HEADER_LINE_LIMIT, "pack header"),
        PROTOCOL_SCHEMA_IDS.exchangePackHeader,
        "pack header",
      ) as { readonly manifest_byte_size: number };
      if (header.manifest_byte_size > MANIFEST_BYTE_LIMIT) {
        throw new DataError("resource_exhausted", "The pack manifest exceeds the reader limit.", {
          details: { manifest_byte_size: header.manifest_byte_size },
        });
      }
      const manifestText = await reader.readUtf8(header.manifest_byte_size, "pack manifest");
      await reader.expectLineFeed("pack manifest");
      manifest = this.#readCanonicalLine(
        manifestText,
        PROTOCOL_SCHEMA_IDS.exchangePackManifest,
        "pack manifest",
      ) as PackManifestWire;
      assertManifestCoherence(manifest);
      this.#assertPrerequisiteCommits(manifest);

      const includedHashes = manifest.objects.map((object) => object.hash);
      preExisting = await this.#objects.has(includedHashes);
      for (const object of manifest.objects) {
        verifiedObjects.push(
          await this.#objects.put(reader.readExact(object.byte_size), putMetadataFor(object)),
        );
      }
      const digest = reader.finalizeDigest();
      const trailer = this.#readCanonicalLine(
        await reader.readLine(TRAILER_LINE_LIMIT, "pack trailer"),
        PROTOCOL_SCHEMA_IDS.exchangePackTrailer,
        "pack trailer",
      ) as { readonly pack_sha256: string };
      if (trailer.pack_sha256 !== digest) {
        throw new DataError(
          "integrity_error",
          "The pack trailer digest does not match its bytes.",
          { details: { expected: trailer.pack_sha256, actual: digest } },
        );
      }
      await reader.expectEnd("pack trailer");
    } finally {
      await reader.close();
    }

    for (const omitted of manifest.omitted_objects) {
      let stored: ObjectRef;
      try {
        stored = await this.#objects.stat(omitted.hash);
      } catch (error) {
        if (isDataError(error, "not_found")) {
          throw new DataError("conflict", "A thin-pack omitted object is not present locally.", {
            details: { hash: omitted.hash },
          });
        }
        throw error;
      }
      if (canonicalizeIdentityJson(stored) !== canonicalizeIdentityJson(omitted)) {
        throw new DataError(
          "conflict",
          "A thin-pack omitted object exists locally with different immutable metadata.",
          { details: { hash: omitted.hash } },
        );
      }
      verifiedObjects.push(stored);
    }
    this.#data.registerVerifiedObjects(verifiedObjects);

    const unit = this.#data.beginUnitOfWork("write");
    try {
      const missingPrerequisites = manifest.prerequisite_commit_ids.filter(
        (commitId) => !hasCommit(unit, commitId),
      );
      if (missingPrerequisites.length > 0) {
        throw new DataError("conflict", "The thin-pack prerequisite commits are missing locally.", {
          details: { missing_commit_ids: missingPrerequisites },
        });
      }

      const importedCommitIds: string[] = [];
      const existingCommitIds: string[] = [];
      for (const commit of manifest.commits) {
        this.#validator.assert(PROTOCOL_SCHEMA_IDS.commit, commit);
        if (hasCommit(unit, commit.commit_id)) {
          existingCommitIds.push(commit.commit_id);
          continue;
        }
        const created = unit.versions.createCommit(commit.manifest);
        if (created.commit_id !== commit.commit_id) {
          throw new DataError("integrity_error", "The pack commit identity is not canonical.", {
            details: { declared: commit.commit_id, canonical: created.commit_id },
          });
        }
        importedCommitIds.push(commit.commit_id);
      }

      const createdRefs: Ref[] = [];
      const unchangedRefNames: string[] = [];
      const conflictingRefs: PackRefConflict[] = [];
      for (const ref of manifest.refs) {
        if (!hasCommit(unit, ref.commit_id)) {
          throw new DataError("integrity_error", "The pack ref targets an unavailable commit.", {
            details: { ref_name: ref.name, commit_id: ref.commit_id },
          });
        }
        let current: Ref | undefined;
        try {
          current = unit.versions.resolveRef(ref.name);
        } catch (error) {
          if (!isDataError(error, "not_found")) {
            throw error;
          }
        }
        if (current === undefined) {
          const precondition = { mode: "must_not_exist" } as unknown as RefUpdatePrecondition;
          createdRefs.push(unit.versions.updateRef(ref.name, ref.commit_id, precondition));
        } else if (current.commit_id === ref.commit_id) {
          unchangedRefNames.push(ref.name);
        } else {
          conflictingRefs.push({
            name: ref.name,
            pack_commit_id: ref.commit_id,
            local_commit_id: current.commit_id,
          });
        }
      }
      unit.commit();

      const packedHashes = manifest.objects.map((object) => object.hash);
      return {
        mode: manifest.mode,
        imported_commit_ids: importedCommitIds,
        existing_commit_ids: existingCommitIds,
        imported_object_hashes: packedHashes.filter((hash) => !preExisting.has(hash)),
        existing_object_hashes: packedHashes.filter((hash) => preExisting.has(hash)),
        created_refs: createdRefs,
        unchanged_ref_names: unchangedRefNames,
        conflicting_refs: conflictingRefs,
      };
    } catch (error) {
      unit.rollback();
      throw error;
    }
  }

  async exportReadable(command: ExportReadableCommand): Promise<readonly ObjectRef[]> {
    const formats = normalizeReadableFormats(command.formats);
    const unit = this.#data.beginUnitOfWork("read");
    let collection: KnowledgeCollection;
    let root: ObjectRef;
    try {
      collection = unit.wiki.getCollection(command.collection_id);
      const publication = collection.publication;
      if (publication["state"] !== "published") {
        throw new DataError(
          "conflict",
          "Readable export requires a published Knowledge Collection.",
          { details: { collection_id: command.collection_id } },
        );
      }
      const commitId = publication["commit_id"];
      if (typeof commitId !== "string") {
        throw new DataError("integrity_error", "Published Knowledge Collection has no Commit ID.");
      }
      const commit = unit.versions.getCommit(commitId);
      const candidate = commit.manifest.roots["wiki"];
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, candidate);
      root = candidate as unknown as ObjectRef;
      if (!commit.manifest.object_hashes.includes(root.hash)) {
        throw new DataError(
          "integrity_error",
          "The Knowledge Commit does not account for its Wiki root object.",
          { details: { commit_id: commitId, hash: root.hash } },
        );
      }
    } finally {
      unit.rollback();
    }

    const bundleText = await readVerifiedUtf8Object(
      this.#objects,
      root,
      KNOWLEDGE_BUNDLE_BYTE_LIMIT,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bundleText) as unknown;
    } catch {
      throw new DataError("integrity_error", "The Knowledge Commit root is not valid JSON.");
    }
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.knowledgeGraph, parsed);
    if (canonicalizeIdentityJson(parsed as JsonObject) !== bundleText) {
      throw new DataError(
        "integrity_error",
        "The Knowledge Commit root is not canonical identity JSON.",
      );
    }
    const bundle = parsed as KnowledgeGraph;
    const frozenCollection = bundle.collections.find(
      (candidate) => candidate.collection_id === collection.collection_id,
    );
    if (
      frozenCollection === undefined ||
      frozenCollection.publication["state"] !== "draft" ||
      frozenCollection.revision + 1 !== collection.revision
    ) {
      throw new DataError(
        "integrity_error",
        "The published Knowledge Collection does not match its immutable Commit root.",
        { details: { collection_id: collection.collection_id } },
      );
    }

    const outputs: ObjectRef[] = [];
    for (const format of formats) {
      const rendered =
        format === "markdown"
          ? renderKnowledgeMarkdown(collection, bundle)
          : renderKnowledgeHtml(collection, bundle);
      outputs.push(
        await this.#objects.put(bytesOf(Buffer.from(rendered, "utf8")), {
          media_type: format === "markdown" ? "text/markdown" : "text/html",
          compression: "none",
          logical_name: `${collection.collection_id}.${format === "markdown" ? "md" : "html"}`,
          extensions: {
            "vistrea.knowledge_export": {
              collection_id: collection.collection_id,
              commit_id: collection.publication["commit_id"] as string,
              format,
            },
          },
        }),
      );
    }
    for (const output of outputs) {
      await this.#objects.pin(output.hash, {
        policy_id: `readable-export:${output.hash}`,
        reason: EXPORTED_OBJECT_RETENTION_REASON,
      });
    }
    this.#data.registerVerifiedObjects(outputs);
    return outputs;
  }

  async *#packByteStream(manifest: PackManifestWire): ByteStream {
    const digest = createHash("sha256");
    const hashed = (bytes: Buffer): Buffer => {
      digest.update(bytes);
      return bytes;
    };
    const manifestBytes = Buffer.from(canonicalizeIdentityJson(manifest), "utf8");
    const header = {
      format: PACK_FORMAT,
      format_version: PACK_FORMAT_VERSION,
      manifest_byte_size: manifestBytes.byteLength,
    };
    yield hashed(Buffer.from(`${canonicalizeIdentityJson(header)}\n`, "utf8"));
    yield hashed(manifestBytes);
    yield hashed(Buffer.from("\n", "utf8"));
    for (const object of manifest.objects) {
      let written = 0;
      const objectDigest = createHash("sha256");
      for await (const chunk of await this.#objects.open(object.hash)) {
        const bytes = Buffer.from(chunk);
        written += bytes.byteLength;
        if (written > object.byte_size) {
          throw packedObjectMismatch(object);
        }
        objectDigest.update(bytes);
        yield hashed(bytes);
      }
      if (written !== object.byte_size || hashOf(objectDigest) !== object.hash) {
        throw packedObjectMismatch(object);
      }
    }
    const trailer = { pack_sha256: digest.digest("hex") };
    yield Buffer.from(`${canonicalizeIdentityJson(trailer)}\n`, "utf8");
  }

  /** Fails fast with the missing prerequisite commits before any object lands. */
  #assertPrerequisiteCommits(manifest: PackManifestWire): void {
    if (manifest.prerequisite_commit_ids.length === 0) {
      return;
    }
    const unit = this.#data.beginUnitOfWork("read");
    try {
      const missing = manifest.prerequisite_commit_ids.filter(
        (commitId) => !hasCommit(unit, commitId),
      );
      if (missing.length > 0) {
        throw new DataError("conflict", "The thin-pack prerequisite commits are missing locally.", {
          details: { missing_commit_ids: missing },
        });
      }
    } finally {
      unit.rollback();
    }
  }

  #readCanonicalLine(text: string, schemaId: string, label: string): JsonObject {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new DataError("integrity_error", `The ${label} is not valid JSON.`);
    }
    this.#validator.assert(schemaId, value);
    if (canonicalizeIdentityJson(value as JsonObject) !== text) {
      throw new DataError("integrity_error", `The ${label} is not canonical identity JSON.`);
    }
    return value as JsonObject;
  }
}

function normalizeReadableFormats(
  formats: readonly ReadableKnowledgeFormat[] | undefined,
): readonly ReadableKnowledgeFormat[] {
  if (formats === undefined) {
    return ["markdown", "html"];
  }
  if (
    !Array.isArray(formats) ||
    formats.length === 0 ||
    formats.length > 2 ||
    new Set(formats).size !== formats.length ||
    formats.some((format) => format !== "markdown" && format !== "html")
  ) {
    throw new DataError(
      "invalid_argument",
      "Readable export formats must be a unique non-empty subset of markdown and html.",
    );
  }
  return (["markdown", "html"] as const).filter((format) => formats.includes(format));
}

async function readVerifiedUtf8Object(
  objects: ObjectStore,
  expected: ObjectRef,
  maximumBytes: number,
): Promise<string> {
  if (expected.compression !== "none") {
    throw new DataError(
      "unsupported",
      "Readable Knowledge export currently requires an uncompressed Commit root.",
      { details: { hash: expected.hash, compression: expected.compression } },
    );
  }
  if (expected.byte_size > maximumBytes) {
    throw new DataError("resource_exhausted", "The Knowledge Commit root exceeds the reader limit.", {
      details: { hash: expected.hash, byte_size: expected.byte_size, maximum_bytes: maximumBytes },
    });
  }
  const stored = await objects.stat(expected.hash);
  if (canonicalizeIdentityJson(stored) !== canonicalizeIdentityJson(expected)) {
    throw new DataError(
      "integrity_error",
      "The stored Knowledge Commit root metadata no longer matches its ObjectRef.",
      { details: { hash: expected.hash } },
    );
  }
  const chunks: Buffer[] = [];
  const digest = createHash("sha256");
  let length = 0;
  for await (const chunk of await objects.open(expected.hash)) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > expected.byte_size || length > maximumBytes) {
      throw packedObjectMismatch(expected);
    }
    digest.update(bytes);
    chunks.push(bytes);
  }
  if (length !== expected.byte_size || `sha256:${digest.digest("hex")}` !== expected.hash) {
    throw packedObjectMismatch(expected);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new DataError("integrity_error", "The Knowledge Commit root is not valid UTF-8.");
  }
}

function renderKnowledgeMarkdown(
  collection: KnowledgeCollection,
  bundle: KnowledgeGraph,
): string {
  const publication = collection.publication;
  const frozen = bundle.collections.find(
    (candidate) => candidate.collection_id === collection.collection_id,
  ) as KnowledgeCollection;
  const nodesById = new Map(bundle.nodes.map((node) => [node.wiki_node_id, node]));
  const linksBySource = new Map<string, typeof bundle.links>();
  for (const link of bundle.links) {
    linksBySource.set(link.source_node_id, [
      ...(linksBySource.get(link.source_node_id) ?? []),
      link,
    ]);
  }
  const lines = [
    `# ${escapeMarkdownText(String(frozen.name))}`,
    "",
    ...(frozen.summary === undefined ? [] : [String(frozen.summary), ""]),
    `- Collection: \`${collection.collection_id}\``,
    `- Commit: \`${String(publication["commit_id"])}\``,
    `- Ref: \`${String(publication["ref_name"])}\``,
    `- Published: ${String(publication["published_at"])}`,
    "",
    "## Contents",
    "",
    ...frozen.node_ids.map((nodeId) => {
      const node = nodesById.get(nodeId);
      return `- ${escapeMarkdownText(String(node?.["title"] ?? nodeId))} (\`${nodeId}\`)`;
    }),
    "",
  ];
  for (const nodeId of frozen.node_ids) {
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      continue;
    }
    lines.push(
      `## ${escapeMarkdownText(String(node["title"]))}`,
      "",
      `Node: \`${node.wiki_node_id}\` · Kind: \`${String(node["kind"])}\` · Revision: ${node.revision}`,
      "",
    );
    const summary = node["summary"];
    if (typeof summary === "string" && summary.length > 0) {
      lines.push(summary, "");
    }
    lines.push(readableNodeContent(node), "");
    const related = node.related_resources;
    if (related.length > 0) {
      lines.push(
        "### Related resources",
        "",
        ...related.map((ref) => `- \`${ref.kind}:${ref.id}\``),
        "",
      );
    }
    const links = linksBySource.get(node.wiki_node_id) ?? [];
    if (links.length > 0) {
      lines.push(
        "### Links",
        "",
        ...links.map(
          (link) =>
            `- \`${String(link["relation"])}\` → \`${link.target.kind}:${link.target.id}\`` +
            (link["label"] === undefined ? "" : ` — ${String(link["label"])}`),
        ),
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderKnowledgeHtml(
  collection: KnowledgeCollection,
  bundle: KnowledgeGraph,
): string {
  const publication = collection.publication;
  const frozen = bundle.collections.find(
    (candidate) => candidate.collection_id === collection.collection_id,
  ) as KnowledgeCollection;
  const nodesById = new Map(bundle.nodes.map((node) => [node.wiki_node_id, node]));
  const linksBySource = new Map<string, typeof bundle.links>();
  for (const link of bundle.links) {
    linksBySource.set(link.source_node_id, [
      ...(linksBySource.get(link.source_node_id) ?? []),
      link,
    ]);
  }
  const nodeSections = frozen.node_ids
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node) => node !== undefined)
    .map((node) => {
      const related = node.related_resources;
      const links = linksBySource.get(node.wiki_node_id) ?? [];
      return [
        `<section id="${escapeHtml(node.wiki_node_id)}">`,
        `<h2>${escapeHtml(String(node["title"]))}</h2>`,
        `<p class="meta"><code>${escapeHtml(node.wiki_node_id)}</code> · ${escapeHtml(String(node["kind"]))} · revision ${node.revision}</p>`,
        ...(typeof node["summary"] === "string"
          ? [`<p>${escapeHtml(node["summary"] as string)}</p>`]
          : []),
        renderMarkdownFragment(readableNodeContent(node)),
        ...(related.length === 0
          ? []
          : [
              "<h3>Related resources</h3><ul>",
              ...related.map(
                (ref) => `<li><code>${escapeHtml(`${ref.kind}:${ref.id}`)}</code></li>`,
              ),
              "</ul>",
            ]),
        ...(links.length === 0
          ? []
          : [
              "<h3>Links</h3><ul>",
              ...links.map(
                (link) =>
                  `<li><code>${escapeHtml(String(link["relation"]))}</code> → <code>${escapeHtml(`${link.target.kind}:${link.target.id}`)}</code>${link["label"] === undefined ? "" : ` — ${escapeHtml(String(link["label"]))}`}</li>`,
              ),
              "</ul>",
            ]),
        "</section>",
      ].join("\n");
    })
    .join("\n");
  const contents = frozen.node_ids
    .map((nodeId) => {
      const node = nodesById.get(nodeId);
      return `<li><a href="#${escapeHtml(nodeId)}">${escapeHtml(String(node?.["title"] ?? nodeId))}</a></li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(String(frozen.name))}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:880px;margin:40px auto;padding:0 24px;color:#1f2328}code,pre{font-family:ui-monospace,monospace}pre{padding:16px;overflow:auto;background:#f6f8fa;border-radius:8px}.meta{color:#59636e}section{border-top:1px solid #d1d9e0;margin-top:32px;padding-top:20px}blockquote{border-left:4px solid #d1d9e0;margin-left:0;padding-left:16px;color:#59636e}</style>
</head>
<body>
<header>
<h1>${escapeHtml(String(frozen.name))}</h1>
${frozen.summary === undefined ? "" : `<p>${escapeHtml(String(frozen.summary))}</p>`}
<ul>
<li>Collection: <code>${escapeHtml(collection.collection_id)}</code></li>
<li>Commit: <code>${escapeHtml(String(publication["commit_id"]))}</code></li>
<li>Ref: <code>${escapeHtml(String(publication["ref_name"]))}</code></li>
<li>Published: ${escapeHtml(String(publication["published_at"]))}</li>
</ul>
</header>
<nav aria-label="Contents"><h2>Contents</h2><ul>${contents}</ul></nav>
${nodeSections}
</body>
</html>
`;
}

function readableNodeContent(node: KnowledgeGraph["nodes"][number]): string {
  const content = node["content"] as JsonObject;
  if (content["storage"] === "inline" && typeof content["text"] === "string") {
    return content["text"];
  }
  const object = content["object"] as JsonObject | undefined;
  return object === undefined
    ? "_Content is unavailable._"
    : `_Object-backed content: \`${String(object["hash"])}\`._`;
}

function renderMarkdownFragment(markdown: string): string {
  const output: string[] = [];
  const paragraph: string[] = [];
  let list: "ul" | "ol" | undefined;
  let fenced = false;
  let codeLanguage = "";
  const code: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      output.push(`<p>${paragraph.map(escapeHtml).join(" ")}</p>`);
      paragraph.length = 0;
    }
  };
  const closeList = (): void => {
    if (list !== undefined) {
      output.push(`</${list}>`);
      list = undefined;
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^```([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence !== null) {
      if (fenced) {
        output.push(
          `<pre><code${codeLanguage === "" ? "" : ` class="language-${escapeHtml(codeLanguage)}"`}>${escapeHtml(code.join("\n"))}</code></pre>`,
        );
        code.length = 0;
        fenced = false;
      } else {
        flushParagraph();
        closeList();
        fenced = true;
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }
    if (fenced) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${escapeHtml(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^[0-9]+[.)]\s+(.+)$/.exec(line);
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      const nextList = unordered === null ? "ol" : "ul";
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${escapeHtml((unordered ?? ordered)?.[1] ?? "")}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flushParagraph();
      closeList();
      output.push(`<blockquote><p>${escapeHtml(quote[1] ?? "")}</p></blockquote>`);
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      closeList();
    } else {
      paragraph.push(line.trim());
    }
  }
  if (fenced) {
    output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  closeList();
  return output.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&");
}

async function* bytesOf(bytes: Buffer): ByteStream {
  yield bytes;
}

function packedObjectMismatch(object: ObjectRef): DataError {
  return new DataError(
    "integrity_error",
    "A stored object no longer matches its ObjectRef bytes.",
    { details: { hash: object.hash } },
  );
}

function hashOf(digest: Hash): string {
  return `sha256:${digest.digest("hex")}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function hasCommit(unit: DataUnitOfWork, commitId: string): boolean {
  try {
    unit.versions.getCommit(commitId);
    return true;
  } catch (error) {
    if (isDataError(error, "not_found")) {
      return false;
    }
    throw error;
  }
}

function collectCommitClosure(
  unit: DataUnitOfWork,
  rootIds: readonly string[],
): Map<string, Commit> {
  const commits = new Map<string, Commit>();
  const pending = [...rootIds];
  while (pending.length > 0) {
    const commitId = pending.pop() as string;
    if (commits.has(commitId)) {
      continue;
    }
    const commit = unit.versions.getCommit(commitId);
    commits.set(commitId, commit);
    pending.push(...commit.manifest.parents);
  }
  return commits;
}

function orderParentFirst(commits: readonly Commit[]): Commit[] {
  const byId = new Map(commits.map((commit) => [commit.commit_id, commit]));
  const remaining = new Map(byId);
  const emitted = new Set<string>();
  const ordered: Commit[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((commit) =>
        commit.manifest.parents.every((parent) => emitted.has(parent) || !byId.has(parent)),
      )
      .sort((left, right) => (left.commit_id < right.commit_id ? -1 : 1));
    if (ready.length === 0) {
      throw new DataError("integrity_error", "The exported commit graph contains a cycle.");
    }
    for (const commit of ready) {
      ordered.push(commit);
      emitted.add(commit.commit_id);
      remaining.delete(commit.commit_id);
    }
  }
  return ordered;
}

function packProtocolVersion(
  commits: readonly Commit[],
): { readonly major: number; readonly minor: number } {
  const versions = commits.map((commit) => commit.manifest.protocol_version);
  const major = versions[0]?.major ?? 1;
  if (versions.some((version) => version.major !== major)) {
    throw new DataError(
      "integrity_error",
      "Pack commits span more than one protocol major version.",
    );
  }
  return { major, minor: Math.max(...versions.map((version) => version.minor)) };
}

function assertManifestCoherence(manifest: PackManifestWire): void {
  const fail = (message: string, details: JsonObject = {}): never => {
    throw new DataError("integrity_error", message, { details });
  };
  if (manifest.mode === "full") {
    if (manifest.prerequisite_commit_ids.length > 0 || manifest.omitted_objects.length > 0) {
      fail("A full pack cannot declare prerequisites or omitted objects.");
    }
  } else if (manifest.prerequisite_commit_ids.length === 0) {
    fail("A thin pack must declare its prerequisite commits.");
  }

  const commitIds = new Set<string>();
  for (const commit of manifest.commits) {
    if (commitIds.has(commit.commit_id)) {
      fail("The pack lists one commit twice.", { commit_id: commit.commit_id });
    }
    commitIds.add(commit.commit_id);
  }

  const availableHashes = new Set<string>();
  for (const list of [manifest.objects, manifest.omitted_objects]) {
    for (const object of list) {
      if (availableHashes.has(object.hash)) {
        fail("The pack lists one object twice.", { hash: object.hash });
      }
      availableHashes.add(object.hash);
    }
  }
  const includedHashes = manifest.objects.map((object) => object.hash);
  const sortedHashes = [...includedHashes].sort();
  if (includedHashes.some((hash, index) => hash !== sortedHashes[index])) {
    fail("Pack objects must be sorted by hash.");
  }
  for (const commit of manifest.commits) {
    for (const hash of commit.manifest.object_hashes) {
      if (!availableHashes.has(hash)) {
        fail("A pack commit references an object the pack does not account for.", {
          commit_id: commit.commit_id,
          hash,
        });
      }
    }
  }

  const refNames = new Set<string>();
  for (const ref of manifest.refs) {
    if (refNames.has(ref.name)) {
      fail("The pack lists one ref twice.", { ref_name: ref.name });
    }
    refNames.add(ref.name);
  }
}

function putMetadataFor(object: ObjectRef): ObjectPutMetadata {
  return {
    expected_hash: object.hash,
    media_type: object.media_type,
    compression: object.compression,
    ...(object.decoded_byte_size === undefined
      ? {}
      : { decoded_byte_size: object.decoded_byte_size }),
    ...(object.encryption === undefined ? {} : { encryption: object.encryption }),
    ...(object.redaction_profile === undefined
      ? {}
      : { redaction_profile: object.redaction_profile }),
    ...(object.logical_name === undefined ? {} : { logical_name: object.logical_name }),
    extensions: object.extensions,
  };
}

/** Sequential pack reader with a running digest over every pre-trailer byte. */
class PackByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #chunks: Buffer[] = [];
  #offset = 0;
  #available = 0;
  #ended = false;
  #digest: Hash | undefined = createHash("sha256");
  #digestHex: string | undefined;

  constructor(stream: ByteStream) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async readLine(limit: number, label: string): Promise<string> {
    const bytes: Buffer[] = [];
    let length = 0;
    for (;;) {
      const chunk = await this.#take(limit - length + 1);
      if (chunk === undefined) {
        throw truncated(label);
      }
      const lineFeedIndex = chunk.indexOf(LINE_FEED);
      if (lineFeedIndex >= 0) {
        bytes.push(chunk.subarray(0, lineFeedIndex));
        this.#unshift(chunk.subarray(lineFeedIndex + 1));
        this.#consume(chunk.subarray(0, lineFeedIndex + 1));
        return Buffer.concat(bytes).toString("utf8");
      }
      length += chunk.byteLength;
      if (length > limit) {
        throw new DataError("integrity_error", `The ${label} line exceeds its size limit.`);
      }
      bytes.push(chunk);
      this.#consume(chunk);
    }
  }

  async readUtf8(length: number, label: string): Promise<string> {
    const bytes: Buffer[] = [];
    for await (const chunk of this.readExact(length, label)) {
      bytes.push(Buffer.from(chunk));
    }
    return Buffer.concat(bytes).toString("utf8");
  }

  async *readExact(length: number, label = "pack object payload"): ByteStream {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.#take(remaining);
      if (chunk === undefined) {
        throw truncated(label);
      }
      remaining -= chunk.byteLength;
      this.#consume(chunk);
      yield chunk;
    }
  }

  async expectLineFeed(label: string): Promise<void> {
    const chunk = await this.#take(1);
    if (chunk === undefined || chunk[0] !== LINE_FEED) {
      throw new DataError("integrity_error", `The ${label} must end with one line feed.`);
    }
    this.#consume(chunk);
  }

  async expectEnd(label: string): Promise<void> {
    const chunk = await this.#take(1);
    if (chunk !== undefined) {
      throw new DataError("integrity_error", `The pack has bytes after its ${label}.`);
    }
  }

  finalizeDigest(): string {
    if (this.#digest === undefined) {
      throw new DataError("internal", "The pack digest was already finalized.");
    }
    this.#digestHex = this.#digest.digest("hex");
    this.#digest = undefined;
    return this.#digestHex;
  }

  /** Releases the underlying object stream even when parsing stops early. */
  async close(): Promise<void> {
    await this.#iterator.return?.();
  }

  #consume(bytes: Buffer): void {
    this.#digest?.update(bytes);
  }

  #unshift(rest: Buffer): void {
    if (rest.byteLength === 0) {
      return;
    }
    this.#chunks.unshift(rest);
    this.#offset = 0;
    this.#available += rest.byteLength;
  }

  /** Returns up to `max` buffered bytes, or undefined at the end of the stream. */
  async #take(max: number): Promise<Buffer | undefined> {
    while (this.#available === 0) {
      if (this.#ended) {
        return undefined;
      }
      const next = await this.#iterator.next();
      if (next.done === true) {
        this.#ended = true;
        return undefined;
      }
      const bytes = Buffer.from(next.value);
      if (bytes.byteLength === 0) {
        continue;
      }
      this.#chunks.push(bytes);
      this.#available += bytes.byteLength;
    }
    const head = this.#chunks[0] as Buffer;
    const view = head.subarray(this.#offset, Math.min(this.#offset + max, head.byteLength));
    this.#offset += view.byteLength;
    this.#available -= view.byteLength;
    if (this.#offset === head.byteLength) {
      this.#chunks.shift();
      this.#offset = 0;
    }
    return view;
  }
}

function truncated(label: string): DataError {
  return new DataError("integrity_error", `The pack ends before its ${label} is complete.`);
}
