import { DataError } from "../api/errors.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type BuildDiff,
  type Clock,
  type Commit,
  type CommitAndRefResult,
  type CommitManifest,
  type CommitQuery,
  type CommitWorkingSetCommand,
  type DesignComparison,
  type DesignReference,
  type DesignRegionMapping,
  type DesignRegionMappingQuery,
  type EventTimeline,
  type EventTimelineQuery,
  type GraphContext,
  type GraphDiff,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type KnowledgeCollection,
  type KnowledgeCollectionQuery,
  type MutationPrecondition,
  type ObjectRef,
  type Observation,
  type ObservationQuery,
  type OperationEvent,
  type OperationRecord,
  type OperationRef,
  type OperationResult,
  type Page,
  type PageRequest,
  type PathQuery,
  type PathResult,
  type ProtocolSchemaId,
  type ProtocolValidator,
  type Ref,
  type RefUpdatePrecondition,
  type ResourceRef,
  type ReviewIssue,
  type ReviewIssueQuery,
  type ReviewVerificationRecord,
  type RevisionPrecondition,
  type RuntimeEvent,
  type RuntimeEventBatch,
  type RuntimeEventQuery,
  type RuntimeSnapshot,
  type ScreenGraph,
  type ScreenState,
  type SnapshotQuery,
  type SnapshotSummary,
  type StateIdentityDecision,
  type Tag,
  type TuningApplication,
  type TuningPatch,
  type ValidationFinding,
  type ValidationFindingCounts,
  type ValidationFindingQuery,
  type ValidationRun,
  type ValidationSuppression,
  type VersionSelector,
  type WikiLink,
  type WikiNode,
  type WikiNodeQuery,
  type WorkingChange,
  type WorkingSet,
} from "../api/models.js";
import type {
  DataUnitOfWork,
  DesignReviewRepository,
  ObservationRepository,
  OperationRepository,
  RuntimeEventRepository,
  ScreenGraphRepository,
  SnapshotRepository,
  UnitOfWorkBound,
  UnitOfWorkMode,
  ValidationRepository,
  VersionRepository,
  WikiRepository,
} from "../api/ports.js";
import type { DataState } from "./state.js";
import {
  assertCreateRevision,
  assertRevisionUpdate,
  canonicalizeIdentityJson,
  cloneFrozen,
  cloneValue,
  commitIdForManifest,
  paginate,
} from "./support.js";

interface UnitContext {
  readonly id: string;
  readonly mode: UnitOfWorkMode;
  readonly state: DataState;
  readonly snapshotVersion: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  assertActive(): void;
  assertWrite(): void;
  validate<T>(schemaId: ProtocolSchemaId | string, value: T): T;
  assertVerifiedObject(hash: string): void;
}

export interface StateUnitStore {
  _isVerifiedObject(hash: string): boolean;
  _verifiedObject(hash: string): ObjectRef | undefined;
  _commit(unit: StateDataUnitOfWork): void;
  _rollback(unit: StateDataUnitOfWork): void;
}

export class StateDataUnitOfWork implements DataUnitOfWork, UnitContext {
  readonly snapshots: SnapshotRepository;
  readonly observations: ObservationRepository;
  readonly runtimeEvents: RuntimeEventRepository;
  readonly screenGraph: ScreenGraphRepository;
  readonly wiki: WikiRepository;
  readonly designReviews: DesignReviewRepository;
  readonly validation: ValidationRepository;
  readonly operations: OperationRepository;
  readonly versions: VersionRepository;
  readonly snapshotVersion: string;
  #active = true;

  constructor(
    readonly store: StateUnitStore,
    readonly id: string,
    readonly mode: UnitOfWorkMode,
    readonly baseGeneration: number,
    snapshotVersionPrefix: string,
    readonly state: DataState,
    readonly validator: ProtocolValidator,
    readonly clock: Clock,
    readonly ids: IdGenerator,
  ) {
    this.snapshotVersion = `${snapshotVersionPrefix}:${baseGeneration}`;
    this.snapshots = new StateSnapshotRepository(this);
    this.observations = new StateObservationRepository(this);
    this.runtimeEvents = new StateRuntimeEventRepository(this);
    this.screenGraph = new StateScreenGraphRepository(this);
    this.wiki = new StateWikiRepository(this);
    this.designReviews = new StateDesignReviewRepository(this);
    this.validation = new StateValidationRepository(this);
    this.operations = new StateOperationRepository(this);
    this.versions = new StateVersionRepository(this);
  }

  assertActive(): void {
    if (!this.#active) {
      throw new DataError("conflict", "The Unit of Work is already closed.", {
        details: { unit_of_work_id: this.id },
      });
    }
  }

  assertWrite(): void {
    this.assertActive();
    if (this.mode !== "write") {
      throw new DataError("conflict", "A read-only Unit of Work cannot mutate data.", {
        details: { unit_of_work_id: this.id },
      });
    }
  }

  assertOwns(...repositories: readonly UnitOfWorkBound[]): void {
    this.assertActive();
    for (const repository of repositories) {
      if (repository.unitOfWorkId !== this.id) {
        throw new DataError("conflict", "Repositories belong to different Units of Work.", {
          details: {
            expected_unit_of_work_id: this.id,
            actual_unit_of_work_id: repository.unitOfWorkId,
          },
        });
      }
    }
  }

  validate<T>(schemaId: ProtocolSchemaId | string, value: T): T {
    this.validator.assert(schemaId, value);
    for (const hash of collectEmbeddedObjectHashes(value)) {
      this.assertVerifiedObject(hash);
    }
    return cloneValue(value);
  }

  assertVerifiedObject(hash: string): void {
    if (!this.store._isVerifiedObject(hash)) {
      throw new DataError("integrity_error", "A referenced object is not verified in the Object Store.", {
        details: { hash },
      });
    }
  }

  commit(): void {
    this.assertActive();
    try {
      this.store._commit(this);
    } finally {
      this.#active = false;
    }
  }

  rollback(): void {
    this.assertActive();
    this.store._rollback(this);
    this.#active = false;
  }
}

abstract class BoundStateRepository {
  constructor(protected readonly unit: UnitContext) {}

  get unitOfWorkId(): string {
    return this.unit.id;
  }

  protected read(): void {
    this.unit.assertActive();
  }

  protected write(): void {
    this.unit.assertWrite();
  }

  protected missing(kind: string, id: string): never {
    throw new DataError("not_found", `${kind} was not found.`, {
      details: { resource_kind: kind, resource_id: id },
    });
  }

  protected duplicate(kind: string, id: string): never {
    throw new DataError("already_exists", `${kind} already exists.`, {
      details: { resource_kind: kind, resource_id: id },
    });
  }
}

class StateSnapshotRepository extends BoundStateRepository implements SnapshotRepository {
  put(snapshot: RuntimeSnapshot, objects: readonly ObjectRef[] = []): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshot);
    if (this.unit.state.snapshots.has(value.snapshot_id)) {
      this.duplicate("runtime_snapshot", value.snapshot_id);
    }
    const storedObjects = objects.map((object) => {
      const validated = this.unit.validate(PROTOCOL_SCHEMA_IDS.objectRef, object);
      this.unit.assertVerifiedObject(validated.hash);
      return validated;
    });
    const associatedHashes = new Set(storedObjects.map((object) => object.hash));
    for (const hash of collectEmbeddedObjectHashes(value)) {
      if (!associatedHashes.has(hash)) {
        throw new DataError(
          "integrity_error",
          "Every ObjectRef embedded in a Snapshot must be explicitly associated by put().",
          { details: { snapshot_id: value.snapshot_id, hash } },
        );
      }
    }
    this.unit.state.snapshots.set(value.snapshot_id, value);
    this.unit.state.snapshotObjects.set(value.snapshot_id, storedObjects);
  }

  get(snapshotId: string): RuntimeSnapshot {
    this.read();
    const value = this.unit.state.snapshots.get(snapshotId);
    return value === undefined ? this.missing("runtime_snapshot", snapshotId) : cloneFrozen(value);
  }

  list(query: SnapshotQuery = {}, page?: PageRequest): Page<SnapshotSummary> {
    this.read();
    const ids = query.snapshot_ids === undefined ? undefined : new Set(query.snapshot_ids);
    const values = [...this.unit.state.snapshots.values()]
      .filter((snapshot) => ids === undefined || ids.has(snapshot.snapshot_id))
      .filter(
        (snapshot) =>
          query.captured_at_or_after === undefined ||
          compareCanonicalTimestamps(
            snapshot.captured_at.wall_time,
            query.captured_at_or_after,
          ) >= 0,
      )
      .filter(
        (snapshot) =>
          query.captured_before === undefined ||
          compareCanonicalTimestamps(snapshot.captured_at.wall_time, query.captured_before) < 0,
      )
      .filter((snapshot) => matchesJsonFields(snapshot.runtime_context, query.runtime_context))
      .sort((left, right) => left.snapshot_id.localeCompare(right.snapshot_id))
      .map((snapshot) => ({
        snapshot_id: snapshot.snapshot_id,
        captured_at: snapshot.captured_at,
        runtime_context: cloneFrozen(snapshot.runtime_context),
      }));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  pin(snapshotId: string, reason: string): void {
    this.write();
    if (reason.trim().length === 0) {
      throw new DataError("invalid_argument", "A Snapshot pin requires a non-empty reason.");
    }
    if (!this.unit.state.snapshots.has(snapshotId)) {
      this.missing("runtime_snapshot", snapshotId);
    }
    const reasons = this.unit.state.snapshotPins.get(snapshotId) ?? [];
    if (!reasons.includes(reason)) {
      this.unit.state.snapshotPins.set(snapshotId, [...reasons, reason]);
    }
  }
}

