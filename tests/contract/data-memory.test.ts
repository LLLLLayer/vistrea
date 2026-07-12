import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { isDataError } from "../../data/api/index.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type CommitManifest,
  type JsonObject,
  type OperationEvent,
  type OperationRef,
  type OperationResult,
  type ObjectRef,
  type ProtocolSchemaId,
  type ProtocolValidator,
  type RuntimeSnapshot,
  type ValidationFinding,
  type ValidationRun,
  type WikiNode,
  type WorkingChange,
} from "../../data/api/index.js";
import {
  commitIdForManifest,
  createRepositoryProtocolValidator,
  loadPhase0A2FixtureSeed,
  MemoryDataStore,
  SequenceClock,
  SequenceIdGenerator,
  type MemoryDataSeed,
} from "../../data/memory/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const seedPromise = validatorPromise.then((validator) =>
  loadPhase0A2FixtureSeed({ validator, repositoryRoot }),
);

async function fixtureContext(): Promise<{
  validator: ProtocolValidator;
  seed: MemoryDataSeed;
  store: MemoryDataStore;
}> {
  const [validator, seed] = await Promise.all([validatorPromise, seedPromise]);
  return {
    validator,
    seed,
    store: new MemoryDataStore({
      validator,
      seed,
      clock: new SequenceClock("2026-07-12T04:00:00.000Z", 1),
      ids: new SequenceIdGenerator(900),
    }),
  };
}

async function readFixture<T>(
  relativePath: string,
  schemaId: ProtocolSchemaId,
  validator: ProtocolValidator,
): Promise<T> {
  const source = await fs.readFile(
    path.join(repositoryRoot, "protocol/fixtures/v1", relativePath),
    "utf8",
  );
  const value = JSON.parse(source) as unknown;
  validator.assert(schemaId, value);
  return value as T;
}

function expectDataError(code: Parameters<typeof isDataError>[1]): (error: unknown) => boolean {
  return (error: unknown): boolean => isDataError(error, code);
}

test("fixture-backed memory data exposes one canonical fact base", async () => {
  const { seed, store } = await fixtureContext();
  const unit = store.beginUnitOfWork("read");
  const fixtureSnapshot = seed.snapshots?.[0] as RuntimeSnapshot;
  const fixtureGraph = seed.screenGraphs?.[0];
  const fixtureOperation = seed.operationRecords?.[0];

  assert.deepEqual(unit.snapshots.get(fixtureSnapshot.snapshot_id), fixtureSnapshot);
  const summary = unit.snapshots.list().items[0];
  assert.ok(summary !== undefined);
  assert.equal(typeof summary.captured_at, "object");
  assert.equal(typeof summary.captured_at.wall_time, "string");
  // @ts-expect-error EventTime is deliberately not a timestamp string.
  const capturedAtString: string = summary.captured_at;
  assert.notEqual(typeof capturedAtString, "string");
  assert.deepEqual(unit.screenGraph.materialize(fixtureGraph?.context as never), fixtureGraph);
  assert.deepEqual(
    unit.observations.get((seed.observations?.[0] as never as { observation_id: string }).observation_id),
    seed.observations?.[0],
  );
  const eventEpochId = seed.runtimeEventBatches?.[0]?.event_epoch_id as string;
  assert.equal(unit.runtimeEvents.getTimeline({ event_epoch_id: eventEpochId }).events.length, 2);
  assert.deepEqual(
    unit.wiki.get((seed.wikiNodes?.[0] as WikiNode).wiki_node_id),
    seed.wikiNodes?.[0],
  );
  assert.deepEqual(
    unit.designReviews.getReference(seed.designReferences?.[0]?.design_reference_id as string),
    seed.designReferences?.[0],
  );
  assert.deepEqual(
    unit.validation.getRun(seed.validationRuns?.[0]?.validation_run_id as string),
    seed.validationRuns?.[0],
  );
  assert.deepEqual(
    unit.operations.getResult(fixtureOperation?.operation.operation_id as string),
    fixtureOperation?.result,
  );
  assert.equal(unit.versions.resolveRef("teams/im/main").revision, 1);

  const returned = unit.snapshots.get(fixtureSnapshot.snapshot_id);
  assert.equal(Object.isFrozen(returned), true);
  assert.throws(() => {
    (returned as unknown as { snapshot_id: string }).snapshot_id = "mutated";
  }, TypeError);
  unit.rollback();
});

