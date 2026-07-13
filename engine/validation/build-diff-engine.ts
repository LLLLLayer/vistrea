import {
  DataError,
  isDataError,
  PROTOCOL_SCHEMA_IDS,
  type BuildDiff,
  type DataUnitOfWork,
  type IdGenerator,
  type JsonObject,
  type ProtocolValidator,
  type ScreenGraph,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "../design/index.js";
import { deterministicGraphId } from "../exploration/index.js";

const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
const BUILD_ID_PATTERN =
  /^build_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** What the frozen baseline graph version considered covered. */
interface BaselineCoverage {
  readonly tag: string;
  readonly stateIds: ReadonlySet<string>;
  readonly stateIdByDigest: ReadonlyMap<string, string>;
  readonly transitionIds: ReadonlySet<string>;
  readonly transitionIdByKey: ReadonlyMap<string, string>;
}

export interface BuildDiffEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly validator: ProtocolValidator;
  readonly ids?: IdGenerator;
}

export interface CompareBuildsCommand {
  readonly project_id: string;
  readonly application_id: string;
  readonly left_build_id: string;
  readonly right_build_id: string;
  /**
   * A frozen graph version tag. Removed coverage that the baseline also
   * exhibited classifies as `regressed`; removals absent from the baseline
   * stay plain `removed` (an intentional change), so gates can fail on
   * regressions only.
   */
  readonly baseline_tag?: string;
}

/**
 * Compares observed Screen Graph coverage between two builds of one
 * application: which Screen States and Transitions each build actually
 * exhibited, derived purely from persisted observation evidence.
 *
 * The current slice reports coverage differences (`added`/`removed`).
 * `changed` never appears yet, because structural identity is the state
 * deduplication key: a structural change between builds surfaces as one
 * removed and one added state, which is the honest observation.
 */
