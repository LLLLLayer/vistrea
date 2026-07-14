import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import {
  FileHubAuditStore,
  FileHubPermissionStore,
  startHubServer,
} from "../../services/hub/index.js";

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
  hub: {
    readonly projects: readonly {
      project_id: string;
      bearerToken: string;
      readOnlyToken: string;
      accessGrants?: readonly { principal_id: string; role: string; bearerToken: string }[];
    }[];
  },
  projectId: string,
): {
  bearerToken: string;
  readOnlyToken: string;
  accessGrants?: readonly { principal_id: string; role: string; bearerToken: string }[];
} {
  const project = hub.projects.find((candidate) => candidate.project_id === projectId);
  if (project === undefined) {
    throw new Error(`The Hub does not serve ${projectId}.`);
  }
  return project;
}

function grantTokenFor(
  hub: Parameters<typeof tokenFor>[0],
  projectId: string,
  principalId: string,
): string {
  const grant = tokenFor(hub, projectId).accessGrants?.find(
    (candidate) => candidate.principal_id === principalId,
  );
  if (grant === undefined) {
    throw new Error(`The Hub did not issue a token for ${principalId}.`);
  }
  return grant.bearerToken;
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

async function hubJson(
  baseUrl: string,
  projectId: string,
  resource: string,
  token: string,
  options: { readonly method?: string; readonly body?: JsonObject } = {},
): Promise<{ readonly status: number; readonly body: JsonObject }> {
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/${resource}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const value = (await response.json()) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Hub returned a non-object JSON response.");
  }
  return { status: response.status, body: value as JsonObject };
}

async function readReadyLine(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<JsonObject> {
  return await new Promise<JsonObject>((resolve, reject) => {
    let source = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`The standalone Hub did not become ready: ${stderr()}`));
    }, 15_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`The standalone Hub exited with ${String(code)}: ${stderr()}`));
    };
    const onData = (chunk: Buffer): void => {
      source += chunk.toString("utf8");
      const newline = source.indexOf("\n");
      if (newline === -1) {
        return;
      }
      cleanup();
      try {
        const value = JSON.parse(source.slice(0, newline)) as unknown;
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("not an object");
        }
        resolve(value as JsonObject);
      } catch {
        reject(new Error(`The standalone Hub emitted an invalid ready line: ${source}`));
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
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

test("the Hub exposes project RBAC, administrator audit, and a safe activity feed", async (t) => {
  const validator = await validatorPromise;
  const party = await makeParty(t, "rbac");
  const hub = await startHubServer({
    host: "127.0.0.1",
    projects: [
      {
        project_id: PROJECT_ID,
        workspace: party.workspace,
        objects: party.objects,
        access: [
          { principal_id: "alice", role: "contributor" },
          { principal_id: "riley", role: "reviewer" },
          { principal_id: "maya", role: "maintainer" },
        ],
      },
    ],
    validator,
  });
  t.after(() => hub.close());

  const projectTokens = tokenFor(hub, PROJECT_ID);
  const alice = grantTokenFor(hub, PROJECT_ID, "alice");
  const riley = grantTokenFor(hub, PROJECT_ID, "riley");
  const maya = grantTokenFor(hub, PROJECT_ID, "maya");

  for (const [token, principal, role] of [
    [projectTokens.readOnlyToken, "hub-bootstrap-viewer", "viewer"],
    [alice, "alice", "contributor"],
    [riley, "riley", "reviewer"],
    [maya, "maya", "maintainer"],
    [projectTokens.bearerToken, "hub-bootstrap-admin", "admin"],
  ] as const) {
    const response = await hubJson(hub.baseUrl, PROJECT_ID, "me", token);
    assert.equal(response.status, 200);
    assert.equal(response.body["principal_id"], principal);
    assert.equal(response.body["role"], role);
  }

  const permissions = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "permissions",
    projectTokens.bearerToken,
  );
  assert.equal(permissions.status, 200);
  assert.equal((permissions.body["items"] as readonly unknown[]).length, 5);
  assert.equal(JSON.stringify(permissions.body).includes(projectTokens.bearerToken), false);

  const deniedPermissions = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "permissions",
    projectTokens.readOnlyToken,
  );
  assert.equal(deniedPermissions.status, 403);
  const deniedRef = await hubJson(hub.baseUrl, PROJECT_ID, "refs:update", alice, {
    method: "POST",
    body: {},
  });
  assert.equal(deniedRef.status, 403);
  const maintainerReachedValidation = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "refs:update",
    maya,
    { method: "POST", body: {} },
  );
  assert.equal(maintainerReachedValidation.status, 400);

  const author = await makeParty(t, "rbac-author");
  await seedCommit(author, "Publish RBAC activity.", '{"screens":["rbac"]}');
  await author.sync.push({
    remote: {
      baseUrl: hub.baseUrl,
      bearerToken: projectTokens.bearerToken,
      projectId: PROJECT_ID,
    },
    ref_names: [REF_NAME],
    created_by: ACTOR,
  });

  const activity = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "events?limit=50",
    projectTokens.readOnlyToken,
  );
  assert.equal(activity.status, 200);
  const activityItems = activity.body["items"] as readonly JsonObject[];
  assert.equal(activityItems.some((event) => event["kind"] === "HubPackImported"), true);
  assert.equal(JSON.stringify(activity.body).includes(projectTokens.bearerToken), false);

  const forbiddenAudit = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "audit-events",
    riley,
  );
  assert.equal(forbiddenAudit.status, 403);
  const audit = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "audit-events?limit=100",
    projectTokens.bearerToken,
  );
  assert.equal(audit.status, 200);
  const auditItems = audit.body["items"] as readonly JsonObject[];
  assert.equal(
    auditItems.some(
      (event) => event["action"] === "access_denied" && event["principal_id"] === "alice",
    ),
    true,
  );
  assert.equal(
    auditItems.some(
      (event) => event["action"] === "pack_imported" && event["outcome"] === "attempted",
    ),
    true,
  );
  assert.equal(
    auditItems.some(
      (event) => event["action"] === "pack_imported" && event["outcome"] === "succeeded",
    ),
    true,
  );
});