test("repository-backed validation rejects semantic-invalid protocol values", async () => {
  const validator = await validatorPromise;
  const cases = [
    ["graph/invalid/dangling-state-reference.json", PROTOCOL_SCHEMA_IDS.screenGraph],
    [
      "runtime-snapshot/invalid/duplicate-node-id.json",
      PROTOCOL_SCHEMA_IDS.runtimeSnapshot,
    ],
    [
      "runtime-event-batch/invalid/non-increasing.json",
      PROTOCOL_SCHEMA_IDS.runtimeEventBatch,
    ],
  ] as const;

  for (const [relativePath, schemaId] of cases) {
    const value = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, "protocol/fixtures/v1", relativePath), "utf8"),
    ) as unknown;
    assert.throws(() => validator.assert(schemaId, value), expectDataError("invalid_argument"));
  }
});

test("Snapshot ObjectRefs must be verified and explicitly associated before visibility", async () => {
  const { validator, store } = await fixtureContext();
  const snapshot = await readFixture<RuntimeSnapshot>(
    "runtime-snapshot/valid/partial-screenshot.json",
    PROTOCOL_SCHEMA_IDS.runtimeSnapshot,
    validator,
  );
  const screenshot = snapshot["screenshot"] as JsonObject;
  const object = screenshot["object"] as ObjectRef;

  const unverified = store.beginUnitOfWork("write");
  assert.throws(() => unverified.snapshots.put(snapshot), expectDataError("integrity_error"));
  assert.throws(
    () => unverified.snapshots.get(snapshot.snapshot_id),
    expectDataError("not_found"),
  );
  unverified.rollback();

  store.registerVerifiedObjects([object]);
  const unassociated = store.beginUnitOfWork("write");
  assert.throws(
    () => unassociated.snapshots.put(snapshot),
    expectDataError("integrity_error"),
  );
  assert.throws(
    () => unassociated.snapshots.get(snapshot.snapshot_id),
    expectDataError("not_found"),
  );
  unassociated.rollback();

  const accepted = store.beginUnitOfWork("write");
  accepted.snapshots.put(snapshot, [object]);
  accepted.commit();
  const reopened = store.beginUnitOfWork("read");
  assert.deepEqual(reopened.snapshots.get(snapshot.snapshot_id), snapshot);
  reopened.rollback();
});

test("Unit of Work binding, read-only mode, rollback, and read snapshots are enforced", async () => {
  const { seed, store } = await fixtureContext();
  const node = seed.wikiNodes?.[0] as WikiNode;
  const readBefore = store.beginUnitOfWork("read");
  const write = store.beginUnitOfWork("write");

  write.assertOwns(write.wiki, write.versions);
  assert.throws(() => write.assertOwns(readBefore.wiki), expectDataError("conflict"));
  assert.throws(
    () => readBefore.snapshots.pin((seed.snapshots?.[0] as RuntimeSnapshot).snapshot_id, "test"),
    expectDataError("conflict"),
  );

  const rolledBack = {
    ...node,
    revision: node.revision + 1,
    title: "Rolled back title",
  } as WikiNode;
  write.wiki.update(rolledBack, { expected_revision: node.revision });
  write.rollback();

  const afterRollback = store.beginUnitOfWork("read");
  assert.equal(afterRollback.wiki.get(node.wiki_node_id)["title"], node["title"]);
  afterRollback.rollback();

  const committedWrite = store.beginUnitOfWork("write");
  const committed = {
    ...node,
    revision: node.revision + 1,
    title: "Committed title",
  } as WikiNode;
  committedWrite.wiki.update(committed, { expected_revision: node.revision });
  committedWrite.commit();

  assert.equal(readBefore.wiki.get(node.wiki_node_id)["title"], node["title"]);
  readBefore.rollback();
  const readAfter = store.beginUnitOfWork("read");
  assert.equal(readAfter.wiki.get(node.wiki_node_id)["title"], "Committed title");
  readAfter.rollback();
});

test("revisioned resources require creation at 1 and exact N plus 1 updates", async () => {
  const { seed, store } = await fixtureContext();
  const node = seed.wikiNodes?.[0] as WikiNode;
  const write = store.beginUnitOfWork("write");

  const jump = { ...node, revision: node.revision + 2 } as WikiNode;
  assert.throws(
    () => write.wiki.update(jump, { expected_revision: node.revision }),
    expectDataError("conflict"),
  );
  assert.equal(write.wiki.get(node.wiki_node_id).revision, node.revision);

  const next = { ...node, revision: node.revision + 1, title: "Revision two" } as WikiNode;
  write.wiki.update(next, { expected_revision: node.revision });
  assert.throws(
    () => write.wiki.update({ ...next, revision: next.revision + 1 } as WikiNode, {
      expected_revision: node.revision,
    }),
    expectDataError("conflict"),
  );
  write.commit();

  const duplicate = store.beginUnitOfWork("write");
  const observation = seed.observations?.[0];
  assert.throws(
    () => duplicate.observations.append(observation as never),
    expectDataError("already_exists"),
  );
  duplicate.rollback();
});

