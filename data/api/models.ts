/**
 * Language-owned Data API values.
 *
 * Canonical persisted values are intentionally branded by their protocol
 * schema instead of being redefined here. A ProtocolValidator is the only
 * supported way to turn untrusted JSON into one of these values.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const PROTOCOL_SCHEMA_IDS = {
  runtimeSnapshot: "https://vistrea.dev/schema/v1/runtime-snapshot.schema.json",
  observation: "https://vistrea.dev/schema/v1/graph.schema.json#/$defs/Observation",
  runtimeEvent: "https://vistrea.dev/schema/v1/runtime-event.schema.json",
  runtimeEventBatch: "https://vistrea.dev/schema/v1/runtime-event-batch.schema.json",
  graphContext: "https://vistrea.dev/schema/v1/graph.schema.json#/$defs/GraphContext",
  screenGraph: "https://vistrea.dev/schema/v1/graph.schema.json",
  screenState: "https://vistrea.dev/schema/v1/graph.schema.json#/$defs/ScreenState",
  transition: "https://vistrea.dev/schema/v1/graph.schema.json#/$defs/Transition",
  stateIdentityDecision:
    "https://vistrea.dev/schema/v1/graph.schema.json#/$defs/StateIdentityDecision",
  wikiNode: "https://vistrea.dev/schema/v1/knowledge.schema.json#/$defs/WikiNode",
  wikiLink: "https://vistrea.dev/schema/v1/knowledge.schema.json#/$defs/WikiLink",
  knowledgeCollection:
    "https://vistrea.dev/schema/v1/knowledge.schema.json#/$defs/KnowledgeCollection",
  knowledgeGraph: "https://vistrea.dev/schema/v1/knowledge.schema.json#/$defs/KnowledgeGraph",
  designReference:
    "https://vistrea.dev/schema/v1/design.schema.json#/$defs/DesignReference",
  designRegionMapping:
    "https://vistrea.dev/schema/v1/design.schema.json#/$defs/DesignRegionMapping",
  designComparison:
    "https://vistrea.dev/schema/v1/design.schema.json#/$defs/DesignComparison",
  reviewIssue: "https://vistrea.dev/schema/v1/design.schema.json#/$defs/ReviewIssue",
  reviewVerificationRecord:
    "https://vistrea.dev/schema/v1/design.schema.json#/$defs/ReviewVerificationRecord",
  tuningPatch: "https://vistrea.dev/schema/v1/design.schema.json#/$defs/TuningPatch",
  tuningApplication:
    "https://vistrea.dev/schema/v1/design.schema.json#/$defs/TuningApplication",
  designReviewBundle:
    "https://vistrea.dev/schema/v1/design.schema.json#/$defs/DesignReviewBundle",
  validationRun: "https://vistrea.dev/schema/v1/validation.schema.json",
  validationFinding:
    "https://vistrea.dev/schema/v1/validation.schema.json#/$defs/ValidationFinding",
  validationSuppression:
    "https://vistrea.dev/schema/v1/validation.schema.json#/$defs/ValidationSuppression",
  validationBundle:
    "https://vistrea.dev/schema/v1/validation.schema.json#/$defs/ValidationBundle",
  buildDiff: "https://vistrea.dev/schema/v1/validation.schema.json#/$defs/BuildDiff",
  operationRef: "https://vistrea.dev/schema/v1/operation.schema.json#/$defs/OperationRef",
  operationEvent: "https://vistrea.dev/schema/v1/operation.schema.json#/$defs/OperationEvent",
  operationResult:
    "https://vistrea.dev/schema/v1/operation.schema.json#/$defs/OperationResult",
  operationRecord: "https://vistrea.dev/schema/v1/operation.schema.json",
  commitManifest: "https://vistrea.dev/schema/v1/commit.schema.json#/$defs/CommitManifest",
  commit: "https://vistrea.dev/schema/v1/commit.schema.json",
  ref: "https://vistrea.dev/schema/v1/commit.schema.json#/$defs/Ref",
  tag: "https://vistrea.dev/schema/v1/commit.schema.json#/$defs/Tag",
  workingChange: "https://vistrea.dev/schema/v1/commit.schema.json#/$defs/WorkingChange",
  workingSet: "https://vistrea.dev/schema/v1/commit.schema.json#/$defs/WorkingSet",
  versionSelector:
    "https://vistrea.dev/schema/v1/commit.schema.json#/$defs/VersionSelector",
  refUpdatePrecondition:
    "https://vistrea.dev/schema/v1/commit.schema.json#/$defs/RefUpdatePrecondition",
  objectRef: "https://vistrea.dev/schema/v1/object.schema.json#/$defs/ObjectRef",
  resourceRef: "https://vistrea.dev/schema/v1/common.schema.json#/$defs/ResourceRef",
  actorRef: "https://vistrea.dev/schema/v1/common.schema.json#/$defs/ActorRef",
  exchangePackManifest: "https://vistrea.dev/schema/v1/exchange-pack.schema.json",
  exchangePackHeader:
    "https://vistrea.dev/schema/v1/exchange-pack.schema.json#/$defs/PackHeader",
  exchangePackTrailer:
    "https://vistrea.dev/schema/v1/exchange-pack.schema.json#/$defs/PackTrailer",
  mutationPrecondition:
    "https://vistrea.dev/schema/v1/common.schema.json#/$defs/MutationPrecondition",
  revisionPrecondition:
    "https://vistrea.dev/schema/v1/common.schema.json#/$defs/RevisionPrecondition",
  workspaceManifest: "https://vistrea.dev/schema/v1/workspace.schema.json",
} as const;

export type ProtocolSchemaId = (typeof PROTOCOL_SCHEMA_IDS)[keyof typeof PROTOCOL_SCHEMA_IDS];

declare const canonicalProtocolValue: unique symbol;

export type CanonicalProtocolValue<
  SchemaId extends ProtocolSchemaId,
  Shape extends JsonObject = JsonObject,
> = Readonly<Shape> & { readonly [canonicalProtocolValue]: SchemaId };

export interface ProtocolValidator {
  assert(schemaId: ProtocolSchemaId | string, value: unknown): void;
}

export interface ProtocolVersion extends JsonObject {
  readonly major: number;
  readonly minor: number;
}

export interface EventTimeShape extends JsonObject {
  readonly wall_time: string;
  readonly monotonic_offset_ns?: number;
}

export interface ResourceRef extends JsonObject {
  readonly kind: string;
  readonly id: string;
  readonly version?: string;
}

export interface EncryptionReference extends JsonObject {
  readonly algorithm: string;
  readonly key_id: string;
}

export interface ObjectRefShape extends JsonObject {
  readonly hash: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly decoded_byte_size?: number;
  readonly compression: "none" | "gzip" | "zstd";
  readonly encryption?: EncryptionReference;
  readonly redaction_profile?: string;
  readonly logical_name?: string;
  readonly extensions: JsonObject;
}

export type ObjectRef = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.objectRef,
  ObjectRefShape
>;

export interface RevisionPrecondition extends JsonObject {
  readonly expected_revision: number;
  readonly expected_commit_id?: string;
}

export interface MutationPrecondition extends JsonObject {
  readonly expected_revision?: number;
  readonly expected_commit_id?: string;
}

export interface RuntimeSnapshotShape extends JsonObject {
  readonly snapshot_id: string;
  readonly protocol_version: ProtocolVersion;
  readonly captured_at: EventTimeShape;
  readonly runtime_context: JsonObject;
}

export type RuntimeSnapshot = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.runtimeSnapshot,
  RuntimeSnapshotShape
>;

export interface ObservationShape extends JsonObject {
  readonly observation_id: string;
  readonly protocol_version: ProtocolVersion;
  readonly kind: string;
  readonly observed_at: EventTimeShape;
  readonly screen_state_id?: string;
  readonly transition_id?: string;
}

export type Observation = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.observation,
  ObservationShape
>;

export interface RuntimeEventShape extends JsonObject {
  readonly event_id: string;
  readonly event_epoch_id: string;
  readonly sequence: number;
  readonly time: EventTimeShape;
  readonly kind: string;
}

export type RuntimeEvent = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.runtimeEvent,
  RuntimeEventShape
>;

export interface RuntimeEventBatchShape extends JsonObject {
  readonly protocol_version: ProtocolVersion;
  readonly event_epoch_id: string;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly events: readonly RuntimeEvent[];
  readonly dropped_event_count: number;
}

export type RuntimeEventBatch = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.runtimeEventBatch,
  RuntimeEventBatchShape
>;

export type GraphContext = CanonicalProtocolValue<typeof PROTOCOL_SCHEMA_IDS.graphContext>;

export interface ScreenStateShape extends JsonObject {
  readonly screen_state_id: string;
  readonly revision: number;
}

export type ScreenState = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.screenState,
  ScreenStateShape
>;

export interface TransitionShape extends JsonObject {
  readonly transition_id: string;
  readonly revision: number;
  readonly source_state_id: string;
  readonly target_state_id: string;
  readonly action_id: string;
}

export type Transition = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.transition,
  TransitionShape
>;

export interface StateIdentityDecisionShape extends JsonObject {
  readonly state_identity_decision_id: string;
  readonly revision: number;
}

export type StateIdentityDecision = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.stateIdentityDecision,
  StateIdentityDecisionShape
>;

export interface ScreenGraphShape extends JsonObject {
  readonly screen_graph_id: string;
  readonly revision: number;
  readonly context: GraphContext;
  readonly states: readonly ScreenState[];
  readonly transitions: readonly Transition[];
  readonly observations: readonly Observation[];
  readonly identity_decisions: readonly StateIdentityDecision[];
}

export type ScreenGraph = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.screenGraph,
  ScreenGraphShape
>;

export interface WikiNodeShape extends JsonObject {
  readonly wiki_node_id: string;
  readonly revision: number;
  readonly related_resources: readonly ResourceRef[];
}

export type WikiNode = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.wikiNode,
  WikiNodeShape
>;

export interface WikiLinkShape extends JsonObject {
  readonly wiki_link_id: string;
  readonly revision: number;
  readonly source_node_id: string;
  readonly target: ResourceRef;
}

export type WikiLink = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.wikiLink,
  WikiLinkShape
>;

export interface KnowledgeCollectionShape extends JsonObject {
  readonly collection_id: string;
  readonly revision: number;
  readonly name: string;
  readonly summary?: string;
  readonly publication: JsonObject;
}

export type KnowledgeCollection = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.knowledgeCollection,
  KnowledgeCollectionShape
>;

interface RevisionedDesignValue extends JsonObject {
  readonly revision: number;
}

export interface DesignReferenceShape extends RevisionedDesignValue {
  readonly design_reference_id: string;
}

export type DesignReference = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.designReference,
  DesignReferenceShape
>;

export interface DesignRegionMappingShape extends RevisionedDesignValue {
  readonly mapping_id: string;
  readonly design_reference_id: string;
  readonly runtime_target: JsonObject;
  readonly state: string;
}

export type DesignRegionMapping = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.designRegionMapping,
  DesignRegionMappingShape
>;

export interface DesignComparisonShape extends RevisionedDesignValue {
  readonly comparison_id: string;
}

export type DesignComparison = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.designComparison,
  DesignComparisonShape
>;

export interface ReviewIssueShape extends RevisionedDesignValue {
  readonly issue_id: string;
  readonly design_reference_id: string;
  readonly state: string;
  readonly severity: string;
}

export type ReviewIssue = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.reviewIssue,
  ReviewIssueShape
>;

export interface ReviewVerificationRecordShape extends RevisionedDesignValue {
  readonly verification_record_id: string;
  readonly issue_id: string;
}

export type ReviewVerificationRecord = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.reviewVerificationRecord,
  ReviewVerificationRecordShape
>;

export interface TuningPatchShape extends RevisionedDesignValue {
  readonly patch_id: string;
}

export type TuningPatch = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.tuningPatch,
  TuningPatchShape
>;

export interface TuningApplicationShape extends RevisionedDesignValue {
  readonly tuning_application_id: string;
  readonly connection_id: string;
  readonly status: string;
}

export type TuningApplication = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.tuningApplication,
  TuningApplicationShape
>;

export interface ValidationFindingCounts extends JsonObject {
  readonly total: number;
  readonly open: number;
  readonly suppressed: number;
  readonly resolved: number;
  readonly by_severity: Readonly<{
    info: number;
    warning: number;
    error: number;
    critical: number;
  }>;
}

export interface ValidationRunShape extends JsonObject {
  readonly validation_run_id: string;
  readonly revision: number;
  readonly state: string;
  readonly finding_counts: ValidationFindingCounts;
}

export type ValidationRun = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.validationRun,
  ValidationRunShape
>;

export interface ValidationFindingShape extends JsonObject {
  readonly finding_id: string;
  readonly validation_run_id: string;
  readonly revision: number;
  readonly status: "open" | "suppressed" | "resolved";
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly active_suppression_id?: string;
}

export type ValidationFinding = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.validationFinding,
  ValidationFindingShape
>;

export interface ValidationSuppressionShape extends JsonObject {
  readonly suppression_id: string;
  readonly finding_id: string;
}

export type ValidationSuppression = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.validationSuppression,
  ValidationSuppressionShape
>;

export interface BuildDiffShape extends JsonObject {
  readonly build_diff_id: string;
}

export type BuildDiff = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.buildDiff,
  BuildDiffShape
>;

export type OperationState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface OperationRefShape extends JsonObject {
  readonly operation_id: string;
  readonly kind: string;
  readonly state: OperationState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly result_ref?: ResourceRef;
  readonly error?: JsonObject;
}

export type OperationRef = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.operationRef,
  OperationRefShape
>;

export interface OperationEventShape extends JsonObject {
  readonly event_id: string;
  readonly operation_id: string;
  readonly sequence: number;
  readonly time: string;
  readonly kind: string;
  readonly state: OperationState;
  readonly error?: JsonObject;
}

export type OperationEvent = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.operationEvent,
  OperationEventShape
>;

interface OperationResultBaseShape extends JsonObject {
  readonly operation_id: string;
  readonly result_type: string;
  readonly schema_id?: string;
}

export interface InlineOperationResultShape extends OperationResultBaseShape {
  readonly storage: "inline";
  readonly value: JsonValue;
}

export interface ResourceOperationResultShape extends OperationResultBaseShape {
  readonly storage: "resource";
  readonly result_ref: ResourceRef;
}

export type OperationResultShape = InlineOperationResultShape | ResourceOperationResultShape;

export type OperationResult = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.operationResult,
  OperationResultShape
>;

export interface OperationRecordShape extends JsonObject {
  readonly protocol_version: ProtocolVersion;
  readonly operation: OperationRef;
  readonly revision: number;
  readonly events: readonly OperationEvent[];
  readonly result?: OperationResult;
  readonly extensions: JsonObject;
}

export type OperationRecord = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.operationRecord,
  OperationRecordShape
>;

export interface WorkingChangeShape extends JsonObject {
  readonly change_id: string;
  readonly operation: "upsert" | "delete";
  readonly resource: ResourceRef;
  readonly payload?: ObjectRef;
  readonly expected_revision?: number;
}

export type WorkingChange = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.workingChange,
  WorkingChangeShape
>;

export interface WorkingSetShape extends JsonObject {
  readonly working_set_id: string;
  readonly base_commit_id: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly changes: readonly WorkingChange[];
}

export type WorkingSet = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.workingSet,
  WorkingSetShape
>;

export interface CommitManifestShape extends JsonObject {
  readonly protocol_version: ProtocolVersion;
  readonly parents: readonly string[];
  readonly created_at: string;
  readonly roots: JsonObject;
  readonly object_hashes: readonly string[];
}

export type CommitManifest = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.commitManifest,
  CommitManifestShape
>;

export interface CommitShape extends JsonObject {
  readonly commit_id: string;
  readonly manifest: CommitManifest;
}

export type Commit = CanonicalProtocolValue<typeof PROTOCOL_SCHEMA_IDS.commit, CommitShape>;

export interface RefShape extends JsonObject {
  readonly name: string;
  readonly commit_id: string;
  readonly revision: number;
}

export type Ref = CanonicalProtocolValue<typeof PROTOCOL_SCHEMA_IDS.ref, RefShape>;

export interface TagShape extends JsonObject {
  readonly name: string;
  readonly commit_id: string;
}

export type Tag = CanonicalProtocolValue<typeof PROTOCOL_SCHEMA_IDS.tag, TagShape>;

export interface CommitVersionSelectorShape extends JsonObject {
  readonly kind: "commit";
  readonly commit_id: string;
}

export interface RefVersionSelectorShape extends JsonObject {
  readonly kind: "ref";
  readonly ref_name: string;
}

export interface TagVersionSelectorShape extends JsonObject {
  readonly kind: "tag";
  readonly tag_name: string;
}

export type VersionSelector = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.versionSelector,
  CommitVersionSelectorShape | RefVersionSelectorShape | TagVersionSelectorShape
>;

export type RefUpdatePrecondition = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.refUpdatePrecondition,
  JsonObject &
    (
      | { readonly mode: "must_match"; readonly expected_commit_id: string }
      | { readonly mode: "must_not_exist" }
      | { readonly mode: "force"; readonly authorization: ResourceRef }
    )
>;

export interface WorkspaceManifestShape extends JsonObject {
  readonly workspace_id: string;
  readonly protocol_version: ProtocolVersion;
  readonly genesis_commit_id: string;
  readonly default_ref_name: string;
}

export type WorkspaceManifest = CanonicalProtocolValue<
  typeof PROTOCOL_SCHEMA_IDS.workspaceManifest,
  WorkspaceManifestShape
>;

export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor?: string;
  readonly snapshot_version?: string;
}

export interface FieldMask {
  readonly paths: readonly string[];
}

export interface SnapshotSummary {
  readonly snapshot_id: string;
  readonly captured_at: EventTimeShape;
  readonly runtime_context: JsonObject;
}

export interface SnapshotQuery {
  readonly snapshot_ids?: readonly string[];
  readonly captured_at_or_after?: string;
  readonly captured_before?: string;
  readonly runtime_context?: Readonly<Record<string, JsonValue>>;
}

export interface ObservationQuery {
  readonly observation_ids?: readonly string[];
  readonly kinds?: readonly string[];
  readonly screen_state_id?: string;
  readonly transition_id?: string;
}

export interface RuntimeEventQuery {
  readonly event_epoch_id?: string;
  readonly first_sequence?: number;
  readonly last_sequence?: number;
  readonly kinds?: readonly string[];
}

export interface EventTimelineQuery extends RuntimeEventQuery {}

export interface EventTimeline {
  readonly event_epoch_id?: string;
  readonly events: readonly RuntimeEvent[];
  readonly reported_gaps: readonly Readonly<{ first_sequence: number; last_sequence: number }>[];
}

export interface PathQuery {
  readonly graph_id?: string;
  readonly source_state_id: string;
  readonly target_state_id: string;
  readonly maximum_depth?: number;
}

export interface PathResult {
  readonly state_ids: readonly string[];
  readonly transition_ids: readonly string[];
}

export interface GraphDiff {
  readonly added_state_ids: readonly string[];
  readonly removed_state_ids: readonly string[];
  readonly added_transition_ids: readonly string[];
  readonly removed_transition_ids: readonly string[];
}

export interface WikiNodeQuery {
  readonly text?: string;
  readonly kinds?: readonly string[];
  readonly labels?: readonly string[];
  readonly statuses?: readonly string[];
}

export interface KnowledgeCollectionQuery {
  readonly text?: string;
  readonly publication_states?: readonly string[];
}

export interface DesignRegionMappingQuery {
  readonly design_reference_id?: string;
  readonly snapshot_id?: string;
  readonly states?: readonly string[];
}

export interface ReviewIssueQuery {
  readonly design_reference_id?: string;
  readonly states?: readonly string[];
  readonly severities?: readonly string[];
}

export interface ValidationFindingQuery {
  readonly validation_run_id?: string;
  readonly statuses?: readonly string[];
  readonly severities?: readonly string[];
}

export interface CommitQuery {
  readonly parent_commit_id?: string;
  readonly created_at_or_after?: string;
  readonly created_before?: string;
}

export interface CommitWorkingSetCommand {
  readonly working_set_id: string;
  readonly working_set_precondition: RevisionPrecondition;
  readonly manifest: CommitManifest;
  readonly target_ref_name: string;
  readonly ref_precondition: RefUpdatePrecondition;
}

export interface CommitAndRefResult {
  readonly commit: Commit;
  readonly ref: Ref;
}

export interface ObjectPutMetadata {
  readonly expected_hash?: string;
  readonly media_type: string;
  readonly compression: "none" | "gzip" | "zstd";
  readonly decoded_byte_size?: number;
  readonly encryption?: EncryptionReference;
  readonly redaction_profile?: string;
  readonly logical_name?: string;
  readonly extensions?: JsonObject;
}

export interface ByteRange {
  readonly offset: number;
  readonly length?: number;
}

export interface RetentionPolicy {
  readonly policy_id: string;
  readonly retain_until?: string;
  readonly reason: string;
}

export interface ObjectInventoryQuery {
  readonly hash_prefix?: string;
  readonly media_types?: readonly string[];
}

export interface SearchDocumentChange {
  readonly operation: "upsert" | "delete";
  readonly resource: ResourceRef;
  readonly title?: string;
  readonly body?: string;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

export interface SearchQuery {
  readonly text: string;
  readonly resource_kinds?: readonly string[];
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

export interface SearchResult {
  readonly resource: ResourceRef;
  readonly score: number;
  readonly title?: string;
  readonly excerpt?: string;
}

export interface SearchIndexStatus {
  readonly state: "ready" | "rebuilding" | "stale" | "failed";
  readonly indexed_revision?: string;
  readonly error?: JsonObject;
}

export interface SearchRebuildSource {
  readonly version: VersionSelector;
  readonly resource_kinds?: readonly string[];
}

export interface ExportPackCommand {
  /** Refs whose targets become pack heads and travel as PackRef entries. */
  readonly ref_names?: readonly string[];
  /** Additional unnamed head commits. */
  readonly commit_ids?: readonly string[];
  /**
   * Commits the importer is assumed to already hold. A non-empty list makes
   * the pack thin: objects reachable from these commits are listed as
   * omitted_objects instead of being included.
   */
  readonly prerequisite_commit_ids?: readonly string[];
  /** Protocol ActorRef describing who produced the pack. */
  readonly created_by: JsonObject;
  readonly message?: string;
}

