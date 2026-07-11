import { DataError } from "../api/errors.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type BuildDiff,
  type Clock,
  type Commit,
  type DesignComparison,
  type DesignReference,
  type DesignRegionMapping,
  type IdGenerator,
  type KnowledgeCollection,
  type ObjectRef,
  type Observation,
  type OperationRecord,
  type ProtocolSchemaId,
  type ProtocolValidator,
  type Ref,
  type ReviewIssue,
  type ReviewVerificationRecord,
  type RuntimeEventBatch,
  type RuntimeSnapshot,
  type ScreenGraph,
  type StateIdentityDecision,
  type Tag,
  type TuningApplication,
  type TuningPatch,
  type ValidationFinding,
  type ValidationRun,
  type ValidationSuppression,
  type WikiLink,
  type WikiNode,
  type WorkingSet,
} from "../api/models.js";
import type {
  DataUnitOfWork,
  UnitOfWorkMode,
  WorkspaceDataSource,
  WorkspaceHealth,
} from "../api/ports.js";
import { createEmptyDataState } from "../internal/state.js";
import {
  canonicalizeIdentityJson,
  cloneFrozen,
  cloneValue,
  SequenceClock,
  SequenceIdGenerator,
} from "../internal/support.js";
import {
  collectEmbeddedObjectHashes,
  StateDataUnitOfWork,
} from "../internal/state-uow.js";

export interface MemoryDataSeed {
  readonly verifiedObjects?: readonly ObjectRef[];
  readonly snapshots?: readonly RuntimeSnapshot[];
  readonly observations?: readonly Observation[];
  readonly runtimeEventBatches?: readonly RuntimeEventBatch[];
  readonly screenGraphs?: readonly ScreenGraph[];
  readonly screenGraphsByVersion?: Readonly<Record<string, string>>;
  readonly identityDecisions?: readonly StateIdentityDecision[];
  readonly wikiNodes?: readonly WikiNode[];
  readonly wikiLinks?: readonly WikiLink[];
  readonly knowledgeCollections?: readonly KnowledgeCollection[];
  readonly designReferences?: readonly DesignReference[];
  readonly designRegionMappings?: readonly DesignRegionMapping[];
  readonly designComparisons?: readonly DesignComparison[];
  readonly reviewIssues?: readonly ReviewIssue[];
  readonly reviewVerificationRecords?: readonly ReviewVerificationRecord[];
  readonly tuningPatches?: readonly TuningPatch[];
  readonly tuningApplications?: readonly TuningApplication[];
  readonly validationRuns?: readonly ValidationRun[];
  readonly validationFindings?: readonly ValidationFinding[];
  readonly validationSuppressions?: readonly ValidationSuppression[];
  readonly buildDiffs?: readonly BuildDiff[];
  readonly operationRecords?: readonly OperationRecord[];
  readonly commits?: readonly Commit[];
  readonly refs?: readonly Ref[];
  readonly tags?: readonly Tag[];
  readonly workingSets?: readonly WorkingSet[];
}

export interface MemoryDataStoreOptions {
  readonly validator: ProtocolValidator;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly seed?: MemoryDataSeed;
}

export class MemoryDataStore implements WorkspaceDataSource {
  readonly clock: Clock;
  readonly #ids: IdGenerator;
  readonly #validator: ProtocolValidator;
  readonly #verifiedObjects = new Map<string, ObjectRef>();
  readonly #openUnits = new Set<string>();
  #state = createEmptyDataState();
  #generation = 0;

  constructor(options: MemoryDataStoreOptions) {
    this.#validator = options.validator;
    this.clock = options.clock ?? new SequenceClock();
    this.#ids = options.ids ?? new SequenceIdGenerator();
    this.#loadSeed(options.seed ?? {});
  }