class StateObservationRepository extends BoundStateRepository implements ObservationRepository {
  append(observation: Observation): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.observation, observation);
    if (this.unit.state.observations.has(value.observation_id)) {
      this.duplicate("observation", value.observation_id);
    }
    this.unit.state.observations.set(value.observation_id, value);
  }

  get(observationId: string): Observation {
    this.read();
    const value = this.unit.state.observations.get(observationId);
    return value === undefined ? this.missing("observation", observationId) : cloneFrozen(value);
  }

  list(query: ObservationQuery = {}, page?: PageRequest): Page<Observation> {
    this.read();
    const ids = query.observation_ids === undefined ? undefined : new Set(query.observation_ids);
    const kinds = query.kinds === undefined ? undefined : new Set(query.kinds);
    const values = [...this.unit.state.observations.values()]
      .filter((value) => ids === undefined || ids.has(value.observation_id))
      .filter((value) => kinds === undefined || kinds.has(String(value.kind)))
      .filter(
        (value) =>
          query.screen_state_id === undefined || value.screen_state_id === query.screen_state_id,
      )
      .filter(
        (value) => query.transition_id === undefined || value.transition_id === query.transition_id,
      )
      .sort((left, right) => left.observation_id.localeCompare(right.observation_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }
}

class StateRuntimeEventRepository extends BoundStateRepository implements RuntimeEventRepository {
  appendBatch(batch: RuntimeEventBatch): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.runtimeEventBatch, batch);
    const existingSequences = new Set(
      [...this.unit.state.runtimeEvents.values()]
        .filter((event) => event.event_epoch_id === value.event_epoch_id)
        .map((event) => event.sequence),
    );
    const batchIds = new Set<string>();
    for (const event of value.events) {
      if (batchIds.has(event.event_id) || this.unit.state.runtimeEvents.has(event.event_id)) {
        this.duplicate("runtime_event", event.event_id);
      }
      if (existingSequences.has(event.sequence)) {
        throw new DataError("conflict", "A Runtime Event sequence already exists in this epoch.", {
          details: { event_epoch_id: value.event_epoch_id, sequence: event.sequence },
        });
      }
      batchIds.add(event.event_id);
    }
    for (const event of value.events) {
      this.unit.state.runtimeEvents.set(event.event_id, cloneValue(event));
    }
    if (value.dropped_event_count > 0) {
      const gaps = this.unit.state.reportedEventGaps.get(value.event_epoch_id) ?? [];
      this.unit.state.reportedEventGaps.set(value.event_epoch_id, [
        ...gaps,
        { first_sequence: value.first_sequence, last_sequence: value.last_sequence },
      ]);
    }
  }

  list(query: RuntimeEventQuery = {}, page?: PageRequest): Page<RuntimeEvent> {
    this.read();
    const kinds = query.kinds === undefined ? undefined : new Set(query.kinds);
    const values = [...this.unit.state.runtimeEvents.values()]
      .filter(
        (event) => query.event_epoch_id === undefined || event.event_epoch_id === query.event_epoch_id,
      )
      .filter(
        (event) => query.first_sequence === undefined || event.sequence >= query.first_sequence,
      )
      .filter((event) => query.last_sequence === undefined || event.sequence <= query.last_sequence)
      .filter((event) => kinds === undefined || kinds.has(String(event.kind)))
      .sort(
        (left, right) =>
          left.event_epoch_id.localeCompare(right.event_epoch_id) || left.sequence - right.sequence,
      );
    return paginate(values, page, this.unit.snapshotVersion);
  }

  getTimeline(query: EventTimelineQuery = {}): EventTimeline {
    this.read();
    const events = this.list(query, { limit: 500 }).items;
    const epoch = query.event_epoch_id;
    return {
      ...(epoch === undefined ? {} : { event_epoch_id: epoch }),
      events,
      reported_gaps:
        epoch === undefined ? [] : cloneFrozen(this.unit.state.reportedEventGaps.get(epoch) ?? []),
    };
  }
}

