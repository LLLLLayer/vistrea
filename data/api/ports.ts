import type {
  BackupWorkspaceCommand,
  BuildDiff,
  ByteRange,
  Clock,
  CompactWorkspaceCommand,
  CompactWorkspaceResult,
  Commit,
  CommitAndRefResult,
  CommitManifest,
  CommitQuery,
  CommitWorkingSetCommand,
  CreateWorkspaceData,
  DesignComparison,
  DesignComparisonQuery,
  DesignReference,
  DesignRegionMapping,
  DesignRegionMappingQuery,
  EventTimeline,
  EventTimelineQuery,
  FieldMask,
  ExportPackCommand,
  ExportReadableCommand,
  FetchCommand,
  GraphContext,
  GraphDiff,
  KnowledgeCollection,
  KnowledgeCollectionQuery,
  WikiNodeQuery,
  ImportPackCommand,
  ImportPackResult,
  MigrationResult,
  MutationPrecondition,
  ObjectInventoryQuery,
  ObjectPutMetadata,
  ObjectRef,
  Observation,
  ObservationQuery,
  OperationEvent,
  OperationRecord,
  OperationRef,
  OperationResult,
  Page,
  PageRequest,
  PathQuery,
  PathResult,
  Ref,
  RefUpdatePrecondition,
  RemoteRef,
  ResolveSyncConflictCommand,
  ResourceRef,
  RestoreWorkspaceCommand,
  WorkspaceRestoreResult,
  ReviewIssue,
  ReviewIssueQuery,
  ReviewVerificationRecord,
  RevisionPrecondition,
  RuntimeEvent,
  RuntimeEventBatch,
  RuntimeEventQuery,
  RuntimeSnapshot,
  SearchDocumentChange,
  SearchIndexStatus,
  SearchQuery,
  SearchRebuildSource,
  SearchResult,
  ScreenGraph,
  ScreenState,
  SnapshotQuery,
  SnapshotSummary,
  StateIdentityDecision,
  SubscribeCommand,
  Subscription,
  SyncConflict,
  SyncConflictQuery,
  SyncConflictResolution,
  SyncStatus,
  Tag,
  TuningApplication,
  TuningPatch,
  ValidationFinding,
  ValidationFindingQuery,
  ValidationRun,
  ValidationSuppression,
  VersionSelector,
  WikiLink,
  WikiNode,
  WorkingChange,
  WorkingSet,
  WorkspaceDescriptor,
  WorkspaceHandle,
  PublishCommand,
  PushCommand,
  RetentionPolicy,
} from "./models.js";

export type UnitOfWorkMode = "read" | "write";

/** Runtime identity used to reject accidental cross-transaction composition. */
export interface UnitOfWorkBound {
  readonly unitOfWorkId: string;
}

export interface SnapshotRepository extends UnitOfWorkBound {
  put(snapshot: RuntimeSnapshot, objects?: readonly ObjectRef[]): void;
  get(snapshotId: string, fields?: FieldMask): RuntimeSnapshot;
  list(query?: SnapshotQuery, page?: PageRequest): Page<SnapshotSummary>;
  pin(snapshotId: string, reason: string): void;
}

export interface ObservationRepository extends UnitOfWorkBound {
  append(observation: Observation): void;
  get(observationId: string): Observation;
  list(query?: ObservationQuery, page?: PageRequest): Page<Observation>;
}

export interface RuntimeEventRepository extends UnitOfWorkBound {
  appendBatch(batch: RuntimeEventBatch): void;
  list(query?: RuntimeEventQuery, page?: PageRequest): Page<RuntimeEvent>;
  getTimeline(query?: EventTimelineQuery): EventTimeline;
}

export interface ScreenGraphRepository extends UnitOfWorkBound {
  createGraph(graph: ScreenGraph): ScreenGraph;
  updateGraph(graph: ScreenGraph, precondition: RevisionPrecondition): ScreenGraph;
  getGraph(screenGraphId: string): ScreenGraph;
  tagGraphVersion(selector: VersionSelector, screenGraphId: string): void;
  materialize(query: GraphContext): ScreenGraph;
  getState(screenStateId: string, at?: VersionSelector): ScreenState;
  findPath(query: PathQuery): readonly PathResult[];
  compare(left: VersionSelector, right: VersionSelector): GraphDiff;
  storeIdentityDecision(decision: StateIdentityDecision): void;
}

