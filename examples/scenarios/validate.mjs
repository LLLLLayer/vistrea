import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

export const scenarioRoot = dirname(fileURLToPath(import.meta.url));

export const requiredScenarioIds = Object.freeze([
  "demo.navigation.basic",
  "demo.form.validation",
  "demo.transient.success",
  "demo.loading.outcomes",
  "demo.modal.dialog",
  "demo.layout.occlusion",
  "demo.accessibility.defects",
  "demo.design.tuning",
  "demo.dynamic.normalization",
  "demo.safety.dangerous",
  "demo.version.new-feature",
  "demo.version.regression"
]);

export const requiredProfileIds = Object.freeze([
  "baseline",
  "new-feature",
  "design-regression",
  "behavior-regression",
  "accessibility-regression",
  "dynamic-content"
]);

export const requiredCoverage = Object.freeze([
  "snapshot",
  "transient-event",
  "exploration",
  "design-tuning",
  "validation",
  "build-diff"
]);

const artifactKindsByCoverage = Object.freeze({
  snapshot: ["runtime-snapshot", "screenshot"],
  "transient-event": ["runtime-event-batch", "key-frame"],
  exploration: ["screen-graph"],
  "design-tuning": ["design-review-bundle", "tuning-patch", "tuning-application"],
  validation: ["validation-bundle"],
  "build-diff": ["build-diff"]
});

const requiredFirstLoopStages = Object.freeze([
  "demo-app-launch",
  "sdk-connect",
  "snapshot-capture",
  "host-receive",
  "studio-render",
  "data-persist",
  "data-reopen"
]);

const requiredFirstLoopScenarioIds = Object.freeze(["demo.navigation.basic"]);
const requiredFirstLoopCapabilities = Object.freeze([
  "runtime.snapshot",
  "runtime.connection"
]);
const requiredFirstLoopArtifactKeys = Object.freeze([
  "demo.navigation.basic.snapshot.home",
  "demo.navigation.basic.screenshot.home"
]);

const comparisonByArtifactKind = Object.freeze({
  "runtime-snapshot": "protocol-canonical",
  screenshot: "platform-visual",
  "runtime-event-batch": "protocol-canonical",
  "key-frame": "platform-visual",
  "screen-graph": "semantic-normalized",
  "design-review-bundle": "protocol-canonical",
  "tuning-patch": "protocol-canonical",
  "tuning-application": "protocol-canonical",
  "validation-bundle": "protocol-canonical",
  "build-diff": "protocol-canonical"
});

function issue(code, path, message) {
  return { code, path, message };
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function addDuplicateIssues(issues, values, keyOf, path, code) {
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const key = keyOf(values[index]);
    if (seen.has(key)) {
      issues.push(issue(code, `${path}/${index}`, `Duplicate identifier: ${key}`));
    }
    seen.add(key);
  }
}

function requireReference(issues, known, value, path, code, kind) {
  if (!known.has(value)) {
    issues.push(issue(code, path, `Unknown ${kind}: ${value}`));
  }
}

