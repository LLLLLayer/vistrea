function issue(code, path, message) {
  return { code, path, message };
}

function addUniqueIds(items, field, path, code, issues) {
  const values = new Map();
  for (const [index, item] of items.entries()) {
    const value = item[field];
    if (values.has(value)) {
      issues.push(issue(code, `${path}/${index}/${field}`, `${field} is duplicated.`));
    } else {
      values.set(value, item);
    }
  }
  return values;
}

function versionMatches(left, right) {
  return left?.major === right?.major && left?.minor === right?.minor;
}

function timestampSortKey(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) {
    throw new TypeError(`Timestamp is not canonical UTC: ${String(value)}`);
  }
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}`;
}

function compareTimestamps(left, right) {
  const leftKey = timestampSortKey(left);
  const rightKey = timestampSortKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function checkTimeOrder(start, end, path, code, issues) {
  if (compareTimestamps(start, end) > 0) {
    issues.push(issue(code, path, "The start time must not be later than the end time."));
  }
}

function sameResourceRef(left, right) {
  return (
    left?.kind === right?.kind &&
    left?.id === right?.id &&
    left?.version === right?.version
  );
}

function sameRuntimeTarget(left, right) {
  return (
    left?.snapshot_id === right?.snapshot_id &&
    left?.tree_id === right?.tree_id &&
    left?.node_id === right?.node_id &&
    left?.stable_id === right?.stable_id
  );
}

function runtimeTargetKey(target) {
  return JSON.stringify([
    target.snapshot_id,
    target.tree_id,
    target.node_id,
  ]);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      deepEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) => deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function checkReferenceCycles(items, idField, successorField, path, code, issues) {
  const byId = new Map(items.map((item) => [item[idField], item]));
  const colors = new Map();

  for (const item of items) {
    const startId = item[idField];
    if (colors.get(startId) === "black") {
      continue;
    }

    const stack = [{ id: startId, successorIndex: 0 }];
    colors.set(startId, "gray");
    while (stack.length > 0) {
      const frame = stack.at(-1);
      const current = byId.get(frame.id);
      const successors = (current?.[successorField] ?? []).filter((id) => byId.has(id));
      if (frame.successorIndex >= successors.length) {
        colors.set(frame.id, "black");
        stack.pop();
        continue;
      }

      const successorIndex = frame.successorIndex;
      const successorId = successors[successorIndex];
      frame.successorIndex += 1;
      if (colors.get(successorId) === "gray") {
        const itemIndex = items.indexOf(current);
        issues.push(
          issue(
            code,
            `${path}/${itemIndex}/${successorField}/${successorIndex}`,
            `${successorField} must not contain a reference cycle.`,
          ),
        );
      } else if (colors.get(successorId) !== "black") {
        colors.set(successorId, "gray");
        stack.push({ id: successorId, successorIndex: 0 });
      }
    }
  }
}

function checkSingleReferenceCycles(items, idField, successorField, path, code, issues) {
  const normalized = items.map((item) => ({
    ...item,
    [successorField]: item[successorField] === undefined ? [] : [item[successorField]],
  }));
  checkReferenceCycles(normalized, idField, successorField, path, code, issues);
}

export function checkScreenGraph(graph) {
  const issues = [];
  const states = addUniqueIds(
    graph.states,
    "screen_state_id",
    "/states",
    "graph_duplicate_state_id",
    issues,
  );
  const actions = addUniqueIds(
    graph.actions,
    "action_id",
    "/actions",
    "graph_duplicate_action_id",
    issues,
  );
  const transitions = addUniqueIds(
    graph.transitions,
    "transition_id",
    "/transitions",
    "graph_duplicate_transition_id",
    issues,
  );
  const observations = addUniqueIds(
    graph.observations,
    "observation_id",
    "/observations",
    "graph_duplicate_observation_id",
    issues,
  );
  const decisions = addUniqueIds(
    graph.identity_decisions,
    "state_identity_decision_id",
    "/identity_decisions",
    "graph_duplicate_identity_decision_id",
    issues,
  );

  // Manual identity curation moves observation membership and re-points
  // transition endpoints. A decision in the graph grants an output state the
  // observations it names, and a superseded tombstone resolves to its
  // surviving states for endpoint comparisons.
  // Only a tombstone can hand its evidence or endpoints to a survivor. An
  // active state still deduplicates new captures, so following its
  // supersession chain would let a live screen's evidence explain a different
  // screen.
  const statesById = new Map(graph.states.map((state) => [state.screen_state_id, state]));
  const resolvesToState = (fromStateId, toStateId, seen = new Set()) => {
    if (fromStateId === toStateId) {
      return true;
    }
    if (seen.has(fromStateId)) {
      return false;
    }
    seen.add(fromStateId);
    const from = statesById.get(fromStateId);
    if (from === undefined || from.status === "active") {
      return false;
    }
    return (from.superseded_by_state_ids ?? []).some((nextId) =>
      resolvesToState(nextId, toStateId, seen),
    );
  };

  // A curation decision may move observation membership, but only along the
  // lineage it actually describes: the observation must have been captured
  // from one of the decision's input states (directly or through the
  // supersession chain), and only a merge or a split may move membership at
  // all. Anything looser would let a fabricated decision launder one state's
  // evidence onto another.
  const decisionGrants = new Map();
  const transitionRedirects = new Map();
  for (const decision of graph.identity_decisions) {
    for (const coalesced of decision.extensions?.["vistrea.coalesced_transitions"] ?? []) {
      transitionRedirects.set(coalesced.from_transition_id, coalesced.to_transition_id);
    }
    if (decision.kind !== "merge" && decision.kind !== "split") {
      continue;
    }
    for (const observationId of decision.observation_ids) {
      const observation = graph.observations.find(
        (candidate) => candidate.observation_id === observationId,
      );
      const capturedFrom =
        observation?.screen_state_id ?? observation?.source_state_id ?? undefined;
      if (
        capturedFrom === undefined ||
        !decision.input_state_ids.some((inputId) => resolvesToState(capturedFrom, inputId))
      ) {
        continue;
      }
      let granted = decisionGrants.get(observationId);
      if (!granted) {
        granted = new Set();
        decisionGrants.set(observationId, granted);
      }
      for (const stateId of decision.output_state_ids) {
        granted.add(stateId);
      }
    }
  }
  const resolveTransitionId = (transitionId, seen = new Set()) => {
    if (seen.has(transitionId)) {
      return transitionId;
    }
    seen.add(transitionId);
    const next = transitionRedirects.get(transitionId);
    return next === undefined ? transitionId : resolveTransitionId(next, seen);
  };
  const observationReferencesState = (observation, stateId) =>
    observation.screen_state_id === stateId ||
    observation.source_state_id === stateId ||
    observation.target_state_id === stateId ||
    decisionGrants.get(observation.observation_id)?.has(stateId) === true;

  // A curation decision must describe a shape that could have happened: a
  // merge collapses its inputs into one of them, and a split keeps its input
  // and adds states. Without this, a fabricated decision could grant one
  // state's evidence to an unrelated state it never produced.
  for (const [index, decision] of graph.identity_decisions.entries()) {
    const inputs = new Set(decision.input_state_ids);
    const outputs = new Set(decision.output_state_ids);
    if (
      decision.kind === "merge" &&
      decision.output_state_ids.some((stateId) => !inputs.has(stateId))
    ) {
      issues.push(
        issue(
          "graph_identity_decision_shape_invalid",
          `/identity_decisions/${index}/output_state_ids`,
          "A merge must survive as one of the states it merged.",
        ),
      );
    }
    if (
      decision.kind === "split" &&
      decision.input_state_ids.some((stateId) => !outputs.has(stateId))
    ) {
      issues.push(
        issue(
          "graph_identity_decision_shape_invalid",
          `/identity_decisions/${index}/output_state_ids`,
          "A split must keep the state it split among its outputs.",
        ),
      );
    }
  }

  // An active state must not claim supersession: status and lineage are one
  // statement, and a graph that says both would be lying about one of them.
  for (const [index, state] of graph.states.entries()) {
    if (
      state.status === "active" &&
      (state.superseded_by_state_ids ?? []).length > 0
    ) {
      issues.push(
        issue(
          "graph_active_state_superseded",
          `/states/${index}/superseded_by_state_ids`,
          "An active Screen State cannot declare superseding states.",
        ),
      );
    }
  }

  if (graph.context.observation_time_range) {
    checkTimeOrder(
      graph.context.observation_time_range.started_at,
      graph.context.observation_time_range.ended_at,
      "/context/observation_time_range",
      "graph_context_time_range_invalid",
      issues,
    );
  }

  for (const [index, stateId] of graph.entry_state_ids.entries()) {
    if (!states.has(stateId)) {
      issues.push(
        issue(
          "graph_dangling_state_reference",
          `/entry_state_ids/${index}`,
          "Entry state does not exist in the graph.",
        ),
      );
    }
  }

  for (const [index, state] of graph.states.entries()) {
    if (!versionMatches(graph.protocol_version, state.protocol_version)) {
      issues.push(
        issue(
          "graph_protocol_version_mismatch",
          `/states/${index}/protocol_version`,
          "State protocol version must match the graph.",
        ),
      );
    }
    checkTimeOrder(
      state.first_seen,
      state.last_seen,
      `/states/${index}`,
      "graph_state_time_range_invalid",
      issues,
    );
    for (const [observationIndex, observationId] of state.observation_ids.entries()) {
      if (!observations.has(observationId)) {
        issues.push(
          issue(
            "graph_dangling_observation_reference",
            `/states/${index}/observation_ids/${observationIndex}`,
            "State observation does not exist in the graph.",
          ),
        );
      }
    }
    const canonicalObservation = state.observation_ids
      .map((observationId) => observations.get(observationId))
      .find(
        (observation) =>
          observation !== undefined &&
          observationReferencesState(observation, state.screen_state_id) &&
          observation.snapshot_ids.includes(state.canonical_snapshot_id),
      );
    if (!canonicalObservation) {
      issues.push(
        issue(
          "graph_state_canonical_snapshot_unobserved",
          `/states/${index}/canonical_snapshot_id`,
          "The canonical Snapshot must be present in an Observation that references the state.",
        ),
      );
    }
    for (const [targetIndex, targetId] of (state.superseded_by_state_ids ?? []).entries()) {
      if (!states.has(targetId)) {
        issues.push(
          issue(
            "graph_dangling_state_reference",
            `/states/${index}/superseded_by_state_ids/${targetIndex}`,
            "Superseding state does not exist in the graph.",
          ),
        );
      } else if (targetId === state.screen_state_id) {
        issues.push(
          issue(
            "graph_state_self_supersession",
            `/states/${index}/superseded_by_state_ids/${targetIndex}`,
            "A state cannot supersede itself.",
          ),
        );
      }
    }
    const seenBuilds = new Set(state.seen_in_build_ids ?? []);
    for (const [missingIndex, buildId] of (state.missing_in_build_ids ?? []).entries()) {
      if (seenBuilds.has(buildId)) {
        issues.push(
          issue(
            "graph_build_presence_conflict",
            `/states/${index}/missing_in_build_ids/${missingIndex}`,
            "A build cannot be both seen and missing for one state.",
          ),
        );
      }
    }
  }

  checkReferenceCycles(
    graph.states,
    "screen_state_id",
    "superseded_by_state_ids",
    "/states",
    "graph_state_supersession_cycle",
    issues,
  );

  for (const [index, action] of graph.actions.entries()) {
    if (!versionMatches(graph.protocol_version, action.protocol_version)) {
      issues.push(
        issue(
          "graph_protocol_version_mismatch",
          `/actions/${index}/protocol_version`,
          "Action protocol version must match the graph.",
        ),
      );
    }
  }

  for (const [index, transition] of graph.transitions.entries()) {
    if (!versionMatches(graph.protocol_version, transition.protocol_version)) {
      issues.push(
        issue(
          "graph_protocol_version_mismatch",
          `/transitions/${index}/protocol_version`,
          "Transition protocol version must match the graph.",
        ),
      );
    }
    for (const [field, collection, code] of [
      ["source_state_id", states, "graph_dangling_state_reference"],
      ["target_state_id", states, "graph_dangling_state_reference"],
      ["action_id", actions, "graph_dangling_action_reference"],
    ]) {
      if (!collection.has(transition[field])) {
        issues.push(
          issue(code, `/transitions/${index}/${field}`, `${field} does not exist in the graph.`),
        );
      }
    }
    for (const [observationIndex, observationId] of transition.observation_ids.entries()) {
      const observation = observations.get(observationId);
      if (!observation) {
        issues.push(
          issue(
            "graph_dangling_observation_reference",
            `/transitions/${index}/observation_ids/${observationIndex}`,
            "Transition observation does not exist in the graph.",
          ),
        );
      } else if (
        observation.kind !== "transition" ||
        resolveTransitionId(observation.transition_id) !== transition.transition_id ||
        observation.action_id !== transition.action_id ||
        !resolvesToState(observation.source_state_id, transition.source_state_id) ||
        !resolvesToState(observation.target_state_id, transition.target_state_id)
      ) {
        issues.push(
          issue(
            "graph_transition_observation_mismatch",
            `/transitions/${index}/observation_ids/${observationIndex}`,
            "Transition observations must identify the same transition, action, source, and target.",
          ),
        );
      }
    }
    if (
      transition.status === "observed" &&
      transition.occurrence_count !== transition.observation_ids.length
    ) {
      issues.push(
        issue(
          "graph_transition_occurrence_mismatch",
          `/transitions/${index}/occurrence_count`,
          "An observed transition occurrence count must equal its immutable Observation count.",
        ),
      );
    }
    if (
      transition.status === "expected" &&
      (transition.occurrence_count !== 0 || transition.observation_ids.length !== 0)
    ) {
      issues.push(
        issue(
          "graph_expected_transition_has_observation",
          `/transitions/${index}`,
          "An expected transition has no observed occurrences or Observation evidence.",
        ),
      );
    }
    checkTimeOrder(
      transition.first_seen,
      transition.last_seen,
      `/transitions/${index}`,
      "graph_transition_time_range_invalid",
      issues,
    );
  }

  for (const [index, observation] of graph.observations.entries()) {
    if (!versionMatches(graph.protocol_version, observation.protocol_version)) {
      issues.push(
        issue(
          "graph_protocol_version_mismatch",
          `/observations/${index}/protocol_version`,
          "Observation protocol version must match the graph.",
        ),
      );
    }
    if (observation.runtime_context.project_id !== graph.context.project_id) {
      issues.push(
        issue(
          "graph_observation_context_mismatch",
          `/observations/${index}/runtime_context/project_id`,
          "Observation project is outside the graph context.",
        ),
      );
    }
    if (observation.runtime_context.application_id !== graph.context.application_id) {
      issues.push(
        issue(
          "graph_observation_context_mismatch",
          `/observations/${index}/runtime_context/application_id`,
          "Observation application is outside the graph context.",
        ),
      );
    }
    if (!graph.context.build_ids.includes(observation.runtime_context.build_id)) {
      issues.push(
        issue(
          "graph_observation_context_mismatch",
          `/observations/${index}/runtime_context/build_id`,
          "Observation build is outside the graph context.",
        ),
      );
    }
    if (!graph.context.environment_ids.includes(observation.runtime_context.environment_id)) {
      issues.push(
        issue(
          "graph_observation_context_mismatch",
          `/observations/${index}/runtime_context/environment_id`,
          "Observation environment is outside the graph context.",
        ),
      );
    }
    if (
      graph.context.platforms &&
      !graph.context.platforms.includes(observation.runtime_context.platform)
    ) {
      issues.push(
        issue(
          "graph_observation_context_mismatch",
          `/observations/${index}/runtime_context/platform`,
          "Observation platform is outside the graph context.",
        ),
      );
    }
    for (const [selector, value] of [
      ["account_profile_ids", observation.runtime_context.account_profile_id],
      ["locales", observation.runtime_context.locale],
      ["themes", observation.runtime_context.theme],
      ["device_kinds", observation.runtime_context.device.kind],
    ]) {
      if (graph.context[selector] && !graph.context[selector].includes(value)) {
        issues.push(
          issue(
            "graph_observation_context_mismatch",
            `/observations/${index}/runtime_context`,
            `Observation does not satisfy GraphContext selector ${selector}.`,
          ),
        );
      }
    }
    if (
      graph.context.feature_context_refs &&
      !graph.context.feature_context_refs.every((reference) =>
        (observation.runtime_context.feature_context_refs ?? []).includes(reference),
      )
    ) {
      issues.push(
        issue(
          "graph_observation_context_mismatch",
          `/observations/${index}/runtime_context/feature_context_refs`,
          "Observation does not satisfy every required feature-context selector.",
        ),
      );
    }
    const observedAt = observation.observed_at.wall_time;
    if (
      graph.context.observation_time_range &&
      (compareTimestamps(observedAt, graph.context.observation_time_range.started_at) < 0 ||
        compareTimestamps(observedAt, graph.context.observation_time_range.ended_at) > 0)
    ) {
      issues.push(
        issue(
          "graph_observation_time_out_of_range",
          `/observations/${index}/observed_at/wall_time`,
          "Observation time must be inside the GraphContext observation range.",
        ),
      );
    }
    if (compareTimestamps(observedAt, graph.materialized_at) > 0) {
      issues.push(
        issue(
          "graph_materialized_before_observation",
          "/materialized_at",
          "A graph cannot be materialized before an Observation it contains.",
        ),
      );
    }

    for (const [field, collection, code, resolve] of [
      ["screen_state_id", states, "graph_dangling_state_reference"],
      ["source_state_id", states, "graph_dangling_state_reference"],
      ["target_state_id", states, "graph_dangling_state_reference"],
      // Immutable evidence keeps naming the transition it was captured for;
      // a merge that coalesced that transition records where it went.
      ["transition_id", transitions, "graph_dangling_transition_reference", resolveTransitionId],
      ["action_id", actions, "graph_dangling_action_reference"],
      ["supersedes_observation_id", observations, "graph_dangling_observation_reference"],
    ]) {
      const value =
        observation[field] === undefined
          ? undefined
          : resolve === undefined
            ? observation[field]
            : resolve(observation[field]);
      if (value !== undefined && !collection.has(value)) {
        issues.push(
          issue(code, `/observations/${index}/${field}`, `${field} does not exist in the graph.`),
        );
      }
    }
    if (
      observation.supersedes_observation_id !== undefined &&
      observation.supersedes_observation_id === observation.observation_id
    ) {
      issues.push(
        issue(
          "graph_observation_self_supersession",
          `/observations/${index}/supersedes_observation_id`,
          "An observation cannot supersede itself.",
        ),
      );
    }
    if (
      observation.before_snapshot_id !== undefined &&
      !observation.snapshot_ids.includes(observation.before_snapshot_id)
    ) {
      issues.push(
        issue(
          "graph_observation_snapshot_mismatch",
          `/observations/${index}/before_snapshot_id`,
          "Before Snapshot must be included in snapshot_ids.",
        ),
      );
    }
    if (
      observation.after_snapshot_id !== undefined &&
      !observation.snapshot_ids.includes(observation.after_snapshot_id)
    ) {
      issues.push(
        issue(
          "graph_observation_snapshot_mismatch",
          `/observations/${index}/after_snapshot_id`,
          "After Snapshot must be included in snapshot_ids.",
        ),
      );
    }
    if (observation.kind === "state") {
      const state = states.get(observation.screen_state_id);
      const movedToReferencingState = [
        ...(decisionGrants.get(observation.observation_id) ?? []),
      ].some((grantedStateId) =>
        states.get(grantedStateId)?.observation_ids.includes(observation.observation_id),
      );
      if (
        state &&
        !state.observation_ids.includes(observation.observation_id) &&
        !movedToReferencingState
      ) {
        issues.push(
          issue(
            "graph_state_observation_mismatch",
            `/observations/${index}/screen_state_id`,
            "A state Observation must be referenced by its Screen State.",
          ),
        );
      }
    }
    if (observation.kind === "transition") {
      const resolvedTransitionId = resolveTransitionId(observation.transition_id);
      const transition = transitions.get(resolvedTransitionId);
      if (transition === undefined) {
        issues.push(
          issue(
            "graph_dangling_transition_reference",
            `/observations/${index}/transition_id`,
            "A transition Observation must name a Transition the graph still holds.",
          ),
        );
      } else if (!transition.observation_ids.includes(observation.observation_id)) {
        issues.push(
          issue(
            "graph_transition_observation_mismatch",
            `/observations/${index}/transition_id`,
            "A transition Observation must be referenced by its Transition.",
          ),
        );
      }
    }
  }

  checkSingleReferenceCycles(
    graph.observations,
    "observation_id",
    "supersedes_observation_id",
    "/observations",
    "graph_observation_supersession_cycle",
    issues,
  );

  for (const [index, decision] of graph.identity_decisions.entries()) {
    if (!versionMatches(graph.protocol_version, decision.protocol_version)) {
      issues.push(
        issue(
          "graph_protocol_version_mismatch",
          `/identity_decisions/${index}/protocol_version`,
          "Identity decision protocol version must match the graph.",
        ),
      );
    }
    for (const [field, ids] of [
      ["input_state_ids", decision.input_state_ids],
      ["output_state_ids", decision.output_state_ids],
    ]) {
      for (const [stateIndex, stateId] of ids.entries()) {
        if (!states.has(stateId)) {
          issues.push(
            issue(
              "graph_dangling_state_reference",
              `/identity_decisions/${index}/${field}/${stateIndex}`,
              "Identity decision state does not exist in the graph.",
            ),
          );
        }
      }
    }
    for (const [observationIndex, observationId] of decision.observation_ids.entries()) {
      if (!observations.has(observationId)) {
        issues.push(
          issue(
            "graph_dangling_observation_reference",
            `/identity_decisions/${index}/observation_ids/${observationIndex}`,
            "Identity decision observation does not exist in the graph.",
          ),
        );
      }
    }
    if (
      decision.supersedes_decision_id !== undefined &&
      (!decisions.has(decision.supersedes_decision_id) ||
        decision.supersedes_decision_id === decision.state_identity_decision_id)
    ) {
      issues.push(
        issue(
          "graph_invalid_superseded_decision",
          `/identity_decisions/${index}/supersedes_decision_id`,
          "Superseded decision must be another decision in the graph.",
        ),
      );
    }
  }

  checkSingleReferenceCycles(
    graph.identity_decisions,
    "state_identity_decision_id",
    "supersedes_decision_id",
    "/identity_decisions",
    "graph_decision_supersession_cycle",
    issues,
  );

  return issues;
}

export function checkKnowledgeGraph(graph) {
  const issues = [];
  const nodes = addUniqueIds(
    graph.nodes,
    "wiki_node_id",
    "/nodes",
    "duplicate_wiki_node_id",
    issues,
  );
  const links = addUniqueIds(
    graph.links,
    "wiki_link_id",
    "/links",
    "duplicate_wiki_link_id",
    issues,
  );
  addUniqueIds(
    graph.collections,
    "collection_id",
    "/collections",
    "duplicate_knowledge_collection_id",
    issues,
  );

  for (const [index, node] of graph.nodes.entries()) {
    if (!versionMatches(graph.protocol_version, node.protocol_version)) {
      issues.push(
        issue(
          "knowledge_protocol_version_mismatch",
          `/nodes/${index}/protocol_version`,
          "Wiki Node protocol version must match its Knowledge Graph.",
        ),
      );
    }
    checkTimeOrder(
      node.created_at,
      node.updated_at,
      `/nodes/${index}`,
      "knowledge_timestamp_order_invalid",
      issues,
    );
    if (node.supersedes_node_id !== undefined) {
      if (!nodes.has(node.supersedes_node_id)) {
        issues.push(
          issue(
            "wiki_node_supersedes_missing",
            `/nodes/${index}/supersedes_node_id`,
            "Superseded Wiki Node is not present in the Knowledge Graph.",
          ),
        );
      } else if (node.supersedes_node_id === node.wiki_node_id) {
        issues.push(
          issue(
            "wiki_node_self_supersession",
            `/nodes/${index}/supersedes_node_id`,
            "A Wiki Node cannot supersede itself.",
          ),
        );
      }
    }
    for (const [attachmentIndex, attachment] of node.attachments.entries()) {
      if (attachment.target.kind !== "wiki_node" || attachment.target.id !== node.wiki_node_id) {
        issues.push(
          issue(
            "artifact_link_target_mismatch",
            `/nodes/${index}/attachments/${attachmentIndex}/target`,
            "A Wiki Node attachment must target its enclosing Wiki Node.",
          ),
        );
      }
    }
  }

  checkSingleReferenceCycles(
    graph.nodes,
    "wiki_node_id",
    "supersedes_node_id",
    "/nodes",
    "wiki_node_supersession_cycle",
    issues,
  );

  for (const [index, link] of graph.links.entries()) {
    if (!versionMatches(graph.protocol_version, link.protocol_version)) {
      issues.push(
        issue(
          "knowledge_protocol_version_mismatch",
          `/links/${index}/protocol_version`,
          "Wiki Link protocol version must match its Knowledge Graph.",
        ),
      );
    }
    if (!nodes.has(link.source_node_id)) {
      issues.push(
        issue(
          "wiki_link_source_missing",
          `/links/${index}/source_node_id`,
          "Wiki Link source is not present in the Knowledge Graph.",
        ),
      );
    }
    if (link.target.kind === "wiki_node" && !nodes.has(link.target.id)) {
      issues.push(
        issue(
          "wiki_link_target_missing",
          `/links/${index}/target/id`,
          "Wiki Link target is not present in the Knowledge Graph.",
        ),
      );
    }
  }

  for (const [index, collection] of graph.collections.entries()) {
    if (!versionMatches(graph.protocol_version, collection.protocol_version)) {
      issues.push(
        issue(
          "knowledge_protocol_version_mismatch",
          `/collections/${index}/protocol_version`,
          "Knowledge Collection protocol version must match its Knowledge Graph.",
        ),
      );
    }
    checkTimeOrder(
      collection.created_at,
      collection.updated_at,
      `/collections/${index}`,
      "knowledge_timestamp_order_invalid",
      issues,
    );
    const memberNodeIds = new Set(collection.node_ids);
    for (const [nodeIndex, nodeId] of collection.node_ids.entries()) {
      if (!nodes.has(nodeId)) {
        issues.push(
          issue(
            "knowledge_collection_node_missing",
            `/collections/${index}/node_ids/${nodeIndex}`,
            "Knowledge Collection node is not present in the graph.",
          ),
        );
      }
    }
    for (const [linkIndex, linkId] of collection.link_ids.entries()) {
      if (!links.has(linkId)) {
        issues.push(
          issue(
            "knowledge_collection_link_missing",
            `/collections/${index}/link_ids/${linkIndex}`,
            "Knowledge Collection link is not present in the graph.",
          ),
        );
      }
    }
    for (const [entryIndex, nodeId] of collection.entry_node_ids.entries()) {
      if (!memberNodeIds.has(nodeId)) {
        issues.push(
          issue(
            "knowledge_collection_entry_not_member",
            `/collections/${index}/entry_node_ids/${entryIndex}`,
            "Knowledge Collection entry must also be one of its member nodes.",
          ),
        );
      }
    }
    if (
      collection.publication.state === "published" &&
      compareTimestamps(collection.publication.published_at, collection.created_at) < 0
    ) {
      issues.push(
        issue(
          "knowledge_timestamp_order_invalid",
          `/collections/${index}/publication/published_at`,
          "A Knowledge Collection cannot be published before it is created.",
        ),
      );
    }
    if (
      collection.publication.state === "archived" &&
      compareTimestamps(collection.publication.archived_at, collection.created_at) < 0
    ) {
      issues.push(
        issue(
          "knowledge_timestamp_order_invalid",
          `/collections/${index}/publication/archived_at`,
          "A Knowledge Collection cannot be archived before it is created.",
        ),
      );
    }
  }

  return issues;
}

export function checkWorkingSet(workingSet) {
  const issues = [];
  addUniqueIds(
    workingSet.changes,
    "change_id",
    "/changes",
    "duplicate_working_change_id",
    issues,
  );
  checkTimeOrder(
    workingSet.created_at,
    workingSet.updated_at,
    "/updated_at",
    "working_set_time_order_invalid",
    issues,
  );
  return issues;
}

function checkReviewIssueHistory(issueValue, index, issues) {
  const history = issueValue.state_history;
  const allowedTransitions = {
    open: new Set(["in_progress", "ready_for_verification", "wont_fix"]),
    in_progress: new Set(["open", "ready_for_verification", "wont_fix"]),
    ready_for_verification: new Set(["in_progress", "resolved", "wont_fix"]),
    resolved: new Set(["open"]),
    wont_fix: new Set(["open"]),
  };

  if (
    history.length === 0 ||
    history[0].revision !== 1 ||
    history[0].from_state !== undefined ||
    history[0].to_state !== "open"
  ) {
    issues.push(
      issue(
        "review_issue_initial_state_invalid",
        `/issues/${index}/state_history/0`,
        "Review Issue history must start at revision one in the open state.",
      ),
    );
  }

  for (const [historyIndex, change] of history.entries()) {
    if (change.revision !== historyIndex + 1) {
      issues.push(
        issue(
          "review_issue_history_revision_invalid",
          `/issues/${index}/state_history/${historyIndex}/revision`,
          "Review Issue history revisions must be contiguous and start at one.",
        ),
      );
    }
    if (
      compareTimestamps(change.changed_at, issueValue.created_at) < 0 ||
      compareTimestamps(change.changed_at, issueValue.updated_at) > 0
    ) {
      issues.push(
        issue(
          "design_timestamp_order_invalid",
          `/issues/${index}/state_history/${historyIndex}/changed_at`,
          "Review Issue state changes must remain inside the resource revision time range.",
        ),
      );
    }
    if (historyIndex > 0) {
      const previous = history[historyIndex - 1];
      if (change.from_state !== previous.to_state) {
        issues.push(
          issue(
            "review_issue_history_discontinuous",
            `/issues/${index}/state_history/${historyIndex}/from_state`,
            "Review Issue state history must form one continuous chain.",
          ),
        );
      }
      if (!allowedTransitions[previous.to_state]?.has(change.to_state)) {
        issues.push(
          issue(
            "review_issue_transition_invalid",
            `/issues/${index}/state_history/${historyIndex}/to_state`,
            `Review Issue cannot transition from ${previous.to_state} to ${change.to_state}.`,
          ),
        );
      }
      if (compareTimestamps(previous.changed_at, change.changed_at) > 0) {
        issues.push(
          issue(
            "design_timestamp_order_invalid",
            `/issues/${index}/state_history/${historyIndex}/changed_at`,
            "Review Issue history timestamps must be nondecreasing.",
          ),
        );
      }
    }
  }

  const finalChange = history.at(-1);
  if (
    !finalChange ||
    issueValue.revision !== finalChange.revision ||
    issueValue.state !== finalChange.to_state
  ) {
    issues.push(
      issue(
        "review_issue_state_mismatch",
        `/issues/${index}/state`,
        "Review Issue revision and state must match the final history entry.",
      ),
    );
  }
}

function checkTuningChangeValue(change, path, issues) {
  const contracts = {
    frame: { kind: "rect" },
    content_insets: { kind: "insets" },
    spacing: { kind: "number", unit: "logical_point" },
    font: { kind: "font" },
    foreground_color: { kind: "color_rgba" },
    background_color: { kind: "color_rgba" },
    alpha: { kind: "number", unit: "ratio", minimum: 0, maximum: 1 },
    corner_radius: { kind: "number", unit: "logical_point", minimum: 0 },
    border_width: { kind: "number", unit: "logical_point", minimum: 0 },
    border_color: { kind: "color_rgba" },
    shadow: { kind: "shadow" },
  };
  const contract = contracts[change.property];
  for (const field of ["original_value", "preview_value"]) {
    const value = change[field];
    if (value.kind !== contract.kind || (contract.unit && value.unit !== contract.unit)) {
      issues.push(
        issue(
          "tuning_change_property_value_mismatch",
          `${path}/${field}`,
          `${change.property} requires ${contract.kind}${contract.unit ? ` in ${contract.unit}` : ""}.`,
        ),
      );
      continue;
    }
    if (
      value.kind === "number" &&
      ((contract.minimum !== undefined && value.value < contract.minimum) ||
        (contract.maximum !== undefined && value.value > contract.maximum))
    ) {
      issues.push(
        issue(
          "tuning_change_property_value_out_of_range",
          `${path}/${field}/value`,
          `${change.property} value is outside its allowed range.`,
        ),
      );
    }
  }
}

export function checkTuningPatch(patch) {
  const issues = [];
  const propertyTargets = new Set();
  checkTimeOrder(
    patch.created_at,
    patch.updated_at,
    "/updated_at",
    "design_timestamp_order_invalid",
    issues,
  );
  addUniqueIds(
    patch.changes,
    "tuning_change_id",
    "/changes",
    "duplicate_tuning_change_id",
    issues,
  );
  for (const [index, change] of patch.changes.entries()) {
    const changePath = `/changes/${index}`;
    const propertyTarget = `${runtimeTargetKey(change.runtime_target)}:${change.property}`;
    if (propertyTargets.has(propertyTarget)) {
      issues.push(
        issue(
          "duplicate_tuning_property_target",
          `${changePath}/property`,
          "One Tuning Patch cannot assign the same property of one runtime target twice.",
        ),
      );
    }
    propertyTargets.add(propertyTarget);
    checkTuningChangeValue(change, changePath, issues);
    if (change.runtime_target.snapshot_id !== patch.target_snapshot_id) {
      issues.push(
        issue(
          "tuning_patch_target_snapshot_mismatch",
          `${changePath}/runtime_target/snapshot_id`,
          "Tuning Change target Snapshot must match its patch.",
        ),
      );
    }
    if (change.original_value.kind !== change.preview_value.kind) {
      issues.push(
        issue(
          "tuning_change_value_kind_mismatch",
          `${changePath}/preview_value/kind`,
          "Original and preview values must use the same value kind.",
        ),
      );
    } else if (deepEqual(change.original_value, change.preview_value)) {
      issues.push(
        issue(
          "tuning_change_not_effective",
          `${changePath}/preview_value`,
          "A Tuning Change preview must differ from the captured original.",
        ),
      );
    }
  }
  return issues;
}

export function checkDesignReviewBundle(bundle) {
  const issues = [];
  const references = addUniqueIds(
    bundle.references,
    "design_reference_id",
    "/references",
    "duplicate_design_reference_id",
    issues,
  );
  const mappings = addUniqueIds(
    bundle.mappings,
    "mapping_id",
    "/mappings",
    "duplicate_design_mapping_id",
    issues,
  );
  const comparisons = addUniqueIds(
    bundle.comparisons,
    "comparison_id",
    "/comparisons",
    "duplicate_design_comparison_id",
    issues,
  );
  const issueMap = addUniqueIds(
    bundle.issues,
    "issue_id",
    "/issues",
    "duplicate_review_issue_id",
    issues,
  );
  const verifications = addUniqueIds(
    bundle.verifications,
    "verification_record_id",
    "/verifications",
    "duplicate_review_verification_id",
    issues,
  );
  const patches = addUniqueIds(
    bundle.patches,
    "patch_id",
    "/patches",
    "duplicate_tuning_patch_id",
    issues,
  );
  const applications = addUniqueIds(
    bundle.applications ?? [],
    "tuning_application_id",
    "/applications",
    "duplicate_tuning_application_id",
    issues,
  );

  const checkVersion = (value, path) => {
    if (!versionMatches(bundle.protocol_version, value.protocol_version)) {
      issues.push(
        issue(
          "design_protocol_version_mismatch",
          `${path}/protocol_version`,
          "Nested design model protocol version must match its bundle.",
        ),
      );
    }
  };
  const checkMutableTimes = (value, path) => {
    checkTimeOrder(
      value.created_at,
      value.updated_at,
      path,
      "design_timestamp_order_invalid",
      issues,
    );
  };

  for (const [index, reference] of bundle.references.entries()) {
    checkVersion(reference, `/references/${index}`);
    checkMutableTimes(reference, `/references/${index}`);
  }

  for (const [index, mapping] of bundle.mappings.entries()) {
    checkVersion(mapping, `/mappings/${index}`);
    checkMutableTimes(mapping, `/mappings/${index}`);
    const reference = references.get(mapping.design_reference_id);
    if (!reference) {
      issues.push(
        issue(
          "design_mapping_reference_missing",
          `/mappings/${index}/design_reference_id`,
          "Design Region Mapping reference is not present in the bundle.",
        ),
      );
    } else if (
      mapping.design_region.x < 0 ||
      mapping.design_region.y < 0 ||
      mapping.design_region.x + mapping.design_region.width > reference.canvas_size.width ||
      mapping.design_region.y + mapping.design_region.height > reference.canvas_size.height
    ) {
      issues.push(
        issue(
          "design_mapping_region_out_of_bounds",
          `/mappings/${index}/design_region`,
          "Mapped design region must remain inside the design canvas.",
        ),
      );
    }
  }

  for (const [index, comparison] of bundle.comparisons.entries()) {
    checkVersion(comparison, `/comparisons/${index}`);
    if (!references.has(comparison.design_reference_id)) {
      issues.push(
        issue(
          "design_comparison_reference_missing",
          `/comparisons/${index}/design_reference_id`,
          "Design Comparison reference is not present in the bundle.",
        ),
      );
    }
    const comparisonMappingIds = new Set(comparison.mapping_ids);
    for (const [mappingIndex, mappingId] of comparison.mapping_ids.entries()) {
      const mapping = mappings.get(mappingId);
      if (!mapping) {
        issues.push(
          issue(
            "design_comparison_mapping_missing",
            `/comparisons/${index}/mapping_ids/${mappingIndex}`,
            "Design Comparison mapping is not present in the bundle.",
          ),
        );
      } else if (
        mapping.design_reference_id !== comparison.design_reference_id ||
        mapping.runtime_target.snapshot_id !== comparison.target_snapshot_id
      ) {
        issues.push(
          issue(
            "design_comparison_mapping_context_mismatch",
            `/comparisons/${index}/mapping_ids/${mappingIndex}`,
            "Comparison mappings must use its Design Reference and target Snapshot.",
          ),
        );
      }
    }
    addUniqueIds(
      comparison.differences,
      "difference_id",
      `/comparisons/${index}/differences`,
      "duplicate_design_difference_id",
      issues,
    );
    for (const [differenceIndex, difference] of comparison.differences.entries()) {
      if (difference.mapping_id !== undefined) {
        const mapping = mappings.get(difference.mapping_id);
        if (!mapping || !comparisonMappingIds.has(difference.mapping_id)) {
          issues.push(
            issue(
              "design_difference_mapping_missing",
              `/comparisons/${index}/differences/${differenceIndex}/mapping_id`,
              "Design Difference mapping must be one of its Comparison mappings.",
            ),
          );
        } else if (
          mapping.design_reference_id !== comparison.design_reference_id ||
          mapping.runtime_target.snapshot_id !== comparison.target_snapshot_id
        ) {
          issues.push(
            issue(
              "design_difference_mapping_context_mismatch",
              `/comparisons/${index}/differences/${differenceIndex}/mapping_id`,
              "Design Difference mapping must share the Comparison reference and Snapshot.",
            ),
          );
        }
        if (
          mapping &&
          difference.runtime_target !== undefined &&
          !sameRuntimeTarget(mapping.runtime_target, difference.runtime_target)
        ) {
          issues.push(
            issue(
              "design_difference_mapping_context_mismatch",
              `/comparisons/${index}/differences/${differenceIndex}/runtime_target`,
              "Design Difference runtime target must match its mapping.",
            ),
          );
        }
      } else if (
        difference.runtime_target !== undefined &&
        difference.runtime_target.snapshot_id !== comparison.target_snapshot_id
      ) {
        issues.push(
          issue(
            "design_difference_mapping_context_mismatch",
            `/comparisons/${index}/differences/${differenceIndex}/runtime_target/snapshot_id`,
            "Unmapped Design Difference must target the Comparison Snapshot.",
          ),
        );
      }
    }
  }

  for (const [index, issueValue] of bundle.issues.entries()) {
    checkVersion(issueValue, `/issues/${index}`);
    checkMutableTimes(issueValue, `/issues/${index}`);
    checkReviewIssueHistory(issueValue, index, issues);
    if (!references.has(issueValue.design_reference_id)) {
      issues.push(
        issue(
          "review_issue_reference_missing",
          `/issues/${index}/design_reference_id`,
          "Review Issue design reference is not present in the bundle.",
        ),
      );
    }
    if (issueValue.mapping_id !== undefined) {
      const mapping = mappings.get(issueValue.mapping_id);
      if (!mapping) {
        issues.push(
          issue(
            "review_issue_mapping_missing",
            `/issues/${index}/mapping_id`,
            "Review Issue mapping is not present in the bundle.",
          ),
        );
      } else if (
        mapping.design_reference_id !== issueValue.design_reference_id ||
        !sameRuntimeTarget(mapping.runtime_target, issueValue.runtime_target)
      ) {
        issues.push(
          issue(
            "design_mapping_target_mismatch",
            `/issues/${index}/mapping_id`,
            "Review Issue mapping must share its Design Reference and runtime target.",
          ),
        );
      }
    }
    if (issueValue.comparison_id !== undefined) {
      const comparison = comparisons.get(issueValue.comparison_id);
      if (!comparison) {
        issues.push(
          issue(
            "review_issue_comparison_missing",
            `/issues/${index}/comparison_id`,
            "Review Issue comparison is not present in the bundle.",
          ),
        );
      } else if (
        comparison.design_reference_id !== issueValue.design_reference_id ||
        comparison.target_snapshot_id !== issueValue.runtime_target.snapshot_id
      ) {
        issues.push(
          issue(
            "review_issue_comparison_context_mismatch",
            `/issues/${index}/comparison_id`,
            "Review Issue comparison must share its Design Reference and target Snapshot.",
          ),
        );
      }
    }
    for (const [verificationIndex, verificationId] of issueValue.verification_record_ids.entries()) {
      const verification = verifications.get(verificationId);
      if (!verification || verification.issue_id !== issueValue.issue_id) {
        issues.push(
          issue(
            "review_issue_verification_missing",
            `/issues/${index}/verification_record_ids/${verificationIndex}`,
            "Review Issue verification must exist and belong to the issue.",
          ),
        );
      }
    }
    for (const [patchIndex, patchId] of issueValue.tuning_patch_ids.entries()) {
      if (!patches.has(patchId)) {
        issues.push(
          issue(
            "review_issue_patch_missing",
            `/issues/${index}/tuning_patch_ids/${patchIndex}`,
            "Review Issue Tuning Patch is not present in the bundle.",
          ),
        );
      }
    }
    const terminal = ["resolved", "wont_fix"].includes(issueValue.state);
    if (terminal && issueValue.resolution === undefined) {
      issues.push(
        issue(
          "review_issue_resolution_mismatch",
          `/issues/${index}/resolution`,
          "A terminal Review Issue must record its resolution.",
        ),
      );
    } else if (!terminal && issueValue.resolution !== undefined) {
      issues.push(
        issue(
          "review_issue_nonterminal_has_resolution",
          `/issues/${index}/resolution`,
          "A nonterminal Review Issue cannot retain a resolution.",
        ),
      );
    }
    if (
      (issueValue.state === "resolved" && issueValue.resolution?.kind !== "verified") ||
      (issueValue.state === "wont_fix" &&
        !["wont_fix", "duplicate", "out_of_scope"].includes(issueValue.resolution?.kind))
    ) {
      issues.push(
        issue(
          "review_issue_resolution_mismatch",
          `/issues/${index}/resolution/kind`,
          "Resolved Issues require verified resolution; wont_fix Issues require a non-verified terminal rationale.",
        ),
      );
    }
    const finalChange = issueValue.state_history.at(-1);
    if (
      issueValue.resolution !== undefined &&
      finalChange &&
      compareTimestamps(issueValue.resolution.resolved_at, finalChange.changed_at) !== 0
    ) {
      issues.push(
        issue(
          "review_issue_resolution_mismatch",
          `/issues/${index}/resolution/resolved_at`,
          "Resolution time must match the terminal state-history change.",
        ),
      );
    }
    if (issueValue.resolution?.kind === "verified") {
      const verification = verifications.get(issueValue.resolution.verification_record_id);
      if (
        !verification ||
        verification.issue_id !== issueValue.issue_id ||
        verification.basis !== "real_build" ||
        verification.result !== "passed"
      ) {
        issues.push(
          issue(
            "review_issue_resolution_requires_passed_real_build",
            `/issues/${index}/resolution/verification_record_id`,
            "A verified resolution requires a passed real-build verification for this issue.",
          ),
        );
      }
      if (
        finalChange?.verification_record_id !== issueValue.resolution.verification_record_id
      ) {
        issues.push(
          issue(
            "review_issue_resolution_mismatch",
            `/issues/${index}/state_history/${issueValue.state_history.length - 1}/verification_record_id`,
            "Terminal history and verified resolution must reference the same verification.",
          ),
        );
      }
    }
  }

  for (const [index, verification] of bundle.verifications.entries()) {
    checkVersion(verification, `/verifications/${index}`);
    const issueValue = issueMap.get(verification.issue_id);
    if (!issueValue) {
      issues.push(
        issue(
          "review_verification_issue_missing",
          `/verifications/${index}/issue_id`,
          "Review Verification target issue is not present in the bundle.",
        ),
      );
    } else if (
      verification.issue_revision >= issueValue.revision ||
      !issueValue.state_history.some((change) => change.revision === verification.issue_revision)
    ) {
      issues.push(
        issue(
          "review_verification_revision_invalid",
          `/verifications/${index}/issue_revision`,
          "Review Verification must address an extant earlier Issue revision.",
        ),
      );
    }
    if (verification.evidence.length === 0) {
      issues.push(
        issue(
          "review_verification_evidence_missing",
          `/verifications/${index}/evidence`,
          "Review Verification requires durable evidence.",
        ),
      );
    }
    if (
      verification.basis === "runtime_preview" &&
      !applications.has(verification.tuning_application_id)
    ) {
      issues.push(
        issue(
          "review_verification_application_missing",
          `/verifications/${index}/tuning_application_id`,
          "Runtime-preview verification must reference a bundled Tuning Application.",
        ),
      );
    }
  }

  for (const [index, patch] of bundle.patches.entries()) {
    checkVersion(patch, `/patches/${index}`);
    issues.push(
      ...checkTuningPatch(patch).map((entry) => ({
        ...entry,
        path: `/patches/${index}${entry.path}`,
      })),
    );
    for (const [issueIndex, issueId] of patch.issue_ids.entries()) {
      if (!issueMap.has(issueId)) {
        issues.push(
          issue(
            "tuning_patch_issue_missing",
            `/patches/${index}/issue_ids/${issueIndex}`,
            "Tuning Patch Review Issue is not present in the bundle.",
          ),
        );
      }
    }
  }

  for (const [index, application] of (bundle.applications ?? []).entries()) {
    checkVersion(application, `/applications/${index}`);
    const patch = patches.get(application.patch_id);
    if (!patch) {
      issues.push(
        issue(
          "tuning_application_patch_missing",
          `/applications/${index}/patch_id`,
          "Tuning Application patch is not present in the bundle.",
        ),
      );
      continue;
    }
    if (application.patch_revision !== patch.revision) {
      issues.push(
        issue(
          "tuning_application_patch_revision_mismatch",
          `/applications/${index}/patch_revision`,
          "Tuning Application must resolve the exact bundled patch revision.",
        ),
      );
    }
    if (application.expected_snapshot_id !== patch.target_snapshot_id) {
      issues.push(
        issue(
          "tuning_application_snapshot_mismatch",
          `/applications/${index}/expected_snapshot_id`,
          "Tuning Application expected Snapshot must match its patch target.",
        ),
      );
    }
    if (application.applied_at !== undefined) {
      checkTimeOrder(
        application.started_at,
        application.applied_at,
        `/applications/${index}/applied_at`,
        "tuning_application_time_order_invalid",
        issues,
      );
    }
    if (application.preview_expires_at !== undefined) {
      checkTimeOrder(
        application.applied_at ?? application.started_at,
        application.preview_expires_at,
        `/applications/${index}/preview_expires_at`,
        "tuning_application_time_order_invalid",
        issues,
      );
    }
    if (application.reverted_at !== undefined) {
      checkTimeOrder(
        application.applied_at ?? application.started_at,
        application.reverted_at,
        `/applications/${index}/reverted_at`,
        "tuning_application_time_order_invalid",
        issues,
      );
    }
    const patchChanges = new Map(patch.changes.map((change) => [change.tuning_change_id, change]));
    const appliedIds = application.applied_changes.map((change) => change.tuning_change_id);
    const rejectedIds = application.rejected_changes.map((change) => change.tuning_change_id);
    const resultIds = [...appliedIds, ...rejectedIds];
    if (
      new Set(resultIds).size !== resultIds.length ||
      resultIds.some((id) => !patchChanges.has(id)) ||
      (application.status !== "applying" && resultIds.length !== patchChanges.size)
    ) {
      issues.push(
        issue(
          "tuning_application_change_partition_invalid",
          `/applications/${index}`,
          "Applied and rejected changes must form an exact disjoint partition of the patch.",
        ),
      );
    }
    for (const [changeIndex, applied] of application.applied_changes.entries()) {
      const source = patchChanges.get(applied.tuning_change_id);
      if (
        source &&
        (!sameRuntimeTarget(applied.runtime_target, source.runtime_target) ||
          !deepEqual(applied.original_value, source.original_value) ||
          !deepEqual(applied.applied_value, source.preview_value))
      ) {
        issues.push(
          issue(
            "tuning_application_value_mismatch",
            `/applications/${index}/applied_changes/${changeIndex}`,
            "Applied Tuning Change must preserve the patch target, original, and preview value.",
          ),
        );
      }
      if (
        applied.reverted_at !== undefined &&
        (compareTimestamps(
          application.applied_at ?? application.started_at,
          applied.reverted_at,
        ) > 0 ||
          (application.reverted_at !== undefined &&
            compareTimestamps(applied.reverted_at, application.reverted_at) > 0))
      ) {
        issues.push(
          issue(
            "tuning_application_time_order_invalid",
            `/applications/${index}/applied_changes/${changeIndex}/reverted_at`,
            "Change reversion must follow application and complete by the Application reversion time.",
          ),
        );
      }
    }
    for (const [changeIndex, rejected] of application.rejected_changes.entries()) {
      const source = patchChanges.get(rejected.tuning_change_id);
      if (source && !sameRuntimeTarget(rejected.runtime_target, source.runtime_target)) {
        issues.push(
          issue(
            "tuning_application_value_mismatch",
            `/applications/${index}/rejected_changes/${changeIndex}/runtime_target`,
            "Rejected Tuning Change must preserve the patch target.",
          ),
        );
      }
    }
    const active = ["active", "partially_active"].includes(application.status);
    const terminal = ["reverted", "expired", "failed", "connection_lost"].includes(
      application.status,
    );
    if (active && (application.applied_changes.length === 0 || application.applied_at === undefined)) {
      issues.push(
        issue(
          "tuning_application_state_invalid",
          `/applications/${index}/status`,
          "An active Tuning Application requires at least one applied change and applied_at.",
        ),
      );
    }
    if (
      (application.status === "active" && application.rejected_changes.length > 0) ||
      (application.status === "partially_active" && application.rejected_changes.length === 0)
    ) {
      issues.push(
        issue(
          "tuning_application_state_invalid",
          `/applications/${index}/status`,
          "Active means every change applied; partially_active requires both applied and rejected changes.",
        ),
      );
    }
    if (
      active &&
      (application.reverted_at !== undefined ||
        application.reversion_reason !== undefined ||
        application.applied_changes.some((change) => change.reverted_at !== undefined))
    ) {
      issues.push(
        issue(
          "tuning_application_state_invalid",
          `/applications/${index}`,
          "An active Tuning Application cannot contain reversion state.",
        ),
      );
    }
    if (
      terminal &&
      application.applied_changes.length > 0 &&
      (application.reverted_at === undefined ||
        application.reversion_reason === undefined ||
        application.applied_changes.some((change) => change.reverted_at === undefined))
    ) {
      issues.push(
        issue(
          "tuning_application_reversion_incomplete",
          `/applications/${index}`,
          "A terminal Tuning Application must prove that every applied change was reverted.",
        ),
      );
    }
    if (
      application.status === "expired" &&
      (application.reversion_reason !== "ttl_expiry" ||
        application.preview_expires_at === undefined ||
        application.reverted_at === undefined ||
        compareTimestamps(application.reverted_at, application.preview_expires_at) < 0)
    ) {
      issues.push(
        issue(
          "tuning_application_state_invalid",
          `/applications/${index}/status`,
          "An expired Application must revert at or after preview expiry for reason ttl_expiry.",
        ),
      );
    }
    if (
      application.status === "connection_lost" &&
      !["transport_loss", "connection_close"].includes(application.reversion_reason)
    ) {
      issues.push(
        issue(
          "tuning_application_state_invalid",
          `/applications/${index}/reversion_reason`,
          "A connection_lost Application requires transport_loss or connection_close.",
        ),
      );
    }
    if (
      application.status === "reverted" &&
      ![
        "explicit_revert",
        "prepare_disconnect",
        "connection_close",
        "application_termination",
      ].includes(application.reversion_reason)
    ) {
      issues.push(
        issue(
          "tuning_application_state_invalid",
          `/applications/${index}/reversion_reason`,
          "A reverted Application requires an explicit lifecycle reversion reason.",
        ),
      );
    }
    if (
      application.status === "failed" &&
      application.applied_changes.length > 0 &&
      application.reversion_reason !== "partial_failure"
    ) {
      issues.push(
        issue(
          "tuning_application_state_invalid",
          `/applications/${index}/reversion_reason`,
          "A failed Application with applied changes requires partial_failure reversion.",
        ),
      );
    }
  }

  return issues;
}

export function checkOperationRecord(record, context = {}) {
  const issues = [];
  const { operation, events, result } = record;
  const eventIds = new Set();
  let previousSequence = 0;
  let previousTime = operation.created_at;
  let previousState;
  let terminalSeen = false;
  let createdEventCount = 0;
  let startedEventCount = 0;
  let terminalEventCount = 0;

  const checkProgress = (progress, path) => {
    if (
      progress?.completed_units !== undefined &&
      progress.completed_units > progress.total_units
    ) {
      issues.push(
        issue(
          "operation_progress_units_invalid",
          `${path}/completed_units`,
          "Completed units cannot exceed total units.",
        ),
      );
    }
    if (
      progress?.fraction !== undefined &&
      progress.completed_units !== undefined &&
      Math.abs(progress.fraction - progress.completed_units / progress.total_units) > 1e-9
    ) {
      issues.push(
        issue(
          "operation_progress_fraction_mismatch",
          `${path}/fraction`,
          "Progress fraction must match completed units divided by total units.",
        ),
      );
    }
  };

  checkProgress(operation.progress, "/operation/progress");

  if (compareTimestamps(operation.created_at, operation.updated_at) > 0) {
    issues.push(
      issue(
        "operation_time_range_invalid",
        "/operation/updated_at",
        "Operation updated_at must not precede created_at.",
      ),
    );
  }

  for (const [index, event] of events.entries()) {
    const eventPath = `/events/${index}`;
    if (eventIds.has(event.event_id)) {
      issues.push(
        issue("operation_duplicate_event_id", `${eventPath}/event_id`, "Event ID is duplicated."),
      );
    }
    eventIds.add(event.event_id);
    if (event.operation_id !== operation.operation_id) {
      issues.push(
        issue(
          "operation_event_owner_mismatch",
          `${eventPath}/operation_id`,
          "Event operation ID must match the record.",
        ),
      );
    }
    if (event.sequence !== previousSequence + 1) {
      issues.push(
        issue(
          "operation_event_sequence_invalid",
          `${eventPath}/sequence`,
          "Operation event sequences must start at one and remain contiguous.",
        ),
      );
    }
    previousSequence = event.sequence;
    if (compareTimestamps(event.time, previousTime) < 0) {
      issues.push(
        issue(
          "operation_event_time_invalid",
          `${eventPath}/time`,
          "Operation event times must be nondecreasing.",
        ),
      );
    }
    previousTime = event.time;
    checkProgress(event.progress, `${eventPath}/progress`);
    if (event.kind === "created") {
      createdEventCount += 1;
      if (index !== 0) {
        issues.push(
          issue(
            "operation_created_event_invalid",
            `${eventPath}/kind`,
            "The created event must occur exactly once at sequence one.",
          ),
        );
      }
    }
    if (event.kind === "started") {
      startedEventCount += 1;
      if (startedEventCount > 1 || (previousState !== undefined && previousState !== "queued")) {
        issues.push(
          issue(
            "operation_started_event_invalid",
            `${eventPath}/kind`,
            "The started event may occur once when first entering running state.",
          ),
        );
      }
    }
    if (event.state === "running" && previousState !== "running" && event.kind !== "started") {
      issues.push(
        issue(
          "operation_started_event_missing",
          `${eventPath}/kind`,
          "The first event entering running state must be started.",
        ),
      );
    }
    if (!["failed", "cancelled"].includes(event.kind) && event.error !== undefined) {
      issues.push(
        issue(
          "operation_event_error_invalid",
          `${eventPath}/error`,
          "Only failed or cancelled events may carry a terminal error.",
        ),
      );
    }
    if (terminalSeen) {
      issues.push(
        issue(
          "operation_event_after_terminal",
          eventPath,
          "No operation event may follow a terminal event.",
        ),
      );
    }
    if (["succeeded", "failed", "cancelled"].includes(event.state)) {
      terminalSeen = true;
      terminalEventCount += 1;
    }
    if (index === 0 && (event.kind !== "created" || event.state !== "queued")) {
      issues.push(
        issue(
          "operation_initial_event_invalid",
          eventPath,
          "The first operation event must create the queued operation.",
        ),
      );
    }
    if (previousState !== undefined) {
      const allowed =
        previousState === "queued"
          ? new Set(["queued", "running", "succeeded", "failed", "cancelled"])
          : previousState === "running"
            ? new Set(["running", "succeeded", "failed", "cancelled"])
            : new Set();
      if (!allowed.has(event.state)) {
        issues.push(
          issue(
            "operation_state_transition_invalid",
            `${eventPath}/state`,
            `Operation cannot transition from ${previousState} to ${event.state}.`,
          ),
        );
      }
    }
    previousState = event.state;
  }

  const finalEvent = events.at(-1);
  if (createdEventCount !== 1) {
    issues.push(
      issue(
        "operation_created_event_invalid",
        "/events",
        "An Operation Record must contain exactly one created event.",
      ),
    );
  }
  if (["succeeded", "failed", "cancelled"].includes(operation.state)) {
    if (terminalEventCount !== 1 || !["succeeded", "failed", "cancelled"].includes(finalEvent.kind)) {
      issues.push(
        issue(
          "operation_terminal_event_invalid",
          "/events",
          "A terminal Operation must end with exactly one matching terminal event.",
        ),
      );
    }
  } else if (terminalEventCount !== 0) {
    issues.push(
      issue(
        "operation_terminal_event_invalid",
        "/events",
        "A nonterminal Operation cannot contain a terminal event.",
      ),
    );
  }
  if (finalEvent.state !== operation.state) {
    issues.push(
      issue(
        "operation_record_state_mismatch",
        "/operation/state",
        "Operation state must match the final event state.",
      ),
    );
  }
  if (compareTimestamps(operation.updated_at, finalEvent.time) < 0) {
    issues.push(
      issue(
        "operation_updated_before_event",
        "/operation/updated_at",
        "Operation updated_at must include the final persisted event.",
      ),
    );
  }
  if (result && result.operation_id !== operation.operation_id) {
    issues.push(
      issue(
        "operation_result_operation_mismatch",
        "/result/operation_id",
        "Operation result must belong to the record operation.",
      ),
    );
  }
  if (result?.storage === "resource") {
    if (!sameResourceRef(operation.result_ref, result.result_ref)) {
      issues.push(
        issue(
          "operation_result_ref_mismatch",
          "/operation/result_ref",
          "Operation result_ref must match the durable resource result.",
        ),
      );
    }
  } else if (result?.storage === "inline" && operation.result_ref !== undefined) {
    issues.push(
      issue(
        "operation_inline_result_has_resource_ref",
        "/operation/result_ref",
        "An inline result must not publish a resource result reference.",
      ),
    );
  }
  if (result?.storage === "inline" && result.schema_id !== undefined) {
    const fragmentMatch = result.schema_id.match(/#\/\$defs\/([^/]+)$/);
    if (fragmentMatch && fragmentMatch[1] !== result.result_type) {
      issues.push(
        issue(
          "operation_result_type_mismatch",
          "/result/result_type",
          "Operation result_type must match the named schema definition.",
        ),
      );
    }
    if (typeof context.validateSchema === "function") {
      const validation = context.validateSchema(result.schema_id, result.value);
      if (!validation.registered) {
        issues.push(
          issue(
            "operation_result_schema_unregistered",
            "/result/schema_id",
            "Operation result schema must be registered locally; remote schema loading is forbidden.",
          ),
        );
      } else if (!validation.valid) {
        issues.push(
          issue(
            "operation_result_value_invalid",
            "/result/value",
            "Inline Operation result does not satisfy its declared schema.",
          ),
        );
      }
    } else {
      issues.push(
        issue(
          "operation_result_schema_unresolved",
          "/result/schema_id",
          "Declared inline result schemas must be resolved and validated locally.",
        ),
      );
    }
  }
  if (
    finalEvent.error &&
    (operation.error?.code !== finalEvent.error.code ||
      operation.error?.retryable !== finalEvent.error.retryable)
  ) {
    issues.push(
      issue(
        "operation_error_mismatch",
        "/operation/error/code",
        "The persisted Operation error must match the terminal event error.",
      ),
    );
  }

  return issues;
}

export function checkValidationRun(run) {
  const issues = [];
  const orderedTimes = [
    ["created_at", run.created_at],
    ["started_at", run.started_at],
    ["completed_at", run.completed_at],
    ["updated_at", run.updated_at],
  ].filter(([, value]) => value !== undefined);
  for (let index = 1; index < orderedTimes.length; index += 1) {
    if (compareTimestamps(orderedTimes[index - 1][1], orderedTimes[index][1]) > 0) {
      issues.push(
        issue(
          "validation_run_time_order_invalid",
          `/${orderedTimes[index][0]}`,
          "Validation lifecycle times must be nondecreasing.",
        ),
      );
    }
  }

  const counts = run.finding_counts;
  if (counts.open + counts.suppressed + counts.resolved !== counts.total) {
    issues.push(
      issue(
        "validation_finding_count_mismatch",
        "/finding_counts",
        "Finding status counts must sum to total.",
      ),
    );
  }
  const severityTotal = Object.values(counts.by_severity).reduce((sum, count) => sum + count, 0);
  if (severityTotal !== counts.total) {
    issues.push(
      issue(
        "validation_severity_count_mismatch",
        "/finding_counts/by_severity",
        "Finding severity counts must sum to total.",
      ),
    );
  }
  return issues;
}

export function checkValidationFinding(finding) {
  const issues = [];
  if (compareTimestamps(finding.detected_at, finding.updated_at) > 0) {
    issues.push(
      issue(
        "validation_finding_time_order_invalid",
        "/updated_at",
        "Finding updated_at must not precede detected_at.",
      ),
    );
  }
  if (
    finding.resolved_at !== undefined &&
    (compareTimestamps(finding.resolved_at, finding.detected_at) < 0 ||
      compareTimestamps(finding.resolved_at, finding.updated_at) > 0)
  ) {
    issues.push(
      issue(
        "validation_finding_time_order_invalid",
        "/resolved_at",
        "Finding resolved_at must be between detected_at and updated_at.",
      ),
    );
  }
  const evidenceIds = new Set();
  for (const [index, evidence] of finding.evidence.entries()) {
    if (evidenceIds.has(evidence.evidence_id)) {
      issues.push(
        issue(
          "validation_duplicate_evidence_id",
          `/evidence/${index}/evidence_id`,
          "Validation evidence ID is duplicated within the Finding.",
        ),
      );
    }
    evidenceIds.add(evidence.evidence_id);
    if (compareTimestamps(evidence.captured_at, finding.updated_at) > 0) {
      issues.push(
        issue(
          "validation_evidence_time_invalid",
          `/evidence/${index}/captured_at`,
          "Finding evidence cannot be captured after the persisted Finding revision.",
        ),
      );
    }
  }
  return issues;
}

export function checkValidationSuppression(suppression) {
  if (
    suppression.expires_at !== undefined &&
    compareTimestamps(suppression.expires_at, suppression.created_at) <= 0
  ) {
    return [
      issue(
        "validation_suppression_expiry_invalid",
        "/expires_at",
        "Suppression expiry must be later than creation.",
      ),
    ];
  }
  return [];
}

export function checkBuildDiff(diff) {
  const issues = [];
  if (sameResourceRef(diff.left_build, diff.right_build)) {
    issues.push(
      issue(
        "build_diff_same_build",
        "/right_build",
        "A Build Diff must compare two distinct build references.",
      ),
    );
  }
  const actual = {
    added: 0,
    removed: 0,
    changed: 0,
    regressed: 0,
    improved: 0,
  };
  const entryIds = new Set();
  for (const [index, entry] of diff.entries.entries()) {
    if (entryIds.has(entry.entry_id)) {
      issues.push(
        issue(
          "build_diff_duplicate_entry_id",
          `/entries/${index}/entry_id`,
          "Build Diff entry ID is duplicated.",
        ),
      );
    }
    entryIds.add(entry.entry_id);
    actual[entry.kind] += 1;
    const hasLeft = entry.left_subject !== undefined;
    const hasRight = entry.right_subject !== undefined;
    if (
      (entry.kind === "added" && (hasLeft || !hasRight)) ||
      (entry.kind === "removed" && (!hasLeft || hasRight)) ||
      (["changed", "regressed", "improved"].includes(entry.kind) && (!hasLeft || !hasRight))
    ) {
      issues.push(
        issue(
          "build_diff_subject_mismatch",
          `/entries/${index}`,
          "Added entries require only a right subject, removed entries only a left subject, and comparisons both.",
        ),
      );
    }
  }
  if (
    diff.summary.total !== diff.entries.length ||
    Object.entries(actual).some(([kind, count]) => diff.summary[kind] !== count)
  ) {
    issues.push(
      issue(
        "build_diff_summary_mismatch",
        "/summary",
        "Build Diff summary must exactly count its entries.",
      ),
    );
  }
  return issues;
}

export function checkValidationBundle(bundle) {
  const issues = checkValidationRun(bundle.run);
  const findings = addUniqueIds(
    bundle.findings,
    "finding_id",
    "/findings",
    "validation_duplicate_finding_id",
    issues,
  );
  const suppressions = addUniqueIds(
    bundle.suppressions,
    "suppression_id",
    "/suppressions",
    "validation_duplicate_suppression_id",
    issues,
  );
  const counts = {
    total: bundle.findings.length,
    open: 0,
    suppressed: 0,
    resolved: 0,
    by_severity: { info: 0, warning: 0, error: 0, critical: 0 },
  };
  const evidenceIds = new Set();

  if (!versionMatches(bundle.protocol_version, bundle.run.protocol_version)) {
    issues.push(
      issue(
        "validation_protocol_version_mismatch",
        "/run/protocol_version",
        "Validation Run protocol version must match its bundle.",
      ),
    );
  }

  for (const [index, finding] of bundle.findings.entries()) {
    counts[finding.status] += 1;
    counts.by_severity[finding.severity] += 1;
    if (!versionMatches(bundle.protocol_version, finding.protocol_version)) {
      issues.push(
        issue(
          "validation_protocol_version_mismatch",
          `/findings/${index}/protocol_version`,
          "Finding protocol version must match its bundle.",
        ),
      );
    }
    if (finding.validation_run_id !== bundle.run.validation_run_id) {
      issues.push(
        issue(
          "validation_finding_run_mismatch",
          `/findings/${index}/validation_run_id`,
          "Finding must belong to the bundled Validation Run.",
        ),
      );
    }
    if (compareTimestamps(finding.detected_at, finding.updated_at) > 0) {
      issues.push(
        issue(
          "validation_finding_time_order_invalid",
          `/findings/${index}/updated_at`,
          "Finding updated_at must not precede detected_at.",
        ),
      );
    }
    if (
      finding.resolved_at !== undefined &&
      (compareTimestamps(finding.resolved_at, finding.detected_at) < 0 ||
        compareTimestamps(finding.resolved_at, finding.updated_at) > 0)
    ) {
      issues.push(
        issue(
          "validation_finding_time_order_invalid",
          `/findings/${index}/resolved_at`,
          "Finding resolved_at must be between detected_at and updated_at.",
        ),
      );
    }
    for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
      if (evidenceIds.has(evidence.evidence_id)) {
        issues.push(
          issue(
            "validation_duplicate_evidence_id",
            `/findings/${index}/evidence/${evidenceIndex}/evidence_id`,
            "Validation evidence ID is duplicated within the bundle.",
          ),
        );
      }
      evidenceIds.add(evidence.evidence_id);
      if (compareTimestamps(evidence.captured_at, finding.updated_at) > 0) {
        issues.push(
          issue(
            "validation_evidence_time_invalid",
            `/findings/${index}/evidence/${evidenceIndex}/captured_at`,
            "Finding evidence cannot be captured after the persisted Finding revision.",
          ),
        );
      }
    }
    if (finding.active_suppression_id !== undefined) {
      const suppression = suppressions.get(finding.active_suppression_id);
      if (!suppression || suppression.finding_id !== finding.finding_id) {
        issues.push(
          issue(
            "validation_active_suppression_mismatch",
            `/findings/${index}/active_suppression_id`,
            "Active suppression must exist and target this finding.",
          ),
        );
      } else if (
        suppression.expires_at !== undefined &&
        compareTimestamps(suppression.expires_at, bundle.run.updated_at) <= 0
      ) {
        issues.push(
          issue(
            "validation_active_suppression_expired",
            `/findings/${index}/active_suppression_id`,
            "An active suppression must remain valid at the bundle Run revision time.",
          ),
        );
      }
    }
    if (compareTimestamps(finding.updated_at, bundle.run.updated_at) > 0) {
      issues.push(
        issue(
          "validation_bundle_revision_time_mismatch",
          `/findings/${index}/updated_at`,
          "Finding state summarized by the Run cannot be newer than run.updated_at.",
        ),
      );
    }
  }

  for (const [index, suppression] of bundle.suppressions.entries()) {
    issues.push(
      ...checkValidationSuppression(suppression).map((entry) => ({
        ...entry,
        path: `/suppressions/${index}${entry.path}`,
      })),
    );
    if (!versionMatches(bundle.protocol_version, suppression.protocol_version)) {
      issues.push(
        issue(
          "validation_protocol_version_mismatch",
          `/suppressions/${index}/protocol_version`,
          "Suppression protocol version must match its bundle.",
        ),
      );
    }
    if (!findings.has(suppression.finding_id)) {
      issues.push(
        issue(
          "validation_dangling_suppression_finding",
          `/suppressions/${index}/finding_id`,
          "Suppression finding does not exist in the bundle.",
        ),
      );
    }
    if (compareTimestamps(suppression.created_at, bundle.run.updated_at) > 0) {
      issues.push(
        issue(
          "validation_bundle_revision_time_mismatch",
          `/suppressions/${index}/created_at`,
          "Suppression state summarized by the Run cannot be newer than run.updated_at.",
        ),
      );
    }
  }

  if (
    bundle.run.finding_counts.total !== counts.total ||
    bundle.run.finding_counts.open !== counts.open ||
    bundle.run.finding_counts.suppressed !== counts.suppressed ||
    bundle.run.finding_counts.resolved !== counts.resolved ||
    Object.entries(counts.by_severity).some(
      ([severity, count]) => bundle.run.finding_counts.by_severity[severity] !== count,
    )
  ) {
    issues.push(
      issue(
        "validation_bundle_count_mismatch",
        "/run/finding_counts",
        "Validation Run counts must exactly summarize bundled findings.",
      ),
    );
  }

  return issues;
}
