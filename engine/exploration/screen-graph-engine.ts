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
    const existing = graph.states.find(
      (candidate) =>
        (candidate["status"] as string) === "active" &&
        ((candidate["identity"] as JsonObject)["layout_digest"] as string) ===
          identity.layout_digest,
    );

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
        title: input.title ?? defaultStateTitle(identity),
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
    try {
      return unit.snapshots.get(snapshotId);
    } catch (error) {
      if (isDataError(error) && error.code === "not_found") {
        throw new DataError("invalid_argument", "The referenced Snapshot is not persisted.", {
          details: { snapshot_id: snapshotId },
        });
      }
      throw error;
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

function defaultStateTitle(identity: StructuralIdentity): string {
  const root = identity.stable_node_ids[0];
  if (root !== undefined) {
    return root;
  }
  return `Screen ${identity.layout_digest.slice("sha256:".length, "sha256:".length + 8)}`;
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