export class BuildDiffEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #ids: IdGenerator;

  constructor(dependencies: BuildDiffEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#validator = dependencies.validator;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  compareBuilds(command: CompareBuildsCommand): BuildDiff {
    if (
      !BUILD_ID_PATTERN.test(command.left_build_id) ||
      !BUILD_ID_PATTERN.test(command.right_build_id)
    ) {
      throw new DataError("invalid_argument", "Build identifiers must be typed build UUIDs.");
    }
    if (command.left_build_id === command.right_build_id) {
      throw new DataError(
        "invalid_argument",
        "A Build Diff must compare two distinct builds.",
      );
    }
    if (
      command.baseline_tag !== undefined &&
      !TAG_NAME_PATTERN.test(command.baseline_tag)
    ) {
      throw new DataError("invalid_argument", "The baseline tag name is invalid.");
    }
    return this.#write((unit) => {
      const graphId = deterministicGraphId(command.project_id, command.application_id);
      const graph = unit.screenGraph.getGraph(graphId);
      this.#assertBuildObserved(graph, command.left_build_id);
      this.#assertBuildObserved(graph, command.right_build_id);
      const baseline =
        command.baseline_tag === undefined
          ? undefined
          : this.#loadBaseline(unit, command, command.baseline_tag);
      const entries = [
        ...this.#stateEntries(graph, command, baseline),
        ...this.#transitionEntries(graph, command, baseline),
      ];
      const now = this.#workspace.clock.now();
      const summary = { added: 0, removed: 0, changed: 0, regressed: 0, improved: 0 };
      for (const entry of entries) {
        summary[entry["kind"] as keyof typeof summary] += 1;
      }
      const diff: JsonObject = {
        build_diff_id: this.#ids.next("builddiff"),
        protocol_version: PROTOCOL_VERSION,
        operation_id: this.#ids.next("operation"),
        left_build: { kind: "build", id: command.left_build_id },
        right_build: { kind: "build", id: command.right_build_id },
        created_at: now,
        summary: { total: entries.length, ...summary },
        entries,
        extensions:
          baseline === undefined
            ? {}
            : { "vistrea.baseline": { tag: baseline.tag } },
      };
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.buildDiff, diff);
      unit.validation.appendBuildDiff(diff as unknown as BuildDiff);
      return diff as unknown as BuildDiff;
    });
  }

  getBuildDiff(buildDiffId: string): BuildDiff {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      return unit.validation.getBuildDiff(buildDiffId);
    } finally {
      unit.rollback();
    }
  }

  #assertBuildObserved(graph: ScreenGraph, buildId: string): void {
    const buildIds = (graph.context["build_ids"] ?? []) as readonly string[];
    if (!buildIds.includes(buildId)) {
      throw new DataError(
        "invalid_argument",
        "The Screen Graph has no observations for this build.",
        { details: { build_id: buildId } },
      );
    }
  }

  #loadBaseline(
    unit: DataUnitOfWork,
    command: CompareBuildsCommand,
    tag: string,
  ): BaselineCoverage {
    const frozenId = deterministicGraphId(
      command.project_id,
      `${command.application_id} tag:${tag}`,
    );
    let frozen: ScreenGraph;
    try {
      frozen = unit.screenGraph.getGraph(frozenId);
    } catch (error) {
      if (isDataError(error, "not_found")) {
        throw new DataError("invalid_argument", "The baseline tag names no frozen graph version.", {
          details: { baseline_tag: tag },
        });
      }
      throw error;
    }
    const stateIds = new Set<string>();
    const stateIdByDigest = new Map<string, string>();
    for (const state of frozen.states as readonly JsonObject[]) {
      if ((state["status"] as string) !== "active") {
        continue;
      }
      const stateId = state["screen_state_id"] as string;
      stateIds.add(stateId);
      for (const digest of identityDigests(state)) {
        if (!stateIdByDigest.has(digest)) {
          stateIdByDigest.set(digest, stateId);
        }
      }
    }
    const transitionIds = new Set<string>();
    const transitionIdByKey = new Map<string, string>();
    for (const transition of frozen.transitions as readonly JsonObject[]) {
      const transitionId = transition["transition_id"] as string;
      transitionIds.add(transitionId);
      const key = (transition["extensions"] as JsonObject)["vistrea.transition_key"];
      if (typeof key === "string" && !transitionIdByKey.has(key)) {
        transitionIdByKey.set(key, transitionId);
      }
    }
    return { tag, stateIds, stateIdByDigest, transitionIds, transitionIdByKey };
  }

  #stateEntries(
    graph: ScreenGraph,
    command: CompareBuildsCommand,
    baseline?: BaselineCoverage,
  ): JsonObject[] {
    const now = this.#workspace.clock.now();
    const entries: JsonObject[] = [];
    for (const state of graph.states as readonly JsonObject[]) {
      // Merged and split tombstones are history, not coverage: their evidence
      // now lives on the surviving state, so reporting them would manufacture
      // a removal that curation itself can never clear.
      if ((state["status"] as string) !== "active") {
        continue;
      }
      const seen = (state["seen_in_build_ids"] ?? []) as readonly string[];
      const inLeft = seen.includes(command.left_build_id);
      const inRight = seen.includes(command.right_build_id);
      if (inLeft === inRight) {
        continue;
      }
      const subject: JsonObject = {
        kind: "screen_state",
        id: state["screen_state_id"] as string,
        version: inLeft ? command.left_build_id : command.right_build_id,
      };
      const baselineStateId =
        !inLeft || baseline === undefined
          ? undefined
          : this.#baselineStateFor(graph, state, baseline);
      const regressed = baselineStateId !== undefined;
      entries.push({
        entry_id: this.#ids.next("diffentry"),
        // A vanished screen has no right-build subject, so the entry stays an
        // honest `removed`; the baseline verdict rides in the extension the
        // gate reads, never in a subject field bent to satisfy the schema.
        kind: inLeft ? "removed" : "added",
        domains: ["behavioral", "structural"],
        severity: regressed ? "error" : inLeft ? "warning" : "info",
        summary: regressed
          ? `The Screen State "${state["title"] as string}" is covered by the "${(baseline as BaselineCoverage).tag}" baseline and the left build but vanished from the right build.`
          : inLeft
            ? `The Screen State "${state["title"] as string}" was observed in the left build but never in the right build.`
            : `The Screen State "${state["title"] as string}" appears only in the right build.`,
        ...(inLeft ? { left_subject: subject } : { right_subject: subject }),
        evidence: [
          {
            evidence_id: this.#ids.next("evidence"),
            kind: "measurement",
            captured_at: now,
            source_ref: { kind: "screen_graph", id: graph.screen_graph_id },
            description:
              "Per-build Screen State coverage derived from persisted observation evidence.",
            extensions: {},
          },
        ],
        extensions: baselineExtensions(baseline, baselineStateId, regressed, inLeft),
      });
    }
    return entries;
  }

  /**
   * The baseline state this live state stands for: by identity, by any digest
   * it carries (merges alias absorbed digests onto the survivor), or — for a
   * manual identity produced by a split — through the curation decision that
   * created it, since the split content was baseline coverage of its source.
   */
  #baselineStateFor(
    graph: ScreenGraph,
    state: JsonObject,
    baseline: BaselineCoverage,
  ): string | undefined {
    const stateId = state["screen_state_id"] as string;
    if (baseline.stateIds.has(stateId)) {
      return stateId;
    }
    for (const digest of identityDigests(state)) {
      const matched = baseline.stateIdByDigest.get(digest);
      if (matched !== undefined) {
        return matched;
      }
    }
    const manualKey = (state["identity"] as JsonObject)["manual_key"];
    if (typeof manualKey !== "string") {
      return undefined;
    }
    const decision = (graph["identity_decisions"] as readonly JsonObject[]).find(
      (candidate) => candidate["state_identity_decision_id"] === manualKey,
    );
    for (const inputId of (decision?.["input_state_ids"] ?? []) as readonly string[]) {
      if (baseline.stateIds.has(inputId)) {
        return inputId;
      }
    }
    return undefined;
  }

  #transitionEntries(
    graph: ScreenGraph,
    command: CompareBuildsCommand,
    baseline?: BaselineCoverage,
  ): JsonObject[] {
    const now = this.#workspace.clock.now();
    // A transition is covered by a build when one of its observations was
    // captured in that build's runtime context.
    const buildsByTransition = new Map<string, Set<string>>();
    for (const observation of graph.observations as readonly JsonObject[]) {
      if (observation["kind"] !== "transition") {
        continue;
      }
      const transitionId = observation["transition_id"] as string;
      const buildId = (observation["runtime_context"] as JsonObject)["build_id"] as string;
      const builds = buildsByTransition.get(transitionId);
      if (builds === undefined) {
        buildsByTransition.set(transitionId, new Set([buildId]));
      } else {
        builds.add(buildId);
      }
    }
    const titles = new Map<string, string>();
    for (const state of graph.states as readonly JsonObject[]) {
      titles.set(state["screen_state_id"] as string, state["title"] as string);
    }
    const entries: JsonObject[] = [];
    for (const transition of graph.transitions as readonly JsonObject[]) {
      const transitionId = transition["transition_id"] as string;
      const builds = buildsByTransition.get(transitionId) ?? new Set<string>();
      const inLeft = builds.has(command.left_build_id);
      const inRight = builds.has(command.right_build_id);
      if (inLeft === inRight) {
        continue;
      }
      const sourceTitle = titles.get(transition["source_state_id"] as string) ?? "unknown";
      const targetTitle = titles.get(transition["target_state_id"] as string) ?? "unknown";
      const subject: JsonObject = {
        kind: "transition",
        id: transitionId,
        version: inLeft ? command.left_build_id : command.right_build_id,
      };
      const transitionKey = (transition["extensions"] as JsonObject)["vistrea.transition_key"];
      const baselineTransitionId =
        !inLeft || baseline === undefined
          ? undefined
          : baseline.transitionIds.has(transitionId)
            ? transitionId
            : typeof transitionKey === "string"
              ? baseline.transitionIdByKey.get(transitionKey)
              : undefined;
      const regressed = baselineTransitionId !== undefined;
      entries.push({
        entry_id: this.#ids.next("diffentry"),
        kind: inLeft ? "removed" : "added",
        domains: ["behavioral"],
        severity: regressed ? "error" : inLeft ? "warning" : "info",
        summary: regressed
          ? `The transition from "${sourceTitle}" to "${targetTitle}" is covered by the "${(baseline as BaselineCoverage).tag}" baseline and the left build but vanished from the right build.`
          : inLeft
            ? `The transition from "${sourceTitle}" to "${targetTitle}" was observed in the left build but never in the right build.`
            : `The transition from "${sourceTitle}" to "${targetTitle}" appears only in the right build.`,
        ...(inLeft ? { left_subject: subject } : { right_subject: subject }),
        evidence: [
          {
            evidence_id: this.#ids.next("evidence"),
            kind: "measurement",
            captured_at: now,
            source_ref: { kind: "screen_graph", id: graph.screen_graph_id },
            description:
              "Per-build Transition coverage derived from persisted observation evidence.",
            extensions: {},
          },
        ],
        extensions: baselineExtensions(baseline, baselineTransitionId, regressed, inLeft),
      });
    }
    return entries;
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

/** Every layout digest a state answers to, including merge aliases. */
function identityDigests(state: JsonObject): readonly string[] {
  const identity = state["identity"] as JsonObject;
  return [
    ...(identity["layout_digest"] === undefined ? [] : [identity["layout_digest"] as string]),
    ...(((identity["extensions"] as JsonObject)["vistrea.alias_layout_digests"] as
      | readonly string[]
      | undefined) ?? []),
  ];
}

/** The baseline verdict a gate reads: the entry's kind stays observation-honest. */
function baselineExtensions(
  baseline: BaselineCoverage | undefined,
  baselineSubjectId: string | undefined,
  regressed: boolean,
  inLeft: boolean,
): JsonObject {
  if (baseline === undefined || !inLeft) {
    return {};
  }
  return {
    "vistrea.baseline": {
      tag: baseline.tag,
      classification: regressed ? "regression" : "expected",
      ...(baselineSubjectId === undefined ? {} : { baseline_subject_id: baselineSubjectId }),
    },
  };
}
