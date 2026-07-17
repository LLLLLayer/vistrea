import {
  DataError,
  type GraphDiff,
  type JsonObject,
  type RuntimeSnapshot,
  type ScreenGraph,
  type VersionSelector,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { AutomationError, type AutomationEngine } from "../automation/index.js";
import {
  ScreenGraphEngine,
  deterministicGraphId,
  type RecordStateObservationResult,
} from "./screen-graph-engine.js";

const DEFAULT_SETTLE_MILLISECONDS = 1_000;
const DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS = 2;
const MAXIMUM_ACTION_BUDGET = 500;
const MAXIMUM_EXPLORATION_DEPTH = 32;
const MAXIMUM_RECOVERY_ATTEMPTS = 5;
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
  /** Optional launch identity overriding the captured Runtime application ID. */
  readonly application_id?: string;
  /** Number of bounded relaunch-and-restore attempts; defaults to two. */
  readonly maximum_recovery_attempts?: number;
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
  /** Every provider action, including relaunch and restoration replay. */
  readonly action_count: number;
  readonly recovery_attempt_count: number;
  readonly recovery_count: number;
  readonly restoration_action_count: number;
  readonly recoveries: readonly ExplorationRecoveryEvent[];
  readonly stopped_reason: "action_budget" | "frontier_exhausted" | "stuck" | "cancelled";
}

export interface ExplorationRecoveryEvent {
  readonly attempt: number;
  readonly restored_state_id: string;
  readonly replayed_action_count: number;
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

interface RestorationFrame {
  readonly stateId: string;
  /** Action from the previous frame; absent only when no replay path is known. */
  readonly viaStableId?: string;
}

interface ActionBudget {
  remaining: number;
  used: number;
}

interface RecoveryTracker {
  remainingAttempts: number;
  attemptsUsed: number;
  restorationActions: number;
  readonly events: ExplorationRecoveryEvent[];
}

interface ExplorationStepResult {
  readonly snapshot: RuntimeSnapshot;
  readonly observed: RecordStateObservationResult;
  readonly transitionId: string;
  readonly createdTransition: boolean;
}

class ExplorationActionBudgetExhausted extends Error {}

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

  /** Rejects an out-of-range walk before any device session is opened. */
  assertExploreBounds(command: ExploreCommand): void {
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
    if (
      !Number.isSafeInteger(settleMilliseconds) ||
      settleMilliseconds < 0 ||
      settleMilliseconds > 60_000
    ) {
      throw new DataError(
        "invalid_argument",
        "settle_milliseconds is outside the supported range.",
      );
    }
    const recoveryAttempts =
      command.maximum_recovery_attempts ?? DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS;
    if (
      !Number.isSafeInteger(recoveryAttempts) ||
      recoveryAttempts < 0 ||
      recoveryAttempts > MAXIMUM_RECOVERY_ATTEMPTS
    ) {
      throw new DataError(
        "invalid_argument",
        "maximum_recovery_attempts is outside the supported range.",
      );
    }
    if (
      command.application_id !== undefined &&
      (typeof command.application_id !== "string" ||
        command.application_id.length === 0 ||
        command.application_id.length > 256)
    ) {
      throw new DataError("invalid_argument", "application_id is invalid.");
    }
    const excluded = command.excluded_stable_ids ?? [];
    if (
      !Array.isArray(excluded) ||
      excluded.length > 128 ||
      excluded.some(
        (value) => typeof value !== "string" || value.length === 0 || value.length > 256,
      )
    ) {
      throw new DataError("invalid_argument", "excluded_stable_ids is invalid.");
    }
  }

