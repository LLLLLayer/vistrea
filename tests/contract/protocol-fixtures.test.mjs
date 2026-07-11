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

test("DataUnitOfWork model coverage freezes the complete repository set", async () => {
  const report = await validateFixtureSet({ silent: true });
  assert.deepEqual(Object.keys(report.modelCoverage.repositories).sort(), [
    "design_reviews",
    "observations",
    "operations",
    "runtime_events",
    "screen_graph",
    "snapshots",
    "validation",
    "versions",
    "wiki",
  ]);
  for (const references of Object.values(report.modelCoverage.repositories)) {
    assert.ok(references.length > 0);
    assert.equal(new Set(references).size, references.length);
  }
});

test("Phase 0A2 failure fixtures exercise cross-model semantic guards", async () => {
  const report = await validateFixtureSet({ silent: true });
  const expected = new Map([
    ["knowledge/invalid/dangling-link.json", "wiki_link_target_missing"],
    ["design/invalid/issue-illegal-transition.json", "review_issue_transition_invalid"],
    [
      "design/invalid/terminal-tuning-not-reverted.json",
      "tuning_application_reversion_incomplete",
    ],
    [
      "design/invalid/tuning-patch-property-value-mismatch.json",
      "tuning_change_property_value_mismatch",
    ],
    ["validation/invalid/bundle-mismatched-run.json", "validation_finding_run_mismatch"],
    ["operation/invalid/inline-result-schema-mismatch.json", "operation_result_value_invalid"],
    ["operation/invalid/progress-without-started.json", "operation_started_event_missing"],
    ["working-set/invalid/duplicate-change-id.json", "duplicate_working_change_id"],
  ]);

  for (const [fixturePath, code] of expected) {
    const result = report.results.find(({ path }) => path === fixturePath);
    assert.equal(result?.passed, true, fixturePath);
    assert.ok(result.semanticErrors.some((error) => error.code === code), fixturePath);
  }
});

