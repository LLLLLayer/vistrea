import type Database from "better-sqlite3";

import { DataError } from "../api/errors.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type JsonObject,
  type JsonValue,
  type ObjectRef,
  type OperationEvent,
  type OperationRecord,
  type OperationResult,
  type ProtocolSchemaId,
  type ProtocolValidator,
  type ValidationFinding,
  type ValidationFindingCounts,
} from "../api/models.js";
import { createEmptyDataState, type DataState } from "../internal/state.js";

type RegularStateKey = Exclude<
  keyof DataState,
  | "snapshotObjects"
  | "snapshotPins"
  | "reportedEventGaps"
  | "screenGraphsByVersion"
  | "operations"
>;

interface ResourceDescriptor {
  readonly stateKey: RegularStateKey;
  readonly repository: string;
  readonly resourceKind: string;
  readonly schemaId?: ProtocolSchemaId;
  readonly identity: (value: Record<string, unknown>) => string;
  readonly revision?: (value: Record<string, unknown>) => number | undefined;
  readonly ordinal?: (value: Record<string, unknown>) => number | undefined;
  readonly relations?: (
    value: Record<string, unknown>,
  ) => readonly [string | undefined, string | undefined, string | undefined];
}

interface ResourceRow {
  readonly repository: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly revision: number | null;
  readonly ordinal: number | null;
  readonly relation_a: string | null;
  readonly relation_b: string | null;
  readonly relation_c: string | null;
  readonly json: string;
}

interface OperationBase {
  readonly protocol_version: JsonObject;
  readonly operation: JsonObject;
  readonly revision: number;
  readonly extensions: JsonObject;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return field !== null && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : {};
}

