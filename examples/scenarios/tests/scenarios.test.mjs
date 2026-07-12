import assert from "node:assert/strict";
import test from "node:test";

import {
  loadScenarioSuite,
  requiredCoverage,
  requiredProfileIds,
  requiredScenarioIds,
  validateScenarioSuite,
  validateSuiteSemantics
} from "../validate.mjs";

function codes(issues) {
  return new Set(issues.map((finding) => finding.code));
}

test("the repository scenario suite passes schema and semantic validation", async () => {
  const result = await validateScenarioSuite();

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.equal(result.scenarioCount, 12);
  assert.equal(result.profileCount, 6);
  assert.equal(result.artifactCount, 66);
  assert.deepEqual(result.coverage, [...requiredCoverage].sort());
});

test("the manifest freezes required shared IDs, profiles, and platform parity", async () => {
  const suite = await loadScenarioSuite();
  const entries = new Map(suite.manifest.scenarios.map((entry) => [entry.scenario_id, entry]));

  assert.deepEqual(
    suite.manifest.profiles.map((profile) => profile.profile_id).sort(),
    [...requiredProfileIds].sort()
  );
  assert.deepEqual(
    suite.manifest.scenarios.filter((entry) => entry.required).map((entry) => entry.scenario_id).sort(),
    [...requiredScenarioIds].sort()
  );

  for (const scenario of suite.scenarios.map((entry) => entry.value)) {
    assert.equal(entries.get(scenario.scenario_id).required, true);
    assert.equal(scenario.platform_support.ios.status, "required");
    assert.equal(scenario.platform_support.android.status, "required");
    assert.deepEqual(
      [...scenario.platform_support.ios.capabilities].sort(),
      [...scenario.platform_support.android.capabilities].sort()
    );
  }

  for (const platform of ["ios", "android"]) {
    assert.equal(suite.manifest.platforms[platform].implementation_status, "in-progress");
    assert.equal(suite.manifest.platforms[platform].capabilities["runtime.snapshot"], "verified");
    assert.equal(suite.manifest.platforms[platform].capabilities["runtime.connection"], "verified");
  }
});

test("both native first loops cover SDK to Host to Studio to Data reopen with shared artifacts", async () => {
  const suite = await loadScenarioSuite();
  const loops = new Map(
    suite.manifest.vertical_loops.map((loop) => [loop.loop_id, loop])
  );

  assert.deepEqual([...loops.keys()].sort(), [
    "android.first-snapshot-loop",
    "ios.first-snapshot-loop"
  ]);
  for (const [platform, loopId] of [
    ["ios", "ios.first-snapshot-loop"],
    ["android", "android.first-snapshot-loop"]
  ]) {
    const loop = loops.get(loopId);
    assert.equal(loop.platform, platform);
    assert.equal(loop.status, "verified");
    assert.deepEqual(loop.scenario_ids, ["demo.navigation.basic"]);
    assert.deepEqual([...loop.required_capabilities].sort(), [
      "runtime.connection",
      "runtime.snapshot"
    ]);
    assert.deepEqual(loop.stages, [
      "demo-app-launch",
      "sdk-connect",
      "snapshot-capture",
      "host-receive",
      "studio-render",
      "data-persist",
      "data-reopen"
    ]);
    assert.deepEqual(loop.artifact_keys, [
      "demo.navigation.basic.snapshot.home",
      "demo.navigation.basic.screenshot.home"
    ]);
  }
});

test("semantic validation requires verified capabilities for every verified loop", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  suite.manifest.platforms.android.capabilities["runtime.connection"] = "implemented";

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("verified_loop_capability_unverified"), true);
});

test("semantic validation preserves the exact Android first-loop contract", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  const loop = suite.manifest.vertical_loops.find(
    (candidate) => candidate.loop_id === "android.first-snapshot-loop"
  );
  loop.stages = loop.stages.filter((stage) => stage !== "studio-render");

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("android_first_loop_stage_mismatch"), true);
});

test("semantic validation rejects dangling state references", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  const navigation = suite.scenarios.find(
    (entry) => entry.value.scenario_id === "demo.navigation.basic"
  ).value;
  navigation.steps[1].to_state_id = "demo.state.missing";

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("unknown_step_state"), true);
});

test("semantic validation requires deterministic artifacts for declared coverage", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  const navigation = suite.scenarios.find(
    (entry) => entry.value.scenario_id === "demo.navigation.basic"
  ).value;
  navigation.expected_artifacts = navigation.expected_artifacts.filter(
    (artifact) => artifact.kind !== "screen-graph"
  );

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("missing_coverage_artifact"), true);
});

test("semantic validation binds each Snapshot expectation to a deterministic artifact", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  const success = suite.scenarios.find(
    (entry) => entry.value.scenario_id === "demo.transient.success"
  ).value;
  success.expected_artifacts = success.expected_artifacts.filter(
    (artifact) => artifact.artifact_key !== "demo.transient.success.snapshot.dismissed"
  );

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("missing_snapshot_artifact"), true);
});

test("semantic validation binds each validation profile to a result artifact", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  const accessibility = suite.scenarios.find(
    (entry) => entry.value.scenario_id === "demo.accessibility.defects"
  ).value;
  accessibility.expected_artifacts = accessibility.expected_artifacts.filter(
    (artifact) => artifact.artifact_key !== "demo.accessibility.defects.validation.baseline"
  );

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("missing_validation_artifact"), true);
});

test("semantic validation binds tuning apply and revert lifecycle artifacts", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  const design = suite.scenarios.find(
    (entry) => entry.value.scenario_id === "demo.design.tuning"
  ).value;
  design.expectations.design_tuning.application.reverted_artifact_key =
    "demo.design.tuning.patch";

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("tuning_application_artifact_mismatch"), true);
});

test("semantic validation recomputes build-diff summaries", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  const newFeature = suite.scenarios.find(
    (entry) => entry.value.scenario_id === "demo.version.new-feature"
  ).value;
  newFeature.expectations.build_diff.expected_summary.added = 1;

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("build_diff_summary_mismatch"), true);
});

test("semantic validation rejects optional support for a required shared scenario", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  suite.scenarios[0].value.platform_support.android.status = "optional";

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("required_platform_not_required"), true);
});

test("semantic validation keeps platform-only identifiers out of shared fixtures", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  suite.scenarios[0].value.stable_nodes[0].node_id = "ios.private.node";

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("platform_identifier_in_shared_scenario"), true);
});

test("semantic validation rejects fixtures outside manifest ownership", async () => {
  const suite = structuredClone(await loadScenarioSuite());
  suite.fixtureFiles.push("fixtures/v1/demo.unlisted.json");

  const issues = validateSuiteSemantics(suite);

  assert.equal(codes(issues).has("unlisted_fixture"), true);
});
