import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { startLocalHost } from "../../apps/host/index.js";
import { isDataError } from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import {
  computeLoopbackClientProof,
  LoopbackTransportError,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

test("the local Host owns production storage and reports live Runtime availability", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const first = await startLocalHost({ workspaceRoot, validator });
  t.after(() => first.close());

  assert.match(first.runtime.authorizationToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.api.bearerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.runtime.authorizationToken, first.api.bearerToken);
  assert.equal(first.runtimeConnected, false);

  const status = await authorizedFetch(first.api.baseUrl, first.api.bearerToken, "/v1/status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    status: "ready",
    runtime_connected: false,
  });

  const emptyRecoveryPoints = await authorizedFetch(
    first.api.baseUrl,
    first.api.bearerToken,
    "/v1/workspace/recovery-points",
  );
  assert.equal(emptyRecoveryPoints.status, 200);
  assert.deepEqual(await emptyRecoveryPoints.json(), { recovery_points: [] });

  const createdRecoveryPoint = await authorizedFetch(
    first.api.baseUrl,
    first.api.bearerToken,
    "/v1/workspace/recovery-points",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Production Host composition acceptance." }),
    },
  );
  assert.equal(createdRecoveryPoint.status, 201);
  const recoveryPoint = (await createdRecoveryPoint.json()) as {
    recovery_point_id: string;
    source: string;
    active_retention_policy_ids: string[];
  };
  assert.match(recoveryPoint.recovery_point_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(recoveryPoint.source, "manual");
  assert.equal(recoveryPoint.active_retention_policy_ids.length, 1);

  const listedRecoveryPoints = await authorizedFetch(
    first.api.baseUrl,
    first.api.bearerToken,
    "/v1/workspace/recovery-points",
  );
  assert.equal(listedRecoveryPoints.status, 200);
  const listedRecoveryPointsBody = (await listedRecoveryPoints.json()) as {
    recovery_points: readonly { recovery_point_id: string }[];
  };
  assert.equal(
    listedRecoveryPointsBody.recovery_points[0]?.recovery_point_id,
    recoveryPoint.recovery_point_id,
  );

  const retentionPolicyId = recoveryPoint.active_retention_policy_ids[0];
  assert.ok(retentionPolicyId !== undefined);
  const releasedRecoveryPoint = await authorizedFetch(
    first.api.baseUrl,
    first.api.bearerToken,
    "/v1/workspace/recovery-points/release",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recovery_point_id: recoveryPoint.recovery_point_id,
        retention_policy_id: retentionPolicyId,
      }),
    },
  );
  assert.equal(releasedRecoveryPoint.status, 200);
  assert.deepEqual(
    ((await releasedRecoveryPoint.json()) as { active_retention_policy_ids: string[] })
      .active_retention_policy_ids,
    [],
  );

  const unavailableCapture = await authorizedFetch(
    first.api.baseUrl,
    first.api.bearerToken,
    "/v1/captures",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(unavailableCapture.status, 503);
  const unavailableBody = JSON.stringify(await unavailableCapture.json());
  assert.match(unavailableBody, /"code":"unavailable"/);
  assert.equal(unavailableBody.includes(first.runtime.authorizationToken), false);
  assert.equal(unavailableBody.includes(first.api.bearerToken), false);

  await assert.rejects(
    first.waitForRuntime(10),
    (error: unknown) => error instanceof LoopbackTransportError && error.code === "timeout",
  );
  await assert.rejects(
    startLocalHost({ workspaceRoot, validator }),
    (error: unknown) => isDataError(error, "conflict"),
  );

  const firstApiToken = first.api.bearerToken;
  const firstRuntimeToken = first.runtime.authorizationToken;
  await first.close();
  await first.close();
  await assert.rejects(fs.stat(path.join(workspaceRoot, ".host.lock")), { code: "ENOENT" });

  const reopened = await startLocalHost({ workspaceRoot, validator });
  t.after(() => reopened.close());
  assert.notEqual(reopened.api.bearerToken, firstApiToken);
  assert.notEqual(reopened.runtime.authorizationToken, firstRuntimeToken);
  const snapshots = await authorizedFetch(
    reopened.api.baseUrl,
    reopened.api.bearerToken,
    "/v1/snapshots",
  );
  assert.equal(snapshots.status, 200);
  assert.deepEqual(await snapshots.json(), {
    items: [],
    snapshot_version: "sqlite:0",
  });
  await reopened.close();
});