const RESOURCE_DESCRIPTORS: readonly ResourceDescriptor[] = [
  {
    stateKey: "snapshots",
    repository: "snapshots",
    resourceKind: "runtime_snapshot",
    schemaId: PROTOCOL_SCHEMA_IDS.runtimeSnapshot,
    identity: (value) => stringField(value, "snapshot_id"),
    relations: (value) => {
      const context = objectField(value, "runtime_context");
      return [
        stringField(context, "build_id") || undefined,
        stringField(context, "session_id") || undefined,
        undefined,
      ];
    },
  },
  {
    stateKey: "observations",
    repository: "observations",
    resourceKind: "observation",
    schemaId: PROTOCOL_SCHEMA_IDS.observation,
    identity: (value) => stringField(value, "observation_id"),
    relations: (value) => [
      stringField(value, "screen_state_id") || undefined,
      stringField(value, "transition_id") || undefined,
      stringField(value, "kind") || undefined,
    ],
  },
  {
    stateKey: "runtimeEvents",
    repository: "runtime_events",
    resourceKind: "runtime_event",
    schemaId: PROTOCOL_SCHEMA_IDS.runtimeEvent,
    identity: (value) => stringField(value, "event_id"),
    ordinal: (value) => numberField(value, "sequence"),
    relations: (value) => [
      stringField(value, "event_epoch_id") || undefined,
      stringField(value, "kind") || undefined,
      undefined,
    ],
  },
  {
    stateKey: "screenGraphs",
    repository: "screen_graph",
    resourceKind: "screen_graph",
    schemaId: PROTOCOL_SCHEMA_IDS.screenGraph,
    identity: (value) => stringField(value, "screen_graph_id"),
    revision: (value) => numberField(value, "revision"),
  },
  {
    stateKey: "identityDecisions",
    repository: "screen_graph",
    resourceKind: "state_identity_decision",
    schemaId: PROTOCOL_SCHEMA_IDS.stateIdentityDecision,
    identity: (value) => stringField(value, "state_identity_decision_id"),
    revision: (value) => numberField(value, "revision"),
  },
  {
    stateKey: "wikiNodes",
    repository: "wiki",
    resourceKind: "wiki_node",
    schemaId: PROTOCOL_SCHEMA_IDS.wikiNode,
    identity: (value) => stringField(value, "wiki_node_id"),
    revision: (value) => numberField(value, "revision"),
  },
  {
    stateKey: "wikiLinks",
    repository: "wiki",
    resourceKind: "wiki_link",
    schemaId: PROTOCOL_SCHEMA_IDS.wikiLink,
    identity: (value) => stringField(value, "wiki_link_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => {
      const target = objectField(value, "target");
      return [
        stringField(value, "source_node_id") || undefined,
        stringField(target, "kind") || undefined,
        stringField(target, "id") || undefined,
      ];
    },
  },
  {
    stateKey: "deletedWikiLinks",
    repository: "wiki",
    resourceKind: "deleted_wiki_link",
    identity: (value) => {
      const link = objectField(value, "link");
      return stringField(link, "wiki_link_id");
    },
    revision: (value) => numberField(value, "deleted_revision"),
  },
  {
    stateKey: "knowledgeCollections",
    repository: "wiki",
    resourceKind: "knowledge_collection",
    schemaId: PROTOCOL_SCHEMA_IDS.knowledgeCollection,
    identity: (value) => stringField(value, "collection_id"),
    revision: (value) => numberField(value, "revision"),
  },
  {
    stateKey: "designReferences",
    repository: "design_reviews",
    resourceKind: "design_reference",
    schemaId: PROTOCOL_SCHEMA_IDS.designReference,
    identity: (value) => stringField(value, "design_reference_id"),
    revision: (value) => numberField(value, "revision"),
  },
  {
    stateKey: "designRegionMappings",
    repository: "design_reviews",
    resourceKind: "design_region_mapping",
    schemaId: PROTOCOL_SCHEMA_IDS.designRegionMapping,
    identity: (value) => stringField(value, "mapping_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [
      stringField(value, "design_reference_id") || undefined,
      stringField(value, "state") || undefined,
      undefined,
    ],
  },
  {
    stateKey: "designComparisons",
    repository: "design_reviews",
    resourceKind: "design_comparison",
    schemaId: PROTOCOL_SCHEMA_IDS.designComparison,
    identity: (value) => stringField(value, "comparison_id"),
    revision: (value) => numberField(value, "revision"),
  },
  {
    stateKey: "reviewIssues",
    repository: "design_reviews",
    resourceKind: "review_issue",
    schemaId: PROTOCOL_SCHEMA_IDS.reviewIssue,
    identity: (value) => stringField(value, "issue_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [
      stringField(value, "design_reference_id") || undefined,
      stringField(value, "state") || undefined,
      stringField(value, "severity") || undefined,
    ],
  },
  {
    stateKey: "reviewVerificationRecords",
    repository: "design_reviews",
    resourceKind: "review_verification_record",
    schemaId: PROTOCOL_SCHEMA_IDS.reviewVerificationRecord,
    identity: (value) => stringField(value, "verification_record_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [stringField(value, "issue_id") || undefined, undefined, undefined],
  },
  {
    stateKey: "tuningPatches",
    repository: "design_reviews",
    resourceKind: "tuning_patch",
    schemaId: PROTOCOL_SCHEMA_IDS.tuningPatch,
    identity: (value) => stringField(value, "patch_id"),
    revision: (value) => numberField(value, "revision"),
  },
  {
    stateKey: "tuningApplications",
    repository: "design_reviews",
    resourceKind: "tuning_application",
    schemaId: PROTOCOL_SCHEMA_IDS.tuningApplication,
    identity: (value) => stringField(value, "tuning_application_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [
      stringField(value, "connection_id") || undefined,
      stringField(value, "status") || undefined,
      undefined,
    ],
  },
  {
    stateKey: "validationRuns",
    repository: "validation",
    resourceKind: "validation_run",
    schemaId: PROTOCOL_SCHEMA_IDS.validationRun,
    identity: (value) => stringField(value, "validation_run_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [stringField(value, "state") || undefined, undefined, undefined],
  },
  {
    stateKey: "validationFindings",
    repository: "validation",
    resourceKind: "validation_finding",
    schemaId: PROTOCOL_SCHEMA_IDS.validationFinding,
    identity: (value) => stringField(value, "finding_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [
      stringField(value, "validation_run_id") || undefined,
      stringField(value, "status") || undefined,
      stringField(value, "severity") || undefined,
    ],
  },
  {
    stateKey: "validationSuppressions",
    repository: "validation",
    resourceKind: "validation_suppression",
    schemaId: PROTOCOL_SCHEMA_IDS.validationSuppression,
    identity: (value) => stringField(value, "suppression_id"),
    relations: (value) => [stringField(value, "finding_id") || undefined, undefined, undefined],
  },
  {
    stateKey: "buildDiffs",
    repository: "validation",
    resourceKind: "build_diff",
    schemaId: PROTOCOL_SCHEMA_IDS.buildDiff,
    identity: (value) => stringField(value, "build_diff_id"),
  },
  {
    stateKey: "commits",
    repository: "versions",
    resourceKind: "commit",
    schemaId: PROTOCOL_SCHEMA_IDS.commit,
    identity: (value) => stringField(value, "commit_id"),
  },
  {
    stateKey: "refs",
    repository: "versions",
    resourceKind: "ref",
    schemaId: PROTOCOL_SCHEMA_IDS.ref,
    identity: (value) => stringField(value, "name"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [stringField(value, "commit_id") || undefined, undefined, undefined],
  },
  {
    stateKey: "tags",
    repository: "versions",
    resourceKind: "tag",
    schemaId: PROTOCOL_SCHEMA_IDS.tag,
    identity: (value) => stringField(value, "name"),
    relations: (value) => [stringField(value, "commit_id") || undefined, undefined, undefined],
  },
  {
    stateKey: "workingSets",
    repository: "versions",
    resourceKind: "working_set",
    schemaId: PROTOCOL_SCHEMA_IDS.workingSet,
    identity: (value) => stringField(value, "working_set_id"),
    revision: (value) => numberField(value, "revision"),
    relations: (value) => [stringField(value, "base_commit_id") || undefined, undefined, undefined],
  },
] as const;

const DESCRIPTOR_BY_ROW_KEY = new Map(
  RESOURCE_DESCRIPTORS.map((descriptor) => [
    `${descriptor.repository}\u0000${descriptor.resourceKind}`,
    descriptor,
  ]),
);

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DataError("integrity_error", "Metadata JSON contains a non-finite number.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new DataError("integrity_error", "Metadata JSON contains undefined.", {
          details: { key },
        });
      }
      result[key] = normalizeJson(child);
    }
    return result;
  }
  throw new DataError("integrity_error", "Metadata contains a non-JSON value.");
}

