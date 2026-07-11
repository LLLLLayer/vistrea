# Data API Ports

## 1. Purpose

`data/api` defines storage ports consumed by Host Engine use cases. Concrete implementations may use SQLite, local files, in-memory fixtures, remote objects, or Vistrea Hub without changing product behavior.

## 2. Unit of Work and transaction model

```ts
interface DataUnitOfWork {
  snapshots: SnapshotRepository;
  observations: ObservationRepository;
  runtimeEvents: RuntimeEventRepository;
  screenGraph: ScreenGraphRepository;
  wiki: WikiRepository;
  designReviews: DesignReviewRepository;
  validation: ValidationRepository;
  operations: OperationRepository;
  versions: VersionRepository;

  commit(): void;
  rollback(): void;
}

interface WorkspaceRepository {
  create(command: CreateWorkspaceData): WorkspaceDescriptor;
  open(workspace_id: string): WorkspaceHandle;
  close(workspace_id: string): void;
  beginUnitOfWork(mode: "read" | "write"): DataUnitOfWork;
  checkHealth(): WorkspaceHealth;
  applyMigrations(target_version?: uint32): MigrationResult;
  backup(command: BackupWorkspaceCommand): ObjectRef;
  compact(command: CompactWorkspaceCommand): CompactWorkspaceResult;
  restore(command: RestoreWorkspaceCommand): WorkspaceDescriptor;
}
```

- `create` atomically initializes the Workspace Manifest, a parentless genesis Commit, and the configured default ref. Its returned descriptor includes the genesis Commit ID and resolved default Ref.
- A Workspace import either completes an equivalent bootstrap from a verified imported root or leaves no visible Workspace.
- Every repository obtained from one `DataUnitOfWork` is bound to the same metadata transaction and consistent read snapshot.
- Repository instances from different units of work must never be mixed in one atomic Engine command.
- One logical Engine command uses one explicit unit of work when atomicity is required.
- Large Object Store writes complete and verify before metadata references become visible.
- A failed metadata transaction must not expose partial graph, issue, patch, or ref updates.
- Object writes that succeed before a metadata rollback become unreachable candidates and are reclaimed later by Workspace GC.

## 3. Snapshot and observation ports

```ts
interface SnapshotRepository {
  put(snapshot: RuntimeSnapshot, objects: ObjectRef[]): void;
  get(snapshot_id: string, fields?: FieldMask): RuntimeSnapshot;
  list(query: SnapshotQuery, page?: PageRequest): Page<SnapshotSummary>;
  pin(snapshot_id: string, reason: string): void;
}

interface ObservationRepository {
  append(observation: Observation): void;
  get(observation_id: string): Observation;
  list(query: ObservationQuery, page?: PageRequest): Page<Observation>;
}

interface RuntimeEventRepository {
  appendBatch(batch: RuntimeEventBatch): void;
  list(query: RuntimeEventQuery, page?: PageRequest): Page<RuntimeEvent>;
  getTimeline(query: EventTimelineQuery): EventTimeline;
}
```

Observations and captured Snapshots are immutable. Corrections create a new record that supersedes or annotates the old record.

## 4. Screen graph port

```ts
interface ScreenGraphRepository {
  materialize(query: GraphContext): ScreenGraph;
  getState(screen_state_id: string, at?: VersionSelector): ScreenState;
  findPath(query: PathQuery): PathResult[];
  compare(left: VersionSelector, right: VersionSelector): GraphDiff;
  storeIdentityDecision(decision: StateIdentityDecision): void;
}
```

Graph materialization is derived from immutable observations plus explicit identity decisions. Missing observation is not automatic deletion.

## 5. Deep Wiki port

```ts
interface WikiRepository {
  create(node: WikiNode, precondition?: MutationPrecondition): WikiNode;
  update(node: WikiNode, precondition: MutationPrecondition): WikiNode;
  get(node_id: string, at?: VersionSelector): WikiNode;
  link(link: WikiLink, precondition?: MutationPrecondition): WikiLink;
  unlink(link_id: string, precondition: MutationPrecondition): void;
  backlinks(node_id: string, page?: PageRequest): Page<WikiLink>;
  related(ref: ResourceRef, page?: PageRequest): Page<WikiNode>;
  putCollection(collection: KnowledgeCollection): void;
  getCollection(id: string, at?: VersionSelector): KnowledgeCollection;
  listCollections(query: KnowledgeCollectionQuery): Page<KnowledgeCollection>;
}
```

## 6. Design review port

```ts
interface DesignReviewRepository {
  putReference(reference: DesignReference): void;
  getReference(id: string, at?: VersionSelector): DesignReference;
  createIssue(issue: ReviewIssue): ReviewIssue;
  updateIssue(issue: ReviewIssue, precondition: MutationPrecondition): ReviewIssue;
  listIssues(query: ReviewIssueQuery, page?: PageRequest): Page<ReviewIssue>;
  appendVerification(record: ReviewVerificationRecord): void;
  putRegionMapping(mapping: DesignRegionMapping): void;
  listRegionMappings(query: DesignRegionMappingQuery): Page<DesignRegionMapping>;
  putPatch(patch: TuningPatch): void;
  getPatch(id: string): TuningPatch;
}
```

## 7. Validation and operation ports

