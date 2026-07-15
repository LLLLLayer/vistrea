import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { startHostLocalApi, type HostLocalApiHandle } from "../../apps/host/index.js";
import { DataError, type JsonObject, type ObjectRef } from "../../data/api/index.js";
import { createRepositoryProtocolValidator, MemoryDataStore } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import type {
  CaptureSnapshotCommand,
  RuntimeCaptureOptions,
  RuntimeCapturePort,
  RuntimeCaptureResult,
} from "../../engine/connection/index.js";
import { startHubServer } from "../../services/hub/index.js";

const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot: process.cwd() });
const PROJECT_ID = "project_019f0000-0000-7000-8000-000000000051";
const REF_NAME = "teams/design/main";
const ACTOR = { kind: "agent", id: "workspace-sync-host-test", extensions: {} };

class UnusedRuntime implements RuntimeCapturePort {
  async captureSnapshot(
    _command: CaptureSnapshotCommand,
    _options?: RuntimeCaptureOptions,
  ): Promise<RuntimeCaptureResult> {
    throw new DataError("unsupported", "This sync test does not capture a Snapshot.");
  }
}

interface Party {
  readonly root: string;
  readonly workspace: MemoryDataStore;
  readonly objects: FileObjectStore;
}

async function makeParty(t: TestContext, label: string): Promise<Party> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vistrea-sync-host-${label}-`));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const validator = await validatorPromise;
  return {
    root,
    workspace: new MemoryDataStore({ validator }),
    objects: await FileObjectStore.open({ workspaceRoot: root }),
  };
}

async function seedCommit(
  party: Party,
  content: string,
  parents: readonly string[] = [],
): Promise<{ readonly commitId: string; readonly object: ObjectRef }> {
  const object = await party.objects.put(
    (async function* () {
      yield Buffer.from(content, "utf8");
    })(),
    { media_type: "application/json", compression: "none", logical_name: "workspace.json" },
  );
  party.workspace.registerVerifiedObjects([object]);
  const unit = party.workspace.beginUnitOfWork("write");
  const commit = unit.versions.createCommit({
    protocol_version: { major: 1, minor: 0 },
    parents,
    created_at: "2026-07-14T08:00:00.000Z",
    author: ACTOR,
    message: "Exercise the public Workspace sync surface.",
    roots: { runtime_graph: object },
    object_hashes: [object.hash],
    extensions: {},
  } as never);
  unit.versions.updateRef(
    REF_NAME,
    commit.commit_id,
    parents.length === 0
      ? ({ mode: "must_not_exist" } as never)
      : ({ mode: "must_match", expected_commit_id: parents[0] } as never),
  );
  unit.commit();
  return { commitId: commit.commit_id, object };
}

async function startPartyHost(t: TestContext, party: Party): Promise<HostLocalApiHandle> {
  const validator = await validatorPromise;
  const host = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: new UnusedRuntime(),
    workspace: party.workspace,
    objects: party.objects,
    validator,
  });
  t.after(() => host.close());
  return host;
}

async function postHost(
  host: HostLocalApiHandle,
  route: string,
  body: JsonObject,
): Promise<{ readonly response: Response; readonly body: JsonObject }> {
  const response = await fetch(`${host.baseUrl}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${host.bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as unknown;
  assert.equal(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), true);
  return { response, body: parsed as JsonObject };
}