export function deterministicJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function parseJson(text: string, context: JsonObject): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DataError("integrity_error", "SQLite metadata contains invalid JSON.", {
      details: { ...context, cause: String(error) },
    });
  }
}

function asRecord(value: unknown, context: JsonObject): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataError("integrity_error", "SQLite metadata resource is not an object.", {
      details: context,
    });
  }
  return value as Record<string, unknown>;
}

export function loadObjectCatalog(
  db: Database.Database,
  validator: ProtocolValidator,
): Map<string, ObjectRef> {
  const result = new Map<string, ObjectRef>();
  const rows = db
    .prepare(
      "SELECT hash, media_type, byte_size, compression, json " +
        "FROM vistrea_object_refs ORDER BY hash COLLATE BINARY",
    )
    .all() as readonly {
    readonly hash: string;
    readonly media_type: string;
    readonly byte_size: number;
    readonly compression: string;
    readonly json: string;
  }[];
  for (const row of rows) {
    const value = parseJson(row.json, { table: "vistrea_object_refs", hash: row.hash });
    validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, value);
    const object = value as ObjectRef;
    if (
      object.hash !== row.hash ||
      object.media_type !== row.media_type ||
      object.byte_size !== row.byte_size ||
      object.compression !== row.compression ||
      deterministicJson(object) !== row.json
    ) {
      throw new DataError("integrity_error", "An ObjectRef catalog row is not canonical.", {
        details: { hash: row.hash },
      });
    }
    result.set(row.hash, object);
  }
  return result;
}

export function persistObjectCatalogEntries(
  db: Database.Database,
  objects: readonly ObjectRef[],
): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO vistrea_object_refs " +
      "(hash, media_type, byte_size, compression, json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const object of [...objects].sort((left, right) => left.hash.localeCompare(right.hash))) {
    insert.run(
      object.hash,
      object.media_type,
      object.byte_size,
      object.compression,
      deterministicJson(object),
    );
  }
}