function validateScenarioSemantics(scenario, manifestProfiles) {
  const issues = [];
  const basePath = `/scenarios/${scenario.scenario_id}`;
  const nodeIds = new Set(scenario.stable_nodes.map((node) => node.node_id));
  const stateIds = new Set(scenario.states.map((state) => state.state_id));
  const stepIds = new Set(scenario.steps.map((step) => step.step_id));
  const artifactByKey = new Map(
    scenario.expected_artifacts.map((artifact) => [artifact.artifact_key, artifact])
  );

  if (scenario.required && !scenario.scenario_id.startsWith("demo.")) {
    issues.push(
      issue(
        "required_scenario_not_shared",
        `${basePath}/scenario_id`,
        "Required cross-platform scenarios must use the demo. namespace"
      )
    );
  }

  addDuplicateIssues(
    issues,
    scenario.stable_nodes,
    (node) => node.node_id,
    `${basePath}/stable_nodes`,
    "duplicate_stable_node"
  );

  if (scenario.scenario_id.startsWith("demo.")) {
    const sharedIdentifiers = [
      ...scenario.stable_nodes.map((node) => [node.node_id, "stable_nodes"]),
      ...scenario.states.map((state) => [state.state_id, "states"]),
      ...scenario.steps.map((step) => [step.step_id, "steps"])
    ];
    for (const [identifier, section] of sharedIdentifiers) {
      if (!identifier.startsWith("demo.")) {
        issues.push(
          issue(
            "platform_identifier_in_shared_scenario",
            `${basePath}/${section}`,
            `Shared scenario identifier must use the demo. namespace: ${identifier}`
          )
        );
      }
    }
  }
  addDuplicateIssues(
    issues,
    scenario.states,
    (state) => state.state_id,
    `${basePath}/states`,
    "duplicate_state"
  );
  addDuplicateIssues(
    issues,
    scenario.steps,
    (step) => step.step_id,
    `${basePath}/steps`,
    "duplicate_step"
  );
  addDuplicateIssues(
    issues,
    scenario.expected_artifacts,
    (artifact) => artifact.artifact_key,
    `${basePath}/expected_artifacts`,
    "duplicate_artifact_key"
  );

  requireReference(
    issues,
    stateIds,
    scenario.reset.entry_state_id,
    `${basePath}/reset/entry_state_id`,
    "unknown_reset_state",
    "state"
  );

  for (const [platform, requirement] of Object.entries(scenario.platform_support)) {
    if (scenario.required && requirement.status !== "required") {
      issues.push(
        issue(
          "required_platform_not_required",
          `${basePath}/platform_support/${platform}/status`,
          `Required shared scenario must be required on ${platform}`
        )
      );
    }
  }

  for (const [index, profile] of scenario.profiles.entries()) {
    requireReference(
      issues,
      manifestProfiles,
      profile,
      `${basePath}/profiles/${index}`,
      "unknown_profile",
      "profile"
    );
  }

  for (const [stateIndex, state] of scenario.states.entries()) {
    for (const [nodeIndex, nodeId] of state.required_node_ids.entries()) {
      requireReference(
        issues,
        nodeIds,
        nodeId,
        `${basePath}/states/${stateIndex}/required_node_ids/${nodeIndex}`,
        "unknown_state_node",
        "stable node"
      );
    }
    for (const [fieldIndex, field] of state.dynamic_fields.entries()) {
      requireReference(
        issues,
        nodeIds,
        field.node_id,
        `${basePath}/states/${stateIndex}/dynamic_fields/${fieldIndex}/node_id`,
        "unknown_dynamic_node",
        "stable node"
      );
    }
  }

  const stepById = new Map();
  for (const [stepIndex, step] of scenario.steps.entries()) {
    stepById.set(step.step_id, step);
    requireReference(
      issues,
      stateIds,
      step.from_state_id,
      `${basePath}/steps/${stepIndex}/from_state_id`,
      "unknown_step_state",
      "state"
    );
    requireReference(
      issues,
      stateIds,
      step.to_state_id,
      `${basePath}/steps/${stepIndex}/to_state_id`,
      "unknown_step_state",
      "state"
    );
    if (step.action.target_node_id !== undefined) {
      requireReference(
        issues,
        nodeIds,
        step.action.target_node_id,
        `${basePath}/steps/${stepIndex}/action/target_node_id`,
        "unknown_action_node",
        "stable node"
      );
    }
    for (const [profileIndex, profile] of (step.profiles ?? scenario.profiles).entries()) {
      if (!scenario.profiles.includes(profile)) {
        issues.push(
          issue(
            "step_profile_outside_scenario",
            `${basePath}/steps/${stepIndex}/profiles/${profileIndex}`,
            `Step profile is not declared by the scenario: ${profile}`
          )
        );
      }
    }
  }

  for (const [artifactIndex, artifact] of scenario.expected_artifacts.entries()) {
    if (!artifact.artifact_key.startsWith(`${scenario.scenario_id}.`)) {
      issues.push(
        issue(
          "artifact_key_not_scenario_scoped",
          `${basePath}/expected_artifacts/${artifactIndex}/artifact_key`,
          `Artifact key must start with ${scenario.scenario_id}.`
        )
      );
    }
    if (!scenario.profiles.includes(artifact.profile)) {
      issues.push(
        issue(
          "artifact_profile_outside_scenario",
          `${basePath}/expected_artifacts/${artifactIndex}/profile`,
          `Artifact profile is not declared by the scenario: ${artifact.profile}`
        )
      );
    }
    if (artifact.after_step_id !== undefined) {
      requireReference(
        issues,
        stepIds,
        artifact.after_step_id,
        `${basePath}/expected_artifacts/${artifactIndex}/after_step_id`,
        "unknown_artifact_step",
        "step"
      );
    }
    const expectedComparison = comparisonByArtifactKind[artifact.kind];
    if (artifact.comparison !== expectedComparison) {
      issues.push(
        issue(
          "artifact_comparison_mismatch",
          `${basePath}/expected_artifacts/${artifactIndex}/comparison`,
          `${artifact.kind} must use ${expectedComparison}`
        )
      );
    }
  }

  const artifactKinds = new Set(scenario.expected_artifacts.map((artifact) => artifact.kind));
  for (const coverage of scenario.coverage) {
    for (const requiredKind of artifactKindsByCoverage[coverage]) {
      if (!artifactKinds.has(requiredKind)) {
        issues.push(
          issue(
            "missing_coverage_artifact",
            `${basePath}/expected_artifacts`,
            `${coverage} coverage requires a ${requiredKind} artifact`
          )
        );
      }
    }
  }

  const snapshotExpectations = scenario.expectations.snapshots ?? [];
  addDuplicateIssues(
    issues,
    snapshotExpectations,
    (expectation) => expectation.expectation_id,
    `${basePath}/expectations/snapshots`,
    "duplicate_snapshot_expectation"
  );
  for (const [index, expectation] of snapshotExpectations.entries()) {
    const path = `${basePath}/expectations/snapshots/${index}`;
    requireReference(issues, stepIds, expectation.after_step_id, `${path}/after_step_id`, "unknown_snapshot_step", "step");
    requireReference(issues, stateIds, expectation.state_id, `${path}/state_id`, "unknown_snapshot_state", "state");
    if (!scenario.profiles.includes(expectation.profile)) {
      issues.push(issue("snapshot_profile_outside_scenario", `${path}/profile`, `Unknown scenario profile: ${expectation.profile}`));
    }
    const snapshotArtifact = scenario.expected_artifacts.find(
      (artifact) =>
        artifact.kind === "runtime-snapshot" &&
        artifact.profile === expectation.profile &&
        artifact.after_step_id === expectation.after_step_id
    );
    if (snapshotArtifact === undefined) {
      issues.push(
        issue(
          "missing_snapshot_artifact",
          path,
          `Snapshot expectation requires a runtime-snapshot artifact for ${expectation.profile} after ${expectation.after_step_id}`
        )
      );
    }
    for (const [nodeIndex, nodeId] of expectation.required_node_ids.entries()) {
      requireReference(issues, nodeIds, nodeId, `${path}/required_node_ids/${nodeIndex}`, "unknown_snapshot_node", "stable node");
    }
    for (const [nodeIndex, nodeId] of expectation.excluded_node_ids.entries()) {
      requireReference(issues, nodeIds, nodeId, `${path}/excluded_node_ids/${nodeIndex}`, "unknown_snapshot_node", "stable node");
      if (expectation.required_node_ids.includes(nodeId)) {
        issues.push(issue("snapshot_node_conflict", `${path}/excluded_node_ids/${nodeIndex}`, `Node is both required and excluded: ${nodeId}`));
      }
    }
  }

  const transientExpectations = scenario.expectations.transient_events ?? [];
  addDuplicateIssues(
    issues,
    transientExpectations,
    (expectation) => expectation.expectation_id,
    `${basePath}/expectations/transient_events`,
    "duplicate_event_expectation"
  );
  const transientOrders = new Map();
  for (const [index, expectation] of transientExpectations.entries()) {
    const path = `${basePath}/expectations/transient_events/${index}`;
    requireReference(issues, stepIds, expectation.after_step_id, `${path}/after_step_id`, "unknown_event_step", "step");
    requireReference(issues, nodeIds, expectation.target_node_id, `${path}/target_node_id`, "unknown_event_node", "stable node");
    if (!scenario.profiles.includes(expectation.profile)) {
      issues.push(issue("event_profile_outside_scenario", `${path}/profile`, `Unknown scenario profile: ${expectation.profile}`));
    }
    const orders = transientOrders.get(expectation.profile) ?? [];
    orders.push(expectation.order);
    transientOrders.set(expectation.profile, orders);
  }
  for (const [profile, orders] of transientOrders) {
    const expectedOrders = Array.from({ length: orders.length }, (_, index) => index + 1);
    if (JSON.stringify([...orders].sort((left, right) => left - right)) !== JSON.stringify(expectedOrders)) {
      issues.push(
        issue(
          "event_order_not_contiguous",
          `${basePath}/expectations/transient_events`,
          `Event order for ${profile} must be contiguous from 1`
        )
      );
    }
    if (
      !scenario.expected_artifacts.some(
        (artifact) => artifact.kind === "runtime-event-batch" && artifact.profile === profile
      )
    ) {
      issues.push(
        issue(
          "missing_event_artifact",
          `${basePath}/expectations/transient_events`,
          `Transient expectations require a runtime-event-batch artifact for ${profile}`
        )
      );
    }
  }

  const transitionIds = new Set();
  const exploration = scenario.expectations.exploration;
  if (exploration !== undefined) {
    addDuplicateIssues(
      issues,
      exploration.expected_transitions,
      (transition) => transition.transition_id,
      `${basePath}/expectations/exploration/expected_transitions`,
      "duplicate_transition"
    );
    for (const [index, transition] of exploration.expected_transitions.entries()) {
      const path = `${basePath}/expectations/exploration/expected_transitions/${index}`;
      transitionIds.add(transition.transition_id);
      requireReference(issues, stepIds, transition.step_id, `${path}/step_id`, "unknown_transition_step", "step");
      requireReference(issues, stateIds, transition.from_state_id, `${path}/from_state_id`, "unknown_transition_state", "state");
      requireReference(issues, stateIds, transition.to_state_id, `${path}/to_state_id`, "unknown_transition_state", "state");
      const step = stepById.get(transition.step_id);
      if (
        step !== undefined &&
        (step.from_state_id !== transition.from_state_id || step.to_state_id !== transition.to_state_id)
      ) {
        issues.push(issue("transition_step_mismatch", path, `Transition does not match step ${transition.step_id}`));
      }
    }
    const transitionStepIds = new Set(exploration.expected_transitions.map((transition) => transition.step_id));
    for (const [index, blocked] of exploration.blocked_actions.entries()) {
      const path = `${basePath}/expectations/exploration/blocked_actions/${index}`;
      requireReference(issues, stepIds, blocked.step_id, `${path}/step_id`, "unknown_blocked_step", "step");
      requireReference(issues, nodeIds, blocked.target_node_id, `${path}/target_node_id`, "unknown_blocked_node", "stable node");
      const step = stepById.get(blocked.step_id);
      if (step !== undefined && step.action.target_node_id !== blocked.target_node_id) {
        issues.push(issue("blocked_action_target_mismatch", path, `Blocked target does not match step ${blocked.step_id}`));
      }
      if (transitionStepIds.has(blocked.step_id)) {
        issues.push(issue("blocked_action_has_transition", path, `Blocked step must not create a Transition: ${blocked.step_id}`));
      }
    }
    addDuplicateIssues(
      issues,
      exploration.identity_expectations,
      (identity) => identity.expectation_id,
      `${basePath}/expectations/exploration/identity_expectations`,
      "duplicate_identity_expectation"
    );
    for (const [index, identity] of exploration.identity_expectations.entries()) {
      const path = `${basePath}/expectations/exploration/identity_expectations/${index}`;
      for (const [side, profile] of [["left", identity.left_profile], ["right", identity.right_profile]]) {
        if (!scenario.profiles.includes(profile)) {
          issues.push(issue("identity_profile_outside_scenario", `${path}/${side}_profile`, `Unknown scenario profile: ${profile}`));
        }
      }
      requireReference(issues, stateIds, identity.left_state_id, `${path}/left_state_id`, "unknown_identity_state", "state");
      requireReference(issues, stateIds, identity.right_state_id, `${path}/right_state_id`, "unknown_identity_state", "state");
      if (identity.outcome === "same-state" && identity.normalized_fields.length === 0) {
        issues.push(issue("identity_normalization_missing", `${path}/normalized_fields`, "same-state identity across dynamic profiles requires explicit normalized fields"));
      }
    }
  }

  const designTuning = scenario.expectations.design_tuning;
  if (designTuning !== undefined) {
    requireReference(issues, nodeIds, designTuning.target_node_id, `${basePath}/expectations/design_tuning/target_node_id`, "unknown_design_node", "stable node");
    const patchArtifact = artifactByKey.get(designTuning.patch.artifact_key);
    if (patchArtifact?.kind !== "tuning-patch") {
      issues.push(issue("tuning_patch_artifact_mismatch", `${basePath}/expectations/design_tuning/patch/artifact_key`, "Patch must reference an expected tuning-patch artifact"));
    }
    const candidateProfile = designTuning.verification.candidate_profile;
    if (patchArtifact !== undefined && patchArtifact.profile !== candidateProfile) {
      issues.push(
        issue(
          "tuning_patch_profile_mismatch",
          `${basePath}/expectations/design_tuning/patch/artifact_key`,
          `Tuning Patch artifact must use candidate profile ${candidateProfile}`
        )
      );
    }
    if (
      !scenario.expected_artifacts.some(
        (artifact) =>
          artifact.kind === "design-review-bundle" && artifact.profile === candidateProfile
      )
    ) {
      issues.push(
        issue(
          "missing_design_review_artifact",
          `${basePath}/expectations/design_tuning`,
          `Design expectation requires a design-review-bundle artifact for ${candidateProfile}`
        )
      );
    }
    for (const field of ["active_artifact_key", "reverted_artifact_key"]) {
      const applicationArtifact = artifactByKey.get(designTuning.application[field]);
      if (applicationArtifact?.kind !== "tuning-application") {
        issues.push(
          issue(
            "tuning_application_artifact_mismatch",
            `${basePath}/expectations/design_tuning/application/${field}`,
            `${field} must reference an expected tuning-application artifact`
          )
        );
      }
      if (applicationArtifact !== undefined && applicationArtifact.profile !== candidateProfile) {
        issues.push(
          issue(
            "tuning_application_profile_mismatch",
            `${basePath}/expectations/design_tuning/application/${field}`,
            `Tuning Application artifact must use candidate profile ${candidateProfile}`
          )
        );
      }
    }
    const differenceByProperty = new Map(
      designTuning.differences.map((difference) => [difference.property_name, difference])
    );
    addDuplicateIssues(
      issues,
      designTuning.differences,
      (difference) => difference.property_name,
      `${basePath}/expectations/design_tuning/differences`,
      "duplicate_design_property"
    );
    addDuplicateIssues(
      issues,
      designTuning.patch.changes,
      (change) => change.property_name,
      `${basePath}/expectations/design_tuning/patch/changes`,
      "duplicate_tuning_property"
    );
    for (const [index, change] of designTuning.patch.changes.entries()) {
      const difference = differenceByProperty.get(change.property_name);
      if (
        difference === undefined ||
        difference.source_value !== change.source_value ||
        difference.design_value !== change.preview_value
      ) {
        issues.push(issue("tuning_change_difference_mismatch", `${basePath}/expectations/design_tuning/patch/changes/${index}`, `Tuning change must resolve the declared ${change.property_name} difference`));
      }
    }
    for (const field of ["baseline_profile", "candidate_profile"]) {
      const profile = designTuning.verification[field];
      if (!scenario.profiles.includes(profile)) {
        issues.push(issue("verification_profile_outside_scenario", `${basePath}/expectations/design_tuning/verification/${field}`, `Unknown scenario profile: ${profile}`));
      }
    }
  }

  const validation = scenario.expectations.validation;
  if (validation !== undefined) {
    addDuplicateIssues(
      issues,
      validation.profile_expectations,
      (profileExpectation) => profileExpectation.profile,
      `${basePath}/expectations/validation/profile_expectations`,
      "duplicate_validation_profile"
    );
    for (const [profileIndex, profileExpectation] of validation.profile_expectations.entries()) {
      const path = `${basePath}/expectations/validation/profile_expectations/${profileIndex}`;
      if (!scenario.profiles.includes(profileExpectation.profile)) {
        issues.push(issue("validation_profile_outside_scenario", `${path}/profile`, `Unknown scenario profile: ${profileExpectation.profile}`));
      }
      if (
        !scenario.expected_artifacts.some(
          (artifact) =>
            artifact.kind === "validation-bundle" &&
            artifact.profile === profileExpectation.profile
        )
      ) {
        issues.push(
          issue(
            "missing_validation_artifact",
            path,
            `Validation expectation requires a validation-bundle artifact for ${profileExpectation.profile}`
          )
        );
      }
      addDuplicateIssues(
        issues,
        profileExpectation.findings,
        (finding) => finding.rule_id,
        `${path}/findings`,
        "duplicate_validation_rule"
      );
      for (const [findingIndex, finding] of profileExpectation.findings.entries()) {
        if (finding.target_node_id !== undefined) {
          requireReference(issues, nodeIds, finding.target_node_id, `${path}/findings/${findingIndex}/target_node_id`, "unknown_finding_node", "stable node");
        }
      }
    }
  }

  const buildDiff = scenario.expectations.build_diff;
  if (buildDiff !== undefined) {
    for (const field of ["baseline_profile", "candidate_profile"]) {
      const profile = buildDiff[field];
      if (!scenario.profiles.includes(profile)) {
        issues.push(issue("diff_profile_outside_scenario", `${basePath}/expectations/build_diff/${field}`, `Unknown scenario profile: ${profile}`));
      }
    }
    if (buildDiff.baseline_profile === buildDiff.candidate_profile) {
      issues.push(issue("diff_profiles_equal", `${basePath}/expectations/build_diff`, "Build diff requires different baseline and candidate profiles"));
    }
    if (
      !scenario.expected_artifacts.some(
        (artifact) =>
          artifact.kind === "build-diff" && artifact.profile === buildDiff.candidate_profile
      )
    ) {
      issues.push(
        issue(
          "missing_build_diff_artifact",
          `${basePath}/expectations/build_diff`,
          `Build diff expectation requires a build-diff artifact for ${buildDiff.candidate_profile}`
        )
      );
    }
    const knownDiffTargets = new Set([...nodeIds, ...stateIds, ...transitionIds]);
    const actualSummary = {
      total: buildDiff.expected_entries.length,
      added: 0,
      removed: 0,
      changed: 0,
      regressed: 0,
      improved: 0
    };
    for (const [index, entry] of buildDiff.expected_entries.entries()) {
      actualSummary[entry.kind] += 1;
      requireReference(issues, knownDiffTargets, entry.target_id, `${basePath}/expectations/build_diff/expected_entries/${index}/target_id`, "unknown_diff_target", "node, state, or transition");
    }
    if (
      Object.entries(actualSummary).some(
        ([key, value]) => buildDiff.expected_summary[key] !== value
      )
    ) {
      issues.push(issue("build_diff_summary_mismatch", `${basePath}/expectations/build_diff/expected_summary`, `Expected ${JSON.stringify(actualSummary)}`));
    }
  }

  return issues;
}