class StateScreenGraphRepository extends BoundStateRepository implements ScreenGraphRepository {
  createGraph(graph: ScreenGraph): ScreenGraph {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.screenGraph, graph);
    assertCreateRevision(value.revision, value.screen_graph_id);
    if (this.unit.state.screenGraphs.has(value.screen_graph_id)) {
      this.duplicate("screen_graph", value.screen_graph_id);
    }
    this.unit.state.screenGraphs.set(value.screen_graph_id, value);
    return cloneFrozen(value);
  }

  updateGraph(graph: ScreenGraph, precondition: RevisionPrecondition): ScreenGraph {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.screenGraph, graph);
    const current = this.unit.state.screenGraphs.get(value.screen_graph_id);
    if (current === undefined) {
      return this.missing("screen_graph", value.screen_graph_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.screen_graph_id);
    this.unit.state.screenGraphs.set(value.screen_graph_id, value);
    return cloneFrozen(value);
  }

  getGraph(screenGraphId: string): ScreenGraph {
    this.read();
    const value = this.unit.state.screenGraphs.get(screenGraphId);
    return value === undefined
      ? this.missing("screen_graph", screenGraphId)
      : cloneFrozen(value);
  }

  tagGraphVersion(selector: VersionSelector, screenGraphId: string): void {
    this.write();
    this.unit.validate(PROTOCOL_SCHEMA_IDS.versionSelector, selector);
    if (!this.unit.state.screenGraphs.has(screenGraphId)) {
      this.missing("screen_graph", screenGraphId);
    }
    this.unit.state.screenGraphsByVersion.set(versionSelectorKey(selector), screenGraphId);
  }

  materialize(query: GraphContext): ScreenGraph {
    this.read();
    this.unit.validate(PROTOCOL_SCHEMA_IDS.graphContext, query);
    const queryKey = canonicalizeIdentityJson(query);
    const graph = [...this.unit.state.screenGraphs.values()].find(
      (candidate) => canonicalizeIdentityJson(candidate.context) === queryKey,
    );
    return graph === undefined
      ? this.missing("screen_graph_for_context", queryKey)
      : cloneFrozen(graph);
  }

  getState(screenStateId: string): ScreenState {
    this.read();
    for (const graph of this.unit.state.screenGraphs.values()) {
      const state = graph.states.find((candidate) => candidate.screen_state_id === screenStateId);
      if (state !== undefined) {
        return cloneFrozen(state);
      }
    }
    return this.missing("screen_state", screenStateId);
  }

  findPath(query: PathQuery): readonly PathResult[] {
    this.read();
    const graph = query.graph_id === undefined
      ? this.unit.state.screenGraphs.values().next().value as ScreenGraph | undefined
      : this.unit.state.screenGraphs.get(query.graph_id);
    if (graph === undefined) {
      return this.missing("screen_graph", query.graph_id ?? "default");
    }
    const maximumDepth = query.maximum_depth ?? 64;
    if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 0 || maximumDepth > 10_000) {
      throw new DataError("invalid_argument", "maximum_depth is outside the supported range.");
    }
    const maximumPaths = query.maximum_paths ?? 16;
    if (!Number.isSafeInteger(maximumPaths) || maximumPaths < 1 || maximumPaths > 100) {
      throw new DataError("invalid_argument", "maximum_paths is outside the supported range.");
    }
    // Simple-path enumeration is exponential in well-connected graphs, so the
    // search returns the first (shortest, BFS order) paths and fails closed
    // when the expansion budget runs out before any path is found.
    let expansionBudget = 50_000;
    const queue: PathResult[] = [{ state_ids: [query.source_state_id], transition_ids: [] }];
    const results: PathResult[] = [];
    while (queue.length > 0 && results.length < maximumPaths) {
      if (expansionBudget === 0) {
        if (results.length > 0) {
          break;
        }
        throw new DataError(
          "resource_exhausted",
          "The path search exceeded its expansion budget; lower maximum_depth.",
        );
      }
      expansionBudget -= 1;
      const path = queue.shift() as PathResult;
      const current = path.state_ids[path.state_ids.length - 1];
      if (current === query.target_state_id) {
        results.push(path);
        continue;
      }
      if (path.transition_ids.length >= maximumDepth) {
        continue;
      }
      for (const transition of graph.transitions.filter((item) => item.source_state_id === current)) {
        if (path.state_ids.includes(transition.target_state_id) || expansionBudget === 0) {
          continue;
        }
        expansionBudget -= 1;
        queue.push({
          state_ids: [...path.state_ids, transition.target_state_id],
          transition_ids: [...path.transition_ids, transition.transition_id],
        });
      }
    }
    return cloneFrozen(results);
  }

  compare(left: VersionSelector, right: VersionSelector): GraphDiff {
    this.read();
    const leftGraph = this.#graphAt(left);
    const rightGraph = this.#graphAt(right);
    return cloneFrozen({
      added_state_ids: difference(ids(rightGraph.states, "screen_state_id"), ids(leftGraph.states, "screen_state_id")),
      removed_state_ids: difference(ids(leftGraph.states, "screen_state_id"), ids(rightGraph.states, "screen_state_id")),
      added_transition_ids: difference(ids(rightGraph.transitions, "transition_id"), ids(leftGraph.transitions, "transition_id")),
      removed_transition_ids: difference(ids(leftGraph.transitions, "transition_id"), ids(rightGraph.transitions, "transition_id")),
    });
  }

  storeIdentityDecision(decision: StateIdentityDecision): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.stateIdentityDecision, decision);
    assertCreateRevision(value.revision, value.state_identity_decision_id);
    if (this.unit.state.identityDecisions.has(value.state_identity_decision_id)) {
      this.duplicate("state_identity_decision", value.state_identity_decision_id);
    }
    this.unit.state.identityDecisions.set(value.state_identity_decision_id, value);
  }

  #graphAt(selector: VersionSelector): ScreenGraph {
    const key = versionSelectorKey(selector);
    const graphId = this.unit.state.screenGraphsByVersion.get(key);
    if (graphId !== undefined) {
      const graph = this.unit.state.screenGraphs.get(graphId);
      if (graph !== undefined) {
        return graph;
      }
    }
    if (this.unit.state.screenGraphs.size === 1) {
      return this.unit.state.screenGraphs.values().next().value as ScreenGraph;
    }
    return this.missing("screen_graph_version", key);
  }
}

