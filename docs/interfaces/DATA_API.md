# Data API Ports

## 1. Purpose

`data/api` defines storage ports consumed by Host Engine use cases. Concrete implementations may use SQLite, local files, in-memory fixtures, remote objects, or Vistrea Hub without changing product behavior.

Canonical persisted and exchanged values are frozen by [`DATA_MODEL_COVERAGE.md`](../protocol/DATA_MODEL_COVERAGE.md) and `protocol/model-coverage/v1.json`. Phase 0B may define language-owned query, command, page, mask, and transaction types around those values, but it cannot redefine them.

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
  registerVerifiedObjects(objects: ObjectRef[]): void;
  beginUnitOfWork(mode: "read" | "write"): DataUnitOfWork;
  checkHealth(): WorkspaceHealth;
  applyMigrations(target_version?: uint32): Promise<MigrationResult>;
  backup(command: BackupWorkspaceCommand): Promise<ObjectRef>;
  compact(command: CompactWorkspaceCommand): CompactWorkspaceResult;
  restore(command: RestoreWorkspaceCommand): Promise<WorkspaceRestoreResult>;
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
- `registerVerifiedObjects` records only canonical metadata returned by a successful Object Store write. It is idempotent for equal values, rejects conflicting metadata for one hash, and does not by itself make an Object reachable from a Snapshot, Working Set, or Commit.
- Revisioned creates and updates follow the shared `1`, `N`, `N + 1` rule in `COMMON_CONTRACTS.md`; repositories reject stale preconditions and submitted revision jumps.

### Workspace lifecycle maintenance

The production local composition implements the lifecycle boundary through
`LocalDataWorkspace` while the manifest/bootstrap portion of the complete
`WorkspaceRepository` remains separate:

- `backup` is the only maintenance operation allowed while the Workspace is
  open. It refuses active Units of Work and temporarily rejects new Units of
  Work and ObjectRef registration, uses SQLite's online backup API,
  independently runs schema, ledger, `quick_check`, foreign-key, catalog, and
  metadata validation, then stores and pins the resulting ObjectRef. The result
  is a metadata recovery point: while retained, its complete reachable
  ObjectRef closure is also a GC root.
- Opening an existing older schema creates that verified and pinned backup
  before synchronously authorizing any migration SQL. A failed migration rolls
  the complete batch back and keeps the recovery object.
- `restore` is offline and lock-exclusive. Before creating a journal or changing
  `metadata.sqlite`, it verifies the stored backup plus the existence, payload
  hash, and canonical catalog metadata of every reachable ObjectRef. It
  preserves the old database/WAL/SHM files under `.recovery/` and uses a durable
  restore journal. Normal open refuses an interrupted restore until explicit
  recovery rolls the preserved files back.
- local garbage collection is offline, dry-run by default, and applies a
  minimum-age grace period. Its mark set includes every live metadata ObjectRef,
  Commit ancestry rooted by Refs, Tags, Working Sets and live resources, plus
  active Object Store retention policies and the reachable closure of every
  retained Workspace metadata backup. A dry run returns `plan_digest` for the
  exact generation, catalog cleanup, and physical deletion plan. Destructive
  collection requires that value from the immediately preceding matching dry
  run as `expected_plan_digest` and fails with a retryable conflict when
  recomputation differs. Catalog rows are removed only after a same-transaction
  reachability recheck and before physical deletion, so a crash can leave a
  repairable unregistered orphan but never a registered missing payload.
- stale `.host.lock` recovery is explicit and succeeds only for a valid lock
  whose PID is definitely absent. The original lock is retained as recovery
  evidence; live, inaccessible, malformed, or symlinked locks fail closed.