```ts
interface ValidationRepository {
  putRun(run: ValidationRun): void;
  updateRun(run: ValidationRun, precondition: MutationPrecondition): void;
  getRun(run_id: string): ValidationRun;
  putFindings(findings: ValidationFinding[]): void;
  listFindings(query: ValidationFindingQuery, page?: PageRequest): Page<ValidationFinding>;
  putSuppression(suppression: ValidationSuppression): void;
}

interface OperationRepository {
  create(operation: OperationRef): void;
  update(operation: OperationRef, precondition: MutationPrecondition): void;
  complete(
    operation: OperationRef,
    result: OperationResult<JsonValue>,
    precondition: MutationPrecondition
  ): void;
  get(operation_id: string): OperationRef;
  getResult(operation_id: string): OperationResult<JsonValue>;
  appendEvents(events: OperationEvent[]): void;
  listEvents(operation_id: string, after_cursor?: string): Page<OperationEvent>;
}
```

`complete` atomically persists the terminal succeeded state and exactly one typed completion result in the same Unit of Work. A succeeded operation without a readable result is integrity-invalid. Progress updates cannot set `succeeded`; failures persist their terminal `OperationRef.error`. Operation state, result, and events survive process restart.

## 8. Version port

```ts
interface VersionRepository {
  createWorkingSet(base_commit_id: string): WorkingSet;
  getWorkingSet(working_set_id: string): WorkingSet;
  appendWorkingChanges(working_set_id: string, changes: WorkingChange[]): void;
  createCommit(manifest: CommitManifest): Commit;
  commitWorkingSetAndUpdateRef(command: CommitWorkingSetCommand): CommitAndRefResult;
  getCommit(commit_id: string): Commit;
  listCommits(query: CommitQuery, page?: PageRequest): Page<Commit>;
  resolveRef(name: string): Ref;
  updateRef(name: string, commit_id: string, precondition: RefUpdatePrecondition): Ref;
  createTag(name: string, commit_id: string): Tag;
  reachableObjects(commit_ids: string[]): AsyncIterable<ObjectRef>;
}
```

Commits are immutable. A Working Set is mutable draft state rooted at one base commit. `commitWorkingSetAndUpdateRef` verifies referenced objects, creates the canonical commit, and compare-and-set updates the target ref in one metadata transaction. A ref conflict leaves the Working Set intact.

```ts
type RefUpdatePrecondition =
  | { mode: "must_match"; expected_commit_id: string }
  | { mode: "must_not_exist" }
  | { mode: "force"; authorization: ForceRefAuthorization };
```

Normal authoring uses `must_match` or `must_not_exist`. `force` is never an omitted precondition: it requires an explicit protected-ref policy decision and an auditable authorization token.

## 9. Object Store port

```ts
interface ObjectStore {
  put(stream: ByteStream, metadata: ObjectMetadata): ObjectRef;
  stat(hash: string): ObjectMetadata;
  open(hash: string, range?: ByteRange): ByteStream;
  has(hashes: string[]): Set<string>;
  pin(hash: string, policy: RetentionPolicy): void;
  inventory(query?: ObjectInventoryQuery): AsyncIterable<ObjectRef>;
  deletePhysical(hash: string): void;
}
```

`put` verifies the content hash before success. The Object Store does not decide reachability. Workspace Engine GC computes protected hashes from Version Repository refs, commits, pins, Working Sets, and retention policy, then invokes the internal `deletePhysical` operation.

## 10. Search port

```ts
interface SearchIndex {
  index(change: SearchDocumentChange): void;
  search(query: SearchQuery, page?: PageRequest): Page<SearchResult>;
  status(): SearchIndexStatus;
  rebuild(source: SearchRebuildSource): OperationRef;
}
```

Search is derived. Failure or deletion of the index must not lose authoritative knowledge.

## 11. Exchange and sync ports

```ts
interface ExchangeService {
  exportPack(command: ExportPackCommand): ObjectRef;
  importPack(command: ImportPackCommand): ImportPackResult;
  exportReadable(command: ExportReadableCommand): ObjectRef[];
}

interface SyncClient {
  getStatus(remote: RemoteRef): SyncStatus;
  fetch(command: FetchCommand): OperationRef;
  push(command: PushCommand): OperationRef;
  publish(command: PublishCommand): OperationRef;
  subscribe(command: SubscribeCommand): Subscription;
  listConflicts(query: SyncConflictQuery): Page<SyncConflict>;
  resolveConflict(command: ResolveSyncConflictCommand): SyncConflictResolution;
}
```

Pack and sync use the same Commit Manifest and ObjectRef formats.

## 12. In-memory test implementations

Every Data API port should provide a deterministic fixture-backed in-memory implementation before platform consumers begin. Fakes must enforce the same immutability, optimistic concurrency, and error semantics as production implementations.

## 13. Required contract tests

- transaction atomicity;
- repository binding to one Unit of Work;
- immutable Observation and Commit behavior;
- Working Set commit plus ref compare-and-set behavior;
- optimistic ref and Review Issue conflicts;
- object hash integrity and range reads;
- graph materialization from fixtures;
- search rebuildability;
- export/import round trip;
- sync missing-object negotiation;
- migration forward compatibility and recovery.
- durable operation completion and typed-result recovery after restart.
