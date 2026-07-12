import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isDataError } from "../../data/api/index.js";
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
