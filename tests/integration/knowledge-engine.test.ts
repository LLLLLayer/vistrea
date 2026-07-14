import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  isDataError,
  type CommitManifest,
  type ObjectStore,
  type RefUpdatePrecondition,
} from "../../data/api/index.js";
import {
  MemoryDataStore,
  SequenceClock,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import { KnowledgeEngine } from "../../engine/knowledge/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const AUTHOR = { kind: "human", id: "designer-1", extensions: {} };
const AGENT = { kind: "agent", id: "vistrea-knowledge-agent", extensions: {} };
const COLLECTION_REF = "teams/design/runtime-knowledge";

async function readObject(objects: ObjectStore, hash: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await objects.open(hash)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function knowledgeEngine(): Promise<KnowledgeEngine> {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T16:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(700),
  });
  return new KnowledgeEngine({
    workspace,
    validator,
    ids: new SequenceIdGenerator(200),
  });
}

test("wiki nodes live through revisioned drafts, publication, search, and archival", async () => {
  const engine = await knowledgeEngine();

  const created = engine.createNode({
    kind: "screen",
    title: "Checkout confirmation",
    slug: "checkout-confirmation",
    summary: "Runtime behavior for the confirmation screen.",
    markdown: "# Checkout confirmation\n\nThe success banner is transient.",
    labels: ["checkout", "runtime"],
    related_resources: [
      { kind: "screen_state", id: "screenstate_019f0000-0000-7000-8000-000000000001" },
    ],
    created_by: AUTHOR,
  });
  assert.equal(created.revision, 1);
  assert.equal(created["status"], "draft");
  assert.match(created.wiki_node_id, /^wiki_/);

  // Stale revisions conflict instead of silently overwriting knowledge.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.updateNode({
        wiki_node_id: created.wiki_node_id,
        expected_revision: 99,
        title: "Wrong",
        updated_by: AUTHOR,
      }),
    ),
    (error: unknown) => isDataError(error, "conflict"),
  );

  const published = engine.updateNode({
    wiki_node_id: created.wiki_node_id,
    expected_revision: 1,
    markdown: "# Checkout confirmation\n\nThe banner auto-dismisses after two seconds.",
    to_status: "published",
    updated_by: AGENT,
  });
  assert.equal(published.revision, 2);
  assert.equal(published["status"], "published");
  assert.equal(
    (published["content"] as { text: string }).text.includes("auto-dismisses"),
    true,
  );

  // Published knowledge cannot jump back to draft; it archives and revives.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.updateNode({
        wiki_node_id: created.wiki_node_id,
        expected_revision: 2,
        to_status: "draft",
        updated_by: AUTHOR,
      }),
    ),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
  const archived = engine.updateNode({
    wiki_node_id: created.wiki_node_id,
    expected_revision: 2,
    to_status: "archived",
    updated_by: AUTHOR,
  });
  assert.equal(archived["status"], "archived");
  assert.equal(engine.getNode(created.wiki_node_id)["status"], "archived");

  const component = engine.createNode({
    kind: "component",
    title: "Success banner",
    markdown: "The banner appears after a successful checkout.",
    labels: ["component", "transient"],
    created_by: AGENT,
  });

  const byText = engine.listNodes({ text: "auto-dismisses" });
  assert.deepEqual(
    byText.items.map((node) => node.wiki_node_id),
    [created.wiki_node_id],
  );
  const byLabel = engine.listNodes({ labels: ["transient"] });
  assert.deepEqual(
    byLabel.items.map((node) => node.wiki_node_id),
    [component.wiki_node_id],
  );
  const byStatus = engine.listNodes({ statuses: ["draft"], kinds: ["component"] });
  assert.equal(byStatus.items.length, 1);
  assert.equal(engine.listNodes({ text: "no-such-phrase" }).items.length, 0);
});