export function loadMetadataState(
  db: Database.Database,
  validator: ProtocolValidator,
  verifiedObjects: ReadonlyMap<string, ObjectRef>,
): DataState {
  const state = createEmptyDataState();
  const operationBases = new Map<string, OperationBase>();
  const rows = db
    .prepare(
      "SELECT repository, resource_kind, resource_id, revision, ordinal, " +
        "relation_a, relation_b, relation_c, json FROM vistrea_resources " +
        "ORDER BY repository COLLATE BINARY, resource_kind COLLATE BINARY, resource_id COLLATE BINARY",
    )
    .all() as readonly ResourceRow[];

  for (const row of rows) {
    const context = {
      repository: row.repository,
      resource_kind: row.resource_kind,
      resource_id: row.resource_id,
    };
    const value = asRecord(parseJson(row.json, context), context);
    if (deterministicJson(value) !== row.json) {
      throw new DataError("integrity_error", "SQLite metadata JSON is not deterministic.", {
        details: context,
      });
    }
    if (row.repository === "operations" && row.resource_kind === "operation") {
      const operation = asRecord(value["operation"], context);
      if (stringField(operation, "operation_id") !== row.resource_id) {
        throw new DataError("integrity_error", "Operation row identity does not match its key.", {
          details: context,
        });
      }
      if (
        row.revision !== numberField(value, "revision") ||
        row.ordinal !== null ||
        row.relation_a !== stringField(operation, "kind") ||
        row.relation_b !== stringField(operation, "state") ||
        row.relation_c !== null
      ) {
        throw new DataError("integrity_error", "Operation index columns do not match JSON.", {
          details: context,
        });
      }
      operationBases.set(row.resource_id, value as unknown as OperationBase);
      continue;
    }

    const descriptor = DESCRIPTOR_BY_ROW_KEY.get(
      `${row.repository}\u0000${row.resource_kind}`,
    );
    if (descriptor === undefined) {
      throw new DataError("integrity_error", "SQLite contains an unknown metadata resource kind.", {
        details: context,
      });
    }
    if (descriptor.identity(value) !== row.resource_id) {
      throw new DataError("integrity_error", "Resource JSON identity does not match its row key.", {
        details: context,
      });
    }
    const relations = descriptor.relations?.(value) ?? [undefined, undefined, undefined];
    if (
      row.revision !== (descriptor.revision?.(value) ?? null) ||
      row.ordinal !== (descriptor.ordinal?.(value) ?? null) ||
      row.relation_a !== (relations[0] ?? null) ||
      row.relation_b !== (relations[1] ?? null) ||
      row.relation_c !== (relations[2] ?? null)
    ) {
      throw new DataError("integrity_error", "Resource index columns do not match JSON.", {
        details: context,
      });
    }
    if (descriptor.schemaId !== undefined) {
      validator.assert(descriptor.schemaId, value);
    }
    const map = state[descriptor.stateKey] as unknown as Map<string, unknown>;
    map.set(row.resource_id, value);
  }

  const eventsByOperation = new Map<string, OperationEvent[]>();
  const eventRows = db
    .prepare(
      "SELECT operation_id, sequence, event_id, state, json FROM vistrea_operation_events " +
        "ORDER BY operation_id COLLATE BINARY, sequence",
    )
    .all() as readonly {
    readonly operation_id: string;
    readonly sequence: number;
    readonly event_id: string;
    readonly state: string;
    readonly json: string;
  }[];
  for (const row of eventRows) {
    const value = parseJson(row.json, {
      table: "vistrea_operation_events",
      operation_id: row.operation_id,
      sequence: row.sequence,
    });
    validator.assert(PROTOCOL_SCHEMA_IDS.operationEvent, value);
    const event = value as OperationEvent;
    if (
      event.operation_id !== row.operation_id ||
      event.sequence !== row.sequence ||
      event.event_id !== row.event_id ||
      event.state !== row.state ||
      deterministicJson(event) !== row.json
    ) {
      throw new DataError("integrity_error", "Operation Event row identity does not match its key.", {
        details: { operation_id: row.operation_id, sequence: row.sequence },
      });
    }
    const events = eventsByOperation.get(row.operation_id) ?? [];
    events.push(event);
    eventsByOperation.set(row.operation_id, events);
  }

  const results = new Map<string, OperationResult>();
  const resultRows = db
    .prepare(
      "SELECT operation_id, result_type, storage, json " +
        "FROM vistrea_operation_results ORDER BY operation_id",
    )
    .all() as readonly {
    readonly operation_id: string;
    readonly result_type: string;
    readonly storage: string;
    readonly json: string;
  }[];
  for (const row of resultRows) {
    const value = parseJson(row.json, {
      table: "vistrea_operation_results",
      operation_id: row.operation_id,
    });
    validator.assert(PROTOCOL_SCHEMA_IDS.operationResult, value);
    const result = value as OperationResult;
    if (
      result.operation_id !== row.operation_id ||
      result.result_type !== row.result_type ||
      result.storage !== row.storage ||
      deterministicJson(result) !== row.json
    ) {
      throw new DataError("integrity_error", "Operation Result row identity does not match its key.", {
        details: { operation_id: row.operation_id },
      });
    }
    results.set(row.operation_id, result);
  }

  for (const [operationId, base] of operationBases) {
    const events = eventsByOperation.get(operationId) ?? [];
    const result = results.get(operationId);
    const record = {
      ...base,
      events,
      ...(result === undefined ? {} : { result }),
    } as unknown as OperationRecord;
    validator.assert(PROTOCOL_SCHEMA_IDS.operationRecord, record);
    state.operations.set(operationId, record);
    eventsByOperation.delete(operationId);
    results.delete(operationId);
  }
  if (eventsByOperation.size > 0 || results.size > 0) {
    throw new DataError("integrity_error", "Operation event or result rows have no Operation summary.");
  }

  const snapshotObjectRows = db
    .prepare(
      "SELECT snapshot_id, ordinal, object_hash FROM vistrea_snapshot_objects " +
        "ORDER BY snapshot_id COLLATE BINARY, ordinal",
    )
    .all() as readonly {
    readonly snapshot_id: string;
    readonly ordinal: number;
    readonly object_hash: string;
  }[];
  for (const row of snapshotObjectRows) {
    if (!state.snapshots.has(row.snapshot_id)) {
      throw new DataError("integrity_error", "Snapshot Object association references a missing Snapshot.", {
        details: { snapshot_id: row.snapshot_id, object_hash: row.object_hash },
      });
    }
    const object = verifiedObjects.get(row.object_hash);
    if (object === undefined) {
      throw new DataError("integrity_error", "Snapshot Object association is not verified.", {
        details: { snapshot_id: row.snapshot_id, object_hash: row.object_hash },
      });
    }
    const current = state.snapshotObjects.get(row.snapshot_id) ?? [];
    if (row.ordinal !== current.length) {
      throw new DataError("integrity_error", "Snapshot Object ordinals are not contiguous.", {
        details: { snapshot_id: row.snapshot_id, ordinal: row.ordinal },
      });
    }
    state.snapshotObjects.set(row.snapshot_id, [...current, object]);
  }

  const pinRows = db
    .prepare("SELECT snapshot_id, reason FROM vistrea_snapshot_pins ORDER BY snapshot_id, reason")
    .all() as readonly { readonly snapshot_id: string; readonly reason: string }[];
  for (const row of pinRows) {
    if (!state.snapshots.has(row.snapshot_id)) {
      throw new DataError("integrity_error", "Snapshot pin references a missing Snapshot.", {
        details: { snapshot_id: row.snapshot_id },
      });
    }
    state.snapshotPins.set(row.snapshot_id, [
      ...(state.snapshotPins.get(row.snapshot_id) ?? []),
      row.reason,
    ]);
  }

  const gapRows = db
    .prepare(
      "SELECT event_epoch_id, first_sequence, last_sequence FROM vistrea_runtime_event_gaps " +
        "ORDER BY event_epoch_id, first_sequence, last_sequence",
    )
    .all() as readonly {
    readonly event_epoch_id: string;
    readonly first_sequence: number;
    readonly last_sequence: number;
  }[];
  for (const row of gapRows) {
    state.reportedEventGaps.set(row.event_epoch_id, [
      ...(state.reportedEventGaps.get(row.event_epoch_id) ?? []),
      { first_sequence: row.first_sequence, last_sequence: row.last_sequence },
    ]);
  }

  const graphVersionRows = db
    .prepare("SELECT selector, screen_graph_id FROM vistrea_screen_graph_versions ORDER BY selector")
    .all() as readonly { readonly selector: string; readonly screen_graph_id: string }[];
  for (const row of graphVersionRows) {
    if (!state.screenGraphs.has(row.screen_graph_id)) {
      throw new DataError("integrity_error", "Graph version points to a missing Screen Graph.", {
        details: { selector: row.selector, screen_graph_id: row.screen_graph_id },
      });
    }
    state.screenGraphsByVersion.set(row.selector, row.screen_graph_id);
  }

  for (const [snapshotId, snapshot] of state.snapshots) {
    const embedded = collectEmbeddedObjectHashes(snapshot);
    const associated = new Set(
      (state.snapshotObjects.get(snapshotId) ?? []).map((object) => object.hash),
    );
    for (const hash of embedded) {
      if (!associated.has(hash)) {
        throw new DataError("integrity_error", "Snapshot JSON has no durable Object association.", {
          details: { snapshot_id: snapshotId, hash },
        });
      }
    }
  }
  for (const finding of state.validationFindings.values()) {
    if (!state.validationRuns.has(finding.validation_run_id)) {
      throw new DataError("integrity_error", "Validation Finding references a missing Run.", {
        details: {
          finding_id: finding.finding_id,
          validation_run_id: finding.validation_run_id,
        },
      });
    }
    if (finding.status === "suppressed") {
      const suppression =
        finding.active_suppression_id === undefined
          ? undefined
          : state.validationSuppressions.get(finding.active_suppression_id);
      if (suppression === undefined || suppression.finding_id !== finding.finding_id) {
        throw new DataError(
          "integrity_error",
          "Suppressed Validation Finding has no matching durable suppression.",
          { details: { finding_id: finding.finding_id } },
        );
      }
    }
  }
  for (const suppression of state.validationSuppressions.values()) {
    if (!state.validationFindings.has(suppression.finding_id)) {
      throw new DataError("integrity_error", "Validation Suppression references a missing Finding.", {
        details: {
          suppression_id: suppression.suppression_id,
          finding_id: suppression.finding_id,
        },
      });
    }
  }
  for (const run of state.validationRuns.values()) {
    const derived = deriveFindingCounts(
      [...state.validationFindings.values()].filter(
        (finding) => finding.validation_run_id === run.validation_run_id,
      ),
    );
    if (deterministicJson(run.finding_counts) !== deterministicJson(derived)) {
      throw new DataError("integrity_error", "Validation Run summary does not match its Findings.", {
        details: { validation_run_id: run.validation_run_id },
      });
    }
  }
  for (const commit of state.commits.values()) {
    for (const parent of commit.manifest.parents) {
      if (!state.commits.has(parent)) {
        throw new DataError("integrity_error", "Commit references a missing parent.", {
          details: { commit_id: commit.commit_id, parent_commit_id: parent },
        });
      }
    }
    for (const hash of commit.manifest.object_hashes) {
      if (!verifiedObjects.has(hash)) {
        throw new DataError("integrity_error", "Commit references an unverified ObjectRef hash.", {
          details: { commit_id: commit.commit_id, hash },
        });
      }
    }
  }
  for (const ref of state.refs.values()) {
    if (!state.commits.has(ref.commit_id)) {
      throw new DataError("integrity_error", "Ref references a missing Commit.", {
        details: { ref_name: ref.name, commit_id: ref.commit_id },
      });
    }
  }
  for (const tag of state.tags.values()) {
    if (!state.commits.has(tag.commit_id)) {
      throw new DataError("integrity_error", "Tag references a missing Commit.", {
        details: { tag_name: tag.name, commit_id: tag.commit_id },
      });
    }
  }
  for (const workingSet of state.workingSets.values()) {
    if (!state.commits.has(workingSet.base_commit_id)) {
      throw new DataError("integrity_error", "Working Set references a missing base Commit.", {
        details: {
          working_set_id: workingSet.working_set_id,
          base_commit_id: workingSet.base_commit_id,
        },
      });
    }
  }
  for (const hash of collectEmbeddedObjectHashes(state)) {
    if (!verifiedObjects.has(hash)) {
      throw new DataError("integrity_error", "Metadata references an unverified ObjectRef.", {
        details: { hash },
      });
    }
  }
  return state;
}