class StateWikiRepository extends BoundStateRepository implements WikiRepository {
  create(node: WikiNode, precondition?: MutationPrecondition): WikiNode {
    this.write();
    this.#assertCreatePrecondition(precondition);
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.wikiNode, node);
    assertCreateRevision(value.revision, value.wiki_node_id);
    if (this.unit.state.wikiNodes.has(value.wiki_node_id)) {
      this.duplicate("wiki_node", value.wiki_node_id);
    }
    this.unit.state.wikiNodes.set(value.wiki_node_id, value);
    return cloneFrozen(value);
  }

  update(node: WikiNode, precondition: RevisionPrecondition): WikiNode {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.wikiNode, node);
    const current = this.unit.state.wikiNodes.get(value.wiki_node_id);
    if (current === undefined) {
      return this.missing("wiki_node", value.wiki_node_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.wiki_node_id);
    this.unit.state.wikiNodes.set(value.wiki_node_id, value);
    return cloneFrozen(value);
  }

  get(nodeId: string): WikiNode {
    this.read();
    const value = this.unit.state.wikiNodes.get(nodeId);
    return value === undefined ? this.missing("wiki_node", nodeId) : cloneFrozen(value);
  }

  link(link: WikiLink, precondition?: MutationPrecondition): WikiLink {
    this.write();
    this.#assertCreatePrecondition(precondition);
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.wikiLink, link);
    assertCreateRevision(value.revision, value.wiki_link_id);
    if (this.unit.state.wikiLinks.has(value.wiki_link_id) || this.unit.state.deletedWikiLinks.has(value.wiki_link_id)) {
      this.duplicate("wiki_link", value.wiki_link_id);
    }
    if (!this.unit.state.wikiNodes.has(value.source_node_id)) {
      this.missing("wiki_node", value.source_node_id);
    }
    if (value.target.kind === "wiki_node" && !this.unit.state.wikiNodes.has(value.target.id)) {
      this.missing("wiki_node", value.target.id);
    }
    this.unit.state.wikiLinks.set(value.wiki_link_id, value);
    return cloneFrozen(value);
  }

  unlink(linkId: string, precondition: RevisionPrecondition): void {
    this.write();
    const current = this.unit.state.wikiLinks.get(linkId);
    if (current === undefined) {
      this.missing("wiki_link", linkId);
    }
    assertRevisionUpdate(current.revision, current.revision + 1, precondition, linkId);
    this.unit.state.wikiLinks.delete(linkId);
    this.unit.state.deletedWikiLinks.set(linkId, {
      link: cloneValue(current),
      deleted_revision: current.revision + 1,
    });
  }

  listNodes(query?: WikiNodeQuery, page?: PageRequest): Page<WikiNode> {
    this.read();
    const text = query?.text?.toLowerCase();
    const kinds = query?.kinds === undefined ? undefined : new Set(query.kinds);
    const labels = query?.labels === undefined ? undefined : new Set(query.labels);
    const statuses = query?.statuses === undefined ? undefined : new Set(query.statuses);
    const values = [...this.unit.state.wikiNodes.values()]
      .filter((node) => {
        if (kinds !== undefined && !kinds.has(node["kind"] as string)) {
          return false;
        }
        if (statuses !== undefined && !statuses.has(node["status"] as string)) {
          return false;
        }
        const nodeLabels = (node["labels"] ?? []) as readonly string[];
        if (labels !== undefined && !nodeLabels.some((label) => labels.has(label))) {
          return false;
        }
        if (text !== undefined) {
          const content = node["content"] as { readonly text?: string } | undefined;
          const haystack = [
            node["title"] as string,
            (node["slug"] as string | undefined) ?? "",
            (node["summary"] as string | undefined) ?? "",
            content?.text ?? "",
            ...nodeLabels,
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(text)) {
            return false;
          }
        }
        return true;
      })
      .sort((left, right) => left.wiki_node_id.localeCompare(right.wiki_node_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  backlinks(nodeId: string, page?: PageRequest): Page<WikiLink> {
    this.read();
    const values = [...this.unit.state.wikiLinks.values()]
      .filter((link) => link.target.kind === "wiki_node" && link.target.id === nodeId)
      .sort((left, right) => left.wiki_link_id.localeCompare(right.wiki_link_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  related(ref: ResourceRef, page?: PageRequest): Page<WikiNode> {
    this.read();
    const values = [...this.unit.state.wikiNodes.values()]
      .filter((node) => node.related_resources.some((candidate) => sameResourceRef(candidate, ref)))
      .sort((left, right) => left.wiki_node_id.localeCompare(right.wiki_node_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  createCollection(collection: KnowledgeCollection): KnowledgeCollection {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.knowledgeCollection, collection);
    assertCreateRevision(value.revision, value.collection_id);
    if (this.unit.state.knowledgeCollections.has(value.collection_id)) {
      this.duplicate("knowledge_collection", value.collection_id);
    }
    this.unit.state.knowledgeCollections.set(value.collection_id, value);
    return cloneFrozen(value);
  }

  updateCollection(
    collection: KnowledgeCollection,
    precondition: RevisionPrecondition,
  ): KnowledgeCollection {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.knowledgeCollection, collection);
    const current = this.unit.state.knowledgeCollections.get(value.collection_id);
    if (current === undefined) {
      return this.missing("knowledge_collection", value.collection_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.collection_id);
    this.unit.state.knowledgeCollections.set(value.collection_id, value);
    return cloneFrozen(value);
  }

  getCollection(id: string): KnowledgeCollection {
    this.read();
    const value = this.unit.state.knowledgeCollections.get(id);
    return value === undefined ? this.missing("knowledge_collection", id) : cloneFrozen(value);
  }

  listCollections(
    query: KnowledgeCollectionQuery = {},
    page?: PageRequest,
  ): Page<KnowledgeCollection> {
    this.read();
    const publicationStates =
      query.publication_states === undefined ? undefined : new Set(query.publication_states);
    const needle = query.text?.toLocaleLowerCase("en-US");
    const values = [...this.unit.state.knowledgeCollections.values()]
      .filter(
        (collection) =>
          needle === undefined ||
          String(collection.name).toLocaleLowerCase("en-US").includes(needle) ||
          String(collection.summary ?? "").toLocaleLowerCase("en-US").includes(needle),
      )
      .filter(
        (collection) =>
          publicationStates === undefined ||
          publicationStates.has(String((collection.publication as JsonObject)["state"])),
      )
      .sort((left, right) => left.collection_id.localeCompare(right.collection_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  #assertCreatePrecondition(precondition: MutationPrecondition | undefined): void {
    if (precondition === undefined) {
      return;
    }
    this.unit.validate(PROTOCOL_SCHEMA_IDS.mutationPrecondition, precondition);
    if (precondition.expected_revision !== undefined) {
      throw new DataError(
        "conflict",
        "A create precondition cannot match a revision because the resource does not exist.",
        { details: { expected_revision: precondition.expected_revision } },
      );
    }
    if (
      precondition.expected_commit_id !== undefined &&
      !this.unit.state.commits.has(precondition.expected_commit_id)
    ) {
      throw new DataError("conflict", "The create version-context precondition is stale.", {
        details: { expected_commit_id: precondition.expected_commit_id },
      });
    }
  }
}

class StateDesignReviewRepository
  extends BoundStateRepository
  implements DesignReviewRepository
{
  createReference(reference: DesignReference): DesignReference {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.designReference, reference);
    assertCreateRevision(value.revision, value.design_reference_id);
    if (this.unit.state.designReferences.has(value.design_reference_id)) {
      this.duplicate("design_reference", value.design_reference_id);
    }
    this.unit.state.designReferences.set(value.design_reference_id, value);
    return cloneFrozen(value);
  }

  updateReference(
    reference: DesignReference,
    precondition: RevisionPrecondition,
  ): DesignReference {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.designReference, reference);
    const current = this.unit.state.designReferences.get(value.design_reference_id);
    if (current === undefined) {
      return this.missing("design_reference", value.design_reference_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.design_reference_id);
    this.unit.state.designReferences.set(value.design_reference_id, value);
    return cloneFrozen(value);
  }

  getReference(id: string): DesignReference {
    this.read();
    const value = this.unit.state.designReferences.get(id);
    return value === undefined ? this.missing("design_reference", id) : cloneFrozen(value);
  }

  createRegionMapping(mapping: DesignRegionMapping): DesignRegionMapping {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.designRegionMapping, mapping);
    assertCreateRevision(value.revision, value.mapping_id);
    if (this.unit.state.designRegionMappings.has(value.mapping_id)) {
      this.duplicate("design_region_mapping", value.mapping_id);
    }
    if (!this.unit.state.designReferences.has(value.design_reference_id)) {
      this.missing("design_reference", value.design_reference_id);
    }
    this.unit.state.designRegionMappings.set(value.mapping_id, value);
    return cloneFrozen(value);
  }

  updateRegionMapping(
    mapping: DesignRegionMapping,
    precondition: RevisionPrecondition,
  ): DesignRegionMapping {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.designRegionMapping, mapping);
    const current = this.unit.state.designRegionMappings.get(value.mapping_id);
    if (current === undefined) {
      return this.missing("design_region_mapping", value.mapping_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.mapping_id);
    this.unit.state.designRegionMappings.set(value.mapping_id, value);
    return cloneFrozen(value);
  }

  listRegionMappings(
    query: DesignRegionMappingQuery = {},
    page?: PageRequest,
  ): Page<DesignRegionMapping> {
    this.read();
    const states = query.states === undefined ? undefined : new Set(query.states);
    const values = [...this.unit.state.designRegionMappings.values()]
      .filter(
        (mapping) =>
          query.design_reference_id === undefined ||
          mapping.design_reference_id === query.design_reference_id,
      )
      .filter(
        (mapping) =>
          query.snapshot_id === undefined ||
          (mapping.runtime_target as JsonObject)["snapshot_id"] === query.snapshot_id,
      )
      .filter((mapping) => states === undefined || states.has(String(mapping.state)))
      .sort((left, right) => left.mapping_id.localeCompare(right.mapping_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  appendComparison(comparison: DesignComparison): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.designComparison, comparison);
    assertCreateRevision(value.revision, value.comparison_id);
    if (this.unit.state.designComparisons.has(value.comparison_id)) {
      this.duplicate("design_comparison", value.comparison_id);
    }
    this.unit.state.designComparisons.set(value.comparison_id, value);
  }

  getComparison(id: string): DesignComparison {
    this.read();
    const value = this.unit.state.designComparisons.get(id);
    return value === undefined ? this.missing("design_comparison", id) : cloneFrozen(value);
  }

  createIssue(issue: ReviewIssue): ReviewIssue {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.reviewIssue, issue);
    assertCreateRevision(value.revision, value.issue_id);
    if (this.unit.state.reviewIssues.has(value.issue_id)) {
      this.duplicate("review_issue", value.issue_id);
    }
    this.unit.state.reviewIssues.set(value.issue_id, value);
    return cloneFrozen(value);
  }

  updateIssue(issue: ReviewIssue, precondition: RevisionPrecondition): ReviewIssue {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.reviewIssue, issue);
    const current = this.unit.state.reviewIssues.get(value.issue_id);
    if (current === undefined) {
      return this.missing("review_issue", value.issue_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.issue_id);
    this.unit.state.reviewIssues.set(value.issue_id, value);
    return cloneFrozen(value);
  }

  listIssues(query: ReviewIssueQuery = {}, page?: PageRequest): Page<ReviewIssue> {
    this.read();
    const states = query.states === undefined ? undefined : new Set(query.states);
    const severities = query.severities === undefined ? undefined : new Set(query.severities);
    const values = [...this.unit.state.reviewIssues.values()]
      .filter(
        (issue) =>
          query.design_reference_id === undefined ||
          issue.design_reference_id === query.design_reference_id,
      )
      .filter((issue) => states === undefined || states.has(String(issue.state)))
      .filter((issue) => severities === undefined || severities.has(String(issue.severity)))
      .sort((left, right) => left.issue_id.localeCompare(right.issue_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  appendVerification(record: ReviewVerificationRecord): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.reviewVerificationRecord, record);
    assertCreateRevision(value.revision, value.verification_record_id);
    if (this.unit.state.reviewVerificationRecords.has(value.verification_record_id)) {
      this.duplicate("review_verification_record", value.verification_record_id);
    }
    if (!this.unit.state.reviewIssues.has(value.issue_id)) {
      this.missing("review_issue", value.issue_id);
    }
    this.unit.state.reviewVerificationRecords.set(value.verification_record_id, value);
  }

  createPatch(patch: TuningPatch): TuningPatch {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.tuningPatch, patch);
    assertCreateRevision(value.revision, value.patch_id);
    if (this.unit.state.tuningPatches.has(value.patch_id)) {
      this.duplicate("tuning_patch", value.patch_id);
    }
    this.unit.state.tuningPatches.set(value.patch_id, value);
    return cloneFrozen(value);
  }

  updatePatch(patch: TuningPatch, precondition: RevisionPrecondition): TuningPatch {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.tuningPatch, patch);
    const current = this.unit.state.tuningPatches.get(value.patch_id);
    if (current === undefined) {
      return this.missing("tuning_patch", value.patch_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.patch_id);
    this.unit.state.tuningPatches.set(value.patch_id, value);
    return cloneFrozen(value);
  }

  getPatch(id: string): TuningPatch {
    this.read();
    const value = this.unit.state.tuningPatches.get(id);
    return value === undefined ? this.missing("tuning_patch", id) : cloneFrozen(value);
  }

  createApplication(application: TuningApplication): TuningApplication {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.tuningApplication, application);
    assertCreateRevision(value.revision, value.tuning_application_id);
    if (this.unit.state.tuningApplications.has(value.tuning_application_id)) {
      this.duplicate("tuning_application", value.tuning_application_id);
    }
    this.unit.state.tuningApplications.set(value.tuning_application_id, value);
    return cloneFrozen(value);
  }

  updateApplication(
    application: TuningApplication,
    precondition: RevisionPrecondition,
  ): TuningApplication {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.tuningApplication, application);
    const current = this.unit.state.tuningApplications.get(value.tuning_application_id);
    if (current === undefined) {
      return this.missing("tuning_application", value.tuning_application_id);
    }
    assertRevisionUpdate(
      current.revision,
      value.revision,
      precondition,
      value.tuning_application_id,
    );
    this.unit.state.tuningApplications.set(value.tuning_application_id, value);
    return cloneFrozen(value);
  }

  getApplication(id: string): TuningApplication {
    this.read();
    const value = this.unit.state.tuningApplications.get(id);
    return value === undefined ? this.missing("tuning_application", id) : cloneFrozen(value);
  }

  listActiveApplications(connectionId: string): readonly TuningApplication[] {
    this.read();
    return cloneFrozen(
      [...this.unit.state.tuningApplications.values()]
        .filter(
          (application) =>
            application.connection_id === connectionId &&
            ["applying", "active", "reverting"].includes(application.status),
        )
        .sort((left, right) =>
          left.tuning_application_id.localeCompare(right.tuning_application_id),
        ),
    );
  }
}

class StateValidationRepository extends BoundStateRepository implements ValidationRepository {
  createRun(run: ValidationRun): ValidationRun {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.validationRun, run);
    assertCreateRevision(value.revision, value.validation_run_id);
    if (this.unit.state.validationRuns.has(value.validation_run_id)) {
      this.duplicate("validation_run", value.validation_run_id);
    }
    this.#assertCounts(value, []);
    this.unit.state.validationRuns.set(value.validation_run_id, value);
    return cloneFrozen(value);
  }

  updateRun(run: ValidationRun, precondition: RevisionPrecondition): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.validationRun, run);
    const current = this.unit.state.validationRuns.get(value.validation_run_id);
    if (current === undefined) {
      this.missing("validation_run", value.validation_run_id);
    }
    assertRevisionUpdate(current.revision, value.revision, precondition, value.validation_run_id);
    this.#assertCounts(value, this.#findingsForRun(value.validation_run_id));
    this.unit.state.validationRuns.set(value.validation_run_id, value);
  }

  getRun(runId: string): ValidationRun {
    this.read();
    const value = this.unit.state.validationRuns.get(runId);
    return value === undefined ? this.missing("validation_run", runId) : cloneFrozen(value);
  }

  addFindings(
    run: ValidationRun,
    findings: readonly ValidationFinding[],
    runPrecondition: RevisionPrecondition,
  ): void {
    this.write();
    const nextRun = this.unit.validate(PROTOCOL_SCHEMA_IDS.validationRun, run);
    const currentRun = this.unit.state.validationRuns.get(nextRun.validation_run_id);
    if (currentRun === undefined) {
      this.missing("validation_run", nextRun.validation_run_id);
    }
    assertRevisionUpdate(
      currentRun.revision,
      nextRun.revision,
      runPrecondition,
      nextRun.validation_run_id,
    );

    const additions: ValidationFinding[] = [];
    const ids = new Set<string>();
    for (const finding of findings) {
      const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.validationFinding, finding);
      assertCreateRevision(value.revision, value.finding_id);
      if (value.validation_run_id !== nextRun.validation_run_id) {
        throw new DataError("invalid_argument", "A Finding belongs to a different Validation Run.", {
          details: { finding_id: value.finding_id, validation_run_id: value.validation_run_id },
        });
      }
      if (ids.has(value.finding_id) || this.unit.state.validationFindings.has(value.finding_id)) {
        this.duplicate("validation_finding", value.finding_id);
      }
      ids.add(value.finding_id);
      additions.push(value);
    }

    this.#assertCounts(nextRun, [...this.#findingsForRun(nextRun.validation_run_id), ...additions]);
    for (const finding of additions) {
      this.unit.state.validationFindings.set(finding.finding_id, finding);
    }
    this.unit.state.validationRuns.set(nextRun.validation_run_id, nextRun);
  }

  getFinding(findingId: string): ValidationFinding {
    this.read();
    const value = this.unit.state.validationFindings.get(findingId);
    return value === undefined ? this.missing("validation_finding", findingId) : cloneFrozen(value);
  }

  updateFinding(
    run: ValidationRun,
    finding: ValidationFinding,
    runPrecondition: RevisionPrecondition,
    findingPrecondition: RevisionPrecondition,
  ): void {
    this.#replaceFinding(run, finding, runPrecondition, findingPrecondition);
  }

  listFindings(
    query: ValidationFindingQuery = {},
    page?: PageRequest,
  ): Page<ValidationFinding> {
    this.read();
    const statuses = query.statuses === undefined ? undefined : new Set(query.statuses);
    const severities = query.severities === undefined ? undefined : new Set(query.severities);
    const values = [...this.unit.state.validationFindings.values()]
      .filter(
        (finding) =>
          query.validation_run_id === undefined ||
          finding.validation_run_id === query.validation_run_id,
      )
      .filter((finding) => statuses === undefined || statuses.has(finding.status))
      .filter((finding) => severities === undefined || severities.has(finding.severity))
      .sort((left, right) => left.finding_id.localeCompare(right.finding_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  suppressFinding(
    run: ValidationRun,
    finding: ValidationFinding,
    suppression: ValidationSuppression,
    runPrecondition: RevisionPrecondition,
    findingPrecondition: RevisionPrecondition,
  ): void {
    this.write();
    const nextSuppression = this.unit.validate(
      PROTOCOL_SCHEMA_IDS.validationSuppression,
      suppression,
    );
    if (this.unit.state.validationSuppressions.has(nextSuppression.suppression_id)) {
      this.duplicate("validation_suppression", nextSuppression.suppression_id);
    }
    if (
      nextSuppression.finding_id !== finding.finding_id ||
      finding.status !== "suppressed" ||
      finding.active_suppression_id !== nextSuppression.suppression_id
    ) {
      throw new DataError(
        "invalid_argument",
        "Suppression, Finding status, and active suppression ID must agree.",
      );
    }
    this.#replaceFinding(
      run,
      finding,
      runPrecondition,
      findingPrecondition,
      nextSuppression,
    );
    this.unit.state.validationSuppressions.set(
      nextSuppression.suppression_id,
      nextSuppression,
    );
  }

  appendBuildDiff(diff: BuildDiff): void {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.buildDiff, diff);
    if (this.unit.state.buildDiffs.has(value.build_diff_id)) {
      this.duplicate("build_diff", value.build_diff_id);
    }
    this.unit.state.buildDiffs.set(value.build_diff_id, value);
  }

  getBuildDiff(buildDiffId: string): BuildDiff {
    this.read();
    const value = this.unit.state.buildDiffs.get(buildDiffId);
    return value === undefined ? this.missing("build_diff", buildDiffId) : cloneFrozen(value);
  }

  #replaceFinding(
    run: ValidationRun,
    finding: ValidationFinding,
    runPrecondition: RevisionPrecondition,
    findingPrecondition: RevisionPrecondition,
    pendingSuppression?: ValidationSuppression,
  ): void {
    this.write();
    const nextRun = this.unit.validate(PROTOCOL_SCHEMA_IDS.validationRun, run);
    const nextFinding = this.unit.validate(PROTOCOL_SCHEMA_IDS.validationFinding, finding);
    const currentRun = this.unit.state.validationRuns.get(nextRun.validation_run_id);
    const currentFinding = this.unit.state.validationFindings.get(nextFinding.finding_id);
    if (currentRun === undefined) {
      this.missing("validation_run", nextRun.validation_run_id);
    }
    if (currentFinding === undefined) {
      this.missing("validation_finding", nextFinding.finding_id);
    }
    if (
      currentFinding.validation_run_id !== currentRun.validation_run_id ||
      nextFinding.validation_run_id !== currentRun.validation_run_id
    ) {
      throw new DataError("invalid_argument", "Finding and Run ownership cannot change.");
    }
    if (nextFinding.status === "suppressed") {
      const suppression =
        pendingSuppression ??
        (nextFinding.active_suppression_id === undefined
          ? undefined
          : this.unit.state.validationSuppressions.get(nextFinding.active_suppression_id));
      if (
        suppression === undefined ||
        suppression.suppression_id !== nextFinding.active_suppression_id ||
        suppression.finding_id !== nextFinding.finding_id
      ) {
        throw new DataError(
          "integrity_error",
          "A suppressed Finding requires its matching durable suppression record.",
          { details: { finding_id: nextFinding.finding_id } },
        );
      }
    }
    assertRevisionUpdate(
      currentRun.revision,
      nextRun.revision,
      runPrecondition,
      nextRun.validation_run_id,
    );
    assertRevisionUpdate(
      currentFinding.revision,
      nextFinding.revision,
      findingPrecondition,
      nextFinding.finding_id,
    );
    const findings = this.#findingsForRun(nextRun.validation_run_id).map((candidate) =>
      candidate.finding_id === nextFinding.finding_id ? nextFinding : candidate,
    );
    this.#assertCounts(nextRun, findings);
    this.unit.state.validationFindings.set(nextFinding.finding_id, nextFinding);
    this.unit.state.validationRuns.set(nextRun.validation_run_id, nextRun);
  }

  #findingsForRun(runId: string): ValidationFinding[] {
    return [...this.unit.state.validationFindings.values()].filter(
      (finding) => finding.validation_run_id === runId,
    );
  }

  #assertCounts(run: ValidationRun, findings: readonly ValidationFinding[]): void {
    const derived = deriveFindingCounts(findings);
    if (canonicalizeIdentityJson(run.finding_counts) !== canonicalizeIdentityJson(derived)) {
      throw new DataError("conflict", "Validation Run finding counts are not current.", {
        details: {
          validation_run_id: run.validation_run_id,
          submitted_counts: run.finding_counts,
          derived_counts: derived,
        },
      });
    }
  }
}