test("Host sync status, push, fetch, conflict, and activity form a secret-safe Hub loop", async (t) => {
  const validator = await validatorPromise;
  const hubParty = await makeParty(t, "hub");
  const hub = await startHubServer({
    host: "127.0.0.1",
    projects: [{ project_id: PROJECT_ID, workspace: hubParty.workspace, objects: hubParty.objects }],
    validator,
  });
  t.after(() => hub.close());
  const hubToken = hub.projects[0]?.bearerToken as string;
  const remote = {
    base_url: hub.baseUrl,
    project_id: PROJECT_ID,
    bearer_token: hubToken,
  };

  const author = await makeParty(t, "author");
  const seeded = await seedCommit(author, '{"screen":"home"}');
  const authorHost = await startPartyHost(t, author);

  const initial = await postHost(authorHost, "/v1/sync/status", {
    remote,
    ref_names: [REF_NAME],
  });
  assert.equal(initial.response.status, 200);
  assert.equal(((initial.body["refs"] as readonly JsonObject[])[0] as JsonObject)["relation"], "local_only");
  assert.equal((initial.body["identity"] as JsonObject)["role"], "admin");
  assert.equal(JSON.stringify(initial.body).includes(hubToken), false);

  const invalidActor = await postHost(authorHost, "/v1/sync/fetch", {
    remote,
    ref_names: [REF_NAME],
    created_by: { actor_id: "legacy-cli", surface: "cli" },
  });
  assert.equal(invalidActor.response.status, 400);
  assert.equal((invalidActor.body["error"] as JsonObject)["code"], "invalid_argument");
  assert.equal(JSON.stringify(invalidActor.body).includes(hubToken), false);

  const pushed = await postHost(authorHost, "/v1/sync/push", {
    remote,
    ref_names: [REF_NAME],
    created_by: ACTOR,
    message: "Publish the design team's shared ref.",
  });
  assert.equal(pushed.response.status, 200);
  assert.deepEqual(
    ((pushed.body["result"] as JsonObject)["import"] as JsonObject)["imported_commit_ids"],
    [seeded.commitId],
  );
  assert.equal(
    ((((pushed.body["status"] as JsonObject)["refs"] as readonly JsonObject[])[0] as JsonObject)[
      "relation"
    ]),
    "synced",
  );

  const reader = await makeParty(t, "reader");
  const readerHost = await startPartyHost(t, reader);
  const fetched = await postHost(readerHost, "/v1/sync/fetch", {
    remote,
    ref_names: [REF_NAME],
    created_by: ACTOR,
  });
  assert.equal(fetched.response.status, 200);
  assert.deepEqual(
    ((fetched.body["result"] as JsonObject)["import"] as JsonObject)["imported_commit_ids"],
    [seeded.commitId],
  );
  assert.deepEqual((fetched.body["result"] as JsonObject)["advanced_refs"], []);
  const readerUnit = reader.workspace.beginUnitOfWork("read");
  try {
    assert.equal(readerUnit.versions.resolveRef(REF_NAME).commit_id, seeded.commitId);
  } finally {
    readerUnit.rollback();
  }

  const authorCliEnvironment = {
    ...process.env,
    VISTREA_HOST_URL: authorHost.baseUrl,
    VISTREA_HOST_TOKEN: authorHost.bearerToken,
    VISTREA_HUB_TOKEN: hubToken,
    VISTREA_CLI_TOOLSETS: "collaboration",
  };
  const second = await seedCommit(author, '{"screen":"catalog"}', [seeded.commitId]);
  const cliPush = await runCli(
    [
      "sync",
      "push",
      "--url",
      hub.baseUrl,
      "--project",
      PROJECT_ID,
      "--refs",
      REF_NAME,
      "--message",
      "Publish through the canonical CLI actor.",
    ],
    authorCliEnvironment,
  );
  assert.equal(cliPush.status, 0, cliPush.stdout);
  assert.equal(cliPush.stdout.includes(hubToken), false);
  const cliPushEnvelope = JSON.parse(cliPush.stdout) as JsonObject;
  assert.deepEqual(
    ((((cliPushEnvelope["data"] as JsonObject)["result"] as JsonObject)["import"] as JsonObject)[
      "imported_commit_ids"
    ]),
    [second.commitId],
  );

  const readerCliEnvironment = {
    ...authorCliEnvironment,
    VISTREA_HOST_URL: readerHost.baseUrl,
    VISTREA_HOST_TOKEN: readerHost.bearerToken,
  };
  const cliFetch = await runCli(
    ["sync", "fetch", "--url", hub.baseUrl, "--project", PROJECT_ID, "--refs", REF_NAME],
    readerCliEnvironment,
  );
  assert.equal(cliFetch.status, 0, cliFetch.stdout);
  assert.equal(cliFetch.stdout.includes(hubToken), false);
  const cliFetchEnvelope = JSON.parse(cliFetch.stdout) as JsonObject;
  assert.equal(
    (((cliFetchEnvelope["data"] as JsonObject)["result"] as JsonObject)[
      "advanced_refs"
    ] as readonly JsonObject[])[0]?.["commit_id"],
    second.commitId,
  );
  const updatedReaderUnit = reader.workspace.beginUnitOfWork("read");
  try {
    assert.equal(updatedReaderUnit.versions.resolveRef(REF_NAME).commit_id, second.commitId);
  } finally {
    updatedReaderUnit.rollback();
  }

  const rival = await makeParty(t, "rival");
  await seedCommit(rival, '{"screen":"rival"}');
  const rivalHost = await startPartyHost(t, rival);
  const conflict = await postHost(rivalHost, "/v1/sync/push", {
    remote,
    ref_names: [REF_NAME],
    created_by: ACTOR,
  });
  assert.equal(conflict.response.status, 200);
  assert.equal(
    ((conflict.body["result"] as JsonObject)["remaining_conflicts"] as readonly unknown[]).length,
    1,
  );
  assert.equal(
    ((((conflict.body["status"] as JsonObject)["refs"] as readonly JsonObject[])[0] as JsonObject)[
      "relation"
    ]),
    "diverged",
  );

  const activity = await postHost(authorHost, "/v1/sync/activity", {
    remote,
    after_sequence: 0,
    limit: 100,
  });
  assert.equal(activity.response.status, 200, JSON.stringify(activity.body));
  const kinds = (activity.body["items"] as readonly JsonObject[]).map((event) => event["kind"]);
  assert.equal(kinds.includes("HubPackImported"), true);
  assert.equal(kinds.includes("HubPackExported"), true);
  assert.equal(JSON.stringify(activity.body).includes(hubToken), false);

  const rejectedToken = "x".repeat(43);
  const rejected = await postHost(authorHost, "/v1/sync/status", {
    remote: { ...remote, bearer_token: rejectedToken },
  });
  assert.equal(rejected.response.status, 401);
  assert.equal((rejected.body["error"] as JsonObject)["code"], "unauthenticated");
  const rejectedSource = JSON.stringify(rejected.body);
  assert.equal(rejectedSource.includes(rejectedToken), false);
  assert.equal(rejectedSource.includes(hubToken), false);

  const cliEnvironment = authorCliEnvironment;
  const cliStatus = await runCli(
    ["sync", "status", "--url", hub.baseUrl, "--project", PROJECT_ID, "--refs", REF_NAME],
    cliEnvironment,
  );
  assert.equal(cliStatus.status, 0, cliStatus.stdout);
  assert.equal(cliStatus.stdout.includes(hubToken), false);
  assert.equal(cliStatus.stdout.includes(authorHost.bearerToken), false);
  const cliStatusEnvelope = JSON.parse(cliStatus.stdout) as JsonObject;
  assert.equal(
    (((cliStatusEnvelope["data"] as JsonObject)["refs"] as readonly JsonObject[])[0] as JsonObject)[
      "relation"
    ],
    "synced",
  );

  const cliActivity = await runCli(
    ["sync", "activity", "--url", hub.baseUrl, "--project", PROJECT_ID, "--limit", "10"],
    cliEnvironment,
  );
  assert.equal(cliActivity.status, 0, cliActivity.stdout);
  assert.equal(cliActivity.stdout.includes(hubToken), false);

  const missingHubToken = await runCli(
    ["sync", "status", "--url", hub.baseUrl, "--project", PROJECT_ID],
    { ...cliEnvironment, VISTREA_HUB_TOKEN: "" },
  );
  assert.equal(missingHubToken.status, 2);
  assert.match(missingHubToken.stdout, /VISTREA_HUB_TOKEN/);
  assert.equal(missingHubToken.stdout.includes(hubToken), false);
});

async function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), ".build/typescript/integrations/cli/main.js"), ...arguments_],
    { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { status, stdout, stderr };
}