  beginUnitOfWork(mode: UnitOfWorkMode): DataUnitOfWork {
    if (mode !== "read" && mode !== "write") {
      throw new DataError("invalid_argument", "Unit of Work mode must be read or write.");
    }
    const id = this.#ids.next("uow");
    const unit = new StateDataUnitOfWork(
      this,
      id,
      mode,
      this.#generation,
      "memory",
      structuredClone(this.#state),
      this.#validator,
      this.clock,
      this.#ids,
    );
    this.#openUnits.add(id);
    return unit;
  }

  checkHealth(): WorkspaceHealth {
    return {
      ok: true,
      generation: this.#generation,
      open_units_of_work: this.#openUnits.size,
      issues: [],
    };
  }

  registerVerifiedObjects(objects: readonly ObjectRef[]): void {
    for (const object of objects) {
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.objectRef, object);
      const current = this.#verifiedObjects.get(object.hash);
      if (current !== undefined && canonicalizeIdentityJson(current) !== canonicalizeIdentityJson(object)) {
        throw new DataError("integrity_error", "One object hash resolved to conflicting metadata.", {
          details: { hash: object.hash },
        });
      }
      this.#verifiedObjects.set(object.hash, cloneValue(object));
    }
  }

  _isVerifiedObject(hash: string): boolean {
    return this.#verifiedObjects.has(hash);
  }

  _verifiedObject(hash: string): ObjectRef | undefined {
    const value = this.#verifiedObjects.get(hash);
    return value === undefined ? undefined : cloneFrozen(value);
  }

  _commit(unit: StateDataUnitOfWork): void {
    if (!this.#openUnits.has(unit.id)) {
      throw new DataError("conflict", "The Unit of Work is no longer active.", {
        details: { unit_of_work_id: unit.id },
      });
    }
    if (unit.mode === "write") {
      if (unit.baseGeneration !== this.#generation) {
        this.#openUnits.delete(unit.id);
        throw new DataError("conflict", "The Workspace changed after this Unit of Work began.", {
          retryable: true,
          details: {
            unit_of_work_id: unit.id,
            base_generation: unit.baseGeneration,
            current_generation: this.#generation,
          },
        });
      }
      if (this.#generation === Number.MAX_SAFE_INTEGER) {
        this.#openUnits.delete(unit.id);
        throw new DataError("resource_exhausted", "The Workspace generation is exhausted.");
      }
      this.#state = structuredClone(unit.state);
      this.#generation += 1;
    }
    this.#openUnits.delete(unit.id);
  }

  _rollback(unit: StateDataUnitOfWork): void {
    this.#openUnits.delete(unit.id);
  }

  #loadSeed(seed: MemoryDataSeed): void {
    this.registerVerifiedObjects(seed.verifiedObjects ?? []);
    const add = <T>(
      values: readonly T[] | undefined,
      map: Map<string, T>,
      id: (value: T) => string,
      schemaId: ProtocolSchemaId,
    ): void => {
      for (const value of values ?? []) {
        this.#validator.assert(schemaId, value);
        const key = id(value);
        if (map.has(key)) {
          throw new DataError("already_exists", "The seed contains a duplicate resource.", {
            details: { resource_id: key },
          });
        }
        map.set(key, cloneValue(value));
      }
    };

