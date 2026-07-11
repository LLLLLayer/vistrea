import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  canonicalizeIdentityJson,
  runSemanticChecks,
  sha256,
} from "../../tools/protocol/semantic-checks.mjs";
import { validateFixtureSet } from "../../tools/protocol/validate-fixtures.mjs";
import { parseJsonStrict } from "../../tools/protocol/strict-json.mjs";

test("all protocol fixtures match their declared expectation", async () => {
  const report = await validateFixtureSet({ silent: true });
  assert.deepEqual(report.failures, []);
});

test("Workspace bootstrap fixtures share one parentless genesis and default ref", async () => {
  const fixtureRoot = new URL("../../protocol/fixtures/v1/", import.meta.url);
  const readFixture = async (relativePath) =>
    parseJsonStrict(await fs.readFile(new URL(relativePath, fixtureRoot)), relativePath);
  const [workspace, commit, ref, workingSet] = await Promise.all([
    readFixture("workspace/valid/local.json"),
    readFixture("commit/valid/initial.json"),
    readFixture("ref/valid/team-main.json"),
    readFixture("working-set/valid/after-genesis.json"),
  ]);

  assert.equal(workspace.genesis_commit_id, commit.commit_id);
  assert.deepEqual(commit.manifest.parents, []);
  assert.equal(workspace.default_ref_name, ref.name);
  assert.equal(ref.commit_id, commit.commit_id);
  assert.equal(workingSet.base_commit_id, commit.commit_id);
});

test("identity JSON canonicalization sorts object keys and preserves array order", () => {
  const value = { z: 1, a: { second: true, first: [2, 1] } };
  assert.equal(canonicalizeIdentityJson(value), '{"a":{"first":[2,1],"second":true},"z":1}');
});

test("identity JSON canonicalization sorts by Unicode code point", () => {
  const value = { "𐀀": 2, "": 1 };
  assert.equal(canonicalizeIdentityJson(value), '{"":1,"𐀀":2}');
});

test("identity JSON rejects floating point numbers", () => {
  assert.throws(() => canonicalizeIdentityJson({ value: 1.5 }), /safe integers/);
});

test("sha256 uses lowercase hexadecimal", () => {
  assert.equal(
    sha256(Buffer.from("Vistrea", "utf8")),
    "b0cd09405ae15f1cfb3f4b291002921832c81e26ed7f308c56b5c1eb5a791de5",
  );
});

function semanticSnapshot(trees, screenshot) {
  return {
    display: {
      logical_size: { width: 100, height: 200 },
      pixel_size: { width: 200, height: 400 },
      pixel_scale_x: 2,
      pixel_scale_y: 2,
    },
    trees,
    ...(screenshot ? { screenshot } : {}),
  };
}

function semanticTree(treeId, nodes, rootNodeIds = [nodes[0].node_id]) {
  return {
    tree_id: treeId,
    root_node_ids: rootNodeIds,
    payload: { inline_nodes: nodes },
    capture_limitations: [],
  };
}

function semanticNode(nodeId, { parent_id, child_ids = [], related_nodes = [] } = {}) {
  return {
    node_id: nodeId,
    ...(parent_id ? { parent_id } : {}),
    child_ids,
    related_nodes,
  };
}

test("node IDs are unique across every inline tree in a Snapshot", () => {
  const snapshot = semanticSnapshot([
    semanticTree("semantic-tree", [semanticNode("shared-node")]),
    semanticTree("view-tree", [semanticNode("shared-node")]),
  ]);

  assert.ok(
    runSemanticChecks("runtime-snapshot", snapshot).some(
      (error) => error.code === "duplicate_node_id",
    ),
  );
});

test("related-node references reject a missing target tree", () => {
  const snapshot = semanticSnapshot([
    semanticTree("semantic-tree", [
      semanticNode("node-1", {
        related_nodes: [{ tree_id: "missing-tree", node_id: "missing-node" }],
      }),
    ]),
  ]);

  assert.ok(
    runSemanticChecks("runtime-snapshot", snapshot).some(
      (error) => error.code === "dangling_related_tree_reference",
    ),
  );
});

test("object-backed trees require a validated resolver before semantic success", () => {
  const tree = {
    tree_id: "object-tree",
    root_node_ids: ["node-1"],
    payload: {
      nodes_object: { hash: "sha256:fixture" },
      node_count: 1,
      encoding: "vistrea.ui-nodes+json",
    },
    capture_limitations: [],
  };
  const snapshot = semanticSnapshot([tree]);
  assert.ok(
    runSemanticChecks("runtime-snapshot", snapshot).some(
      (error) => error.code === "tree_payload_unresolved",
    ),
  );
  assert.deepEqual(
    runSemanticChecks("runtime-snapshot", snapshot, {
      resolveUiNodes: () => [semanticNode("node-1")],
    }),
    [],
  );
});

test("deep flat trees are checked without recursive stack growth", () => {
  const nodeCount = 15_000;
  const nodes = Array.from({ length: nodeCount }, (_, index) =>
    semanticNode(`node-${index}`, {
      ...(index > 0 ? { parent_id: `node-${index - 1}` } : {}),
      child_ids: index + 1 < nodeCount ? [`node-${index + 1}`] : [],
    }),
  );
  const snapshot = semanticSnapshot([semanticTree("deep-tree", nodes)]);

  assert.deepEqual(runSemanticChecks("runtime-snapshot", snapshot), []);
});

test("partial screenshot coverage must stay in bounds and align to pixels", () => {
  const snapshot = semanticSnapshot(
    [semanticTree("semantic-tree", [semanticNode("node-1")])],
    {
      coverage: { x: 90.25, y: 0, width: 20, height: 10 },
      pixel_size: { width: 40, height: 20 },
    },
  );
  const codes = new Set(
    runSemanticChecks("runtime-snapshot", snapshot).map((error) => error.code),
  );

  assert.ok(codes.has("screenshot_coverage_out_of_bounds"));
  assert.ok(codes.has("screenshot_coverage_not_pixel_aligned"));
});

test("semantic check dispatch rejects unknown kinds", () => {
  assert.throws(() => runSemanticChecks("unknown-kind", {}), /Unknown semantic check kind/);
});