export interface ImportPackCommand {
  /** A verified `.vistrea-pack` object already present in the local Object Store. */
  readonly pack: ObjectRef;
}

export interface PackRefConflict {
  readonly name: string;
  readonly pack_commit_id: string;
  readonly local_commit_id: string;
}

export interface ImportPackResult {
  readonly mode: "full" | "thin";
  readonly imported_commit_ids: readonly string[];
  readonly existing_commit_ids: readonly string[];
  readonly imported_object_hashes: readonly string[];
  readonly existing_object_hashes: readonly string[];
  readonly created_refs: readonly Ref[];
  readonly unchanged_ref_names: readonly string[];
  readonly conflicting_refs: readonly PackRefConflict[];
}

export interface ExportReadableCommand extends JsonObject {}
export interface RemoteRef extends JsonObject {}
export interface SyncStatus extends JsonObject {}
export interface FetchCommand extends JsonObject {}
export interface PushCommand extends JsonObject {}
export interface PublishCommand extends JsonObject {}
export interface SubscribeCommand extends JsonObject {}
export interface Subscription extends JsonObject {}
export interface SyncConflictQuery extends JsonObject {}
export interface SyncConflict extends JsonObject {}
export interface ResolveSyncConflictCommand extends JsonObject {}
export interface SyncConflictResolution extends JsonObject {}

export interface CreateWorkspaceData {
  readonly manifest: WorkspaceManifest;
  readonly genesis_commit: Commit;
  readonly default_ref: Ref;
}

export interface WorkspaceDescriptor {
  readonly manifest: WorkspaceManifest;
  readonly genesis_commit_id: string;
  readonly default_ref: Ref;
}

export interface WorkspaceHandle {
  readonly workspace_id: string;
}

export interface MigrationResult {
  readonly from_version: number;
  readonly to_version: number;
  readonly applied_versions: readonly number[];
}

export interface BackupWorkspaceCommand {
  readonly reason: string;
  readonly retention: RetentionPolicy;
}

export interface CompactWorkspaceCommand {
  readonly reclaim_derived_data?: boolean;
}

export interface CompactWorkspaceResult {
  readonly reclaimed_bytes: number;
}

export interface RestoreWorkspaceCommand {
  readonly backup: ObjectRef;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}