test("Hub administrators manage roles and rotate revocable one-time tokens", async (t) => {
  const validator = await validatorPromise;
  const party = await makeParty(t, "permission-admin");
  const hub = await startHubServer({
    host: "127.0.0.1",
    projects: [{ project_id: PROJECT_ID, workspace: party.workspace, objects: party.objects }],
    validator,
  });
  t.after(() => hub.close());
  const admin = tokenFor(hub, PROJECT_ID).bearerToken;
  const viewer = tokenFor(hub, PROJECT_ID).readOnlyToken;

  const deniedGrant = await hubJson(hub.baseUrl, PROJECT_ID, "permissions:grant", viewer, {
    method: "POST",
    body: { principal_id: "zoe", role: "viewer" },
  });
  assert.equal(deniedGrant.status, 403);

  const [firstGrant, duplicateGrant] = await Promise.all([
    hubJson(hub.baseUrl, PROJECT_ID, "permissions:grant", admin, {
      method: "POST",
      body: { principal_id: "zoe", role: "viewer" },
    }),
    hubJson(hub.baseUrl, PROJECT_ID, "permissions:grant", admin, {
      method: "POST",
      body: { principal_id: "zoe", role: "viewer" },
    }),
  ]);
  const granted = firstGrant.status === 201 ? firstGrant : duplicateGrant;
  const duplicate = firstGrant.status === 409 ? firstGrant : duplicateGrant;
  assert.equal(granted.status, 201);
  assert.equal(duplicate.status, 409);
  const originalToken = granted.body["bearer_token"];
  assert.equal(typeof originalToken, "string");
  assert.match(originalToken as string, /^[A-Za-z0-9_-]{43}$/);

  const originalIdentity = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "me",
    originalToken as string,
  );
  assert.equal(originalIdentity.body["role"], "viewer");

  const updated = await hubJson(hub.baseUrl, PROJECT_ID, "permissions/zoe", admin, {
    method: "PATCH",
    body: { role: "maintainer" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body["role"], "maintainer");
  const updatedIdentity = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "me",
    originalToken as string,
  );
  assert.equal(updatedIdentity.body["role"], "maintainer");

  const invalidUtf8 = await fetch(
    `${hub.baseUrl}/v1/projects/${PROJECT_ID}/permissions:grant`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${admin}`,
        "content-type": "application/json",
      },
      body: new Uint8Array([0xff]),
    },
  );
  assert.equal(invalidUtf8.status, 400);
  const unexpectedRotationBody = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "permissions/zoe:rotate-token",
    admin,
    { method: "POST", body: {} },
  );
  assert.equal(unexpectedRotationBody.status, 400);

  const rotated = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "permissions/zoe:rotate-token",
    admin,
    { method: "POST" },
  );
  assert.equal(rotated.status, 200);
  const rotatedToken = rotated.body["bearer_token"];
  assert.equal(typeof rotatedToken, "string");
  assert.notEqual(rotatedToken, originalToken);
  assert.equal(
    (await fetch(`${hub.baseUrl}/v1/projects/${PROJECT_ID}/me`, {
      headers: { authorization: `Bearer ${originalToken as string}` },
    })).status,
    401,
  );
  assert.equal(
    (await hubJson(hub.baseUrl, PROJECT_ID, "me", rotatedToken as string)).body["role"],
    "maintainer",
  );

  const protectedBootstrap = await hubJson(
    hub.baseUrl,
    PROJECT_ID,
    "permissions/hub-bootstrap-admin",
    admin,
    { method: "PATCH", body: { role: "viewer" } },
  );
  assert.equal(protectedBootstrap.status, 409);

  const revoked = await fetch(`${hub.baseUrl}/v1/projects/${PROJECT_ID}/permissions/zoe`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${admin}` },
  });
  assert.equal(revoked.status, 204);
  assert.equal(
    (await fetch(`${hub.baseUrl}/v1/projects/${PROJECT_ID}/me`, {
      headers: { authorization: `Bearer ${rotatedToken as string}` },
    })).status,
    401,
  );

  const permissions = await hubJson(hub.baseUrl, PROJECT_ID, "permissions", admin);
  assert.equal(JSON.stringify(permissions.body).includes("bearer_token"), false);
  assert.equal(JSON.stringify(permissions.body).includes(originalToken as string), false);
  assert.equal(JSON.stringify(permissions.body).includes(rotatedToken as string), false);

  const activity = await hubJson(hub.baseUrl, PROJECT_ID, "events?limit=100", viewer);
  const permissionEvents = (activity.body["items"] as readonly JsonObject[]).filter(
    (event) => event["kind"] === "PermissionChanged",
  );
  assert.equal(permissionEvents.length, 4);
  assert.equal(JSON.stringify(permissionEvents).includes("token"), false);

  const audit = await hubJson(hub.baseUrl, PROJECT_ID, "audit-events?limit=100", admin);
  const auditItems = audit.body["items"] as readonly JsonObject[];
  for (const action of [
    "permission_granted",
    "permission_role_updated",
    "permission_token_rotated",
    "permission_revoked",
  ]) {
    assert.equal(
      auditItems.some((event) => event["action"] === action && event["outcome"] === "succeeded"),
      true,
    );
  }
  assert.equal(JSON.stringify(audit.body).includes(originalToken as string), false);
  assert.equal(JSON.stringify(audit.body).includes(rotatedToken as string), false);
});

