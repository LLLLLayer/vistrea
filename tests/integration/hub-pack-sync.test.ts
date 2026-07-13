import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { test, type TestContext } from "node:test";

import {
  isDataError,
  type JsonObject,
  type ObjectRef,
} from "../../data/api/index.js";
import { createRepositoryProtocolValidator, MemoryDataStore } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import { HubPackSync, type HubRemote } from "../../data/sync/index.js";
import { startHubServer } from "../../services/hub/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const PROJECT_ID = "project_019f0000-0000-7000-8000-000000000001";
const REF_NAME = "teams/sync/main";
const ACTOR = { kind: "agent", id: "vistrea-sync-test", extensions: {} };

/** How many objects the party's store holds on disk. */
async function countObjects(root: string): Promise<number> {
  const entries = await fs.readdir(path.join(root, "objects"), {
    recursive: true,
    withFileTypes: true,
  });
  return entries.filter((entry) => entry.isFile()).length;
}

/** Tokens are per project: a Hub token never reaches another namespace. */
function tokenFor(
  hub: { readonly projects: readonly { project_id: string; bearerToken: string; readOnlyToken: string }[] },
  projectId: string,
): { bearerToken: string; readOnlyToken: string } {
  const project = hub.projects.find((candidate) => candidate.project_id === projectId);
  if (project === undefined) {
    throw new Error(`The Hub does not serve ${projectId}.`);
  }
  return project;
}

interface Party {
  readonly root: string;
  readonly workspace: MemoryDataStore;
  readonly objects: FileObjectStore;
  readonly sync: HubPackSync;
}