class StateOperationRepository extends BoundStateRepository implements OperationRepository {
  create(operation: OperationRef, createdEvent: OperationEvent): OperationRecord {
    this.write();
    const nextOperation = this.unit.validate(PROTOCOL_SCHEMA_IDS.operationRef, operation);
    const event = this.unit.validate(PROTOCOL_SCHEMA_IDS.operationEvent, createdEvent);
    if (this.unit.state.operations.has(nextOperation.operation_id)) {
      this.duplicate("operation", nextOperation.operation_id);
    }
    if (
      nextOperation.state !== "queued" ||
      event.kind !== "created" ||
      event.state !== "queued" ||
      event.sequence !== 1 ||
      event.operation_id !== nextOperation.operation_id
    ) {
      throw new DataError(
        "invalid_argument",
        "Operation creation requires the queued summary and its sequence-one created event.",
      );
    }
    const record = this.#validateRecord({
      protocol_version: { major: 1, minor: 0 },
      operation: nextOperation,
      revision: 1,
      events: [event],
      extensions: {},
    });
    this.unit.state.operations.set(nextOperation.operation_id, record);
    return cloneFrozen(record);
  }

  appendEvents(
    operation: OperationRef,
    events: readonly OperationEvent[],
    expectedNextSequence: number,
    precondition: RevisionPrecondition,
  ): OperationRecord {
    this.write();
    const nextOperation = this.unit.validate(PROTOCOL_SCHEMA_IDS.operationRef, operation);
    const current = this.unit.state.operations.get(nextOperation.operation_id);
    if (current === undefined) {
      return this.missing("operation", nextOperation.operation_id);
    }
    assertRevisionUpdate(
      current.revision,
      current.revision + 1,
      precondition,
      nextOperation.operation_id,
    );
    if (events.length === 0) {
      throw new DataError("invalid_argument", "appendEvents requires at least one event.");
    }
    if (nextOperation.state === "succeeded") {
      throw new DataError("invalid_argument", "Succeeded Operations must use complete().");
    }
    this.#assertOperationIdentity(current.operation, nextOperation);
    this.#assertExpectedSequence(current, expectedNextSequence);
    const appended = events.map((event) =>
      this.unit.validate(PROTOCOL_SCHEMA_IDS.operationEvent, event),
    );
    const record = this.#validateRecord({
      protocol_version: current.protocol_version,
      operation: nextOperation,
      revision: current.revision + 1,
      events: [...current.events, ...appended],
      extensions: current.extensions,
    });
    this.unit.state.operations.set(nextOperation.operation_id, record);
    return cloneFrozen(record);
  }

  complete(
    operation: OperationRef,
    result: OperationResult,
    terminalEvent: OperationEvent,
    expectedNextSequence: number,
    precondition: RevisionPrecondition,
  ): OperationRecord {
    this.write();
    const nextOperation = this.unit.validate(PROTOCOL_SCHEMA_IDS.operationRef, operation);
    const nextResult = this.unit.validate(PROTOCOL_SCHEMA_IDS.operationResult, result);
    const event = this.unit.validate(PROTOCOL_SCHEMA_IDS.operationEvent, terminalEvent);
    const current = this.unit.state.operations.get(nextOperation.operation_id);
    if (current === undefined) {
      return this.missing("operation", nextOperation.operation_id);
    }
    assertRevisionUpdate(
      current.revision,
      current.revision + 1,
      precondition,
      nextOperation.operation_id,
    );
    this.#assertOperationIdentity(current.operation, nextOperation);
    this.#assertExpectedSequence(current, expectedNextSequence);
    if (
      nextOperation.state !== "succeeded" ||
      event.kind !== "succeeded" ||
      event.state !== "succeeded" ||
      event.operation_id !== nextOperation.operation_id ||
      nextResult.operation_id !== nextOperation.operation_id
    ) {
      throw new DataError(
        "invalid_argument",
        "Operation completion requires matching succeeded summary, event, and result ownership.",
      );
    }
    if (nextResult.storage === "inline" && nextResult.schema_id !== undefined) {
      this.unit.validate(nextResult.schema_id, nextResult.value);
      const fragment = /#\/\$defs\/([^/]+)$/.exec(nextResult.schema_id)?.[1];
      if (fragment !== undefined && fragment !== nextResult.result_type) {
        throw new DataError(
          "integrity_error",
          "Inline result_type must match the named schema definition.",
        );
      }
    }
    if (
      nextResult.storage === "resource" &&
      (nextOperation.result_ref === undefined ||
        nextResult.result_ref === undefined ||
        !sameResourceRef(nextOperation.result_ref, nextResult.result_ref))
    ) {
      throw new DataError(
        "integrity_error",
        "The Operation result_ref does not match the resource completion result.",
      );
    }
    const record = this.#validateRecord({
      protocol_version: current.protocol_version,
      operation: nextOperation,
      revision: current.revision + 1,
      events: [...current.events, event],
      result: nextResult,
      extensions: current.extensions,
    });
    this.unit.state.operations.set(nextOperation.operation_id, record);
    return cloneFrozen(record);
  }

  get(operationId: string): OperationRecord {
    this.read();
    const value = this.unit.state.operations.get(operationId);
    return value === undefined ? this.missing("operation", operationId) : cloneFrozen(value);
  }

  getResult(operationId: string): OperationResult {
    const record = this.get(operationId);
    if (record.operation.state !== "succeeded" || record.result === undefined) {
      throw new DataError("conflict", "The Operation does not have a durable completion result.", {
        details: { operation_id: operationId, state: record.operation.state },
      });
    }
    return cloneFrozen(record.result);
  }

  listEvents(operationId: string, afterCursor?: string): Page<OperationEvent> {
    const record = this.get(operationId);
    return paginate(
      record.events,
      afterCursor === undefined ? undefined : { cursor: afterCursor },
      this.unit.snapshotVersion,
    );
  }

  #assertExpectedSequence(record: OperationRecord, expectedNextSequence: number): void {
    const actual = record.events.length + 1;
    if (expectedNextSequence !== actual) {
      throw new DataError("conflict", "The expected Operation event sequence is stale.", {
        retryable: true,
        details: {
          operation_id: record.operation.operation_id,
          expected_next_sequence: expectedNextSequence,
          current_next_sequence: actual,
        },
      });
    }
  }

  #assertOperationIdentity(current: OperationRef, next: OperationRef): void {
    if (
      current.operation_id !== next.operation_id ||
      current.kind !== next.kind ||
      current.created_at !== next.created_at
    ) {
      throw new DataError("invalid_argument", "Immutable Operation identity fields cannot change.");
    }
  }

  #validateRecord(candidate: JsonObject): OperationRecord {
    const record = this.unit.validate(
      PROTOCOL_SCHEMA_IDS.operationRecord,
      candidate as OperationRecord,
    );
    assertOperationHistory(record);
    return record;
  }
}

