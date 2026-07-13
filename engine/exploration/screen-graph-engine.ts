import { createHash } from "node:crypto";

import {
  DataError,
  PROTOCOL_SCHEMA_IDS,
  isDataError,
  type DataUnitOfWork,
  type GraphContext,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type Observation,
  type PathQuery,
  type PathResult,
  type ProtocolValidator,
  type RuntimeSnapshot,
  type ScreenGraph,
  type ScreenState,
  type Transition,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "../design/index.js";

const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
const IDENTITY_PROFILE = { kind: "identity_profile", id: "structural-v1" } as const;

/**
 * Capture limitations that make a Snapshot unusable as Screen State evidence.
 *
 * `structural-v1` hashes the captured tree, so a tree that omits content which
 * is really on screen does not identify the screen — it identifies the capture
 * condition. Admitting one would split a single screen into two Screen States
 * that appear and disappear with an unrelated runtime, and every downstream
 * merge, diff, and baseline would inherit that lie. These Snapshots are still
 * persisted as evidence; they simply may not enter the graph.
 */
const IDENTITY_UNSAFE_LIMITATION_CODES = new Set(["ios.capture.content-not-observable"]);

export const SCREEN_STATE_KINDS = ["screen", "modal", "overlay", "transient"] as const;
export const OBSERVATION_CAPTURE_SOURCES = [
  "sdk",
  "automation",
  "manual",
  "import",
  "validation",
] as const;
export const ACTION_KINDS = [
  "tap",
  "long_press",
  "type_text",
  "clear_text",
  "swipe",
  "scroll",
  "back",
  "launch",
  "dismiss",
] as const;
export const ACTION_RISKS = ["safe", "sensitive", "dangerous", "forbidden"] as const;

export interface ScreenGraphEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly validator: ProtocolValidator;
  readonly ids?: IdGenerator;
}

export interface StructuralIdentity {
  readonly layout_digest: string;
  readonly stable_node_ids: readonly string[];
}

export interface RecordStateObservationCommand {
  readonly snapshot_id: string;
  readonly title?: string;
  readonly state_kind?: (typeof SCREEN_STATE_KINDS)[number];
  readonly entry?: boolean;
  readonly capture_source?: (typeof OBSERVATION_CAPTURE_SOURCES)[number];
  readonly session_id?: string;
}

export interface RecordStateObservationResult {
  readonly screen_graph_id: string;
  readonly graph_revision: number;
  readonly screen_state: ScreenState;
  readonly observation_id: string;
  readonly created: boolean;
}

export interface TransitionActionCommand {
  readonly kind: (typeof ACTION_KINDS)[number];
  readonly requested_effect: string;
  readonly risk?: (typeof ACTION_RISKS)[number];
  readonly target?: {
    readonly stable_id?: string;
    readonly node_id?: string;
    readonly tree_id?: string;
  };
  readonly parameters?: JsonObject;
}

export interface RecordTransitionObservationCommand {
  readonly before_snapshot_id: string;
  readonly after_snapshot_id: string;
  readonly action: TransitionActionCommand;
  readonly capture_source?: (typeof OBSERVATION_CAPTURE_SOURCES)[number];
  readonly session_id?: string;
}

export interface RecordTransitionObservationResult {
  readonly screen_graph_id: string;
  readonly graph_revision: number;
  readonly transition: Transition;
  readonly action_id: string;
  readonly source_state_id: string;
  readonly target_state_id: string;
  readonly observation_id: string;
  readonly created: boolean;
}

export interface MergeScreenStatesCommand {
  readonly project_id: string;
  readonly application_id: string;
  /** All states collapsing into one identity; at least two, all active. */
  readonly state_ids: readonly string[];
  /** The surviving state; must be one of state_ids, defaults to the first. */
  readonly into_state_id?: string;
  readonly expected_graph_revision: number;
  readonly merged_by: JsonObject;
  readonly justification?: string;
}

export interface SplitScreenStateCommand {
  readonly project_id: string;
  readonly application_id: string;
  readonly state_id: string;
  /** The observations moving into the new state; a strict non-empty subset. */
  readonly observation_ids: readonly string[];
  readonly title?: string;
  readonly expected_graph_revision: number;
  readonly split_by: JsonObject;
  readonly justification?: string;
}

export interface AnnotateScreenStateCommand {
  readonly project_id: string;
  readonly application_id: string;
  readonly state_id: string;
  /** Replaces the state's labels; an empty array clears them. */
  readonly labels?: readonly string[];
  /** Replaces the one-sentence summary; an empty string clears it. */
  readonly summary?: string;
  readonly expected_graph_revision: number;
  readonly annotated_by: JsonObject;
}

export interface AnnotateScreenStateResult {
  readonly screen_graph_id: string;
  readonly graph_revision: number;
  readonly state: ScreenState;
}

export interface IdentityCurationResult {
  readonly screen_graph_id: string;
  readonly graph_revision: number;
  readonly decision: JsonObject;
  readonly state: ScreenState;
}

export interface GetScreenGraphQuery {
  readonly project_id: string;
  readonly application_id: string;
}

interface StateResolution {
  readonly graph: MutableGraph;
  readonly state: JsonObject;
  readonly observationId: string;
  readonly created: boolean;
}

interface MutableGraph {
  screen_graph_id: string;
  protocol_version: typeof PROTOCOL_VERSION;
  revision: number;
  materialized_at: string;
  context: JsonObject;
  entry_state_ids: string[];
  states: JsonObject[];
  actions: JsonObject[];
  transitions: JsonObject[];
  observations: JsonObject[];
  identity_decisions: JsonObject[];
  extensions: JsonObject;
  created: boolean;
}