async function makeParty(t: TestContext, label: string): Promise<Party> {
  const validator = await validatorPromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vistrea-hub-sync-${label}-`));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const workspace = new MemoryDataStore({ validator });
  const objects = await FileObjectStore.open({ workspaceRoot: root });
  const sync = new HubPackSync({ workspace, objects, validator });
  return { root, workspace, objects, sync };
}

async function seedCommit(
  party: Party,
  message: string,
  content: string,
  parents: readonly string[] = [],
): Promise<{ commitId: string; object: ObjectRef }> {
  const bytes = Buffer.from(content, "utf8");
  const object = await party.objects.put(
    (async function* () {
      yield bytes;
    })(),
    { media_type: "application/json", compression: "none", logical_name: "graph.json" },
  );
  party.workspace.registerVerifiedObjects([object]);
  const unit = party.workspace.beginUnitOfWork("write");
  const commit = unit.versions.createCommit({
    protocol_version: { major: 1, minor: 0 },
    parents,
    created_at: "2026-07-12T06:00:00.000Z",
    author: ACTOR,
    message,
    roots: { runtime_graph: object },
    object_hashes: [object.hash],
    extensions: {},
  } as never);
  if (parents.length === 0) {
    unit.versions.updateRef(REF_NAME, commit.commit_id, { mode: "must_not_exist" } as never);
  } else {
    unit.versions.updateRef(REF_NAME, commit.commit_id, {
      mode: "must_match",
      expected_commit_id: parents[0],
    } as never);
  }
  unit.commit();
  return { commitId: commit.commit_id, object };
}

test("push and fetch move commits through the optional Hub and never force refs", async (t) => {
  const validator = await validatorPromise;
  const hubParty = await makeParty(t, "hub");
  const hub = await startHubServer({
    host: "127.0.0.1",
    projects: [
      { project_id: PROJECT_ID, workspace: hubParty.workspace, objects: hubParty.objects },
    ],
    validator,
  });
  t.after(() => hub.close());
  const remote: HubRemote = {
    baseUrl: hub.baseUrl,
    bearerToken: tokenFor(hub, PROJECT_ID).bearerToken,
    projectId: PROJECT_ID,
  };

  const author = await makeParty(t, "author");
  const seeded = await seedCommit(author, "Record the shared graph.", '{"screens":["home"]}');

  // Unauthenticated and wrong-project requests fail closed.
  const unauthorized = await fetch(`${hub.baseUrl}/v1/projects/${PROJECT_ID}/refs`);
  assert.equal(unauthorized.status, 401);
  await assert.rejects(
    author.sync.listRemoteRefs({
      ...remote,
      projectId: "project_019f0000-0000-7000-8000-0000000000ff",
    }),
    // The Hub does not disclose which namespaces it serves: a token that is
    // not that project's token is simply not a token.
    (error: unknown) => isDataError(error, "internal"),
  );

  const pushed = await author.sync.push({
    remote,
    ref_names: [REF_NAME],
    created_by: ACTOR,
    message: "First push through the Hub.",
  });
  assert.equal(pushed.import.mode, "full");
  assert.deepEqual(pushed.import.imported_commit_ids, [seeded.commitId]);
  assert.equal(pushed.import.created_refs[0]?.name, REF_NAME);
  assert.deepEqual(pushed.remaining_conflicts, []);
  assert.deepEqual(pushed.advanced_refs, []);

  const status = await author.sync.listRemoteRefs(remote);
  assert.equal(status.remote_refs.length, 1);
  assert.equal((status.remote_refs[0] as unknown as JsonObject)["commit_id"], seeded.commitId);

  // A second identical push changes nothing.
  const repeated = await author.sync.push({ remote, ref_names: [REF_NAME], created_by: ACTOR });
  assert.deepEqual(repeated.import.imported_commit_ids, []);
  assert.deepEqual(repeated.import.unchanged_ref_names, [REF_NAME]);

  // A fresh Workspace fetches the same history byte-identically.
  const reader = await makeParty(t, "reader");
  const fetched = await reader.sync.fetch({
    remote,
    ref_names: [REF_NAME],
    created_by: ACTOR,
  });
  assert.equal(fetched.mode, "full");
  assert.deepEqual(fetched.imported_commit_ids, [seeded.commitId]);
  assert.equal(fetched.created_refs[0]?.name, REF_NAME);
  const readerUnit = reader.workspace.beginUnitOfWork("read");
  try {
    assert.equal(readerUnit.versions.resolveRef(REF_NAME).commit_id, seeded.commitId);
  } finally {
    readerUnit.rollback();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of await reader.objects.open(seeded.object.hash)) {
    chunks.push(Buffer.from(chunk));
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), '{"screens":["home"]}');

  // Divergent histories surface as ref conflicts on the Hub, never a force.
  const rival = await makeParty(t, "rival");
  await seedCommit(rival, "A divergent graph.", '{"screens":["other"]}');
  const conflicted = await rival.sync.push({ remote, ref_names: [REF_NAME], created_by: ACTOR });
  assert.equal(conflicted.remaining_conflicts.length, 1);
  assert.equal(conflicted.remaining_conflicts[0]?.name, REF_NAME);
  assert.deepEqual(conflicted.advanced_refs, []);
  const afterConflict = await author.sync.listRemoteRefs(remote);
  assert.equal(
    (afterConflict.remote_refs[0] as unknown as JsonObject)["commit_id"],
    seeded.commitId,
  );

  // The author extends history and pushes the fast-forward successfully.
  const second = await seedCommit(
    author,
    "Extend the shared graph.",
    '{"screens":["home","detail"]}',
    [seeded.commitId],
  );
  const advanced = await author.sync.push({ remote, ref_names: [REF_NAME], created_by: ACTOR });
  assert.deepEqual(advanced.import.imported_commit_ids, [second.commitId]);
  assert.equal(advanced.advanced_refs.length, 1);
  assert.equal((advanced.advanced_refs[0] as unknown as JsonObject)["commit_id"], second.commitId);
  assert.deepEqual(advanced.remaining_conflicts, []);
  const advancedStatus = await author.sync.listRemoteRefs(remote);
  assert.equal(
    (advancedStatus.remote_refs[0] as unknown as JsonObject)["commit_id"],
    second.commitId,
  );
});

test("the Hub isolates project namespaces and enforces read-only tokens", async (t) => {
  const validator = await validatorPromise;
  const PROJECT_B = "project_019f0000-0000-7000-8000-000000000002";
  const partyA = await makeParty(t, "multi-a");
  const partyB = await makeParty(t, "multi-b");
  const hub = await startHubServer({
    host: "127.0.0.1",
    projects: [
      { project_id: PROJECT_ID, workspace: partyA.workspace, objects: partyA.objects },
      { project_id: PROJECT_B, workspace: partyB.workspace, objects: partyB.objects },
    ],
    validator,
  });
  t.after(() => hub.close());

  const author = await makeParty(t, "multi-author");
  const seeded = await seedCommit(author, "Record the multi-project graph.", '{"screens":["a"]}');
  const remoteA = { baseUrl: hub.baseUrl, bearerToken: tokenFor(hub, PROJECT_ID).bearerToken, projectId: PROJECT_ID };
  const remoteB = {
    baseUrl: hub.baseUrl,
    bearerToken: tokenFor(hub, PROJECT_B).bearerToken,
    projectId: PROJECT_B,
  };

  const pushed = await author.sync.push({
    remote: remoteA,
    ref_names: [REF_NAME],
    created_by: ACTOR,
  });
  assert.deepEqual(pushed.import.imported_commit_ids, [seeded.commitId]);

  // Project B sees none of project A's refs.
  const isolated = await author.sync.listRemoteRefs(remoteB);
  assert.deepEqual(isolated.remote_refs, []);
  const visible = await author.sync.listRemoteRefs(remoteA);
  assert.equal(visible.remote_refs.length, 1);

  // The read-only token reads and exports but can never mutate.
  const readOnlyRemote = { ...remoteA, bearerToken: tokenFor(hub, PROJECT_ID).readOnlyToken };
  const readListing = await author.sync.listRemoteRefs(readOnlyRemote);
  assert.equal(readListing.remote_refs.length, 1);
  const reader = await makeParty(t, "multi-reader");
  const fetched = await reader.sync.fetch({
    remote: readOnlyRemote,
    ref_names: [REF_NAME],
    created_by: ACTOR,
  });
  assert.deepEqual(fetched.imported_commit_ids, [seeded.commitId]);
  await assert.rejects(
    author.sync.push({ remote: readOnlyRemote, ref_names: [REF_NAME], created_by: ACTOR }),
    (error: unknown) =>
      isDataError(error, "internal") &&
      (error as { details: JsonObject }).details["hub_error_code"] === "forbidden",
  );

  // A garbage token stays unauthenticated regardless of role.
  const forbidden = await fetch(`${hub.baseUrl}/v1/projects/${PROJECT_ID}/refs`, {
    headers: { authorization: `Bearer ${"x".repeat(43)}` },
  });
  assert.equal(forbidden.status, 401);

  // Tokens are per project: another team's token cannot read this namespace.
  const crossProject = await fetch(`${hub.baseUrl}/v1/projects/${PROJECT_ID}/refs`, {
    headers: { authorization: `Bearer ${tokenFor(hub, PROJECT_B).bearerToken}` },
  });
  assert.equal(crossProject.status, 401);

  // Export streams without persisting: a read-only caller cannot grow the
  // Hub's object store one pack per request.
  const beforeExports = await countObjects(partyA.root);
  for (let index = 0; index < 3; index += 1) {
    await reader.sync.fetch({ remote: readOnlyRemote, ref_names: [REF_NAME], created_by: ACTOR });
  }
  assert.equal(await countObjects(partyA.root), beforeExports);
});

test("the Hub serves TLS when configured and refuses non-loopback plain HTTP", async (t) => {
  const validator = await validatorPromise;
  const party = await makeParty(t, "tls");

  // Plain HTTP must never leave the machine.
  await assert.rejects(
    startHubServer({
      host: "0.0.0.0",
      projects: [
        { project_id: PROJECT_ID, workspace: party.workspace, objects: party.objects },
      ],
      validator,
    }),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );

  // A self-signed pair generated for this test only; skip when openssl is
  // unavailable rather than pretending TLS was proven.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-hub-tls-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
      "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  if (generated.status !== 0) {
    t.skip("openssl is unavailable for TLS certificate generation");
    return;
  }

  const hub = await startHubServer({
    host: "127.0.0.1",
    projects: [
      { project_id: PROJECT_ID, workspace: party.workspace, objects: party.objects },
    ],
    validator,
    tls: { certificatePath: certPath, privateKeyPath: keyPath },
  });
  t.after(() => hub.close());
  assert.match(hub.baseUrl, /^https:/);

  const certificate = await fs.readFile(certPath);
  const status = await new Promise<number>((resolve, reject) => {
    const request = https.request(
      `${hub.baseUrl}/v1/projects/${PROJECT_ID}/refs`,
      { ca: certificate, headers: { authorization: `Bearer ${tokenFor(hub, PROJECT_ID).bearerToken}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
  assert.equal(status, 200);
});