    add(seed.snapshots, this.#state.snapshots, (value) => value.snapshot_id, PROTOCOL_SCHEMA_IDS.runtimeSnapshot);
    add(seed.observations, this.#state.observations, (value) => value.observation_id, PROTOCOL_SCHEMA_IDS.observation);
    add(seed.screenGraphs, this.#state.screenGraphs, (value) => value.screen_graph_id, PROTOCOL_SCHEMA_IDS.screenGraph);
    add(seed.identityDecisions, this.#state.identityDecisions, (value) => value.state_identity_decision_id, PROTOCOL_SCHEMA_IDS.stateIdentityDecision);
    add(seed.wikiNodes, this.#state.wikiNodes, (value) => value.wiki_node_id, PROTOCOL_SCHEMA_IDS.wikiNode);
    add(seed.wikiLinks, this.#state.wikiLinks, (value) => value.wiki_link_id, PROTOCOL_SCHEMA_IDS.wikiLink);
    add(seed.knowledgeCollections, this.#state.knowledgeCollections, (value) => value.collection_id, PROTOCOL_SCHEMA_IDS.knowledgeCollection);
    add(seed.designReferences, this.#state.designReferences, (value) => value.design_reference_id, PROTOCOL_SCHEMA_IDS.designReference);
    add(seed.designRegionMappings, this.#state.designRegionMappings, (value) => value.mapping_id, PROTOCOL_SCHEMA_IDS.designRegionMapping);
    add(seed.designComparisons, this.#state.designComparisons, (value) => value.comparison_id, PROTOCOL_SCHEMA_IDS.designComparison);
    add(seed.reviewIssues, this.#state.reviewIssues, (value) => value.issue_id, PROTOCOL_SCHEMA_IDS.reviewIssue);
    add(seed.reviewVerificationRecords, this.#state.reviewVerificationRecords, (value) => value.verification_record_id, PROTOCOL_SCHEMA_IDS.reviewVerificationRecord);
    add(seed.tuningPatches, this.#state.tuningPatches, (value) => value.patch_id, PROTOCOL_SCHEMA_IDS.tuningPatch);
    add(seed.tuningApplications, this.#state.tuningApplications, (value) => value.tuning_application_id, PROTOCOL_SCHEMA_IDS.tuningApplication);
    add(seed.validationRuns, this.#state.validationRuns, (value) => value.validation_run_id, PROTOCOL_SCHEMA_IDS.validationRun);
    add(seed.validationFindings, this.#state.validationFindings, (value) => value.finding_id, PROTOCOL_SCHEMA_IDS.validationFinding);
    add(seed.validationSuppressions, this.#state.validationSuppressions, (value) => value.suppression_id, PROTOCOL_SCHEMA_IDS.validationSuppression);
    add(seed.buildDiffs, this.#state.buildDiffs, (value) => value.build_diff_id, PROTOCOL_SCHEMA_IDS.buildDiff);
    add(seed.operationRecords, this.#state.operations, (value) => value.operation.operation_id, PROTOCOL_SCHEMA_IDS.operationRecord);
    add(seed.commits, this.#state.commits, (value) => value.commit_id, PROTOCOL_SCHEMA_IDS.commit);
    add(seed.refs, this.#state.refs, (value) => value.name, PROTOCOL_SCHEMA_IDS.ref);
    add(seed.tags, this.#state.tags, (value) => value.name, PROTOCOL_SCHEMA_IDS.tag);
    add(seed.workingSets, this.#state.workingSets, (value) => value.working_set_id, PROTOCOL_SCHEMA_IDS.workingSet);

    for (const snapshot of seed.snapshots ?? []) {
      const objects = [...collectEmbeddedObjectHashes(snapshot)]
        .sort()
        .map((hash) => {
          const object = this.#verifiedObjects.get(hash);
          if (object === undefined) {
            throw new DataError(
              "integrity_error",
              "A seeded Snapshot references an ObjectRef that was not registered as verified.",
              { details: { snapshot_id: snapshot.snapshot_id, hash } },
            );
          }
          return cloneValue(object);
        });
      if (objects.length > 0) {
        this.#state.snapshotObjects.set(snapshot.snapshot_id, objects);
      }
    }

    for (const batch of seed.runtimeEventBatches ?? []) {
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.runtimeEventBatch, batch);
      for (const event of batch.events) {
        if (this.#state.runtimeEvents.has(event.event_id)) {
          throw new DataError("already_exists", "The seed contains a duplicate runtime event.", {
            details: { event_id: event.event_id },
          });
        }
        this.#state.runtimeEvents.set(event.event_id, cloneValue(event));
      }
    }
    for (const [selector, graphId] of Object.entries(seed.screenGraphsByVersion ?? {})) {
      if (!this.#state.screenGraphs.has(graphId)) {
        throw new DataError("not_found", "A seeded graph version points to an unknown graph.", {
          details: { selector, screen_graph_id: graphId },
        });
      }
      this.#state.screenGraphsByVersion.set(selector, graphId);
    }
    for (const hash of collectEmbeddedObjectHashes(seed)) {
      if (!this.#verifiedObjects.has(hash)) {
        throw new DataError(
          "integrity_error",
          "Seed metadata references an object that was not registered as verified.",
          { details: { hash } },
        );
      }
    }
  }
}
