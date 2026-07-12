import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { startLocalHost } from "../../apps/host/index.js";
import { isDataError } from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { LoopbackTransportError } from "../../engine/connection/index.js";

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
    readonly runtime: { readonly authorization_token: string };
  };
  assert.equal((await fs.stat(connectionFile)).mode & 0o777, 0o600);
  assert.match(descriptor.api.bearer_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(descriptor.runtime.authorization_token, /^[A-Za-z0-9_-]{43}$/);
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