  async explore(command: ExploreCommand, hooks: ExplorationRunHooks = {}): Promise<ExplorationReport> {
    this.assertExploreBounds(command);
    const maximumDepth = command.maximum_depth ?? 8;
    const settleMilliseconds = command.settle_milliseconds ?? DEFAULT_SETTLE_MILLISECONDS;
    const excludedStableIds = new Set(command.excluded_stable_ids ?? []);
    const actionBudget: ActionBudget = { remaining: command.maximum_actions, used: 0 };
    const recovery: RecoveryTracker = {
      remainingAttempts:
        command.maximum_recovery_attempts ?? DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS,
      attemptsUsed: 0,
      restorationActions: 0,
      events: [],
    };

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
    const depthStack: RestorationFrame[] = [
      { stateId: observed.screen_state.screen_state_id },
    ];
    let stoppedReason: ExplorationReport["stopped_reason"] = "frontier_exhausted";

    while (actionBudget.remaining > 0) {
      if (hooks.shouldContinue?.() === false) {
        stoppedReason = "cancelled";
        break;
      }
      const currentStateId = (depthStack[depthStack.length - 1] as RestorationFrame).stateId;
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
        let back: ExplorationStepResult;
        try {
          back = await this.#step(
            command,
            snapshot,
            { kind: "back" },
            settleMilliseconds,
            depthStack,
            actionBudget,
            recovery,
          );
        } catch (error) {
          if (error instanceof ExplorationActionBudgetExhausted) {
            stoppedReason = "action_budget";
            break;
          }
          throw error;
        }
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
        if (depthStack[depthStack.length - 1]?.stateId !== returnedStateId) {
          // Back landed somewhere unexpected; restart the branch bookkeeping
          // from the actually observed state. With no known replay path,
          // recovery later fails honestly instead of guessing navigation.
          depthStack.length = 0;
          depthStack.push({ stateId: returnedStateId });
        }
        if (actionBudget.remaining === 0) {
          // The budget ran out on the return navigation, not the frontier.
          stoppedReason = "action_budget";
          break;
        }
        continue;
      }