test("Operation create, event append, and typed completion are one durable lifecycle", async () => {
  const { seed, store } = await fixtureContext();
  const operationId = "operation_019f0000-0000-7000-8000-000000000901";
  const createdAt = "2026-07-12T06:00:00.000Z";
  const queued = {
    operation_id: operationId,
    kind: "RunValidation",
    state: "queued",
    created_at: createdAt,
    updated_at: createdAt,
  } as OperationRef;
  const created = {
    event_id: "operationevent_019f0000-0000-7000-8000-000000000901",
    operation_id: operationId,
    sequence: 1,
    time: createdAt,
    kind: "created",
    state: "queued",
    extensions: {},
  } as unknown as OperationEvent;

  const write = store.beginUnitOfWork("write");
  assert.equal(write.operations.create(queued, created).revision, 1);
  const running = {
    ...queued,
    state: "running",
    updated_at: "2026-07-12T06:00:01.000Z",
  } as OperationRef;
  const started = {
    event_id: "operationevent_019f0000-0000-7000-8000-000000000902",
    operation_id: operationId,
    sequence: 2,
    time: "2026-07-12T06:00:01.000Z",
    kind: "started",
    state: "running",
    extensions: {},
  } as unknown as OperationEvent;
  assert.throws(
    () => write.operations.appendEvents(running, [started], 3, { expected_revision: 1 }),
    expectDataError("conflict"),
  );
  assert.equal(
    write.operations.appendEvents(running, [started], 2, { expected_revision: 1 }).revision,
    2,
  );

  const succeeded = {
    ...queued,
    state: "succeeded",
    updated_at: "2026-07-12T06:00:02.000Z",
  } as OperationRef;
  const terminal = {
    event_id: "operationevent_019f0000-0000-7000-8000-000000000903",
    operation_id: operationId,
    sequence: 3,
    time: "2026-07-12T06:00:02.000Z",
    kind: "succeeded",
    state: "succeeded",
    extensions: {},
  } as unknown as OperationEvent;
  const resultValue = seed.validationRuns?.[0];
  assert.ok(resultValue !== undefined);
  const result = {
    operation_id: operationId,
    result_type: "ValidationRun",
    schema_id: PROTOCOL_SCHEMA_IDS.validationRun,
    storage: "inline",
    value: resultValue,
  } as unknown as OperationResult;
  const completed = write.operations.complete(succeeded, result, terminal, 3, {
    expected_revision: 2,
  });
  assert.equal(completed.revision, 3);
  assert.deepEqual(completed.result, result);
  write.commit();

  const reopened = store.beginUnitOfWork("read");
  assert.deepEqual(reopened.operations.getResult(operationId), result);
  assert.deepEqual(
    reopened.operations.listEvents(operationId).items.map((event) => event.sequence),
    [1, 2, 3],
  );
  reopened.rollback();
});

test("Validation Finding changes and Run summary counts commit atomically", async () => {
  const { seed, store } = await fixtureContext();
  const currentRun = seed.validationRuns?.[0] as ValidationRun;
  const currentFinding = seed.validationFindings?.[0] as ValidationFinding;
  const findingRecord = structuredClone(currentFinding) as unknown as Record<string, unknown>;
  delete findingRecord["active_suppression_id"];
  Object.assign(findingRecord, {
    status: "resolved",
    resolved_at: "2026-07-12T02:22:00.000Z",
    updated_at: "2026-07-12T02:22:00.000Z",
    revision: currentFinding.revision + 1,
  });
  const resolvedFinding = findingRecord as unknown as ValidationFinding;
  const correctRun = {
    ...currentRun,
    revision: currentRun.revision + 1,
    updated_at: "2026-07-12T02:22:00.000Z",
    finding_counts: {
      total: 1,
      open: 0,
      suppressed: 0,
      resolved: 1,
      by_severity: { info: 0, warning: 1, error: 0, critical: 0 },
    },
  } as ValidationRun;
  const incorrectRun = {
    ...correctRun,
    finding_counts: currentRun.finding_counts,
  } as ValidationRun;

  const write = store.beginUnitOfWork("write");
  assert.throws(
    () =>
      write.validation.updateFinding(
        incorrectRun,
        resolvedFinding,
        { expected_revision: currentRun.revision },
        { expected_revision: currentFinding.revision },
      ),
    expectDataError("conflict"),
  );
  assert.equal(write.validation.getFinding(currentFinding.finding_id).status, "suppressed");
  write.validation.updateFinding(
    correctRun,
    resolvedFinding,
    { expected_revision: currentRun.revision },
    { expected_revision: currentFinding.revision },
  );
  write.commit();

  const reopened = store.beginUnitOfWork("read");
  assert.equal(reopened.validation.getFinding(currentFinding.finding_id).status, "resolved");
  assert.equal(reopened.validation.getRun(currentRun.validation_run_id).finding_counts.resolved, 1);
  reopened.rollback();
});