test("the private Hub permission store survives restart while tokens do not", async (t) => {
  const validator = await validatorPromise;
  const party = await makeParty(t, "permission-store");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-hub-permissions-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "permissions.json");
  const configured = [{
    project_id: PROJECT_ID,
    grants: [{ principal_id: "zoe", role: "viewer" as const }],
  }];

  let store = await FileHubPermissionStore.open(filename, configured);
  let hub = await startHubServer({
    host: "127.0.0.1",
    projects: [{ project_id: PROJECT_ID, workspace: party.workspace, objects: party.objects }],
    validator,
    permissions: store,
  });
  const firstAdmin = tokenFor(hub, PROJECT_ID).bearerToken;
  const firstZoe = grantTokenFor(hub, PROJECT_ID, "zoe");
  const changed = await hubJson(hub.baseUrl, PROJECT_ID, "permissions/zoe", firstAdmin, {
    method: "PATCH",
    body: { role: "reviewer" },
  });
  assert.equal(changed.status, 200);
  await hub.close();
  await store.close();

  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  const persistedSource = await fs.readFile(filename, "utf8");
  assert.match(persistedSource, /"principal_id":"zoe","role":"reviewer"/);
  assert.equal(persistedSource.includes(firstAdmin), false);
  assert.equal(persistedSource.includes(firstZoe), false);

  store = await FileHubPermissionStore.open(filename, configured);
  await assert.rejects(
    FileHubPermissionStore.open(filename, configured),
    (error: unknown) => isDataError(error, "conflict"),
  );
  hub = await startHubServer({
    host: "127.0.0.1",
    projects: [{ project_id: PROJECT_ID, workspace: party.workspace, objects: party.objects }],
    validator,
    permissions: store,
  });
  t.after(async () => {
    await hub.close();
    await store.close();
  });
  const secondAdmin = tokenFor(hub, PROJECT_ID).bearerToken;
  const secondZoe = grantTokenFor(hub, PROJECT_ID, "zoe");
  assert.notEqual(secondAdmin, firstAdmin);
  assert.notEqual(secondZoe, firstZoe);
  assert.equal((await hubJson(hub.baseUrl, PROJECT_ID, "me", secondZoe)).body["role"], "reviewer");
  assert.equal(
    (await fetch(`${hub.baseUrl}/v1/projects/${PROJECT_ID}/me`, {
      headers: { authorization: `Bearer ${firstZoe}` },
    })).status,
    401,
  );
});

