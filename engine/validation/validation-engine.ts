import {
  DataError,
  PROTOCOL_SCHEMA_IDS,
  type DataUnitOfWork,
  type IdGenerator,
  type JsonObject,
  type Page,
  type PageRequest,
  type ProtocolValidator,
  type RuntimeSnapshot,
  type ScreenGraph,
  type ValidationFinding,
  type ValidationFindingQuery,
  type ValidationRun,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "../design/index.js";
import { deterministicGraphId } from "../exploration/index.js";

const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
const RULE_SET = { kind: "validation_rule_set", id: "ruleset.vistrea.core", version: "1.0.0" };
const MINIMUM_TOUCH_TARGET_POINTS = 44;

export const VALIDATION_CATEGORIES = [
  "structural",
  "visual",
  "behavioral",
  "accessibility",
] as const;

export type ValidationCategory = (typeof VALIDATION_CATEGORIES)[number];

export const SUPPRESSION_REASON_CODES = [
  "false_positive",
  "accepted_risk",
  "known_issue",
  "environment_variance",
  "other",
] as const;

export interface ValidationEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly validator: ProtocolValidator;
  readonly ids?: IdGenerator;
}

export interface ValidateSnapshotCommand {
  readonly snapshot_id: string;
  readonly categories?: readonly ValidationCategory[];
}

export interface ValidateScreenGraphCommand {
  readonly project_id: string;
  readonly application_id: string;
}

export interface ValidationOutcome {
  readonly run: ValidationRun;
  readonly findings: readonly ValidationFinding[];
}

export interface SuppressFindingCommand {
  readonly finding_id: string;
  readonly expected_finding_revision: number;
  readonly reason_code: (typeof SUPPRESSION_REASON_CODES)[number];
  readonly justification: string;
  readonly created_by: JsonObject;
  readonly expires_at?: string;
}

interface RuleFinding {
  readonly rule_id: string;
  readonly category: ValidationCategory;
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly message: string;
  readonly subject: JsonObject;
  readonly expected?: JsonObject;
  readonly actual?: JsonObject;
  readonly measurement: string;
}

interface FlattenedNode {
  readonly node: JsonObject;
  readonly treeId: string;
}

/**
 * Executes the built-in `ruleset.vistrea.core` validators over persisted
 * Snapshots and the materialized Screen Graph, persisting every run and
 * finding with exact count bookkeeping.
 *
 * The rules complement, never repeat, protocol semantic checks: a Snapshot is
 * already structurally coherent when persisted, so validators judge product
 * quality — identity coverage, touch targets, labels, geometry sanity, and
 * graph reachability.
 */