      this.#markExecuted(executedByState, currentStateId, candidate.stableId);
      let forward: ExplorationStepResult;
      try {
        forward = await this.#step(
          command,
          snapshot,
          { kind: "tap", stableId: candidate.stableId },
          settleMilliseconds,
          depthStack,
          actionBudget,
          recovery,
        );
      } catch (error) {
        if (error instanceof ExplorationActionBudgetExhausted) {
          stoppedReason = "action_budget";
          break;
        }
        throw error;
      }
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
          depthStack.push({ stateId: targetStateId, viaStableId: candidate.stableId });
        } else if (
          depthStack.length >= 2 &&
          depthStack[depthStack.length - 2]?.stateId === targetStateId
        ) {
          // The action navigated back on its own.
          depthStack.pop();
        } else {
          depthStack.length = 0;
          depthStack.push({ stateId: targetStateId });
        }
      }
      if (actionBudget.remaining === 0) {
        stoppedReason = "action_budget";
        break;
      }
    }

    return {
      screen_graph_id: graphId,
      initial_state_id: initialStateId,
      steps,
      discovered_state_ids: [...discovered],
      action_count: actionBudget.used,
      recovery_attempt_count: recovery.attemptsUsed,
      recovery_count: recovery.events.length,
      restoration_action_count: recovery.restorationActions,
      recoveries: recovery.events,
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
    restorationPath: readonly RestorationFrame[],
    actionBudget: ActionBudget,
    recovery: RecoveryTracker,
  ): Promise<ExplorationStepResult> {
    let attemptSnapshot = beforeSnapshot;
    while (true) {
      this.#consumeAction(actionBudget);
      const result = await this.#automation.execute({
        automation_session_id: command.automation_session_id,
        kind: action.kind,
        ...(action.kind === "tap"
          ? {
              target: { stable_id: action.stableId as string },
              expected_snapshot_id: attemptSnapshot.snapshot_id,
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
        // The provider's own words explain the refusal (a locked display, an
        // unsafe input) far better than the outcome word alone.
        throw new DataError(
          "conflict",
          `An exploration action did not execute: ${result.detail}`,
          { details: { outcome: result.outcome, kind: action.kind } },
        );
      }
      if (settleMilliseconds > 0) {
        await this.#sleep(settleMilliseconds);
      }

      let snapshot: RuntimeSnapshot;
      try {
        snapshot = await this.#capture.captureSnapshot("after_action");
      } catch (error) {
        if (!isRecoverableCaptureFailure(error) || recovery.remainingAttempts === 0) {
          throw error;
        }
        const runtimeContext = beforeSnapshot["runtime_context"] as JsonObject;
        const applicationId = command.application_id ?? runtimeContext["application_id"];
        if (typeof applicationId !== "string" || applicationId.length === 0) {
          throw error;
        }
        attemptSnapshot = await this.#restoreState(
          command,
          restorationPath,
          applicationId,
          settleMilliseconds,
          actionBudget,
          recovery,
        );
        continue;
      }

      const observed = this.#graph.recordStateObservation({
        snapshot_id: snapshot.snapshot_id,
        capture_source: "automation",
      });
      const transition = this.#graph.recordTransitionObservation({
        before_snapshot_id: attemptSnapshot.snapshot_id,
        after_snapshot_id: snapshot.snapshot_id,
        action: {
          kind: action.kind,
          requested_effect:
            action.kind === "tap"
              ? `Exploration tap on ${action.stableId as string}`
              : "Exploration back navigation",
          risk: "safe",
          ...(action.kind === "tap"
            ? { target: { stable_id: action.stableId as string } }
            : {}),
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
  }

  /**
   * Relaunches the app and deterministically replays the known path from the
   * entry state. Recovery succeeds only when every structural Screen State
   * identity matches the pre-crash path; it never guesses from coordinates or
   * reports an unverified state as restored.
   */
  async #restoreState(
    command: ExploreCommand,
    restorationPath: readonly RestorationFrame[],
    applicationId: string,
    settleMilliseconds: number,
    actionBudget: ActionBudget,
    recovery: RecoveryTracker,
  ): Promise<RuntimeSnapshot> {
    recoveryAttempt: while (recovery.remainingAttempts > 0) {
      recovery.remainingAttempts -= 1;
      recovery.attemptsUsed += 1;
      const attempt = recovery.attemptsUsed;

      this.#consumeAction(actionBudget);
      const launched = await this.#automation.execute({
        automation_session_id: command.automation_session_id,
        kind: "launch",
        intent: { requested_effect: `Recover ${applicationId} after a lost Runtime connection` },
        payload: { bundle_id: applicationId, package_id: applicationId },
      });
      if (launched.outcome === "blocked" || launched.outcome === "failed") {
        continue;
      }
      if (settleMilliseconds > 0) {
        await this.#sleep(settleMilliseconds);
      }

      let currentSnapshot: RuntimeSnapshot;
      try {
        currentSnapshot = await this.#capture.captureSnapshot("after_action");
      } catch (error) {
        if (isRecoverableCaptureFailure(error)) {
          continue;
        }
        throw error;
      }
      let currentObserved = this.#graph.recordStateObservation({
        snapshot_id: currentSnapshot.snapshot_id,
        capture_source: "automation",
      });
      const root = restorationPath[0];
      if (root === undefined || currentObserved.screen_state.screen_state_id !== root.stateId) {
        continue;
      }

      let replayedThisAttempt = 0;
      for (const frame of restorationPath.slice(1)) {
        const stableId = frame.viaStableId;
        if (stableId === undefined) {
          continue recoveryAttempt;
        }
        const replayBefore = currentSnapshot;
        this.#consumeAction(actionBudget);
        const replayed = await this.#automation.execute({
          automation_session_id: command.automation_session_id,
          kind: "tap",
          target: { stable_id: stableId },
          expected_snapshot_id: replayBefore.snapshot_id,
          intent: { requested_effect: `Restore state by replaying ${stableId}` },
        });
        recovery.restorationActions += 1;
        if (replayed.outcome === "blocked" || replayed.outcome === "failed") {
          continue recoveryAttempt;
        }
        if (settleMilliseconds > 0) {
          await this.#sleep(settleMilliseconds);
        }
        try {
          currentSnapshot = await this.#capture.captureSnapshot("after_action");
        } catch (error) {
          if (isRecoverableCaptureFailure(error)) {
            continue recoveryAttempt;
          }
          throw error;
        }
        currentObserved = this.#graph.recordStateObservation({
          snapshot_id: currentSnapshot.snapshot_id,
          capture_source: "automation",
        });
        this.#graph.recordTransitionObservation({
          before_snapshot_id: replayBefore.snapshot_id,
          after_snapshot_id: currentSnapshot.snapshot_id,
          action: {
            kind: "tap",
            requested_effect: `Exploration tap on ${stableId}`,
            risk: "safe",
            target: { stable_id: stableId },
          },
          capture_source: "automation",
        });
        replayedThisAttempt += 1;
        if (currentObserved.screen_state.screen_state_id !== frame.stateId) {
          continue recoveryAttempt;
        }
      }

      recovery.events.push({
        attempt,
        restored_state_id: currentObserved.screen_state.screen_state_id,
        replayed_action_count: replayedThisAttempt,
      });
      return currentSnapshot;
    }
    throw new AutomationError(
      "timeout",
      "The app could not be restored to the pre-crash Screen State within the recovery limit.",
    );
  }

  #consumeAction(budget: ActionBudget): void {
    if (budget.remaining <= 0) {
      throw new ExplorationActionBudgetExhausted();
    }
    budget.remaining -= 1;
    budget.used += 1;
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

/** Only lost/late Runtime connectivity is safe to repair with a relaunch. */
function isRecoverableCaptureFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === "unavailable" || code === "timeout";
}