export function validateSuiteSemantics({ manifest, scenarios, fixtureFiles }) {
  const issues = [];
  const manifestProfiles = new Set(manifest.profiles.map((profile) => profile.profile_id));
  const manifestEntriesById = new Map(manifest.scenarios.map((entry) => [entry.scenario_id, entry]));
  const manifestEntriesByFile = new Map(manifest.scenarios.map((entry) => [entry.file, entry]));
  const scenarioById = new Map(scenarios.map((entry) => [entry.value.scenario_id, entry]));

  addDuplicateIssues(issues, manifest.profiles, (profile) => profile.profile_id, "/manifest/profiles", "duplicate_profile");
  addDuplicateIssues(issues, manifest.scenarios, (entry) => entry.scenario_id, "/manifest/scenarios", "duplicate_manifest_scenario");
  addDuplicateIssues(issues, manifest.scenarios, (entry) => entry.file, "/manifest/scenarios", "duplicate_manifest_file");
  addDuplicateIssues(issues, scenarios, (entry) => entry.value.scenario_id, "/scenarios", "duplicate_fixture_scenario");

  if (!sameSet([...manifestProfiles], requiredProfileIds)) {
    issues.push(issue("profile_set_mismatch", "/manifest/profiles", `Profiles must be exactly: ${requiredProfileIds.join(", ")}`));
  }
  for (const [index, profile] of manifest.profiles.entries()) {
    if (profile.base_profile !== undefined) {
      requireReference(issues, manifestProfiles, profile.base_profile, `/manifest/profiles/${index}/base_profile`, "unknown_base_profile", "profile");
      if (profile.base_profile === profile.profile_id) {
        issues.push(issue("self_based_profile", `/manifest/profiles/${index}/base_profile`, "Profile cannot derive from itself"));
      }
    }
  }

  for (const requiredId of requiredScenarioIds) {
    const entry = manifestEntriesById.get(requiredId);
    if (entry === undefined) {
      issues.push(issue("missing_required_scenario", "/manifest/scenarios", `Missing required Scenario ID: ${requiredId}`));
    } else if (!entry.required) {
      issues.push(issue("required_scenario_optional", `/manifest/scenarios/${requiredId}/required`, `Required Scenario ID is marked optional: ${requiredId}`));
    }
  }

  const coverage = new Set(manifest.scenarios.flatMap((entry) => entry.coverage));
  if (!sameSet([...coverage], requiredCoverage)) {
    issues.push(issue("suite_coverage_mismatch", "/manifest/scenarios", `Suite coverage must be exactly: ${requiredCoverage.join(", ")}`));
  }

  const inventory = new Set(fixtureFiles);
  for (const file of fixtureFiles) {
    if (!manifestEntriesByFile.has(file)) {
      issues.push(issue("unlisted_fixture", `/fixtures/${file}`, `Fixture is not listed in the manifest: ${file}`));
    }
  }
  for (const [index, entry] of manifest.scenarios.entries()) {
    if (!inventory.has(entry.file)) {
      issues.push(issue("missing_fixture", `/manifest/scenarios/${index}/file`, `Listed fixture does not exist: ${entry.file}`));
    }
    const loaded = scenarios.find((scenario) => scenario.file === entry.file);
    if (loaded === undefined) {
      continue;
    }
    if (loaded.value.scenario_id !== entry.scenario_id) {
      issues.push(issue("fixture_id_mismatch", `/manifest/scenarios/${index}/scenario_id`, `Fixture declares ${loaded.value.scenario_id}`));
    }
    if (loaded.value.required !== entry.required) {
      issues.push(issue("fixture_required_mismatch", `/manifest/scenarios/${index}/required`, "Manifest and fixture required flags differ"));
    }
    if (!sameSet(loaded.value.coverage, entry.coverage)) {
      issues.push(issue("fixture_coverage_mismatch", `/manifest/scenarios/${index}/coverage`, "Manifest and fixture coverage differ"));
    }
  }

  const allArtifactKeys = new Map();
  for (const scenarioEntry of scenarios) {
    const scenario = scenarioEntry.value;
    issues.push(...validateScenarioSemantics(scenario, manifestProfiles));
    for (const artifact of scenario.expected_artifacts) {
      if (allArtifactKeys.has(artifact.artifact_key)) {
        issues.push(issue("duplicate_suite_artifact_key", `/scenarios/${scenario.scenario_id}/expected_artifacts`, `Artifact key also belongs to ${allArtifactKeys.get(artifact.artifact_key)}: ${artifact.artifact_key}`));
      }
      allArtifactKeys.set(artifact.artifact_key, scenario.scenario_id);
    }
    for (const [platform, requirement] of Object.entries(scenario.platform_support)) {
      const platformStatus = manifest.platforms[platform];
      for (const capability of requirement.capabilities) {
        const status = platformStatus.capabilities[capability];
        if (status === undefined || status === "unsupported") {
          issues.push(issue("platform_capability_unavailable", `/scenarios/${scenario.scenario_id}/platform_support/${platform}/capabilities`, `${platform} does not declare support for ${capability}`));
        }
      }
    }
  }

  if (manifest.platforms.ios.initial_adapter !== "uikit") {
    issues.push(issue("ios_adapter_mismatch", "/manifest/platforms/ios/initial_adapter", "The initial iOS adapter must be UIKit"));
  }
  if (manifest.platforms.android.initial_adapter !== "view-viewgroup") {
    issues.push(issue("android_adapter_mismatch", "/manifest/platforms/android/initial_adapter", "The initial Android adapter must be View/ViewGroup"));
  }

  addDuplicateIssues(
    issues,
    manifest.vertical_loops,
    (loop) => loop.loop_id,
    "/manifest/vertical_loops",
    "duplicate_vertical_loop"
  );
  for (const loop of manifest.vertical_loops) {
    const path = `/manifest/vertical_loops/${loop.loop_id}`;
    const platformStatus = manifest.platforms[loop.platform];
    if (platformStatus === undefined) {
      issues.push(issue("vertical_loop_platform_unknown", `${path}/platform`, `Unknown platform: ${loop.platform}`));
      continue;
    }
    for (const scenarioId of loop.scenario_ids) {
      if (!scenarioById.has(scenarioId) || !requiredScenarioIds.includes(scenarioId)) {
        issues.push(issue("vertical_loop_unknown_scenario", `${path}/scenario_ids`, `Vertical loop must reference a required shared scenario: ${scenarioId}`));
      }
    }
    for (const capability of loop.required_capabilities) {
      const status = platformStatus.capabilities[capability];
      if (status === undefined || status === "unsupported") {
        issues.push(issue("vertical_loop_capability_unavailable", `${path}/required_capabilities`, `${loop.platform} does not declare support for ${capability}`));
      }
      if (loop.status === "verified" && status !== "verified") {
        issues.push(issue("verified_loop_capability_unverified", `${path}/required_capabilities`, `Verified loop requires verified ${loop.platform} capability: ${capability}`));
      }
    }
    for (const artifactKey of loop.artifact_keys) {
      const owner = allArtifactKeys.get(artifactKey);
      if (owner === undefined || !loop.scenario_ids.includes(owner)) {
        issues.push(issue("vertical_loop_artifact_mismatch", `${path}/artifact_keys`, `Vertical-loop artifact must belong to a referenced shared scenario: ${artifactKey}`));
      }
    }
  }

  const firstLoop = manifest.vertical_loops.find((loop) => loop.loop_id === "ios.first-snapshot-loop");
  if (firstLoop === undefined) {
    issues.push(issue("missing_first_ios_loop", "/manifest/vertical_loops", "Missing ios.first-snapshot-loop acceptance contract"));
  } else {
    if (firstLoop.platform !== "ios") {
      issues.push(issue("first_loop_platform_mismatch", "/manifest/vertical_loops/ios.first-snapshot-loop/platform", "First snapshot loop must target iOS"));
    }
    if (firstLoop.status !== "verified") {
      issues.push(issue("first_loop_status_mismatch", "/manifest/vertical_loops/ios.first-snapshot-loop/status", "The first iOS snapshot loop must remain verified"));
    }
    if (!sameSet(firstLoop.stages, requiredFirstLoopStages)) {
      issues.push(issue("first_loop_stage_mismatch", "/manifest/vertical_loops/ios.first-snapshot-loop/stages", `First iOS loop must cover: ${requiredFirstLoopStages.join(", ")}`));
    }
    if (!sameSet(firstLoop.scenario_ids, requiredFirstLoopScenarioIds)) {
      issues.push(issue("first_loop_unknown_scenario", "/manifest/vertical_loops/ios.first-snapshot-loop/scenario_ids", `First iOS loop must reference exactly: ${requiredFirstLoopScenarioIds.join(", ")}`));
    }
    if (!sameSet(firstLoop.required_capabilities, requiredFirstLoopCapabilities)) {
      issues.push(issue("first_loop_capability_unavailable", "/manifest/vertical_loops/ios.first-snapshot-loop/required_capabilities", `First iOS loop must require exactly: ${requiredFirstLoopCapabilities.join(", ")}`));
    }
    if (!sameSet(firstLoop.artifact_keys, requiredFirstLoopArtifactKeys)) {
      issues.push(issue("first_loop_artifact_mismatch", "/manifest/vertical_loops/ios.first-snapshot-loop/artifact_keys", `First iOS loop must retain exactly: ${requiredFirstLoopArtifactKeys.join(", ")}`));
    }
  }

  const androidFirstLoop = manifest.vertical_loops.find(
    (loop) => loop.loop_id === "android.first-snapshot-loop"
  );
  if (androidFirstLoop === undefined) {
    issues.push(issue("missing_first_android_loop", "/manifest/vertical_loops", "Missing android.first-snapshot-loop acceptance contract"));
  } else {
    if (androidFirstLoop.platform !== "android") {
      issues.push(issue("android_first_loop_platform_mismatch", "/manifest/vertical_loops/android.first-snapshot-loop/platform", "First Android snapshot loop must target Android"));
    }
    if (androidFirstLoop.status !== "verified") {
      issues.push(issue("android_first_loop_status_mismatch", "/manifest/vertical_loops/android.first-snapshot-loop/status", "The first Android snapshot loop must remain verified"));
    }
    if (!sameSet(androidFirstLoop.stages, requiredFirstLoopStages)) {
      issues.push(issue("android_first_loop_stage_mismatch", "/manifest/vertical_loops/android.first-snapshot-loop/stages", `First Android loop must cover: ${requiredFirstLoopStages.join(", ")}`));
    }
    if (!sameSet(androidFirstLoop.scenario_ids, requiredFirstLoopScenarioIds)) {
      issues.push(issue("android_first_loop_scenario_mismatch", "/manifest/vertical_loops/android.first-snapshot-loop/scenario_ids", `First Android loop must reference exactly: ${requiredFirstLoopScenarioIds.join(", ")}`));
    }
    if (!sameSet(androidFirstLoop.required_capabilities, requiredFirstLoopCapabilities)) {
      issues.push(issue("android_first_loop_capability_mismatch", "/manifest/vertical_loops/android.first-snapshot-loop/required_capabilities", `First Android loop must require exactly: ${requiredFirstLoopCapabilities.join(", ")}`));
    }
    if (!sameSet(androidFirstLoop.artifact_keys, requiredFirstLoopArtifactKeys)) {
      issues.push(issue("android_first_loop_artifact_mismatch", "/manifest/vertical_loops/android.first-snapshot-loop/artifact_keys", `First Android loop must retain exactly: ${requiredFirstLoopArtifactKeys.join(", ")}`));
    }
  }

  return issues;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadScenarioSuite(rootDir = scenarioRoot) {
  const root = resolve(rootDir);
  const manifest = await readJson(join(root, "manifest.json"));
  const manifestSchema = await readJson(join(root, "schema/v1/manifest.schema.json"));
  const scenarioSchema = await readJson(join(root, "schema/v1/scenario.schema.json"));
  const fixtureDirectory = join(root, "fixtures/v1");
  const fixtureNames = (await readdir(fixtureDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const fixtureFiles = fixtureNames.map((name) => `fixtures/v1/${name}`);
  const scenarios = await Promise.all(
    fixtureFiles.map(async (file) => ({
      file,
      value: await readJson(join(root, file))
    }))
  );
  return { root, manifest, manifestSchema, scenarioSchema, fixtureFiles, scenarios };
}

export async function validateScenarioSuite(rootDir = scenarioRoot) {
  const suite = await loadScenarioSuite(rootDir);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateManifest = ajv.compile(suite.manifestSchema);
  const validateScenario = ajv.compile(suite.scenarioSchema);
  const issues = [];

  if (!validateManifest(suite.manifest)) {
    for (const error of validateManifest.errors ?? []) {
      issues.push(issue("manifest_schema_invalid", `/manifest${error.instancePath}`, error.message ?? "Schema validation failed"));
    }
  }

  for (const scenario of suite.scenarios) {
    if (!validateScenario(scenario.value)) {
      for (const error of validateScenario.errors ?? []) {
        issues.push(issue("scenario_schema_invalid", `/${scenario.file}${error.instancePath}`, error.message ?? "Schema validation failed"));
      }
    }
  }

  if (issues.length === 0) {
    issues.push(...validateSuiteSemantics(suite));
  }

  return {
    ok: issues.length === 0,
    issues,
    scenarioCount: suite.scenarios.length,
    profileCount: suite.manifest.profiles.length,
    artifactCount: suite.scenarios.reduce(
      (count, scenario) => count + scenario.value.expected_artifacts.length,
      0
    ),
    coverage: sorted(new Set(suite.manifest.scenarios.flatMap((entry) => entry.coverage)))
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const requestedRoot = process.argv[2] === undefined ? scenarioRoot : resolve(process.argv[2]);
  try {
    const result = await validateScenarioSuite(requestedRoot);
    if (!result.ok) {
      for (const finding of result.issues) {
        console.error(`FAIL ${finding.code} ${finding.path}: ${finding.message}`);
      }
      process.exitCode = 1;
    } else {
      console.log(
        `PASS: ${result.scenarioCount} scenarios, ${result.profileCount} profiles, ` +
          `${result.artifactCount} deterministic artifacts, coverage=${result.coverage.join(",")}`
      );
    }
  } catch (error) {
    const displayRoot = relative(process.cwd(), requestedRoot) || ".";
    console.error(`FAIL scenario_suite_unreadable ${displayRoot}: ${error.message}`);
    process.exitCode = 1;
  }
}