/**
 * Deterministic Screen State identity and deduplication over persisted
 * Snapshots. The engine maintains one coherent materialized Screen Graph per
 * project and application, and every write revalidates the complete document
 * against the canonical protocol schema and semantic rules.
 */
export class ScreenGraphEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #ids: IdGenerator;

  constructor(dependencies: ScreenGraphEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#validator = dependencies.validator;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  /**
   * Computes the deterministic structural identity of a Snapshot: the ordered
   * hierarchy of node roles, native types, and stable identifiers, excluding
   * volatile identifiers, geometry, and content.
   */
  static computeStructuralIdentity(snapshot: RuntimeSnapshot): StructuralIdentity {
    const trees = snapshot["trees"] as readonly JsonObject[];
    const stableIds = new Set<string>();
    const treeSignatures = trees.map((tree) => {
      const payload = tree["payload"] as JsonObject;
      const inline = (payload["inline_nodes"] ?? []) as readonly JsonObject[];
      const nodesById = new Map<string, JsonObject>();
      for (const node of inline) {
        nodesById.set(node["node_id"] as string, node);
        const stableId = node["stable_id"];
        if (typeof stableId === "string") {
          stableIds.add(stableId);
        }
      }
      const signNode = (nodeId: string): JsonValue => {
        const node = nodesById.get(nodeId);
        if (node === undefined) {
          return null;
        }
        return [
          (node["role"] as string | undefined) ?? "",
          (node["native_type"] as string | undefined) ?? "",
          (node["stable_id"] as string | undefined) ?? "",
          ((node["child_ids"] ?? []) as readonly string[]).map(signNode),
        ];
      };
      return [
        (tree["kind"] as string | undefined) ?? "",
        ((tree["root_node_ids"] ?? []) as readonly string[]).map(signNode),
      ];
    });
    const canonical = canonicalJson(treeSignatures as unknown as JsonValue);
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    return {
      layout_digest: `sha256:${digest}`,
      stable_node_ids: [...stableIds].sort(),
    };
  }

  recordStateObservation(command: RecordStateObservationCommand): RecordStateObservationResult {
    return this.#write((unit) => {
      const resolution = this.#resolveState(unit, {
        snapshotId: command.snapshot_id,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.state_kind === undefined ? {} : { stateKind: command.state_kind }),
        entry: command.entry === true,
        captureSource: command.capture_source ?? "sdk",
        ...(command.session_id === undefined ? {} : { sessionId: command.session_id }),
      });
      const graph = resolution.graph;
      const persisted = this.#persistGraph(unit, graph);
      const state = persisted.states.find(
        (candidate) =>
          candidate.screen_state_id === (resolution.state["screen_state_id"] as string),
      ) as ScreenState;
      return {
        screen_graph_id: persisted.screen_graph_id,
        graph_revision: persisted.revision,
        screen_state: state,
        observation_id: resolution.observationId,
        created: resolution.created,
      };
    });
  }

  recordTransitionObservation(
    command: RecordTransitionObservationCommand,
  ): RecordTransitionObservationResult {
    return this.#write((unit) => {
      const captureSource = command.capture_source ?? "automation";
      const source = this.#resolveState(unit, {
        snapshotId: command.before_snapshot_id,
        entry: false,
        captureSource,
        ...(command.session_id === undefined ? {} : { sessionId: command.session_id }),
      });
      const target = this.#resolveState(unit, {
        snapshotId: command.after_snapshot_id,
        entry: false,
        captureSource,
        ...(command.session_id === undefined ? {} : { sessionId: command.session_id }),
        graph: source.graph,
      });
      const graph = target.graph;
      const now = this.#workspace.clock.now();
      const sourceStateId = source.state["screen_state_id"] as string;
      const targetStateId = target.state["screen_state_id"] as string;

      const action = this.#resolveAction(graph, command);
      const actionId = action["action_id"] as string;

      const transitionKey = `${sourceStateId}\n${targetStateId}\n${actionSignature(command)}`;
      let transition = graph.transitions.find(
        (candidate) => (candidate["extensions"] as JsonObject)["vistrea.transition_key"] === transitionKey,
      );
      const created = transition === undefined;

      const afterSnapshot = this.#getSnapshot(unit, command.after_snapshot_id);
      const observationId = this.#ids.next("observation");
      const transitionId =
        transition === undefined
          ? this.#ids.next("transition")
          : (transition["transition_id"] as string);
      const observation: JsonObject = {
        observation_id: observationId,
        protocol_version: PROTOCOL_VERSION,
        kind: "transition",
        observed_at: { wall_time: now },
        runtime_context: afterSnapshot["runtime_context"] as JsonObject,
        capture_source: captureSource,
        ...(command.session_id === undefined ? {} : { session_id: command.session_id }),
        transition_id: transitionId,
        action_id: actionId,
        source_state_id: sourceStateId,
        target_state_id: targetStateId,
        before_snapshot_id: command.before_snapshot_id,
        after_snapshot_id: command.after_snapshot_id,
        snapshot_ids: uniqueStrings([command.before_snapshot_id, command.after_snapshot_id]),
        runtime_event_ids: [],
        artifact_ids: [],
        confidence: 1,
        capabilities: { names: ["runtime.snapshot"], extensions: {} },
        extensions: {},
      };
      unit.observations.append(observation as unknown as Observation);
      graph.observations.push(observation);

      if (transition === undefined) {
        transition = {
          transition_id: transitionId,
          protocol_version: PROTOCOL_VERSION,
          revision: 1,
          source_state_id: sourceStateId,
          target_state_id: targetStateId,
          action_id: actionId,
          observation_ids: [observationId],
          status: "observed",
          confidence: 1,
          occurrence_count: 1,
          first_seen: now,
          last_seen: now,
          extensions: { "vistrea.transition_key": transitionKey },
        };
        graph.transitions.push(transition);
      } else {
        const observationIds = [
          ...(transition["observation_ids"] as readonly string[]),
          observationId,
        ];
        const updated: JsonObject = {
          ...transition,
          revision: (transition["revision"] as number) + 1,
          observation_ids: observationIds,
          occurrence_count: observationIds.length,
          last_seen: now,
        };
        graph.transitions[graph.transitions.indexOf(transition)] = updated;
        transition = updated;
      }

      const persisted = this.#persistGraph(unit, graph);
      const persistedTransition = persisted.transitions.find(
        (candidate) => candidate.transition_id === transitionId,
      ) as Transition;
      return {
        screen_graph_id: persisted.screen_graph_id,
        graph_revision: persisted.revision,
        transition: persistedTransition,
        action_id: actionId,
        source_state_id: sourceStateId,
        target_state_id: targetStateId,
        observation_id: observationId,
        created,
      };
    });
  }

  /**
   * Collapses structurally distinct states that are one product screen into
   * a single identity. The surviving state absorbs observation membership,
   * seen builds, and the merged layout digests as dedup aliases; absorbed
   * states become `merged` tombstones superseded by the survivor; every
   * transition endpoint re-points to the survivor. The manual decision is
   * recorded in the graph, and future observations of any merged structure
   * deduplicate into the survivor.
   */
  mergeScreenStates(command: MergeScreenStatesCommand): IdentityCurationResult {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.merged_by);
    const stateIds = [...new Set(command.state_ids)];
    if (stateIds.length < 2 || stateIds.length !== command.state_ids.length) {
      throw new DataError("invalid_argument", "A merge names at least two distinct states.");
    }
    const targetId = command.into_state_id ?? (stateIds[0] as string);
    if (!stateIds.includes(targetId)) {
      throw new DataError("invalid_argument", "into_state_id must be one of state_ids.");
    }
    return this.#write((unit) => {
      const graph = this.#loadCurationGraph(unit, command);
      const states = stateIds.map((stateId) => this.#requireActiveState(graph, stateId));
      const target = states.find(
        (state) => (state["screen_state_id"] as string) === targetId,
      ) as JsonObject;
      const absorbed = states.filter((state) => state !== target);
      const now = this.#workspace.clock.now();

      const movedObservationIds = uniqueStrings(
        absorbed.flatMap((state) => (state["observation_ids"] as readonly string[]) ?? []),
      );
      const decision = this.#curationDecision({
        decisionId: this.#ids.next("identitydecision"),
        kind: "merge",
        inputStateIds: stateIds,
        outputStateIds: [targetId],
        observationIds: movedObservationIds,
        actor: command.merged_by,
        justification:
          command.justification ??
          "Manually merged structurally distinct captures of one product screen.",
        now,
      });

      const targetDigest = (target["identity"] as JsonObject)["layout_digest"];
      const aliasDigests = uniqueStrings(
        [
          ...(((target["identity"] as JsonObject)["extensions"] as JsonObject)[
            "vistrea.alias_layout_digests"
          ] as readonly string[] | undefined ?? []),
          ...absorbed.flatMap((state) => {
            const identity = state["identity"] as JsonObject;
            const extensions = identity["extensions"] as JsonObject;
            return [
              ...(identity["layout_digest"] === undefined
                ? []
                : [identity["layout_digest"] as string]),
              ...((extensions["vistrea.alias_layout_digests"] as readonly string[] | undefined) ??
                []),
            ];
          }),
        ].filter((digest) => digest !== targetDigest),
      );
      const seenBuilds = uniqueStrings(
        states.flatMap((state) => (state["seen_in_build_ids"] as readonly string[]) ?? []),
      );
      const updatedTarget: JsonObject = {
        ...target,
        revision: (target["revision"] as number) + 1,
        observation_ids: uniqueStrings([
          ...(target["observation_ids"] as readonly string[]),
          ...movedObservationIds,
        ]),
        identity: {
          ...(target["identity"] as JsonObject),
          extensions: {
            ...((target["identity"] as JsonObject)["extensions"] as JsonObject),
            ...(aliasDigests.length === 0
              ? {}
              : { "vistrea.alias_layout_digests": aliasDigests }),
          },
        },
        first_seen: minimumTimestamp(states.map((state) => state["first_seen"] as string)),
        last_seen: maximumTimestamp(states.map((state) => state["last_seen"] as string)),
        ...(seenBuilds.length === 0 ? {} : { seen_in_build_ids: seenBuilds }),
        ...(target["missing_in_build_ids"] === undefined
          ? {}
          : {
              missing_in_build_ids: (
                target["missing_in_build_ids"] as readonly string[]
              ).filter((buildId) => !seenBuilds.includes(buildId)),
            }),
      };
      this.#replaceState(graph, updatedTarget);
      for (const state of absorbed) {
        this.#replaceState(graph, {
          ...state,
          revision: (state["revision"] as number) + 1,
          status: "merged",
          superseded_by_state_ids: [targetId],
        });
      }

      const absorbedIds = new Set(
        absorbed.map((state) => state["screen_state_id"] as string),
      );
      graph.transitions = graph.transitions.map((transition) => {
        const sourceId = transition["source_state_id"] as string;
        const endpointId = transition["target_state_id"] as string;
        if (!absorbedIds.has(sourceId) && !absorbedIds.has(endpointId)) {
          return transition;
        }
        const nextSource = absorbedIds.has(sourceId) ? targetId : sourceId;
        const nextTarget = absorbedIds.has(endpointId) ? targetId : endpointId;
        const extensions = transition["extensions"] as JsonObject;
        const storedKey = extensions["vistrea.transition_key"] as string | undefined;
        const keyTail = storedKey?.split("\n").slice(2).join("\n");
        return {
          ...transition,
          revision: (transition["revision"] as number) + 1,
          source_state_id: nextSource,
          target_state_id: nextTarget,
          extensions: {
            ...extensions,
            ...(keyTail === undefined
              ? {}
              : { "vistrea.transition_key": `${nextSource}\n${nextTarget}\n${keyTail}` }),
          },
        };
      });
      // Re-pointing can land two transitions on the same (source, target,
      // action): they are one transition now, so coalesce them instead of
      // leaving a duplicate whose occurrences no future observation reaches.
      const transitionsByKey = new Map<string, JsonObject>();
      // Observations are immutable evidence: a coalesced transition records
      // where its dropped twin went, and the shared semantic rules resolve
      // observation ownership through that record.
      const coalescedTransitions: JsonObject[] = [];
      const coalesced: JsonObject[] = [];
      for (const transition of graph.transitions) {
        const key = (transition["extensions"] as JsonObject)["vistrea.transition_key"];
        const existing = typeof key === "string" ? transitionsByKey.get(key) : undefined;
        if (existing === undefined) {
          if (typeof key === "string") {
            transitionsByKey.set(key, transition);
          }
          coalesced.push(transition);
          continue;
        }
        const observationIds = uniqueStrings([
          ...(existing["observation_ids"] as readonly string[]),
          ...(transition["observation_ids"] as readonly string[]),
        ]);
        const survivingTransition: JsonObject = {
          ...existing,
          revision: (existing["revision"] as number) + 1,
          observation_ids: observationIds,
          occurrence_count: observationIds.length,
          first_seen: minimumTimestamp([
            existing["first_seen"] as string,
            transition["first_seen"] as string,
          ]),
          last_seen: maximumTimestamp([
            existing["last_seen"] as string,
            transition["last_seen"] as string,
          ]),
        };
        transitionsByKey.set(key as string, survivingTransition);
        coalesced[coalesced.indexOf(existing)] = survivingTransition;
        coalescedTransitions.push({
          from_transition_id: transition["transition_id"] as string,
          to_transition_id: existing["transition_id"] as string,
        });
      }
      graph.transitions = coalesced;

      graph.entry_state_ids = uniqueStrings(
        graph.entry_state_ids.map((stateId) => (absorbedIds.has(stateId) ? targetId : stateId)),
      );

      const recordedDecision: JsonObject =
        coalescedTransitions.length === 0
          ? decision
          : {
              ...decision,
              extensions: {
                ...(decision["extensions"] as JsonObject),
                "vistrea.coalesced_transitions": coalescedTransitions,
              },
            };
      graph.identity_decisions.push(recordedDecision);
      unit.screenGraph.storeIdentityDecision(recordedDecision as never);
      const persisted = this.#persistGraph(unit, graph);
      return {
        screen_graph_id: persisted.screen_graph_id,
        graph_revision: persisted.revision,
        decision: recordedDecision,
        state: persisted.states.find(
          (state) => state.screen_state_id === targetId,
        ) as ScreenState,
      };
    });
  }

  /**
   * Separates wrongly deduplicated observations out of one state. The source
   * state keeps its structural identity, so future structurally identical
   * captures still deduplicate into it; the new state carries a `manual`
   * identity without a layout digest and only grows through explicit
   * curation. The manual decision is recorded in the graph.
   */
  splitScreenState(command: SplitScreenStateCommand): IdentityCurationResult {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.split_by);
    const movedIds = [...new Set(command.observation_ids)];
    if (movedIds.length === 0 || movedIds.length !== command.observation_ids.length) {
      throw new DataError("invalid_argument", "A split names at least one observation once.");
    }
    if (
      command.title !== undefined &&
      (command.title.length === 0 || command.title.length > 512)
    ) {
      throw new DataError("invalid_argument", "The split title is out of bounds.");
    }
    return this.#write((unit) => {
      const graph = this.#loadCurationGraph(unit, command);
      const source = this.#requireActiveState(graph, command.state_id);
      const sourceObservationIds = source["observation_ids"] as readonly string[];
      if (!movedIds.every((observationId) => sourceObservationIds.includes(observationId))) {
        throw new DataError("invalid_argument", "Every split observation must belong to the state.");
      }
      const remainingIds = sourceObservationIds.filter(
        (observationId) => !movedIds.includes(observationId),
      );
      if (remainingIds.length === 0) {
        throw new DataError(
          "invalid_argument",
          "A split must leave at least one observation behind.",
        );
      }
      const observationsById = new Map(
        graph.observations.map((observation) => [
          observation["observation_id"] as string,
          observation,
        ]),
      );
      const movedObservations = movedIds.map(
        (observationId) => observationsById.get(observationId) as JsonObject,
      );
      const remainingObservations = remainingIds.map(
        (observationId) => observationsById.get(observationId) as JsonObject,
      );
      const now = this.#workspace.clock.now();
      const newStateId = this.#ids.next("screenstate");
      const decisionId = this.#ids.next("identitydecision");
      const decision = this.#curationDecision({
        decisionId,
        kind: "split",
        inputStateIds: [command.state_id],
        outputStateIds: [command.state_id, newStateId],
        observationIds: movedIds,
        actor: command.split_by,
        justification:
          command.justification ??
          "Manually separated observations that are not the same product screen.",
        now,
      });

      const movedTimes = movedObservations.map(observationWallTime);
      // When the moved observations all share one structure that the source
      // only answers to because a merge aliased it, the split gives that
      // digest back: the merge becomes reversible and future captures of that
      // structure land on the new state instead of the source. Otherwise the
      // structures are genuinely identical, no rule can tell them apart, and
      // the new state stays manual — future identical captures return to the
      // source, which is the honest outcome.
      const movedDigests = new Set(
        movedObservations.map((observation) =>
          ScreenGraphEngine.computeStructuralIdentity(
            this.#getSnapshot(
              unit,
              (observation["snapshot_ids"] as readonly string[])[0] as string,
            ),
          ).layout_digest,
        ),
      );
      const sourceIdentity = source["identity"] as JsonObject;
      const sourceAliases = ((sourceIdentity["extensions"] as JsonObject)[
        "vistrea.alias_layout_digests"
      ] as readonly string[] | undefined) ?? [];
      const reclaimedDigest =
        movedDigests.size === 1 && sourceAliases.includes([...movedDigests][0] as string)
          ? ([...movedDigests][0] as string)
          : undefined;
      const newState: JsonObject = {
        screen_state_id: newStateId,
        protocol_version: PROTOCOL_VERSION,
        revision: 1,
        title: command.title ?? `${source["title"] as string} (split)`.slice(0, 512),
        kind: source["kind"] as string,
        status: "active",
        canonical_snapshot_id: firstSnapshotId(movedObservations),
        observation_ids: movedIds,
        identity:
          reclaimedDigest === undefined
            ? { strategy: "manual", manual_key: decisionId, extensions: {} }
            : {
                strategy: "structural",
                layout_digest: reclaimedDigest,
                normalization_profile: IDENTITY_PROFILE,
                extensions: {},
              },
        first_seen: minimumTimestamp(movedTimes),
        last_seen: maximumTimestamp(movedTimes),
        ...(observationBuilds(movedObservations).length === 0
          ? {}
          : { seen_in_build_ids: observationBuilds(movedObservations) }),
        extensions: {},
      };
      graph.states.push(newState);

      const remainingTimes = remainingObservations.map(observationWallTime);
      const remainingSnapshots = new Set(
        remainingObservations.flatMap(
          (observation) => observation["snapshot_ids"] as readonly string[],
        ),
      );
      const remainingAliases = sourceAliases.filter((digest) => digest !== reclaimedDigest);
      this.#replaceState(graph, {
        ...source,
        revision: (source["revision"] as number) + 1,
        identity: {
          ...sourceIdentity,
          extensions: {
            ...withoutKey(
              sourceIdentity["extensions"] as JsonObject,
              "vistrea.alias_layout_digests",
            ),
            ...(remainingAliases.length === 0
              ? {}
              : { "vistrea.alias_layout_digests": remainingAliases }),
          },
        },
        observation_ids: remainingIds,
        canonical_snapshot_id: remainingSnapshots.has(
          source["canonical_snapshot_id"] as string,
        )
          ? (source["canonical_snapshot_id"] as string)
          : firstSnapshotId(remainingObservations),
        first_seen: minimumTimestamp(remainingTimes),
        last_seen: maximumTimestamp(remainingTimes),
        ...(observationBuilds(remainingObservations).length === 0
          ? {}
          : { seen_in_build_ids: observationBuilds(remainingObservations) }),
      });

      graph.identity_decisions.push(decision);
      unit.screenGraph.storeIdentityDecision(decision as never);
      const persisted = this.#persistGraph(unit, graph);
      return {
        screen_graph_id: persisted.screen_graph_id,
        graph_revision: persisted.revision,
        decision,
        state: persisted.states.find(
          (state) => state.screen_state_id === newStateId,
        ) as ScreenState,
      };
    });
  }

  /**
   * Sets or clears a state's labels and one-sentence summary. Annotations are
   * knowledge, not identity: they never move observations or change what a
   * state matches, so both an agent and an operator may write them freely —
   * guarded only by the graph revision they read, exactly like curation.
   */
  annotateScreenState(command: AnnotateScreenStateCommand): AnnotateScreenStateResult {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.annotated_by);
    if (command.labels === undefined && command.summary === undefined) {
      throw new DataError("invalid_argument", "An annotation sets labels, a summary, or both.");
    }
    if (command.labels !== undefined) {
      const unique = new Set(command.labels);
      if (
        unique.size !== command.labels.length ||
        command.labels.some((label) => label.length === 0 || label.length > 128)
      ) {
        throw new DataError("invalid_argument", "Labels are unique strings of 1 to 128 characters.");
      }
    }
    if (command.summary !== undefined && command.summary.length > 280) {
      throw new DataError("invalid_argument", "A summary is at most 280 characters.");
    }
    return this.#write((unit) => {
      const graph = this.#loadCurationGraph(unit, command);
      const state = this.#requireActiveState(graph, command.state_id);
      const now = this.#workspace.clock.now();
      let updated: JsonObject = {
        ...state,
        revision: (state["revision"] as number) + 1,
        last_seen: now,
      };
      if (command.labels !== undefined) {
        updated =
          command.labels.length === 0
            ? withoutKey(updated, "labels")
            : { ...updated, labels: [...command.labels] };
      }
      if (command.summary !== undefined) {
        updated =
          command.summary.length === 0
            ? withoutKey(updated, "summary")
            : { ...updated, summary: command.summary };
      }
      graph.states = graph.states.map((candidate) =>
        (candidate["screen_state_id"] as string) === command.state_id ? updated : candidate,
      );
      const persisted = this.#persistGraph(unit, graph);
      const annotated = persisted.states.find(
        (candidate) => candidate.screen_state_id === command.state_id,
      ) as ScreenState;
      return {
        screen_graph_id: persisted.screen_graph_id,
        graph_revision: persisted.revision,
        state: annotated,
      };
    });
  }

  #loadCurationGraph(
    unit: DataUnitOfWork,
    command: {
      readonly project_id: string;
      readonly application_id: string;
      readonly expected_graph_revision: number;
    },
  ): MutableGraph {
    const graph = this.#loadOrCreateGraph(unit, command.project_id, command.application_id);
    if (graph.created) {
      throw new DataError("not_found", "The Screen Graph does not exist yet.");
    }
    if (graph.revision !== command.expected_graph_revision) {
      throw new DataError("conflict", "The Screen Graph revision does not match.", {
        retryable: true,
        details: {
          expected_revision: command.expected_graph_revision,
          current_revision: graph.revision,
        },
      });
    }
    return graph;
  }

  #requireActiveState(graph: MutableGraph, stateId: string): JsonObject {
    const state = graph.states.find(
      (candidate) => (candidate["screen_state_id"] as string) === stateId,
    );
    if (state === undefined) {
      throw new DataError("not_found", "The Screen State does not exist in the graph.", {
        details: { screen_state_id: stateId },
      });
    }
    if ((state["status"] as string) !== "active") {
      throw new DataError("conflict", "Only active Screen States can be curated.", {
        details: { screen_state_id: stateId, status: state["status"] as string },
      });
    }
    return state;
  }

  #replaceState(graph: MutableGraph, state: JsonObject): void {
    const index = graph.states.findIndex(
      (candidate) => candidate["screen_state_id"] === state["screen_state_id"],
    );
    graph.states[index] = state;
  }

  #curationDecision(input: {
    readonly decisionId: string;
    readonly kind: "merge" | "split";
    readonly inputStateIds: readonly string[];
    readonly outputStateIds: readonly string[];
    readonly observationIds: readonly string[];
    readonly actor: JsonObject;
    readonly justification: string;
    readonly now: string;
  }): JsonObject {
    return {
      state_identity_decision_id: input.decisionId,
      protocol_version: PROTOCOL_VERSION,
      revision: 1,
      created_at: input.now,
      created_by: input.actor,
      source: "manual",
      kind: input.kind,
      input_state_ids: input.inputStateIds,
      output_state_ids: input.outputStateIds,
      observation_ids: input.observationIds,
      confidence: 1,
      evidence: [
        {
          factor: "manual",
          score: 1,
          weight: 1,
          explanation: input.justification.slice(0, 1024),
          resource_refs: [],
          extensions: {},
        },
      ],
      extensions: {},
    };
  }

  getGraph(query: GetScreenGraphQuery): ScreenGraph {
    return this.#read((unit) =>
      unit.screenGraph.getGraph(deterministicGraphId(query.project_id, query.application_id)),
    );
  }

  getState(screenStateId: string): ScreenState {
    return this.#read((unit) => unit.screenGraph.getState(screenStateId));
  }

  findPath(query: PathQuery): readonly PathResult[] {
    return this.#read((unit) => unit.screenGraph.findPath(query));
  }

  #resolveState(
    unit: DataUnitOfWork,
    input: {
      readonly snapshotId: string;
      readonly title?: string;
      readonly stateKind?: string;
      readonly entry: boolean;
      readonly captureSource: string;
      readonly sessionId?: string;
      readonly graph?: MutableGraph;
    },
  ): StateResolution {
    const snapshot = this.#getSnapshot(unit, input.snapshotId);
    const runtimeContext = snapshot["runtime_context"] as JsonObject;
    const graph =
      input.graph ??
      this.#loadOrCreateGraph(
        unit,
        runtimeContext["project_id"] as string,
        runtimeContext["application_id"] as string,
      );
    this.#accumulateContext(graph, runtimeContext);

    const identity = ScreenGraphEngine.computeStructuralIdentity(snapshot);
    const now = this.#workspace.clock.now();
    // Manual merges alias absorbed layout digests onto the surviving state,
    // so future captures of any merged structure deduplicate into it.
    const existing = graph.states.find((candidate) => {
      if ((candidate["status"] as string) !== "active") {
        return false;
      }
      const candidateIdentity = candidate["identity"] as JsonObject;
      if ((candidateIdentity["layout_digest"] as string | undefined) === identity.layout_digest) {
        return true;
      }
      const aliases = (candidateIdentity["extensions"] as JsonObject)[
        "vistrea.alias_layout_digests"
      ] as readonly string[] | undefined;
      return aliases?.includes(identity.layout_digest) === true;
    });

    const observationId = this.#ids.next("observation");
    const stateId =
      existing === undefined
        ? this.#ids.next("screenstate")
        : (existing["screen_state_id"] as string);
    const observation: JsonObject = {
      observation_id: observationId,
      protocol_version: PROTOCOL_VERSION,
      kind: "state",
      observed_at: { wall_time: now },
      runtime_context: runtimeContext,
      capture_source: input.captureSource,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      screen_state_id: stateId,
      snapshot_ids: [input.snapshotId],
      runtime_event_ids: [],
      artifact_ids: [],
      confidence: 1,
      capabilities: { names: ["runtime.snapshot"], extensions: {} },
      extensions: {},
    };
    unit.observations.append(observation as unknown as Observation);
    graph.observations.push(observation);

    const buildId = runtimeContext["build_id"] as string;
    let state: JsonObject;
    if (existing === undefined) {
      state = {
        screen_state_id: stateId,
        protocol_version: PROTOCOL_VERSION,
        revision: 1,
        title: input.title ?? defaultStateTitle(snapshot, identity),
        kind: input.stateKind ?? "screen",
        status: "active",
        canonical_snapshot_id: input.snapshotId,
        observation_ids: [observationId],
        identity: {
          strategy: "structural",
          ...(identity.stable_node_ids.length === 0
            ? {}
            : { stable_node_ids: identity.stable_node_ids }),
          layout_digest: identity.layout_digest,
          normalization_profile: IDENTITY_PROFILE,
          extensions: {},
        },
        first_seen: now,
        last_seen: now,
        seen_in_build_ids: [buildId],
        extensions: {},
      };
      graph.states.push(state);
      if (input.entry || graph.entry_state_ids.length === 0) {
        graph.entry_state_ids.push(stateId);
      }
    } else {
      state = {
        ...existing,
        revision: (existing["revision"] as number) + 1,
        ...(input.title === undefined ? {} : { title: input.title }),
        last_seen: now,
        observation_ids: [
          ...(existing["observation_ids"] as readonly string[]),
          observationId,
        ],
        seen_in_build_ids: uniqueStrings([
          ...((existing["seen_in_build_ids"] ?? []) as readonly string[]),
          buildId,
        ]),
      };
      graph.states[graph.states.indexOf(existing)] = state;
      if (input.entry && !graph.entry_state_ids.includes(stateId)) {
        graph.entry_state_ids.push(stateId);
      }
    }
    return { graph, state, observationId, created: existing === undefined };
  }

  #resolveAction(graph: MutableGraph, command: RecordTransitionObservationCommand): JsonObject {
    const signature = actionSignature(command);
    const existing = graph.actions.find(
      (candidate) => (candidate["extensions"] as JsonObject)["vistrea.action_key"] === signature,
    );
    if (existing !== undefined) {
      return existing;
    }
    const target = command.action.target;
    const action: JsonObject = {
      action_id: this.#ids.next("action"),
      protocol_version: PROTOCOL_VERSION,
      kind: command.action.kind,
      requested_effect: command.action.requested_effect,
      risk: command.action.risk ?? "safe",
      ...(target === undefined
        ? {}
        : {
            target: {
              ...(target.stable_id === undefined ? {} : { stable_id: target.stable_id }),
              ...(target.node_id === undefined ? {} : { node_id: target.node_id }),
              ...(target.tree_id === undefined ? {} : { tree_id: target.tree_id }),
              snapshot_id: command.before_snapshot_id,
              extensions: {},
            },
          }),
      parameters: { ...(command.action.parameters ?? {}), extensions: {} },
      extensions: { "vistrea.action_key": signature },
    };
    graph.actions.push(action);
    return action;
  }

  #loadOrCreateGraph(unit: DataUnitOfWork, projectId: string, applicationId: string): MutableGraph {
    const graphId = deterministicGraphId(projectId, applicationId);
    try {
      const existing = unit.screenGraph.getGraph(graphId);
      return {
        screen_graph_id: existing.screen_graph_id,
        protocol_version: PROTOCOL_VERSION,
        revision: existing.revision,
        materialized_at: existing["materialized_at"] as string,
        context: structuredClone(existing.context) as JsonObject,
        entry_state_ids: [...(existing["entry_state_ids"] as readonly string[])],
        states: structuredClone(existing.states) as unknown as JsonObject[],
        actions: structuredClone(existing["actions"]) as unknown as JsonObject[],
        transitions: structuredClone(existing.transitions) as unknown as JsonObject[],
        observations: structuredClone(existing.observations) as unknown as JsonObject[],
        identity_decisions: structuredClone(
          existing.identity_decisions,
        ) as unknown as JsonObject[],
        extensions: structuredClone(existing["extensions"]) as JsonObject,
        created: false,
      };
    } catch (error) {
      if (!isDataError(error) || error.code !== "not_found") {
        throw error;
      }
      return {
        screen_graph_id: graphId,
        protocol_version: PROTOCOL_VERSION,
        revision: 0,
        materialized_at: this.#workspace.clock.now(),
        context: {
          project_id: projectId,
          application_id: applicationId,
          build_ids: [],
          environment_ids: [],
          extensions: {},
        },
        entry_state_ids: [],
        states: [],
        actions: [],
        transitions: [],
        observations: [],
        identity_decisions: [],
        extensions: {},
        created: true,
      };
    }
  }

  #accumulateContext(graph: MutableGraph, runtimeContext: JsonObject): void {
    const context = graph.context;
    graph.context = {
      ...context,
      build_ids: uniqueStrings([
        ...((context["build_ids"] ?? []) as readonly string[]),
        runtimeContext["build_id"] as string,
      ]),
      environment_ids: uniqueStrings([
        ...((context["environment_ids"] ?? []) as readonly string[]),
        runtimeContext["environment_id"] as string,
      ]),
      platforms: uniqueStrings([
        ...((context["platforms"] ?? []) as readonly string[]),
        runtimeContext["platform"] as string,
      ]),
    };
  }

  #persistGraph(unit: DataUnitOfWork, graph: MutableGraph): ScreenGraph {
    const document: JsonObject = {
      screen_graph_id: graph.screen_graph_id,
      protocol_version: PROTOCOL_VERSION,
      revision: graph.revision + 1,
      materialized_at: this.#workspace.clock.now(),
      context: graph.context,
      entry_state_ids: graph.entry_state_ids,
      states: graph.states,
      actions: graph.actions,
      transitions: graph.transitions,
      observations: graph.observations,
      identity_decisions: graph.identity_decisions,
      extensions: graph.extensions,
    };
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.screenGraph, document);
    const value = document as unknown as ScreenGraph;
    if (graph.created) {
      return unit.screenGraph.createGraph(value);
    }
    return unit.screenGraph.updateGraph(value, { expected_revision: graph.revision });
  }

  #getSnapshot(unit: DataUnitOfWork, snapshotId: string): RuntimeSnapshot {
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = unit.snapshots.get(snapshotId);
    } catch (error) {
      if (isDataError(error) && error.code === "not_found") {
        throw new DataError("invalid_argument", "The referenced Snapshot is not persisted.", {
          details: { snapshot_id: snapshotId },
        });
      }
      throw error;
    }
    const unsafe = (
      (snapshot as unknown as JsonObject)["capture_limitations"] as
        | readonly JsonObject[]
        | undefined
    )?.filter((limitation) =>
      IDENTITY_UNSAFE_LIMITATION_CODES.has(limitation["code"] as string),
    );
    if (unsafe !== undefined && unsafe.length > 0) {
      throw new DataError(
        "invalid_argument",
        "The Snapshot reports content the capture could not observe, so its structure identifies " +
          "the capture condition rather than the screen. Recapture with the content observable.",
        {
          details: {
            snapshot_id: snapshotId,
            codes: unsafe.map((limitation) => limitation["code"] as string),
          },
        },
      );
    }
    return snapshot;
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