export interface WikiRepository extends UnitOfWorkBound {
  create(node: WikiNode, precondition?: MutationPrecondition): WikiNode;
  update(node: WikiNode, precondition: RevisionPrecondition): WikiNode;
  get(nodeId: string, at?: VersionSelector): WikiNode;
  listNodes(query?: WikiNodeQuery, page?: PageRequest): Page<WikiNode>;
  link(link: WikiLink, precondition?: MutationPrecondition): WikiLink;
  getLink(linkId: string, at?: VersionSelector): WikiLink;
  unlink(linkId: string, precondition: RevisionPrecondition): void;
  backlinks(nodeId: string, page?: PageRequest): Page<WikiLink>;
  related(ref: ResourceRef, page?: PageRequest): Page<WikiNode>;
  createCollection(collection: KnowledgeCollection): KnowledgeCollection;
  updateCollection(
    collection: KnowledgeCollection,
    precondition: RevisionPrecondition,
  ): KnowledgeCollection;
  getCollection(id: string, at?: VersionSelector): KnowledgeCollection;
  listCollections(
    query?: KnowledgeCollectionQuery,
    page?: PageRequest,
  ): Page<KnowledgeCollection>;
}

export interface DesignReviewRepository extends UnitOfWorkBound {
  createReference(reference: DesignReference): DesignReference;
  updateReference(
    reference: DesignReference,
    precondition: RevisionPrecondition,
  ): DesignReference;
  getReference(id: string, at?: VersionSelector): DesignReference;
  listReferences(page?: PageRequest): Page<DesignReference>;
  createRegionMapping(mapping: DesignRegionMapping): DesignRegionMapping;
  updateRegionMapping(
    mapping: DesignRegionMapping,
    precondition: RevisionPrecondition,
  ): DesignRegionMapping;
  listRegionMappings(
    query?: DesignRegionMappingQuery,
    page?: PageRequest,
  ): Page<DesignRegionMapping>;
  appendComparison(comparison: DesignComparison): void;
  getComparison(id: string): DesignComparison;
  listComparisons(query?: DesignComparisonQuery, page?: PageRequest): Page<DesignComparison>;
  createIssue(issue: ReviewIssue): ReviewIssue;
  updateIssue(issue: ReviewIssue, precondition: RevisionPrecondition): ReviewIssue;
  listIssues(query?: ReviewIssueQuery, page?: PageRequest): Page<ReviewIssue>;
  appendVerification(record: ReviewVerificationRecord): void;
  createPatch(patch: TuningPatch): TuningPatch;
  updatePatch(patch: TuningPatch, precondition: RevisionPrecondition): TuningPatch;
  getPatch(id: string): TuningPatch;
  createApplication(application: TuningApplication): TuningApplication;
  updateApplication(
    application: TuningApplication,
    precondition: RevisionPrecondition,
  ): TuningApplication;
  getApplication(id: string): TuningApplication;
  listActiveApplications(connectionId: string): readonly TuningApplication[];
}

export interface ValidationRepository extends UnitOfWorkBound {
  createRun(run: ValidationRun): ValidationRun;
  updateRun(run: ValidationRun, precondition: RevisionPrecondition): void;
  getRun(runId: string): ValidationRun;
  addFindings(
    run: ValidationRun,
    findings: readonly ValidationFinding[],
    runPrecondition: RevisionPrecondition,
  ): void;
  getFinding(findingId: string): ValidationFinding;
  updateFinding(
    run: ValidationRun,
    finding: ValidationFinding,
    runPrecondition: RevisionPrecondition,
    findingPrecondition: RevisionPrecondition,
  ): void;
  listFindings(
    query?: ValidationFindingQuery,
    page?: PageRequest,
  ): Page<ValidationFinding>;
  suppressFinding(
    run: ValidationRun,
    finding: ValidationFinding,
    suppression: ValidationSuppression,
    runPrecondition: RevisionPrecondition,
    findingPrecondition: RevisionPrecondition,
  ): void;
  appendBuildDiff(diff: BuildDiff): void;
  getBuildDiff(buildDiffId: string): BuildDiff;
}

export interface OperationRepository extends UnitOfWorkBound {
  create(operation: OperationRef, createdEvent: OperationEvent): OperationRecord;
  appendEvents(
    operation: OperationRef,
    events: readonly OperationEvent[],
    expectedNextSequence: number,
    precondition: RevisionPrecondition,
  ): OperationRecord;
  complete(
    operation: OperationRef,
    result: OperationResult,
    terminalEvent: OperationEvent,
    expectedNextSequence: number,
    precondition: RevisionPrecondition,
  ): OperationRecord;
  get(operationId: string): OperationRecord;
  getResult(operationId: string): OperationResult;
  listEvents(operationId: string, afterCursor?: string): Page<OperationEvent>;
}