export class ValidationEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #ids: IdGenerator;

  constructor(dependencies: ValidationEngineDependencies) {
    this.#workspace = dependencies.workspace;
    this.#validator = dependencies.validator;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  validateSnapshot(command: ValidateSnapshotCommand): ValidationOutcome {
    const categories = normalizeCategories(command.categories);
    return this.#write((unit) => {
      const snapshot = this.#getSnapshot(unit, command.snapshot_id);
      const ruleFindings: RuleFinding[] = [];
      if (categories.has("structural")) {
        ruleFindings.push(...structuralRules(snapshot));
      }
      if (categories.has("accessibility")) {
        ruleFindings.push(...accessibilityRules(snapshot));
      }
      if (categories.has("visual")) {
        ruleFindings.push(...visualRules(snapshot));
      }
      return this.#persistRun(
        unit,
        { kind: "runtime_snapshot", id: command.snapshot_id },
        { kind: "runtime_snapshot", id: command.snapshot_id },
        ruleFindings,
      );
    });
  }

  validateScreenGraph(command: ValidateScreenGraphCommand): ValidationOutcome {
    return this.#write((unit) => {
      const graphId = deterministicGraphId(command.project_id, command.application_id);
      const graph = unit.screenGraph.getGraph(graphId);
      const ruleFindings = behavioralRules(graph);
      return this.#persistRun(
        unit,
        { kind: "screen_graph", id: graphId },
        { kind: "screen_graph", id: graphId },
        ruleFindings,
      );
    });
  }

  getRun(validationRunId: string): ValidationRun {
    return this.#read((unit) => unit.validation.getRun(validationRunId));
  }

  getFinding(findingId: string): ValidationFinding {
    return this.#read((unit) => unit.validation.getFinding(findingId));
  }

  listFindings(query?: ValidationFindingQuery, page?: PageRequest): Page<ValidationFinding> {
    return this.#read((unit) => unit.validation.listFindings(query, page));
  }

  suppressFinding(command: SuppressFindingCommand): ValidationFinding {
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.actorRef, command.created_by);
    if (command.justification.length === 0 || command.justification.length > 2_048) {
      throw new DataError("invalid_argument", "A suppression requires a bounded justification.");
    }
    return this.#write((unit) => {
      const finding = unit.validation.getFinding(command.finding_id);
      if (finding.revision !== command.expected_finding_revision) {
        throw new DataError("conflict", "The Finding revision does not match.", {
          details: {
            finding_id: command.finding_id,
            expected_revision: command.expected_finding_revision,
            current_revision: finding.revision,
          },
        });
      }
      if (finding["status"] !== "open") {
        throw new DataError("conflict", "Only open Findings can be suppressed.", {
          details: { finding_id: command.finding_id, status: finding["status"] },
        });
      }
      const run = unit.validation.getRun(finding.validation_run_id);
      const now = this.#workspace.clock.now();
      const suppressionId = this.#ids.next("suppression");
      const suppression: JsonObject = {
        suppression_id: suppressionId,
        protocol_version: PROTOCOL_VERSION,
        finding_id: command.finding_id,
        reason_code: command.reason_code,
        justification: command.justification,
        created_by: command.created_by,
        created_at: now,
        ...(command.expires_at === undefined ? {} : { expires_at: command.expires_at }),
        extensions: {},
      };
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.validationSuppression, suppression);
      const updatedFinding: JsonObject = {
        ...finding,
        revision: finding.revision + 1,
        status: "suppressed",
        active_suppression_id: suppressionId,
        updated_at: now,
      };
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.validationFinding, updatedFinding);
      const counts = run["finding_counts"] as JsonObject;
      const updatedRun: JsonObject = {
        ...run,
        revision: run.revision + 1,
        updated_at: now,
        finding_counts: {
          ...counts,
          open: (counts["open"] as number) - 1,
          suppressed: (counts["suppressed"] as number) + 1,
        },
      };
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.validationRun, updatedRun);
      unit.validation.suppressFinding(
        updatedRun as unknown as ValidationRun,
        updatedFinding as unknown as ValidationFinding,
        suppression as never,
        { expected_revision: run.revision },
        { expected_revision: finding.revision },
      );
      return updatedFinding as unknown as ValidationFinding;
    });
  }

  #persistRun(
    unit: DataUnitOfWork,
    target: JsonObject,
    evidenceSource: JsonObject | undefined,
    ruleFindings: readonly RuleFinding[],
  ): ValidationOutcome {
    const now = this.#workspace.clock.now();
    const runId = this.#ids.next("validationrun");
    const initialRun: JsonObject = {
      validation_run_id: runId,
      protocol_version: PROTOCOL_VERSION,
      operation_id: this.#ids.next("operation"),
      target,
      rule_set: RULE_SET,
      state: "running",
      created_at: now,
      started_at: now,
      updated_at: now,
      revision: 1,
      finding_counts: emptyCounts(),
      extensions: {},
    };
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.validationRun, initialRun);
    unit.validation.createRun(initialRun as unknown as ValidationRun);

    const findings = ruleFindings.map((ruleFinding): JsonObject => {
      const detectedAt = this.#workspace.clock.now();
      return {
        finding_id: this.#ids.next("finding"),
        protocol_version: PROTOCOL_VERSION,
        validation_run_id: runId,
        rule_id: ruleFinding.rule_id,
        category: ruleFinding.category,
        severity: ruleFinding.severity,
        status: "open",
        message: ruleFinding.message,
        subject: ruleFinding.subject,
        ...(ruleFinding.expected === undefined ? {} : { expected: ruleFinding.expected }),
        ...(ruleFinding.actual === undefined ? {} : { actual: ruleFinding.actual }),
        evidence: [
          {
            evidence_id: this.#ids.next("evidence"),
            kind: "measurement",
            captured_at: detectedAt,
            ...(evidenceSource === undefined ? {} : { source_ref: evidenceSource }),
            description: ruleFinding.measurement,
            extensions: {},
          },
        ],
        detected_at: detectedAt,
        updated_at: detectedAt,
        revision: 1,
        extensions: {},
      };
    });
    for (const finding of findings) {
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.validationFinding, finding);
    }

    const completedAt = this.#workspace.clock.now();
    const finalRun: JsonObject = {
      ...initialRun,
      revision: 2,
      state: "succeeded",
      completed_at: completedAt,
      updated_at: completedAt,
      finding_counts: countsFor(findings),
    };
    this.#validator.assert(PROTOCOL_SCHEMA_IDS.validationRun, finalRun);
    if (findings.length === 0) {
      unit.validation.updateRun(finalRun as unknown as ValidationRun, { expected_revision: 1 });
    } else {
      unit.validation.addFindings(
        finalRun as unknown as ValidationRun,
        findings as unknown as ValidationFinding[],
        { expected_revision: 1 },
      );
    }
    return {
      run: finalRun as unknown as ValidationRun,
      findings: findings as unknown as ValidationFinding[],
    };
  }

  #getSnapshot(unit: DataUnitOfWork, snapshotId: string): RuntimeSnapshot {
    try {
      return unit.snapshots.get(snapshotId);
    } catch (error) {
      if (error instanceof DataError && error.code === "not_found") {
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

function normalizeCategories(
  categories: readonly ValidationCategory[] | undefined,
): ReadonlySet<ValidationCategory> {
  if (categories === undefined) {
    return new Set(["structural", "accessibility", "visual"]);
  }
  const set = new Set<ValidationCategory>();
  for (const category of categories) {
    if (!VALIDATION_CATEGORIES.includes(category)) {
      throw new DataError("invalid_argument", "Unknown validation category.", {
        details: { category },
      });
    }
    if (category === "behavioral") {
      throw new DataError(
        "invalid_argument",
        "Behavioral rules run against the Screen Graph, not one Snapshot.",
      );
    }
    set.add(category);
  }
  if (set.size === 0) {
    throw new DataError("invalid_argument", "At least one validation category is required.");
  }
  return set;
}

function flattenNodes(snapshot: RuntimeSnapshot): FlattenedNode[] {
  const values: FlattenedNode[] = [];
  for (const tree of snapshot["trees"] as readonly JsonObject[]) {
    const payload = tree["payload"] as JsonObject;
    for (const node of (payload["inline_nodes"] ?? []) as readonly JsonObject[]) {
      values.push({ node, treeId: tree["tree_id"] as string });
    }
  }
  return values;
}

function nodeSubject(snapshot: RuntimeSnapshot, node: JsonObject): JsonObject {
  return {
    kind: "ui_node",
    id: node["node_id"] as string,
    version: snapshot.snapshot_id,
  };
}

function isInteractive(node: JsonObject): boolean {
  return ((node["actions"] ?? []) as readonly string[]).length > 0;
}

function structuralRules(snapshot: RuntimeSnapshot): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const nodes = flattenNodes(snapshot);
  const byStableId = new Map<string, FlattenedNode[]>();
  for (const entry of nodes) {
    const stableId = entry.node["stable_id"];
    if (typeof stableId === "string") {
      const existing = byStableId.get(stableId);
      if (existing === undefined) {
        byStableId.set(stableId, [entry]);
      } else {
        existing.push(entry);
      }
    }
  }
  for (const [stableId, entries] of byStableId) {
    if (entries.length > 1) {
      findings.push({
        rule_id: "structural.duplicate-stable-id",
        category: "structural",
        severity: "error",
        message: `The stable identifier ${stableId} resolves to ${entries.length} nodes, breaking identity, automation, and tuning targeting.`,
        subject: nodeSubject(snapshot, (entries[0] as FlattenedNode).node),
        actual: {
          stable_id: stableId,
          node_ids: entries.map((entry) => entry.node["node_id"] as string),
        },
        measurement: "Counted nodes sharing one stable identifier across all captured trees.",
      });
    }
  }
  for (const entry of nodes) {
    if (isInteractive(entry.node) && typeof entry.node["stable_id"] !== "string") {
      findings.push({
        rule_id: "structural.interactive-without-stable-id",
        category: "structural",
        severity: "warning",
        message:
          "An interactive node has no stable identifier, so automation, identity, and tuning cannot target it deterministically.",
        subject: nodeSubject(snapshot, entry.node),
        actual: { actions: (entry.node["actions"] ?? []) as readonly string[] },
        measurement: "Checked every node declaring actions for a stable identifier.",
      });
    }
  }
  return findings;
}

function accessibilityRules(snapshot: RuntimeSnapshot): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const entry of flattenNodes(snapshot)) {
    const node = entry.node;
    if (!isInteractive(node)) {
      continue;
    }
    const frame = node["frame"] as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (
      frame !== undefined &&
      (frame.width < MINIMUM_TOUCH_TARGET_POINTS || frame.height < MINIMUM_TOUCH_TARGET_POINTS)
    ) {
      findings.push({
        rule_id: "accessibility.minimum-touch-target",
        category: "accessibility",
        severity: "warning",
        message: "An interactive touch target is smaller than the platform minimum.",
        subject: nodeSubject(snapshot, node),
        expected: {
          minimum_width: MINIMUM_TOUCH_TARGET_POINTS,
          minimum_height: MINIMUM_TOUCH_TARGET_POINTS,
          unit: "pt",
        },
        actual: { width: frame.width, height: frame.height, unit: "pt" },
        measurement: "Measured the captured logical frame of the interactive node.",
      });
    }
    const accessibility = node["accessibility"] as JsonObject | undefined;
    const content = node["content"] as JsonObject | undefined;
    const label = accessibility?.["label"] ?? content?.["text"];
    if (typeof label !== "string" || label.length === 0) {
      findings.push({
        rule_id: "accessibility.missing-label",
        category: "accessibility",
        severity: "warning",
        message:
          "An interactive node exposes neither an accessibility label nor text content.",
        subject: nodeSubject(snapshot, node),
        measurement: "Checked accessibility.label and content.text on the interactive node.",
      });
    }
  }
  return findings;
}