Explicit pack and readable exports receive indefinite retention policies.
Unreferenced capture payloads remain unpinned and become GC candidates after
the grace period. `ObjectStore.unpin(hash, policy_id)` explicitly releases a
named policy, after which the ordinary reachability and age rules decide
whether GC may delete the object.

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
  update(node: WikiNode, precondition: RevisionPrecondition): WikiNode;
  get(node_id: string, at?: VersionSelector): WikiNode;
  link(link: WikiLink, precondition?: MutationPrecondition): WikiLink;
  getLink(link_id: string, at?: VersionSelector): WikiLink;
  unlink(link_id: string, precondition: RevisionPrecondition): void;
  backlinks(node_id: string, page?: PageRequest): Page<WikiLink>;
  related(ref: ResourceRef, page?: PageRequest): Page<WikiNode>;
  createCollection(collection: KnowledgeCollection): KnowledgeCollection;
  updateCollection(
    collection: KnowledgeCollection,
    precondition: RevisionPrecondition
  ): KnowledgeCollection;
  getCollection(id: string, at?: VersionSelector): KnowledgeCollection;
  listCollections(query: KnowledgeCollectionQuery): Page<KnowledgeCollection>;
}
```

`unlink` removes the live link and persists its next-revision deletion evidence in the same Unit of Work. The owning Engine command includes that deletion in its Working Set/Commit; a historical version can still reconstruct the prior link.

Knowledge Collection publication writes a canonical `KnowledgeGraph` bundle to the Object Store first, registers its verified `ObjectRef`, then creates a Working Set, Commit, CAS Ref update, and published Collection projection in one metadata Unit of Work. The bundle contains the pre-publication draft Collection so its own `commit_id` never creates a circular content hash; the mutable projection carries the returned Commit/Ref identity.

## 6. Design review port

```ts
interface DesignReviewRepository {
  createReference(reference: DesignReference): DesignReference;
  updateReference(
    reference: DesignReference,
    precondition: RevisionPrecondition
  ): DesignReference;
  getReference(id: string, at?: VersionSelector): DesignReference;
  createRegionMapping(mapping: DesignRegionMapping): DesignRegionMapping;
  updateRegionMapping(
    mapping: DesignRegionMapping,
    precondition: RevisionPrecondition
  ): DesignRegionMapping;
  listRegionMappings(query: DesignRegionMappingQuery): Page<DesignRegionMapping>;
  appendComparison(comparison: DesignComparison): void;
  getComparison(id: string): DesignComparison;
  createIssue(issue: ReviewIssue): ReviewIssue;
  updateIssue(issue: ReviewIssue, precondition: RevisionPrecondition): ReviewIssue;
  listIssues(query: ReviewIssueQuery, page?: PageRequest): Page<ReviewIssue>;
  appendVerification(record: ReviewVerificationRecord): void;
  createPatch(patch: TuningPatch): TuningPatch;
  updatePatch(patch: TuningPatch, precondition: RevisionPrecondition): TuningPatch;
  getPatch(id: string): TuningPatch;
  createApplication(application: TuningApplication): TuningApplication;
  updateApplication(
    application: TuningApplication,
    precondition: RevisionPrecondition
  ): TuningApplication;
  getApplication(id: string): TuningApplication;
  listActiveApplications(connection_id: string): TuningApplication[];
}
```

Design Comparisons and Verification Records are immutable evidence. References, mappings, Review Issues, Tuning Patches, and Tuning Applications are revisioned mutable resources and require optimistic concurrency after creation.

`ReviewIssueQuery.screen_state_id` restricts results to issues whose `runtime_target.snapshot_id` appears in an Observation owned by that Screen State. This is a Data-port query, not a Studio-side approximation, so in-memory and SQLite Workspaces return identical state-scoped issue sets.

## 7. Validation and operation ports

```ts
interface ValidationRepository {
  createRun(run: ValidationRun): ValidationRun;
  updateRun(run: ValidationRun, precondition: RevisionPrecondition): void;
  getRun(run_id: string): ValidationRun;
  addFindings(
    run: ValidationRun,
    findings: ValidationFinding[],
    run_precondition: RevisionPrecondition
  ): void;
  getFinding(finding_id: string): ValidationFinding;
  updateFinding(
    run: ValidationRun,
    finding: ValidationFinding,
    run_precondition: RevisionPrecondition,
    finding_precondition: RevisionPrecondition
  ): void;
  listFindings(query: ValidationFindingQuery, page?: PageRequest): Page<ValidationFinding>;
  suppressFinding(
    run: ValidationRun,
    finding: ValidationFinding,
    suppression: ValidationSuppression,
    run_precondition: RevisionPrecondition,
    finding_precondition: RevisionPrecondition
  ): void;
  appendBuildDiff(diff: BuildDiff): void;
  getBuildDiff(build_diff_id: string): BuildDiff;
}