class StateVersionRepository extends BoundStateRepository implements VersionRepository {
  createWorkingSet(baseCommitId: string): WorkingSet {
    this.write();
    if (!this.unit.state.commits.has(baseCommitId)) {
      return this.missing("commit", baseCommitId);
    }
    const timestamp = this.unit.clock.now();
    const candidate = {
      working_set_id: this.unit.ids.next("workingset"),
      base_commit_id: baseCommitId,
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
      changes: [],
      extensions: {},
    } as unknown as WorkingSet;
    const workingSet = this.unit.validate(PROTOCOL_SCHEMA_IDS.workingSet, candidate);
    if (this.unit.state.workingSets.has(workingSet.working_set_id)) {
      throw new DataError("conflict", "The generated working-set ID already exists.", {
        details: { working_set_id: workingSet.working_set_id },
      });
    }
    this.unit.state.workingSets.set(workingSet.working_set_id, workingSet);
    return cloneFrozen(workingSet);
  }

  getWorkingSet(workingSetId: string): WorkingSet {
    this.read();
    const value = this.unit.state.workingSets.get(workingSetId);
    return value === undefined ? this.missing("working_set", workingSetId) : cloneFrozen(value);
  }

  appendWorkingChanges(
    workingSetId: string,
    changes: readonly WorkingChange[],
    precondition: RevisionPrecondition,
  ): WorkingSet {
    this.write();
    const current = this.unit.state.workingSets.get(workingSetId);
    if (current === undefined) {
      return this.missing("working_set", workingSetId);
    }
    const nextRevision = current.revision + 1;
    assertRevisionUpdate(current.revision, nextRevision, precondition, workingSetId);
    const existingIds = new Set(current.changes.map((change) => change.change_id));
    const additions: WorkingChange[] = [];
    for (const change of changes) {
      const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.workingChange, change);
      if (existingIds.has(value.change_id)) {
        this.duplicate("working_change", value.change_id);
      }
      existingIds.add(value.change_id);
      if (value.payload !== undefined) {
        this.unit.assertVerifiedObject(value.payload.hash);
      }
      additions.push(value);
    }
    const candidate = {
      ...current,
      revision: nextRevision,
      updated_at: this.unit.clock.now(),
      changes: [...current.changes, ...additions],
    } as WorkingSet;
    const next = this.unit.validate(PROTOCOL_SCHEMA_IDS.workingSet, candidate);
    this.unit.state.workingSets.set(workingSetId, next);
    return cloneFrozen(next);
  }

  createCommit(manifest: CommitManifest): Commit {
    this.write();
    const nextManifest = this.#verifyManifest(manifest);
    const commit = this.#buildCommit(nextManifest);
    const existing = this.unit.state.commits.get(commit.commit_id);
    if (existing !== undefined) {
      return cloneFrozen(existing);
    }
    this.unit.state.commits.set(commit.commit_id, commit);
    return cloneFrozen(commit);
  }

  commitWorkingSetAndUpdateRef(command: CommitWorkingSetCommand): CommitAndRefResult {
    this.write();
    const workingSet = this.unit.state.workingSets.get(command.working_set_id);
    if (workingSet === undefined) {
      return this.missing("working_set", command.working_set_id);
    }
    assertCurrentRevision(workingSet.revision, command.working_set_precondition, workingSet.working_set_id);
    const manifest = this.#verifyManifest(command.manifest);
    if (manifest.parents[0] !== workingSet.base_commit_id) {
      throw new DataError(
        "conflict",
        "The Commit primary parent must equal the Working Set base Commit.",
        {
          details: {
            working_set_id: workingSet.working_set_id,
            base_commit_id: workingSet.base_commit_id,
            primary_parent: manifest.parents[0] ?? null,
          },
        },
      );
    }
    const objectHashes = new Set(manifest.object_hashes);
    for (const change of workingSet.changes) {
      if (change.operation === "upsert" && !objectHashes.has((change.payload as ObjectRef).hash)) {
        throw new DataError(
          "integrity_error",
          "The Commit Manifest does not include a Working Set payload object.",
          { details: { change_id: change.change_id, hash: (change.payload as ObjectRef).hash } },
        );
      }
    }

    const commit = this.#buildCommit(manifest);
    const nextRef = this.#buildRef(
      command.target_ref_name,
      commit.commit_id,
      command.ref_precondition,
    );

    // All checks complete before either metadata value becomes visible in this transaction.
    if (!this.unit.state.commits.has(commit.commit_id)) {
      this.unit.state.commits.set(commit.commit_id, commit);
    }
    this.unit.state.refs.set(nextRef.name, nextRef);
    return cloneFrozen({ commit, ref: nextRef });
  }

  getCommit(commitId: string): Commit {
    this.read();
    const value = this.unit.state.commits.get(commitId);
    return value === undefined ? this.missing("commit", commitId) : cloneFrozen(value);
  }

  listCommits(query: CommitQuery = {}, page?: PageRequest): Page<Commit> {
    this.read();
    const values = [...this.unit.state.commits.values()]
      .filter(
        (commit) =>
          query.parent_commit_id === undefined ||
          commit.manifest.parents.includes(query.parent_commit_id),
      )
      .filter(
        (commit) =>
          query.created_at_or_after === undefined ||
          compareCanonicalTimestamps(
            commit.manifest.created_at,
            query.created_at_or_after,
          ) >= 0,
      )
      .filter(
        (commit) =>
          query.created_before === undefined ||
          compareCanonicalTimestamps(commit.manifest.created_at, query.created_before) < 0,
      )
      .sort((left, right) => left.commit_id.localeCompare(right.commit_id));
    return paginate(values, page, this.unit.snapshotVersion);
  }

  listRefs(page?: PageRequest): Page<Ref> {
    this.read();
    const values = [...this.unit.state.refs.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    return paginate(values, page, this.unit.snapshotVersion);
  }

  resolveRef(name: string): Ref {
    this.read();
    const value = this.unit.state.refs.get(name);
    return value === undefined ? this.missing("ref", name) : cloneFrozen(value);
  }

  updateRef(name: string, commitId: string, precondition: RefUpdatePrecondition): Ref {
    this.write();
    if (!this.unit.state.commits.has(commitId)) {
      return this.missing("commit", commitId);
    }
    this.unit.validate(PROTOCOL_SCHEMA_IDS.refUpdatePrecondition, precondition);
    const ref = this.#buildRef(name, commitId, precondition);
    this.unit.state.refs.set(name, ref);
    return cloneFrozen(ref);
  }

  createTag(tag: Tag): Tag {
    this.write();
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.tag, tag);
    if (this.unit.state.tags.has(value.name)) {
      this.duplicate("tag", value.name);
    }
    if (!this.unit.state.commits.has(value.commit_id)) {
      return this.missing("commit", value.commit_id);
    }
    this.unit.state.tags.set(value.name, value);
    return cloneFrozen(value);
  }

  *reachableObjects(commitIds: readonly string[]): Iterable<ObjectRef> {
    this.read();
    const pending = [...commitIds];
    const visitedCommits = new Set<string>();
    const yieldedObjects = new Set<string>();
    while (pending.length > 0) {
      const commitId = pending.pop() as string;
      if (visitedCommits.has(commitId)) {
        continue;
      }
      const commit = this.unit.state.commits.get(commitId);
      if (commit === undefined) {
        this.missing("commit", commitId);
      }
      visitedCommits.add(commitId);
      pending.push(...commit.manifest.parents);
      for (const hash of commit.manifest.object_hashes) {
        if (yieldedObjects.has(hash)) {
          continue;
        }
        const object = (this.unit as StateDataUnitOfWork).store._verifiedObject(hash);
        if (object === undefined) {
          throw new DataError("integrity_error", "A reachable Commit object is unavailable.", {
            details: { commit_id: commitId, hash },
          });
        }
        yieldedObjects.add(hash);
        yield object;
      }
    }
  }

  #verifyManifest(manifest: CommitManifest): CommitManifest {
    const value = this.unit.validate(PROTOCOL_SCHEMA_IDS.commitManifest, manifest);
    for (const parent of value.parents) {
      if (!this.unit.state.commits.has(parent)) {
        this.missing("commit", parent);
      }
    }
    for (const hash of value.object_hashes) {
      this.unit.assertVerifiedObject(hash);
    }
    for (const root of Object.values(value.roots as JsonObject)) {
      if (typeof root === "object" && root !== null && !Array.isArray(root)) {
        const hash = String((root as JsonObject)["hash"]);
        if (!value.object_hashes.includes(hash)) {
          throw new DataError(
            "integrity_error",
            "Every Commit root hash must appear in object_hashes.",
            { details: { hash } },
          );
        }
        this.unit.assertVerifiedObject(hash);
      }
    }
    return value;
  }

  #buildCommit(manifest: CommitManifest): Commit {
    const candidate = {
      commit_id: commitIdForManifest(manifest),
      manifest,
    } as unknown as Commit;
    return this.unit.validate(PROTOCOL_SCHEMA_IDS.commit, candidate);
  }

  #buildRef(name: string, commitId: string, precondition: RefUpdatePrecondition): Ref {
    this.unit.validate(PROTOCOL_SCHEMA_IDS.refUpdatePrecondition, precondition);
    const current = this.unit.state.refs.get(name);
    if (precondition.mode === "must_match") {
      if (current === undefined || current.commit_id !== precondition.expected_commit_id) {
        throw new DataError("conflict", "The Ref compare-and-set precondition failed.", {
          retryable: true,
          details: {
            ref_name: name,
            expected_commit_id: precondition.expected_commit_id,
            current_commit_id: current?.commit_id ?? null,
          },
        });
      }
    } else if (precondition.mode === "must_not_exist" && current !== undefined) {
      throw new DataError("conflict", "The Ref already exists.", {
        retryable: true,
        details: { ref_name: name, current_commit_id: current.commit_id },
      });
    } else if (precondition.mode === "force") {
      // The contract requires a protected-ref policy decision plus an
      // auditable authorization record for forced moves; that policy layer
      // does not exist yet, so forcing fails closed instead of trusting an
      // unverifiable authorization reference.
      throw new DataError("unsupported", "Forced Ref updates require the protected-ref policy layer.", {
        details: { ref_name: name },
      });
    }
    const candidate = {
      name,
      commit_id: commitId,
      revision: current === undefined ? 1 : current.revision + 1,
    } as unknown as Ref;
    return this.unit.validate(PROTOCOL_SCHEMA_IDS.ref, candidate);
  }
}