test("the composed Host pumps Runtime events into production storage", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const host = await startLocalHost({ workspaceRoot, validator });
  t.after(() => host.close());

  const epochId = "epoch_019f0000-0000-7000-8000-0000000000aa";
  const socket = net.createConnection({ host: host.runtime.host, port: host.runtime.port });
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.setNoDelay(true);
  let buffered = Buffer.alloc(0);
  const inbox: Record<string, unknown>[] = [];
  const waiters: ((message: Record<string, unknown>) => void)[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const message = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as Record<
        string,
        unknown
      >;
      buffered = buffered.subarray(newline + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) {
        inbox.push(message);
      } else {
        waiter(message);
      }
    }
  });
  const nextMessage = (): Promise<Record<string, unknown>> => {
    const queued = inbox.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return withTimeout(
      new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve)),
      5_000,
      "Runtime transport message",
    );
  };
  const send = (message: Record<string, unknown>): void => {
    socket.write(`${JSON.stringify(message)}\n`);
  };

  const challenge = await nextMessage();
  assert.equal(challenge["type"], "host_challenge");
  const clientNonce = randomBytes(24).toString("base64url");
  const versions = [{ major: 1, minor: 0 }];
  const capabilities = ["runtime.events", "runtime.snapshot"];
  send({
    type: "client_hello",
    connection_attempt_id: challenge["connection_attempt_id"],
    runtime_instance_id: "runtime.composition.events",
    build_configuration: "debug",
    supported_versions: versions,
    capabilities,
    selected_auth_method: "hmac-sha256",
    client_nonce: clientNonce,
    challenge_response: computeLoopbackClientProof(host.runtime.authorizationToken, {
      connectionAttemptId: challenge["connection_attempt_id"] as string,
      hostNonce: challenge["nonce"] as string,
      clientNonce,
      runtimeInstanceId: "runtime.composition.events",
      buildConfiguration: "debug",
      supportedVersions: versions,
      capabilities,
    }),
    event_epoch: {
      event_epoch_id: epochId,
      oldest_retained_sequence: 1,
      next_sequence: 2,
    },
  });
  const welcome = await nextMessage();
  assert.equal(welcome["type"], "host_welcome");
  assert.deepEqual(welcome["enabled_capabilities"], ["runtime.events", "runtime.snapshot"]);
  await host.waitForRuntime(5_000);

  // The composed Host subscribes automatically and resumes from the oldest event.
  const subscribeRequest = await nextMessage();
  assert.equal(subscribeRequest["type"], "subscribe_events");
  assert.equal(subscribeRequest["event_epoch_id"], epochId);
  assert.deepEqual(subscribeRequest["start"], { mode: "oldest_retained" });
  send({
    type: "subscribe_result",
    request_id: subscribeRequest["request_id"],
    subscription_id: "composition-events",
  });
  send({
    type: "event_batch",
    subscription_id: "composition-events",
    batch: {
      protocol_version: { major: 1, minor: 0 },
      event_epoch_id: epochId,
      first_sequence: 1,
      last_sequence: 1,
      events: [
        {
          event_id: "event_019f0000-0000-7000-8000-0000000000aa",
          protocol_version: { major: 1, minor: 0 },
          event_epoch_id: epochId,
          sequence: 1,
          time: { wall_time: "2026-07-12T09:00:00.000Z" },
          kind: "transient_presented",
          stable_id: "demo.toast.success",
          payload: { text: "Saved successfully" },
          extensions: {},
        },
      ],
      dropped_event_count: 0,
      extensions: {},
    },
  });

  const acknowledgement = await nextMessage();
  assert.deepEqual(acknowledgement, {
    type: "acknowledge_events",
    subscription_id: "composition-events",
    event_epoch_id: epochId,
    durable_through_sequence: 1,
  });

  const timeline = await authorizedFetch(
    host.api.baseUrl,
    host.api.bearerToken,
    `/v1/events?event_epoch_id=${encodeURIComponent(epochId)}`,
  );
  assert.equal(timeline.status, 200);
  const timelineBody = (await timeline.json()) as {
    events: readonly { sequence: number; kind: string }[];
  };
  assert.equal(timelineBody.events.length, 1);
  assert.equal(timelineBody.events[0]?.sequence, 1);
  assert.equal(timelineBody.events[0]?.kind, "transient_presented");

  const status = await authorizedFetch(host.api.baseUrl, host.api.bearerToken, "/v1/status");
  const statusBody = (await status.json()) as {
    runtime_events?: { state: string; event_epoch_id?: string };
  };
  assert.equal(statusBody.runtime_events?.state, "running");
  assert.equal(statusBody.runtime_events?.event_epoch_id, epochId);
  await host.close();
});

test("the Host executable writes credentials only to a private ephemeral descriptor", async (t) => {
  const workspaceRoot = await temporaryWorkspace(t);
  const connectionFile = path.join(workspaceRoot, "host-connection.json");
  const child = spawn(
    process.execPath,
    [
      path.join(repositoryRoot, ".build/typescript/apps/host/serve.js"),
      "--workspace",
      workspaceRoot,
      "--connection-file",
      connectionFile,
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  });

  const readyLine = await withTimeout(readLine(child.stdout), 10_000, "Host ready output");
  const descriptor = JSON.parse(await fs.readFile(connectionFile, "utf8")) as {
    readonly api: { readonly base_url: string; readonly bearer_token: string };
    readonly runtime: {
      readonly authorization_token: string;
      readonly transport: "loopback" | "tls";
      readonly certificate_sha256?: string;
    };
  };
  assert.equal((await fs.stat(connectionFile)).mode & 0o777, 0o600);
  assert.match(descriptor.api.bearer_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(descriptor.runtime.authorization_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(descriptor.runtime.transport, "loopback");
  assert.equal(descriptor.runtime.certificate_sha256, undefined);
  assert.equal(readyLine.includes(descriptor.api.bearer_token), false);
  assert.equal(readyLine.includes(descriptor.runtime.authorization_token), false);
  assert.equal(JSON.parse(readyLine).connection_file, connectionFile);

  const status = await authorizedFetch(
    descriptor.api.base_url,
    descriptor.api.bearer_token,
    "/v1/status",
  );
  assert.equal(status.status, 200);
  child.kill("SIGTERM");
  const [exitCode] = await withTimeout(once(child, "close"), 10_000, "Host shutdown");
  assert.equal(exitCode, 0);
  await assert.rejects(fs.stat(connectionFile), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(workspaceRoot, ".host.lock")), { code: "ENOENT" });
});

async function authorizedFetch(
  baseUrl: string,
  token: string,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

async function temporaryWorkspace(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-local-host-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let source = "";
    stream.setEncoding("utf8");
    const onData = (chunk: string): void => {
      source += chunk;
      const newline = source.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(source.slice(0, newline));
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("The Host process ended before emitting a ready line."));
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
