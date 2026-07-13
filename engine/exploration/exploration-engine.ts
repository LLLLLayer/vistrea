import {
  DataError,
  type GraphDiff,
  type JsonObject,
  type RuntimeSnapshot,
  type ScreenGraph,
  type VersionSelector,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import type { AutomationEngine } from "../automation/index.js";
import {
  ScreenGraphEngine,
  deterministicGraphId,
  type RecordStateObservationResult,
} from "./screen-graph-engine.js";

const DEFAULT_SETTLE_MILLISECONDS = 1_000;
const MAXIMUM_ACTION_BUDGET = 500;
const MAXIMUM_EXPLORATION_DEPTH = 32;
const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export interface ExplorationCapturePort {
  captureSnapshot(reason: "before_action" | "after_action"): Promise<RuntimeSnapshot>;
}

export interface ExplorationEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly capture: ExplorationCapturePort;
  readonly automation: AutomationEngine;
  readonly graph: ScreenGraphEngine;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface ExploreCommand {
  readonly automation_session_id: string;
  readonly maximum_actions: number;
  readonly maximum_depth?: number;
  readonly settle_milliseconds?: number;
  /**
   * Stable IDs exploration must never tap. Debug tooling controls (for
   * example the in-app Inspector launcher) belong to Vistrea, not to the
   * application frontier, and tapping them traps the walk behind overlays.
   */
  readonly excluded_stable_ids?: readonly string[];
}

export interface ExecutedExplorationStep {
  readonly kind: "tap" | "back";
  readonly target_stable_id?: string;
  readonly source_state_id: string;
  readonly target_state_id: string;
  readonly transition_id: string;
  readonly created_transition: boolean;
  readonly discovered_new_state: boolean;
}

export interface ExplorationReport {
  readonly screen_graph_id: string;
  readonly initial_state_id: string;
  readonly steps: readonly ExecutedExplorationStep[];
  readonly discovered_state_ids: readonly string[];
  readonly action_count: number;
  readonly stopped_reason: "action_budget" | "frontier_exhausted" | "stuck" | "cancelled";
}

/** Per-run observation hooks for long-running callers such as Operations. */
export interface ExplorationRunHooks {
  readonly onStep?: (step: ExecutedExplorationStep) => void;
  /** Checked before every action; returning false stops the walk cleanly. */
  readonly shouldContinue?: () => boolean;
}

export interface TagGraphVersionCommand {
  readonly project_id: string;
  readonly application_id: string;
  readonly tag_name: string;
}

export interface TaggedGraphVersion {
  readonly tag_name: string;
  readonly screen_graph_id: string;
  readonly source_graph_id: string;
  readonly revision: number;
  readonly state_count: number;
  readonly transition_count: number;
}

interface FrontierEntry {
  readonly stableId: string;
}

/**
 * Bounded deterministic depth-first exploration over real executed actions.
 *
 * Every step is observation-honest: the engine captures before and after
 * Snapshots, records both endpoint states through structural identity
 * deduplication, and records the executed Transition. Only tap candidates
 * declared by the captured tree are executed, in sorted stable-identifier
 * order, and system back physically returns after a branch is exhausted.
 * Dangerous and forbidden actions are never generated.
 */
export class ExplorationEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #capture: ExplorationCapturePort;
  readonly #automation: AutomationEngine;
  readonly #graph: ScreenGraphEngine;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(dependencies: ExplorationEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#capture = dependencies.capture;
    this.#automation = dependencies.automation;
    this.#graph = dependencies.graph;
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async explore(command: ExploreCommand, hooks: ExplorationRunHooks = {}): Promise<ExplorationReport> {
    if (
      !Number.isSafeInteger(command.maximum_actions) ||
      command.maximum_actions < 1 ||
      command.maximum_actions > MAXIMUM_ACTION_BUDGET
    ) {
      throw new DataError("invalid_argument", "maximum_actions is outside the supported range.");
    }
    const maximumDepth = command.maximum_depth ?? 8;
    if (
      !Number.isSafeInteger(maximumDepth) ||
      maximumDepth < 1 ||
      maximumDepth > MAXIMUM_EXPLORATION_DEPTH
    ) {
      throw new DataError("invalid_argument", "maximum_depth is outside the supported range.");
    }
    const settleMilliseconds = command.settle_milliseconds ?? DEFAULT_SETTLE_MILLISECONDS;
    const excluded = command.excluded_stable_ids ?? [];
    if (
      excluded.length > 128 ||
      excluded.some(
        (value) => typeof value !== "string" || value.length === 0 || value.length > 256,
      )
    ) {
      throw new DataError("invalid_argument", "excluded_stable_ids is invalid.");
    }
    const excludedStableIds = new Set(excluded);

    let snapshot = await this.#capture.captureSnapshot("before_action");
    let observed = this.#graph.recordStateObservation({
      snapshot_id: snapshot.snapshot_id,
      capture_source: "automation",
      entry: true,
    });
    const initialStateId = observed.screen_state.screen_state_id;
    const graphId = observed.screen_graph_id;

    const executedByState = new Map<string, Set<string>>();
    const discovered = new Set<string>([initialStateId]);
    const steps: ExecutedExplorationStep[] = [];
    const depthStack: string[] = [observed.screen_state.screen_state_id];
    let actionCount = 0;
    let stoppedReason: ExplorationReport["stopped_reason"] = "frontier_exhausted";

    while (actionCount < command.maximum_actions) {
      if (hooks.shouldContinue?.() === false) {
        stoppedReason = "cancelled";
        break;
      }
      const currentStateId = depthStack[depthStack.length - 1] as string;
      const candidate = this.#nextCandidate(
        snapshot,
        executedByState,
        currentStateId,
        excludedStableIds,
      );

      if (candidate === undefined) {
        // The branch is exhausted; physically return when depth remains.
        if (depthStack.length <= 1) {
          stoppedReason = "frontier_exhausted";
          break;
        }
        const back = await this.#step(
          command,
          snapshot,
          { kind: "back" },
          settleMilliseconds,
        );
        actionCount += 1;
        snapshot = back.snapshot;
        const returnedStateId = back.observed.screen_state.screen_state_id;
        steps.push({
          kind: "back",
          source_state_id: currentStateId,
          target_state_id: returnedStateId,
          transition_id: back.transitionId,
          created_transition: back.createdTransition,
          discovered_new_state: back.observed.created,
        });
        hooks.onStep?.(steps[steps.length - 1] as ExecutedExplorationStep);
        if (returnedStateId === currentStateId) {
          // Back did not leave the state; stop instead of looping forever.
          stoppedReason = "stuck";
          break;
        }
        depthStack.pop();
        if (depthStack[depthStack.length - 1] !== returnedStateId) {
          // Back landed somewhere unexpected; restart the branch bookkeeping
          // from the actually observed state.
          depthStack.length = 0;
          depthStack.push(returnedStateId);
        }
        if (actionCount >= command.maximum_actions) {
          // The budget ran out on the return navigation, not the frontier.
          stoppedReason = "action_budget";
          break;
        }
        continue;
      }

      this.#markExecuted(executedByState, currentStateId, candidate.stableId);
      const forward = await this.#step(
        command,
        snapshot,
        { kind: "tap", stableId: candidate.stableId },
        settleMilliseconds,
      );
      actionCount += 1;
      snapshot = forward.snapshot;
      const targetStateId = forward.observed.screen_state.screen_state_id;
      const discoveredNewState = !discovered.has(targetStateId);
      discovered.add(targetStateId);
      steps.push({
        kind: "tap",
        target_stable_id: candidate.stableId,
        source_state_id: currentStateId,
        target_state_id: targetStateId,
        transition_id: forward.transitionId,
        created_transition: forward.createdTransition,
        discovered_new_state: discoveredNewState,
      });
      hooks.onStep?.(steps[steps.length - 1] as ExecutedExplorationStep);
      if (targetStateId !== currentStateId) {
        if (discoveredNewState && depthStack.length < maximumDepth) {
          depthStack.push(targetStateId);
        } else if (depthStack.length >= 2 && depthStack[depthStack.length - 2] === targetStateId) {
          // The action navigated back on its own.
          depthStack.pop();
        } else {
          depthStack.length = 0;
          depthStack.push(targetStateId);
        }
      }
      if (actionCount >= command.maximum_actions) {
        stoppedReason = "action_budget";
        break;
      }
    }

    return {
      screen_graph_id: graphId,
      initial_state_id: initialStateId,
      steps,
      discovered_state_ids: [...discovered],
      action_count: actionCount,
      stopped_reason: stoppedReason,
    };
  }

  /**
   * Freezes the current materialized graph under a version tag so later
   * explorations can be compared against it.
   */
  tagGraphVersion(command: TagGraphVersionCommand): TaggedGraphVersion {
    if (!TAG_NAME_PATTERN.test(command.tag_name)) {
      throw new DataError("invalid_argument", "The version tag name is invalid.");
    }
    const sourceGraphId = deterministicGraphId(command.project_id, command.application_id);
    const unit = this.#workspace.beginUnitOfWork("write");
    try {
      const source = unit.screenGraph.getGraph(sourceGraphId);
      const frozenId = deterministicGraphId(
        command.project_id,
        `${command.application_id} tag:${command.tag_name}`,
      );
      const frozen = {
        ...(structuredClone(source) as unknown as JsonObject),
        screen_graph_id: frozenId,
        revision: 1,
        context: {
          ...(structuredClone(source.context) as JsonObject),
          version_selector: { kind: "tag", tag_name: command.tag_name },
        },
      } as unknown as ScreenGraph;
      unit.screenGraph.createGraph(frozen);
      unit.screenGraph.tagGraphVersion(
        { kind: "tag", tag_name: command.tag_name } as unknown as VersionSelector,
        frozenId,
      );
      unit.commit();
      return {
        tag_name: command.tag_name,
        screen_graph_id: frozenId,
        source_graph_id: sourceGraphId,
        revision: source.revision,
        state_count: source.states.length,
        transition_count: source.transitions.length,
      };
    } catch (error) {
      try {
        unit.rollback();
      } catch {
        // The original failure is the meaningful error.
      }
      throw error;
    }
  }

  compareGraphVersions(leftTag: string, rightTag: string): GraphDiff {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      return unit.screenGraph.compare(
        { kind: "tag", tag_name: leftTag } as unknown as VersionSelector,
        { kind: "tag", tag_name: rightTag } as unknown as VersionSelector,
      );
    } finally {
      unit.rollback();
    }
  }

  async #step(
    command: ExploreCommand,
    beforeSnapshot: RuntimeSnapshot,
    action: { readonly kind: "tap" | "back"; readonly stableId?: string },
    settleMilliseconds: number,
  ): Promise<{
    snapshot: RuntimeSnapshot;
    observed: RecordStateObservationResult;
    transitionId: string;
    createdTransition: boolean;
  }> {
    const result = await this.#automation.execute({
      automation_session_id: command.automation_session_id,
      kind: action.kind,
      ...(action.kind === "tap"
        ? {
            target: { stable_id: action.stableId as string },
            expected_snapshot_id: beforeSnapshot.snapshot_id,
          }
        : {}),
      intent: {
        requested_effect:
          action.kind === "tap"
            ? `Exploration tap on ${action.stableId as string}`
            : "Exploration back navigation",
      },
    });
    if (result.outcome === "blocked" || result.outcome === "failed") {
      throw new DataError("conflict", "An exploration action did not execute.", {
        details: { outcome: result.outcome, kind: action.kind },
      });
    }
    if (settleMilliseconds > 0) {
      await this.#sleep(settleMilliseconds);
    }
    const snapshot = await this.#capture.captureSnapshot("after_action");
    const observed = this.#graph.recordStateObservation({
      snapshot_id: snapshot.snapshot_id,
      capture_source: "automation",
    });
    const transition = this.#graph.recordTransitionObservation({
      before_snapshot_id: beforeSnapshot.snapshot_id,
      after_snapshot_id: snapshot.snapshot_id,
      action: {
        kind: action.kind,
        requested_effect:
          action.kind === "tap"
            ? `Exploration tap on ${action.stableId as string}`
            : "Exploration back navigation",
        risk: "safe",
        ...(action.kind === "tap" ? { target: { stable_id: action.stableId as string } } : {}),
      },
      capture_source: "automation",
    });
    return {
      snapshot,
      observed,
      transitionId: transition.transition.transition_id,
      createdTransition: transition.created,
    };
  }

  #nextCandidate(
    snapshot: RuntimeSnapshot,
    executedByState: Map<string, Set<string>>,
    stateId: string,
    excludedStableIds: ReadonlySet<string>,
  ): FrontierEntry | undefined {
    const executed = executedByState.get(stateId) ?? new Set<string>();
    const candidates: string[] = [];
    for (const tree of snapshot["trees"] as readonly JsonObject[]) {
      const payload = tree["payload"] as JsonObject;
      for (const node of (payload["inline_nodes"] ?? []) as readonly JsonObject[]) {
        const stableId = node["stable_id"];
        const actions = (node["actions"] ?? []) as readonly string[];
        if (
          typeof stableId === "string" &&
          actions.includes("tap") &&
          !executed.has(stableId) &&
          !excludedStableIds.has(stableId)
        ) {
          candidates.push(stableId);
        }
      }
    }
    candidates.sort();
    const next = candidates[0];
    return next === undefined ? undefined : { stableId: next };
  }

  #markExecuted(
    executedByState: Map<string, Set<string>>,
    stateId: string,
    stableId: string,
  ): void {
    const existing = executedByState.get(stateId);
    if (existing === undefined) {
      executedByState.set(stateId, new Set([stableId]));
    } else {
      existing.add(stableId);
    }
  }
}