function visualRules(snapshot: RuntimeSnapshot): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const display = snapshot["display"] as JsonObject;
  const logical = display["logical_size"] as { width: number; height: number };
  for (const entry of flattenNodes(snapshot)) {
    const node = entry.node;
    const frame = node["frame"] as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (frame === undefined) {
      continue;
    }
    const state = node["state"] as JsonObject | undefined;
    const visible = state?.["visible"] === true;
    if (
      isInteractive(node) &&
      (frame.x + frame.width <= 0 ||
        frame.y + frame.height <= 0 ||
        frame.x >= logical.width ||
        frame.y >= logical.height)
    ) {
      findings.push({
        rule_id: "visual.offscreen-interactive",
        category: "visual",
        severity: "error",
        message: "An interactive node lies entirely outside the display bounds.",
        subject: nodeSubject(snapshot, node),
        expected: { display_width: logical.width, display_height: logical.height, unit: "pt" },
        actual: { x: frame.x, y: frame.y, width: frame.width, height: frame.height, unit: "pt" },
        measurement: "Intersected the node frame with the display logical bounds.",
      });
    }
    if (visible && (frame.width <= 0 || frame.height <= 0)) {
      findings.push({
        rule_id: "visual.zero-size-visible",
        category: "visual",
        severity: "warning",
        message: "A node reports itself visible but has no drawable area.",
        subject: nodeSubject(snapshot, node),
        actual: { width: frame.width, height: frame.height, unit: "pt" },
        measurement: "Compared the visible state flag with the captured frame area.",
      });
    }
  }
  return findings;
}