function deriveFindingCounts(
  findings: readonly ValidationFinding[],
): ValidationFindingCounts {
  const counts = {
    total: findings.length,
    open: 0,
    suppressed: 0,
    resolved: 0,
    by_severity: { info: 0, warning: 0, error: 0, critical: 0 },
  };
  for (const finding of findings) {
    counts[finding.status] += 1;
    counts.by_severity[finding.severity] += 1;
  }
  return counts;
}

export function replaceMetadataState(db: Database.Database, state: DataState): void {
  db.exec(
    "DELETE FROM vistrea_operation_events; " +
      "DELETE FROM vistrea_operation_results; " +
      "DELETE FROM vistrea_snapshot_objects; " +
      "DELETE FROM vistrea_snapshot_pins; " +
      "DELETE FROM vistrea_runtime_event_gaps; " +
      "DELETE FROM vistrea_screen_graph_versions; " +
      "DELETE FROM vistrea_resources;",
  );

  const insertResource = db.prepare(
    "INSERT INTO vistrea_resources " +
      "(repository, resource_kind, resource_id, revision, ordinal, relation_a, relation_b, relation_c, json) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const descriptor of RESOURCE_DESCRIPTORS) {
    const map = state[descriptor.stateKey] as unknown as Map<string, unknown>;
    for (const [resourceId, rawValue] of [...map.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const value = asRecord(rawValue, {
        repository: descriptor.repository,
        resource_kind: descriptor.resourceKind,
        resource_id: resourceId,
      });
      const relations = descriptor.relations?.(value) ?? [undefined, undefined, undefined];
      insertResource.run(
        descriptor.repository,
        descriptor.resourceKind,
        resourceId,
        descriptor.revision?.(value) ?? null,
        descriptor.ordinal?.(value) ?? null,
        relations[0] ?? null,
        relations[1] ?? null,
        relations[2] ?? null,
        deterministicJson(value),
      );
    }
  }

  const insertEvent = db.prepare(
    "INSERT INTO vistrea_operation_events " +
      "(operation_id, sequence, event_id, state, json) VALUES (?, ?, ?, ?, ?)",
  );
  const insertResult = db.prepare(
    "INSERT INTO vistrea_operation_results " +
      "(operation_id, result_type, storage, json) VALUES (?, ?, ?, ?)",
  );
  for (const [operationId, record] of [...state.operations.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const base = {
      protocol_version: record.protocol_version,
      operation: record.operation,
      revision: record.revision,
      extensions: record.extensions,
    };
    insertResource.run(
      "operations",
      "operation",
      operationId,
      record.revision,
      null,
      record.operation.kind,
      record.operation.state,
      null,
      deterministicJson(base),
    );
    for (const event of record.events) {
      insertEvent.run(
        operationId,
        event.sequence,
        event.event_id,
        event.state,
        deterministicJson(event),
      );
    }
    if (record.result !== undefined) {
      insertResult.run(
        operationId,
        record.result.result_type,
        record.result.storage,
        deterministicJson(record.result),
      );
    }
  }

  const insertSnapshotObject = db.prepare(
    "INSERT INTO vistrea_snapshot_objects (snapshot_id, ordinal, object_hash) VALUES (?, ?, ?)",
  );
  for (const [snapshotId, objects] of [...state.snapshotObjects.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    objects.forEach((object, ordinal) => insertSnapshotObject.run(snapshotId, ordinal, object.hash));
  }

  const insertPin = db.prepare(
    "INSERT INTO vistrea_snapshot_pins (snapshot_id, reason) VALUES (?, ?)",
  );
  for (const [snapshotId, reasons] of [...state.snapshotPins.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const reason of [...reasons].sort()) {
      insertPin.run(snapshotId, reason);
    }
  }

  const insertGap = db.prepare(
    "INSERT INTO vistrea_runtime_event_gaps " +
      "(event_epoch_id, first_sequence, last_sequence) VALUES (?, ?, ?)",
  );
  for (const [eventEpochId, gaps] of [...state.reportedEventGaps.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    for (const gap of [...gaps].sort(
      (left, right) =>
        left.first_sequence - right.first_sequence || left.last_sequence - right.last_sequence,
    )) {
      insertGap.run(eventEpochId, gap.first_sequence, gap.last_sequence);
    }
  }

  const insertGraphVersion = db.prepare(
    "INSERT INTO vistrea_screen_graph_versions (selector, screen_graph_id) VALUES (?, ?)",
  );
  for (const [selector, graphId] of [...state.screenGraphsByVersion.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    insertGraphVersion.run(selector, graphId);
  }
}

function collectEmbeddedObjectHashes(value: unknown): ReadonlySet<string> {
  const hashes = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (candidate instanceof Map) {
      for (const item of candidate.values()) {
        visit(item);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    const object = candidate as Record<string, unknown>;
    if (
      typeof object["hash"] === "string" &&
      typeof object["media_type"] === "string" &&
      typeof object["byte_size"] === "number" &&
      typeof object["compression"] === "string" &&
      object["extensions"] !== null &&
      typeof object["extensions"] === "object"
    ) {
      hashes.add(object["hash"]);
    }
    for (const child of Object.values(object)) {
      visit(child);
    }
  };
  visit(value);
  return hashes;
}