function deriveFindingCounts(findings: readonly ValidationFinding[]): ValidationFindingCounts {
  const result: ValidationFindingCounts = {
    total: findings.length,
    open: 0,
    suppressed: 0,
    resolved: 0,
    by_severity: { info: 0, warning: 0, error: 0, critical: 0 },
  };
  const mutable = cloneValue(result) as {
    total: number;
    open: number;
    suppressed: number;
    resolved: number;
    by_severity: Record<ValidationFinding["severity"], number>;
  };
  for (const finding of findings) {
    mutable[finding.status] += 1;
    mutable.by_severity[finding.severity] += 1;
  }
  return mutable as ValidationFindingCounts;
}

function assertCurrentRevision(
  currentRevision: number,
  precondition: RevisionPrecondition,
  resourceId: string,
): void {
  if (precondition.expected_revision !== currentRevision) {
    throw new DataError("conflict", "The revision precondition is stale.", {
      retryable: true,
      details: {
        resource_id: resourceId,
        expected_revision: precondition.expected_revision,
        current_revision: currentRevision,
      },
    });
  }
}

function assertOperationHistory(record: OperationRecord): void {
  let expectedSequence = 1;
  let previousState: OperationRef["state"] | undefined;
  let previousTime = record.operation.created_at;
  let terminalSeen = false;
  let createdCount = 0;
  let startedCount = 0;
  const eventIds = new Set<string>();

  for (const event of record.events) {
    if (eventIds.has(event.event_id)) {
      throw new DataError("integrity_error", "Operation event IDs must be unique.");
    }
    eventIds.add(event.event_id);
    if (event.operation_id !== record.operation.operation_id || event.sequence !== expectedSequence) {
      throw new DataError(
        "integrity_error",
        "Operation events must have matching ownership and contiguous sequences.",
      );
    }
    expectedSequence += 1;
    if (compareCanonicalTimestamps(event.time, previousTime) < 0) {
      throw new DataError("integrity_error", "Operation event time moved backwards.");
    }
    previousTime = event.time;
    if (terminalSeen) {
      throw new DataError("integrity_error", "An Operation event followed a terminal event.");
    }
    if (event.kind === "created") {
      createdCount += 1;
    }
    if (event.kind === "started") {
      startedCount += 1;
    }
    if (previousState === undefined) {
      if (event.kind !== "created" || event.state !== "queued" || event.sequence !== 1) {
        throw new DataError("integrity_error", "The first Operation event must create queued state.");
      }
    } else {
      const allowed =
        previousState === "queued"
          ? new Set(["queued", "running", "succeeded", "failed", "cancelled"])
          : previousState === "running"
            ? new Set(["running", "succeeded", "failed", "cancelled"])
            : new Set<string>();
      if (!allowed.has(event.state)) {
        throw new DataError("integrity_error", "The Operation state transition is invalid.");
      }
      if (event.state === "running" && previousState !== "running" && event.kind !== "started") {
        throw new DataError("integrity_error", "The first running event must be started.");
      }
    }
    if (["succeeded", "failed", "cancelled"].includes(event.state)) {
      terminalSeen = true;
    }
    previousState = event.state;
  }

  if (createdCount !== 1 || startedCount > 1) {
    throw new DataError("integrity_error", "Operation created/started event cardinality is invalid.");
  }
  const finalEvent = record.events.at(-1) as OperationEvent;
  if (finalEvent.state !== record.operation.state) {
    throw new DataError("integrity_error", "Operation summary state does not match its final event.");
  }
  if (compareCanonicalTimestamps(record.operation.updated_at, finalEvent.time) < 0) {
    throw new DataError("integrity_error", "Operation updated_at precedes its final event.");
  }
  const terminal = ["succeeded", "failed", "cancelled"].includes(record.operation.state);
  if (terminal !== ["succeeded", "failed", "cancelled"].includes(finalEvent.kind)) {
    throw new DataError("integrity_error", "Operation terminal state and event do not agree.");
  }
}