test("wiki links bind knowledge to resources with backlinks and related lookups", async () => {
  const engine = await knowledgeEngine();
  const screen = engine.createNode({
    kind: "screen",
    title: "Home",
    markdown: "The Home screen.",
    related_resources: [
      { kind: "screen_state", id: "screenstate_019f0000-0000-7000-8000-000000000001" },
    ],
    created_by: AUTHOR,
  });
  const component = engine.createNode({
    kind: "component",
    title: "Open catalog button",
    markdown: "Primary navigation entry point.",
    created_by: AUTHOR,
  });

  // Links to missing Wiki Nodes fail closed.
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.linkNode({
        source_node_id: screen.wiki_node_id,
        target: { kind: "wiki_node", id: "wiki_019f0000-0000-7000-8000-00000000dead" },
        relation: "documents",
        created_by: AUTHOR,
      }),
    ),
    (error: unknown) => isDataError(error, "not_found"),
  );

  const link = engine.linkNode({
    source_node_id: screen.wiki_node_id,
    target: { kind: "wiki_node", id: component.wiki_node_id },
    relation: "documents",
    label: "Component details",
    created_by: AUTHOR,
  });
  engine.linkNode({
    source_node_id: component.wiki_node_id,
    target: { kind: "screen_state", id: "screenstate_019f0000-0000-7000-8000-000000000001" },
    relation: "evidence_for",
    created_by: AGENT,
  });

  const backlinks = engine.backlinks(component.wiki_node_id);
  assert.deepEqual(
    backlinks.items.map((item) => item.wiki_link_id),
    [link.wiki_link_id],
  );
  const related = engine.relatedTo({
    kind: "screen_state",
    id: "screenstate_019f0000-0000-7000-8000-000000000001",
  });
  assert.deepEqual(
    related.items.map((node) => node.wiki_node_id),
    [screen.wiki_node_id],
  );

  engine.unlinkNode({ wiki_link_id: link.wiki_link_id, expected_revision: 1 });
  assert.equal(engine.backlinks(component.wiki_node_id).items.length, 0);
  await assert.rejects(
    Promise.resolve().then(() =>
      engine.unlinkNode({ wiki_link_id: link.wiki_link_id, expected_revision: 2 }),
    ),
    (error: unknown) => isDataError(error, "not_found"),
  );
});

test("the Deep Wiki survives production Workspace reopen", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-wiki-workspace-"));
  t.after(async () => fs.rm(workspaceRoot, { recursive: true, force: true }));

  let workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  let nodeId: string;
  try {
    const engine = new KnowledgeEngine({ workspace: workspace.data, validator });
    const node = engine.createNode({
      kind: "note",
      title: "Persisted note",
      markdown: "Reopen evidence.",
      created_by: AUTHOR,
    });
    nodeId = node.wiki_node_id;
    engine.linkNode({
      source_node_id: nodeId,
      target: { kind: "snapshot", id: "snapshot_019f0000-0000-7000-8000-000000000001" },
      relation: "evidence_for",
      created_by: AUTHOR,
    });
  } finally {
    await workspace.close();
  }

  workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  try {
    const engine = new KnowledgeEngine({ workspace: workspace.data, validator });
    const reopened = engine.getNode(nodeId);
    assert.equal(reopened["title"], "Persisted note");
    assert.equal(engine.listNodes({ text: "reopen evidence" }).items.length, 1);
    const related = engine.relatedTo({
      kind: "snapshot",
      id: "snapshot_019f0000-0000-7000-8000-000000000001",
    });
    // Related lookups match node related_resources, not link targets.
    assert.equal(related.items.length, 0);
  } finally {
    await workspace.close();
  }
});