/**
 * Derives a human title for a state nobody named. A screen's heading is
 * usually the shortest prominent text near the top of the tree: chrome
 * banners run long, list rows carry prices and descriptions, and the
 * heading ("Shop", "Detail") is terse. Header-role nodes win outright when
 * a platform reports them. Sorted stable node ids are deliberately not
 * used — the alphabetically first id on every Demo screen was the Debug
 * Inspector launcher, which named every explored state after a button.
 */
function defaultStateTitle(snapshot: RuntimeSnapshot, identity: StructuralIdentity): string {
  const candidates: { text: string; role: string }[] = [];
  const trees = ((snapshot as unknown as JsonObject)["trees"] ?? []) as readonly JsonObject[];
  for (const tree of trees) {
    const payload = tree["payload"] as JsonObject;
    const nodes = new Map<string, JsonObject>();
    for (const node of ((payload["inline_nodes"] ?? []) as readonly JsonObject[])) {
      nodes.set(node["node_id"] as string, node);
    }
    const visit = (nodeId: string): void => {
      if (candidates.length >= 8) {
        return;
      }
      const node = nodes.get(nodeId);
      if (node === undefined) {
        return;
      }
      const text = (((node["content"] ?? {}) as JsonObject)["text"] as string | undefined)?.trim();
      if (text !== undefined && text.length >= 2 && text.length <= 64) {
        candidates.push({ text, role: (node["role"] as string | undefined) ?? "" });
      }
      for (const childId of ((node["child_ids"] ?? []) as readonly string[])) {
        visit(childId);
      }
    };
    for (const rootId of ((tree["root_node_ids"] ?? []) as readonly string[])) {
      visit(rootId);
    }
  }
  const header = candidates.find((candidate) => candidate.role === "header");
  if (header !== undefined) {
    return header.text;
  }
  let best: string | undefined;
  for (const candidate of candidates) {
    if (best === undefined || candidate.text.length < best.length) {
      best = candidate.text;
    }
  }
  if (best !== undefined) {
    return best;
  }
  return `Screen ${identity.layout_digest.slice("sha256:".length, "sha256:".length + 8)}`;
}