interface OperationRepository {
  create(operation: OperationRef, created_event: OperationEvent): OperationRecord;
  appendEvents(
    operation: OperationRef,
    events: OperationEvent[],
    expected_next_sequence: JsonSafeUInt,
    precondition: RevisionPrecondition
  ): OperationRecord;
  complete(
    operation: OperationRef,
    result: OperationResult<JsonValue>,
    terminal_event: OperationEvent,
    expected_next_sequence: JsonSafeUInt,
    precondition: RevisionPrecondition
  ): OperationRecord;
  get(operation_id: string): OperationRecord;
  getResult(operation_id: string): OperationResult<JsonValue>;
  listEvents(operation_id: string, after_cursor?: string): Page<OperationEvent>;
}
```

`create` atomically persists the queued Operation and its sequence-one `created` event. `appendEvents` atomically updates the Operation summary and appends a contiguous event suffix; it may persist running, failed, or cancelled state but cannot set `succeeded`. `complete` atomically persists the terminal succeeded state, its final event, and exactly one typed completion result. The record revision and expected next sequence prevent concurrent writers from forking one event stream. A succeeded operation without a readable result is integrity-invalid. Operation state, result, and events survive process restart.

`ValidationRun.finding_counts` is the current summary at the Run revision, not a frozen completion snapshot. `addFindings`, every Finding status or severity update, and `suppressFinding` therefore update the affected Findings plus Run counts/revision/timestamp in one Unit of Work. Both Run and existing Finding revisions are compare-and-set inputs; callers cannot mutate a Finding independently and leave the summary stale.

`updateRun` changes lifecycle fields but cannot independently overwrite `finding_counts`; the repository derives and verifies those counts from the same transaction snapshot.

## 8. Version port

```ts
interface VersionRepository {
  createWorkingSet(base_commit_id: string): WorkingSet;
  getWorkingSet(working_set_id: string): WorkingSet;
  appendWorkingChanges(
    working_set_id: string,
    changes: WorkingChange[],
    precondition: RevisionPrecondition
  ): WorkingSet;
  createCommit(manifest: CommitManifest): Commit;
  commitWorkingSetAndUpdateRef(command: CommitWorkingSetCommand): CommitAndRefResult;
  getCommit(commit_id: string): Commit;
  listCommits(query: CommitQuery, page?: PageRequest): Page<Commit>;
  resolveRef(name: string): Ref;
  updateRef(name: string, commit_id: string, precondition: RefUpdatePrecondition): Ref;
  createTag(tag: Tag): Tag;
  reachableObjects(commit_ids: string[]): AsyncIterable<ObjectRef>;
}
```

Commits are immutable. A Working Set is mutable draft state rooted at one base commit. `commitWorkingSetAndUpdateRef` verifies referenced objects, creates the canonical commit, and compare-and-set updates the target ref in one metadata transaction. A ref conflict leaves the Working Set intact.

```ts
type RefUpdatePrecondition =
  | { mode: "must_match"; expected_commit_id: string }
  | { mode: "must_not_exist" }
  | { mode: "force"; authorization: ResourceRef };
```

Normal authoring uses `must_match` or `must_not_exist`. `force` is never an omitted precondition: it requires an explicit protected-ref policy decision and a `ResourceRef` to an auditable authorization record. Until that policy layer exists, implementations reject `force` with `unsupported` instead of trusting an unverifiable authorization reference.

## 9. Object Store port

```ts
interface ObjectStore {
  put(stream: ByteStream, metadata: ObjectPutMetadata): Promise<ObjectRef>;
  stat(hash: string): Promise<ObjectRef>;
  open(hash: string, range?: ByteRange): Promise<ByteStream>;
  has(hashes: readonly string[]): Promise<ReadonlySet<string>>;
  pin(hash: string, policy: RetentionPolicy): Promise<void>;
  unpin(hash: string, policy_id: string): Promise<void>;
  inventory(query?: ObjectInventoryQuery): AsyncIterable<ObjectRef>;
  deletePhysical(hash: string): Promise<void>;
}
```

`put` hashes the exact encoded byte stream and verifies `expected_hash` before
success. Compression and optional encryption descriptors remain immutable
`ObjectRef` metadata; neither changes encoded-byte identity. `unpin` releases
only the named policy and is idempotent; it never deletes bytes. The Object
Store does not decide reachability. Offline Workspace GC computes protected
hashes from live metadata, Commit roots and ancestry, Working Sets, retention
policy, and object age, then invokes the internal `deletePhysical` operation.

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

`ExportReadableCommand` names one published `collection_id` and an optional unique subset of `markdown` and `html`. The exporter resolves the Collection's immutable Commit `wiki` root, verifies its bytes and canonical protocol value, and writes deterministic readable objects; it never renders mutable draft state.

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
- migration forward compatibility and recovery;
- durable operation completion and typed-result recovery after restart.