test("a Knowledge Collection publishes through Commit/Ref identity and exports immutable readable views", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-collection-workspace-"));
  const clock = new SequenceClock("2026-07-14T08:00:00.000Z", 1_000);
  const workspace = await LocalDataWorkspace.open({
    workspaceRoot,
    validator,
    clock,
    ids: new SequenceIdGenerator(8_000),
  });
  t.after(async () => {
    await workspace.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const seed = workspace.data.beginUnitOfWork("write");
  const base = seed.versions.createCommit({
    protocol_version: { major: 1, minor: 0 },
    parents: [],
    created_at: clock.now(),
    author: AUTHOR,
    message: "Create the runtime knowledge publication line.",
    roots: {},
    object_hashes: [],
    extensions: {},
  } as unknown as CommitManifest);
  seed.versions.updateRef(COLLECTION_REF, base.commit_id, {
    mode: "must_not_exist",
  } as unknown as RefUpdatePrecondition);
  seed.commit();

  const engine = new KnowledgeEngine({
    workspace: workspace.data,
    objects: workspace.objects,
    validator,
    ids: new SequenceIdGenerator(9_000),
  });
  const draftNode = engine.createNode({
    kind: "screen",
    title: "Storefront search",
    markdown: "# Search behavior\n\n<script>alert('unsafe')</script>\n\n- Type a query.\n- Clear it.",
    related_resources: [{ kind: "screen_state", id: "screenstate_019f0000-0000-7000-8000-000000000001" }],
    created_by: AUTHOR,
  });
  const node = engine.updateNode({
    wiki_node_id: draftNode.wiki_node_id,
    expected_revision: draftNode.revision,
    to_status: "published",
    updated_by: AGENT,
  });
  const collection = engine.createCollection({
    name: "Storefront runtime knowledge",
    summary: "Approved Storefront behavior and evidence.",
    node_ids: [node.wiki_node_id],
    entry_node_ids: [node.wiki_node_id],
    created_by: AUTHOR,
  });
  assert.equal(collection.publication["state"], "draft");
  assert.deepEqual(engine.listCollections({ publication_states: ["draft"] }).items, [collection]);

  const publication = await engine.publishCollection({
    collection_id: collection.collection_id,
    expected_revision: collection.revision,
    base_commit_id: base.commit_id,
    target_ref_name: COLLECTION_REF,
    ref_precondition: {
      mode: "must_match",
      expected_commit_id: base.commit_id,
    } as unknown as RefUpdatePrecondition,
    published_by: AGENT,
    message: "Publish the approved Storefront runtime knowledge.",
  });
  assert.equal(publication.collection.revision, 2);
  assert.equal(publication.collection.publication["state"], "published");
  assert.equal(publication.collection.publication["commit_id"], publication.commit.commit_id);
  assert.equal(publication.ref.commit_id, publication.commit.commit_id);
  assert.deepEqual(publication.commit.manifest.parents, [base.commit_id]);
  assert.deepEqual(publication.commit.manifest.roots["wiki"], publication.bundle_root);
  assert.ok(publication.commit.manifest.object_hashes.includes(publication.bundle_root.hash));

  const frozenBundle = JSON.parse(
    await readObject(workspace.objects, publication.bundle_root.hash),
  ) as Record<string, unknown>;
  const frozenCollections = frozenBundle["collections"] as readonly Record<string, unknown>[];
  assert.equal(frozenCollections[0]?.["revision"], 1);
  assert.equal(
    (frozenCollections[0]?.["publication"] as Record<string, unknown>)["state"],
    "draft",
  );

  const exports = await workspace.exchange.exportReadable({
    collection_id: collection.collection_id,
    formats: ["markdown", "html"],
  });
  assert.deepEqual(exports.map((object) => object.media_type), ["text/markdown", "text/html"]);
  const markdown = await readObject(workspace.objects, exports[0]?.hash as string);
  const html = await readObject(workspace.objects, exports[1]?.hash as string);
  assert.match(markdown, /# Storefront runtime knowledge/);
  assert.match(markdown, new RegExp(publication.commit.commit_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(markdown, /Type a query/);
  assert.match(html, /<!doctype html>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&#39;unsafe&#39;\)&lt;\/script&gt;/);

  const nextDraft = engine.updateCollection({
    collection_id: publication.collection.collection_id,
    expected_revision: publication.collection.revision,
    summary: "A new unpublished revision.",
    updated_by: AUTHOR,
  });
  assert.equal(nextDraft.publication["state"], "draft");
  await assert.rejects(
    () => workspace.exchange.exportReadable({ collection_id: nextDraft.collection_id }),
    (error: unknown) => isDataError(error, "conflict"),
  );
});