export interface VersionRepository extends UnitOfWorkBound {
  createWorkingSet(baseCommitId: string): WorkingSet;
  getWorkingSet(workingSetId: string): WorkingSet;
  appendWorkingChanges(
    workingSetId: string,
    changes: readonly WorkingChange[],
    precondition: RevisionPrecondition,
  ): WorkingSet;
  createCommit(manifest: CommitManifest): Commit;
  commitWorkingSetAndUpdateRef(command: CommitWorkingSetCommand): CommitAndRefResult;
  getCommit(commitId: string): Commit;
  listCommits(query?: CommitQuery, page?: PageRequest): Page<Commit>;
  resolveRef(name: string): Ref;
  listRefs(page?: PageRequest): Page<Ref>;
  updateRef(name: string, commitId: string, precondition: RefUpdatePrecondition): Ref;
  createTag(tag: Tag): Tag;
  reachableObjects(commitIds: readonly string[]): Iterable<ObjectRef>;
}

export interface DataUnitOfWork {
  readonly id: string;
  readonly mode: UnitOfWorkMode;
  readonly snapshots: SnapshotRepository;
  readonly observations: ObservationRepository;
  readonly runtimeEvents: RuntimeEventRepository;
  readonly screenGraph: ScreenGraphRepository;
  readonly wiki: WikiRepository;
  readonly designReviews: DesignReviewRepository;
  readonly validation: ValidationRepository;
  readonly operations: OperationRepository;
  readonly versions: VersionRepository;

  assertOwns(...repositories: readonly UnitOfWorkBound[]): void;
  commit(): void;
  rollback(): void;
}

export interface WorkspaceHealth {
  readonly ok: boolean;
  readonly generation: number;
  readonly open_units_of_work: number;
  readonly issues: readonly string[];
}

export interface WorkspaceDataSource {
  /**
   * Records ObjectRefs returned by a successful ObjectStore put before a
   * metadata Unit of Work may reference them. Registration is idempotent;
   * conflicting metadata for one hash is an integrity error.
   */
  registerVerifiedObjects(objects: readonly ObjectRef[]): void;
  beginUnitOfWork(mode: UnitOfWorkMode): DataUnitOfWork;
  checkHealth(): WorkspaceHealth;
  readonly clock: Clock;
}

export interface WorkspaceRepository extends WorkspaceDataSource {
  create(command: CreateWorkspaceData): WorkspaceDescriptor;
  open(workspaceId: string): WorkspaceHandle;
  close(workspaceId: string): void;
  applyMigrations(targetVersion?: number): Promise<MigrationResult>;
  backup(command: BackupWorkspaceCommand): Promise<ObjectRef>;
  compact(command: CompactWorkspaceCommand): CompactWorkspaceResult;
  restore(command: RestoreWorkspaceCommand): Promise<WorkspaceRestoreResult>;
}

export type ByteStream = AsyncIterable<Uint8Array>;

/** Object I/O is asynchronous and always remains outside a metadata Unit of Work. */
export interface ObjectStore {
  put(stream: ByteStream, metadata: ObjectPutMetadata): Promise<ObjectRef>;
  stat(hash: string): Promise<ObjectRef>;
  open(hash: string, range?: ByteRange): Promise<ByteStream>;
  has(hashes: readonly string[]): Promise<ReadonlySet<string>>;
  pin(hash: string, policy: RetentionPolicy): Promise<void>;
  unpin(hash: string, policyId: string): Promise<void>;
  inventory(query?: ObjectInventoryQuery): AsyncIterable<ObjectRef>;
  deletePhysical(hash: string): Promise<void>;
}

export interface SearchIndex {
  index(change: SearchDocumentChange): void;
  search(query: SearchQuery, page?: PageRequest): Page<SearchResult>;
  status(): SearchIndexStatus;
  rebuild(source: SearchRebuildSource): OperationRef;
}

export interface ExchangeService {
  exportPack(command: ExportPackCommand): Promise<ObjectRef>;
  importPack(command: ImportPackCommand): Promise<ImportPackResult>;
  exportReadable(command: ExportReadableCommand): Promise<readonly ObjectRef[]>;
}

export interface SyncClient {
  getStatus(remote: RemoteRef): Promise<SyncStatus>;
  fetch(command: FetchCommand): OperationRef;
  push(command: PushCommand): OperationRef;
  publish(command: PublishCommand): OperationRef;
  subscribe(command: SubscribeCommand): Subscription;
  listConflicts(query: SyncConflictQuery, page?: PageRequest): Page<SyncConflict>;
  resolveConflict(command: ResolveSyncConflictCommand): SyncConflictResolution;
}