test("Working Set commit and Ref CAS are atomic and preserve drafts on conflict", async () => {
  const { validator, seed, store } = await fixtureContext();
  const initialCommit = seed.commits?.[0];
  const workingSet = seed.workingSets?.[0];
  const currentRef = seed.refs?.[0];
  assert.ok(initialCommit !== undefined && workingSet !== undefined && currentRef !== undefined);
  const change = await readFixture<WorkingChange>(
    "working-change/valid/upsert-screen.json",
    PROTOCOL_SCHEMA_IDS.workingChange,
    validator,
  );
  store.registerVerifiedObjects([change.payload as never]);

  const write = store.beginUnitOfWork("write");
  const updatedWorkingSet = write.versions.appendWorkingChanges(
    workingSet.working_set_id,
    [change],
    { expected_revision: workingSet.revision },
  );
  const manifest = {
    ...initialCommit.manifest,
    parents: [initialCommit.commit_id],
    created_at: "2026-07-12T07:00:00.000Z",
    message: "Commit the fixture-backed screen change.",
    object_hashes: [
      ...initialCommit.manifest.object_hashes,
      (change.payload as never as { hash: string }).hash,
    ],
  } as CommitManifest;
  validator.assert(PROTOCOL_SCHEMA_IDS.commitManifest, manifest);
  const result = write.versions.commitWorkingSetAndUpdateRef({
    working_set_id: updatedWorkingSet.working_set_id,
    working_set_precondition: { expected_revision: updatedWorkingSet.revision },
    manifest,
    target_ref_name: currentRef.name,
    ref_precondition: {
      mode: "must_match",
      expected_commit_id: currentRef.commit_id,
    } as never,
  });
  assert.equal(result.ref.commit_id, result.commit.commit_id);
  assert.equal(result.ref.revision, currentRef.revision + 1);
  write.commit();

  const conflicting = store.beginUnitOfWork("write");
  const conflictingManifest = {
    ...manifest,
    created_at: "2026-07-12T07:00:01.000Z",
    message: "This commit must remain invisible after Ref conflict.",
  } as CommitManifest;
  const invisibleCommitId = commitIdForManifest(conflictingManifest);
  assert.throws(
    () =>
      conflicting.versions.commitWorkingSetAndUpdateRef({
        working_set_id: updatedWorkingSet.working_set_id,
        working_set_precondition: { expected_revision: updatedWorkingSet.revision },
        manifest: conflictingManifest,
        target_ref_name: currentRef.name,
        ref_precondition: {
          mode: "must_match",
          expected_commit_id: currentRef.commit_id,
        } as never,
      }),
    expectDataError("conflict"),
  );
  assert.throws(() => conflicting.versions.getCommit(invisibleCommitId), expectDataError("not_found"));
  assert.equal(
    conflicting.versions.getWorkingSet(updatedWorkingSet.working_set_id).revision,
    updatedWorkingSet.revision,
  );

  // Forced moves fail closed until the protected-ref policy layer exists.
  assert.throws(
    () =>
      conflicting.versions.updateRef(currentRef.name, initialCommit.commit_id, {
        mode: "force",
        authorization: { kind: "review_issue", id: "issue_019f0000-0000-7000-8000-000000000001" },
      } as never),
    expectDataError("unsupported"),
  );
  conflicting.rollback();
});

test("concurrent writers conflict instead of losing an atomic transaction", async () => {
  const { seed, store } = await fixtureContext();
  const snapshotId = (seed.snapshots?.[0] as RuntimeSnapshot).snapshot_id;
  const first = store.beginUnitOfWork("write");
  const second = store.beginUnitOfWork("write");
  first.snapshots.pin(snapshotId, "first writer");
  second.snapshots.pin(snapshotId, "second writer");
  first.commit();
  assert.throws(() => second.commit(), expectDataError("conflict"));
  assert.equal(store.checkHealth().generation, 1);
});

test("deterministic clocks and IDs make fixture consumers reproducible", async () => {
  const [firstContext, secondContext] = await Promise.all([fixtureContext(), fixtureContext()]);
  const baseCommitId = firstContext.seed.commits?.[0]?.commit_id as string;
  const first = firstContext.store.beginUnitOfWork("write");
  const second = secondContext.store.beginUnitOfWork("write");
  const firstWorkingSet = first.versions.createWorkingSet(baseCommitId);
  const secondWorkingSet = second.versions.createWorkingSet(baseCommitId);
  assert.deepEqual(firstWorkingSet, secondWorkingSet);
  first.rollback();
  second.rollback();
});