test("Phase 0A2 direct semantic guards fail closed", async () => {
  const fixtureRoot = new URL("../../protocol/fixtures/v1/", import.meta.url);
  const finding = parseJsonStrict(
    await fs.readFile(new URL("validation/valid/finding-with-evidence.json", fixtureRoot)),
  );
  finding.status = "resolved";
  finding.resolved_at = "2026-07-12T01:59:59.000Z";
  assert.ok(
    runSemanticChecks("validation-finding", finding).some(
      (error) => error.code === "validation_finding_time_order_invalid",
    ),
  );

  const validationRun = parseJsonStrict(
    await fs.readFile(new URL("validation/valid/run-succeeded.json", fixtureRoot)),
  );
  validationRun.created_at = "2026-07-12T02:10:00.000000002Z";
  validationRun.started_at = "2026-07-12T02:10:00.000000001Z";
  assert.ok(
    runSemanticChecks("validation-run", validationRun).some(
      (error) => error.code === "validation_run_time_order_invalid",
    ),
  );

  const operation = parseJsonStrict(
    await fs.readFile(new URL("operation/valid/succeeded-inline.json", fixtureRoot)),
  );
  operation.result.result_type = "UnexpectedResult";
  assert.ok(
    runSemanticChecks("operation-record", operation).some(
      (error) => error.code === "operation_result_type_mismatch",
    ),
  );
  operation.result.result_type = "ValidationRun";
  operation.result.value = { validation_run_id: "validationrun_missing_fields" };
  assert.ok(
    runSemanticChecks("operation-record", operation).some(
      (error) => error.code === "operation_result_schema_unresolved",
    ),
  );

  const graph = parseJsonStrict(
    await fs.readFile(new URL("graph/valid/coherent.json", fixtureRoot)),
  );
  graph.observations.push({
    ...structuredClone(graph.observations[1]),
    observation_id: "observation_019f2000-0000-7000-8000-000000000099",
  });
  assert.ok(
    runSemanticChecks("screen-graph", graph).some(
      (error) => error.code === "graph_transition_observation_mismatch",
    ),
  );

  const design = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  const color = (red) => ({
    kind: "color_rgba",
    value: { red, green: 0, blue: 0, alpha: 1 },
    color_space: "srgb",
    extensions: {},
  });
  design.patches[0].changes[0].original_value = color(0.2);
  design.patches[0].changes[0].preview_value = color(0.4);
  assert.ok(
    runSemanticChecks("design-review-bundle", design).some(
      (error) => error.code === "tuning_change_property_value_mismatch",
    ),
  );

  const designWithDifference = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  designWithDifference.comparisons.push({
    comparison_id: "comparison_019f0000-0000-7600-8000-000000000699",
    protocol_version: { major: 1, minor: 0 },
    revision: 1,
    design_reference_id: designWithDifference.references[0].design_reference_id,
    target_snapshot_id: designWithDifference.mappings[0].runtime_target.snapshot_id,
    quality: "complete",
    mapping_ids: [designWithDifference.mappings[0].mapping_id],
    differences: [
      {
        difference_id: "difference_019f0000-0000-7600-8000-000000000699",
        mapping_id: "mapping_019f0000-0000-7600-8000-000000000699",
        category: "alpha",
        severity: "minor",
        expected: { kind: "number", value: 0.8, unit: "ratio", extensions: {} },
        actual: { kind: "number", value: 1, unit: "ratio", extensions: {} },
        evidence: [],
        extensions: {},
      },
    ],
    evidence: [],
    completed_at: "2026-07-12T02:07:00Z",
    completed_by: { kind: "agent", id: "contract-test", extensions: {} },
    extensions: {},
  });
  assert.ok(
    runSemanticChecks("design-review-bundle", designWithDifference).some(
      (error) => error.code === "design_difference_mapping_missing",
    ),
  );

  const designWithWrongMapping = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  designWithWrongMapping.references.push({
    ...structuredClone(designWithWrongMapping.references[0]),
    design_reference_id: "designref_019f0000-0000-7600-8000-000000000698",
  });
  designWithWrongMapping.issues[0].design_reference_id =
    "designref_019f0000-0000-7600-8000-000000000698";
  assert.ok(
    runSemanticChecks("design-review-bundle", designWithWrongMapping).some(
      (error) => error.code === "design_mapping_target_mismatch",
    ),
  );

  const patchWithDuplicateTarget = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  const duplicateTargetChange = {
    ...structuredClone(patchWithDuplicateTarget.patches[0].changes[0]),
    tuning_change_id: "tuningchange_019f0000-0000-7600-8000-000000000698",
    preview_value: { kind: "number", value: 0.7, unit: "ratio", extensions: {} },
  };
  delete duplicateTargetChange.runtime_target.stable_id;
  patchWithDuplicateTarget.patches[0].changes.push(duplicateTargetChange);
  assert.ok(
    runSemanticChecks("design-review-bundle", patchWithDuplicateTarget).some(
      (error) => error.code === "duplicate_tuning_property_target",
    ),
  );

  const designWithReversedApplicationTime = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  designWithReversedApplicationTime.applications[0].started_at = "2026-07-12T02:03:02Z";
  assert.ok(
    runSemanticChecks("design-review-bundle", designWithReversedApplicationTime).some(
      (error) => error.code === "tuning_application_time_order_invalid",
    ),
  );

  const designWithContradictoryResolution = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  designWithContradictoryResolution.issues[0].state = "wont_fix";
  designWithContradictoryResolution.issues[0].state_history.at(-1).to_state = "wont_fix";
  assert.ok(
    runSemanticChecks("design-review-bundle", designWithContradictoryResolution).some(
      (error) => error.code === "review_issue_resolution_mismatch",
    ),
  );

  const designWithFutureHistory = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  designWithFutureHistory.issues[0].state_history.at(-1).changed_at =
    "2027-07-12T02:06:00Z";
  designWithFutureHistory.issues[0].resolution.resolved_at = "2027-07-12T02:06:00Z";
  assert.ok(
    runSemanticChecks("design-review-bundle", designWithFutureHistory).some(
      (error) => error.code === "design_timestamp_order_invalid",
    ),
  );

  const prematurelyExpiredApplication = parseJsonStrict(
    await fs.readFile(new URL("design/valid/review-bundle.json", fixtureRoot)),
  );
  const expiredApplication = prematurelyExpiredApplication.applications[0];
  expiredApplication.status = "expired";
  expiredApplication.reversion_reason = "explicit_revert";
  expiredApplication.reverted_at = "2026-07-12T02:04:00Z";
  expiredApplication.applied_changes[0].reverted_at = "2026-07-12T02:04:00Z";
  assert.ok(
    runSemanticChecks("design-review-bundle", prematurelyExpiredApplication).some(
      (error) => error.code === "tuning_application_state_invalid",
    ),
  );

  const findingWithFutureEvidence = parseJsonStrict(
    await fs.readFile(new URL("validation/valid/finding-with-evidence.json", fixtureRoot)),
  );
  findingWithFutureEvidence.evidence[0].captured_at = "2027-07-12T02:00:00Z";
  assert.ok(
    runSemanticChecks("validation-finding", findingWithFutureEvidence).some(
      (error) => error.code === "validation_evidence_time_invalid",
    ),
  );
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