function withoutKey(value: JsonObject, key: string): JsonObject {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

function observationWallTime(observation: JsonObject): string {
  return (observation["observed_at"] as JsonObject)["wall_time"] as string;
}

function firstSnapshotId(observations: readonly JsonObject[]): string {
  return ((observations[0] as JsonObject)["snapshot_ids"] as readonly string[])[0] as string;
}

function observationBuilds(observations: readonly JsonObject[]): string[] {
  return uniqueStrings(
    observations.map(
      (observation) => (observation["runtime_context"] as JsonObject)["build_id"] as string,
    ),
  );
}

function minimumTimestamp(values: readonly string[]): string {
  return [...values].sort()[0] as string;
}

function maximumTimestamp(values: readonly string[]): string {
  return [...values].sort().at(-1) as string;
}

function actionSignature(command: RecordTransitionObservationCommand): string {
  const target = command.action.target;
  return canonicalJson([
    command.action.kind,
    target?.stable_id ?? "",
    target?.stable_id === undefined ? target?.node_id ?? "" : "",
    (command.action.parameters ?? {}) as JsonValue,
  ] as unknown as JsonValue);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** One stable Screen Graph identity per project and application. */
export function deterministicGraphId(projectId: string, applicationId: string): string {
  const digest = createHash("sha256")
    .update(`vistrea.screen-graph\n${projectId}\n${applicationId}`, "utf8")
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return (
    `graph_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry as JsonValue)}`);
  return `{${entries.join(",")}}`;
}