function behavioralRules(graph: ScreenGraph): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const states = graph.states as readonly JsonObject[];
  const transitions = graph.transitions as readonly JsonObject[];
  const entryIds = new Set((graph["entry_state_ids"] ?? []) as readonly string[]);
  const outgoing = new Map<string, string[]>();
  for (const transition of transitions) {
    const source = transition["source_state_id"] as string;
    const target = transition["target_state_id"] as string;
    const targets = outgoing.get(source);
    if (targets === undefined) {
      outgoing.set(source, [target]);
    } else {
      targets.push(target);
    }
  }
  const reachable = new Set<string>(entryIds);
  const queue = [...entryIds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const target of outgoing.get(current) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  for (const state of states) {
    const stateId = state["screen_state_id"] as string;
    if (state["status"] !== "active") {
      continue;
    }
    const subject: JsonObject = {
      kind: "screen_state",
      id: stateId,
      version: graph.screen_graph_id,
    };
    if (!reachable.has(stateId)) {
      findings.push({
        rule_id: "behavioral.unreachable-state",
        category: "behavioral",
        severity: "warning",
        message:
          "An active Screen State is not reachable from any entry state through observed transitions.",
        subject,
        actual: { entry_state_ids: [...entryIds] },
        measurement: "Breadth-first reachability over observed transitions from every entry state.",
      });
    }
    if (
      transitions.length > 0 &&
      !entryIds.has(stateId) &&
      (outgoing.get(stateId) ?? []).length === 0
    ) {
      findings.push({
        rule_id: "behavioral.dead-end-state",
        category: "behavioral",
        severity: "info",
        message: "A non-entry Screen State has no observed outgoing transition.",
        subject,
        measurement: "Counted observed outgoing transitions per state.",
      });
    }
  }
  return findings;
}

function emptyCounts(): JsonObject {
  return {
    total: 0,
    open: 0,
    suppressed: 0,
    resolved: 0,
    by_severity: { info: 0, warning: 0, error: 0, critical: 0 },
  };
}

function countsFor(findings: readonly JsonObject[]): JsonObject {
  const bySeverity = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const finding of findings) {
    bySeverity[finding["severity"] as keyof typeof bySeverity] += 1;
  }
  return {
    total: findings.length,
    open: findings.length,
    suppressed: 0,
    resolved: 0,
    by_severity: bySeverity,
  };
}