function compareCanonicalTimestamps(left: string, right: string): number {
  const pattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
  const leftMatch = pattern.exec(left);
  const rightMatch = pattern.exec(right);
  if (leftMatch === null || rightMatch === null) {
    throw new DataError("invalid_argument", "Timestamp is not canonical RFC 3339 UTC.");
  }
  const leftSeconds = Date.parse(`${leftMatch[1]}Z`);
  const rightSeconds = Date.parse(`${rightMatch[1]}Z`);
  if (leftSeconds !== rightSeconds) {
    return leftSeconds - rightSeconds;
  }
  const leftFraction = BigInt((leftMatch[2] ?? "").padEnd(9, "0"));
  const rightFraction = BigInt((rightMatch[2] ?? "").padEnd(9, "0"));
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
}

export function collectEmbeddedObjectHashes(value: unknown): ReadonlySet<string> {
  const hashes = new Set<string>();
  const visit = (candidate: unknown): void => {
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

function matchesJsonFields(
  candidate: JsonObject,
  expected: Readonly<Record<string, JsonValue>> | undefined,
): boolean {
  return (
    expected === undefined ||
    Object.entries(expected).every(
      ([key, value]) => canonicalizeIdentityJson(candidate[key] as JsonValue) === canonicalizeIdentityJson(value),
    )
  );
}

function sameResourceRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.kind === right.kind && left.id === right.id && left.version === right.version;
}

function versionSelectorKey(selector: VersionSelector): string {
  if (selector["kind"] === "commit") {
    return `commit:${String(selector["commit_id"])}`;
  }
  if (selector["kind"] === "ref") {
    return `ref:${String(selector["ref_name"])}`;
  }
  return `tag:${String(selector["tag_name"])}`;
}

function ids<T extends JsonObject>(values: readonly T[], key: keyof T & string): readonly string[] {
  return values.map((value) => String(value[key])).sort();
}

function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}