test("the file Hub audit store survives reopen and enforces private file mode", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-hub-audit-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "audit.jsonl");
  const first = await FileHubAuditStore.open(filename, {
    now: () => new Date("2026-07-14T10:00:00.000Z"),
  });
  t.after(() => first.close());
  await first.record({
    project_id: PROJECT_ID,
    principal_id: "audit-test",
    role: "admin",
    action: "permissions_listed",
    outcome: "succeeded",
    resource: "permissions",
  });
  await assert.rejects(
    FileHubAuditStore.open(filename),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await first.record({
    project_id: "project_019f0000-0000-7000-8000-000000000002",
    principal_id: "other-project-admin",
    role: "admin",
    action: "permissions_listed",
    outcome: "succeeded",
    resource: "permissions",
  });
  await first.close();
  await assert.rejects(fs.access(`${filename}.lock`));
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);

  const reopened = await FileHubAuditStore.open(filename, {
    now: () => new Date("2026-07-14T10:01:00.000Z"),
  });
  t.after(() => reopened.close());
  await reopened.record({
    project_id: PROJECT_ID,
    principal_id: "audit-test",
    role: "admin",
    action: "audit_listed",
    outcome: "succeeded",
    resource: "audit-events",
  });
  const page = await reopened.list({ project_id: PROJECT_ID });
  assert.deepEqual(page.items.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(page.items.map((event) => event.occurred_at), [
    "2026-07-14T10:00:00.000Z",
    "2026-07-14T10:01:00.000Z",
  ]);
  const afterFirst = await reopened.list({ project_id: PROJECT_ID, after_sequence: 1 });
  assert.deepEqual(afterFirst.items.map((event) => event.sequence), [2]);
  const otherProject = await reopened.list({
    project_id: "project_019f0000-0000-7000-8000-000000000002",
  });
  assert.deepEqual(otherProject.items.map((event) => event.sequence), [1]);
});

test("the standalone Hub composes durable permissions and private token handoff", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-hub-standalone-"));
  const workspace = path.join(directory, "workspace");
  const connectionFile = path.join(directory, "connection.json");
  const permissionFile = path.join(directory, "permissions.json");
  const auditLog = path.join(directory, "audit.jsonl");
  let active: ChildProcessWithoutNullStreams | undefined;

  const stop = async (): Promise<void> => {
    const child = active;
    active = undefined;
    if (child === undefined || child.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  };
  t.after(async () => {
    await stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const start = async (): Promise<{
    readonly admin: string;
    readonly zoe: string;
    readonly baseUrl: string;
  }> => {
    let stderr = "";
    const child = spawn(
      process.execPath,
      [
        path.join(repositoryRoot, ".build", "typescript", "services", "hub", "main.js"),
        "--project", PROJECT_ID,
        "--workspace", workspace,
        "--grant", "zoe:viewer",
        "--connection-file", connectionFile,
        "--permission-file", permissionFile,
        "--audit-log", auditLog,
      ],
      { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    active = child;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const ready = await readReadyLine(child, () => stderr);
    assert.equal(ready["status"], "ready");
    const descriptor = JSON.parse(await fs.readFile(connectionFile, "utf8")) as {
      readonly hub_url: string;
      readonly permission_file: string;
      readonly projects: readonly {
        readonly hub_token: string;
        readonly access_grants: readonly {
          readonly principal_id: string;
          readonly hub_token: string;
        }[];
      }[];
    };
    assert.equal(descriptor.permission_file, permissionFile);
    const project = descriptor.projects[0];
    const zoe = project?.access_grants.find((grant) => grant.principal_id === "zoe")?.hub_token;
    assert.equal(typeof project?.hub_token, "string");
    assert.equal(typeof zoe, "string");
    return {
      admin: project?.hub_token as string,
      zoe: zoe as string,
      baseUrl: descriptor.hub_url,
    };
  };

  const first = await start();
  assert.equal((await hubJson(first.baseUrl, PROJECT_ID, "me", first.zoe)).body["role"], "viewer");
  const updated = await hubJson(first.baseUrl, PROJECT_ID, "permissions/zoe", first.admin, {
    method: "PATCH",
    body: { role: "reviewer" },
  });
  assert.equal(updated.status, 200);
  await stop();
  await assert.rejects(fs.access(connectionFile));
  assert.equal((await fs.stat(permissionFile)).mode & 0o777, 0o600);

  const second = await start();
  assert.notEqual(second.admin, first.admin);
  assert.notEqual(second.zoe, first.zoe);
  assert.equal((await hubJson(second.baseUrl, PROJECT_ID, "me", second.zoe)).body["role"], "reviewer");
  assert.equal(
    (await fetch(`${second.baseUrl}/v1/projects/${PROJECT_ID}/me`, {
      headers: { authorization: `Bearer ${first.zoe}` },
    })).status,
    401,
  );
  const persisted = await fs.readFile(permissionFile, "utf8");
  assert.equal(persisted.includes(first.admin), false);
  assert.equal(persisted.includes(first.zoe), false);
  assert.equal(persisted.includes(second.admin), false);
  assert.equal(persisted.includes(second.zoe), false);
  await stop();
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
