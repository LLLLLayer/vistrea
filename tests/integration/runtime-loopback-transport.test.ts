import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";

import type { ByteStream } from "../../data/api/index.js";
import {
  computeLoopbackClientProof,
  computeLoopbackHostProof,
  LoopbackRuntimeHost,
  LoopbackTransportError,
  type CaptureSnapshotCommand,
  type LoopbackAuthorizationToken,
  type LoopbackProtocolVersion,
  type LoopbackRuntimeHostOptions,
  type LoopbackRuntimeSession,
  type RuntimeBuildConfiguration,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const authorizationToken = "vistrea-loopback-integration-token-0001";
const wrongAuthorizationToken = "vistrea-loopback-integration-token-9999";
const captureCommand: CaptureSnapshotCommand = {
  include: { paths: ["trees", "screenshot"] },
  screenshot: "reference",
  reason: "manual",
};

interface WireFixture {
  readonly snapshot: unknown;
  readonly object: Readonly<Record<string, unknown>>;
  readonly payload: Buffer;
}

interface ReadyRuntime {
  readonly peer: TestJsonLinePeer;
  readonly session: LoopbackRuntimeSession;
  readonly challenge: Readonly<Record<string, unknown>>;
  readonly welcome: Readonly<Record<string, unknown>>;
  readonly clientNonce: string;
  readonly runtimeInstanceId: string;
  readonly versions: readonly LoopbackProtocolVersion[];
  readonly capabilities: readonly string[];
}

class TestJsonLinePeer {
  readonly #socket: Socket;
  readonly #messages: Readonly<Record<string, unknown>>[] = [];
  readonly #waiters: Array<{
    readonly resolve: (message: Readonly<Record<string, unknown>>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(socket: Socket) {
    this.#socket = socket;
    this.#socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#socket.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(new Error("Test Runtime peer closed."));
      }
    });
  }

  send(message: Readonly<Record<string, unknown>>): void {
    this.sendRaw(JSON.stringify(message) + "\n");
  }

  sendRaw(value: string | Uint8Array): void {
    this.#socket.write(value);
  }

  next(): Promise<Readonly<Record<string, unknown>>> {
    const message = this.#messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    if (this.#closed) {
      return Promise.reject(new Error("Test Runtime peer is closed."));
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  destroy(): void {
    this.#socket.destroy();
  }

  async waitForClose(): Promise<void> {
    if (!this.#closed) {
      await once(this.#socket, "close");
    }
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const value = JSON.parse(line.toString("utf8")) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Host emitted a non-object JSON line.");
      }
      const message = value as Readonly<Record<string, unknown>>;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#messages.push(message);
      } else {
        waiter.resolve(message);
      }
    }
  }
}

async function connectPeer(host: LoopbackRuntimeHost): Promise<TestJsonLinePeer> {
  const socket = net.createConnection({
    host: host.endpoint.host,
    port: host.endpoint.port,
  });
  const peer = new TestJsonLinePeer(socket);
  await once(socket, "connect");
  socket.setNoDelay(true);
  return peer;
}

async function authenticateRuntime(
  host: LoopbackRuntimeHost,
  token: LoopbackAuthorizationToken = authorizationToken,
  buildConfiguration: RuntimeBuildConfiguration = "debug",
): Promise<ReadyRuntime> {
  const peer = await connectPeer(host);
  const challenge = await withTimeout(peer.next());
  assert.equal(challenge["type"], "host_challenge");
  const connectionAttemptId = stringField(challenge, "connection_attempt_id");
  const hostNonce = stringField(challenge, "nonce");
  const clientNonce = randomBytes(24).toString("base64url");
  const runtimeInstanceId = "runtime.test.instance";
  const versions = [{ major: 1, minor: 0 }] as const;
  const capabilities = ["runtime.snapshot", "runtime.events"] as const;
  const sessionPromise = host.acceptSession();
  peer.send({
    type: "client_hello",
    connection_attempt_id: connectionAttemptId,
    runtime_instance_id: runtimeInstanceId,
    build_configuration: buildConfiguration,
    supported_versions: versions,
    capabilities,
    selected_auth_method: "hmac-sha256",
    client_nonce: clientNonce,
    challenge_response: computeLoopbackClientProof(token, {
      connectionAttemptId,
      hostNonce,
      clientNonce,
      runtimeInstanceId,
      buildConfiguration,
      supportedVersions: versions,
      capabilities,
    }),
  });
  const welcome = await withTimeout(peer.next());
  assert.equal(welcome["type"], "host_welcome");
  const session = await withTimeout(sessionPromise);
  return {
    peer,
    session,
    challenge,
    welcome,
    clientNonce,
    runtimeInstanceId,
    versions,
    capabilities,
  };
}

async function sendHelloForError(
  host: LoopbackRuntimeHost,
  proofToken: LoopbackAuthorizationToken,
  buildConfiguration: RuntimeBuildConfiguration,
  supportedVersions: readonly LoopbackProtocolVersion[] = [{ major: 1, minor: 0 }],
  capabilities: readonly string[] = ["runtime.snapshot"],
): Promise<{
  readonly peer: TestJsonLinePeer;
  readonly response: Readonly<Record<string, unknown>>;
}> {
  const peer = await connectPeer(host);
  const challenge = await withTimeout(peer.next());
  const connectionAttemptId = stringField(challenge, "connection_attempt_id");
  const hostNonce = stringField(challenge, "nonce");
  const clientNonce = randomBytes(24).toString("base64url");
  const runtimeInstanceId = "runtime.rejected.instance";
  peer.send({
    type: "client_hello",
    connection_attempt_id: connectionAttemptId,
    runtime_instance_id: runtimeInstanceId,
    build_configuration: buildConfiguration,
    supported_versions: supportedVersions,
    capabilities,
    selected_auth_method: "hmac-sha256",
    client_nonce: clientNonce,
    challenge_response: computeLoopbackClientProof(proofToken, {
      connectionAttemptId,
      hostNonce,
      clientNonce,
      runtimeInstanceId,
      buildConfiguration,
      supportedVersions,
      capabilities,
    }),
  });
  return { peer, response: await withTimeout(peer.next()) };
}

async function loadWireFixture(): Promise<WireFixture> {
  const [snapshotValue, artifactValue, objectValue] = await Promise.all([
    readJson("protocol/fixtures/v1/runtime-snapshot/valid/android-view.json"),
    readJson("protocol/fixtures/v1/artifact/valid/screenshot.json"),
    readJson("protocol/fixtures/v1/object/valid/plain-text.json"),
  ]);
  const snapshot = mutableRecord(structuredClone(snapshotValue));
  const screenshot = mutableRecord(snapshot["screenshot"]);
  const artifact = record(artifactValue);
  const objectFixture = record(objectValue);
  const object = record(structuredClone(artifact["object"]));
  screenshot["object"] = object;
  const payloadBase64 = objectFixture["payload_base64"];
  if (typeof payloadBase64 !== "string") {
    throw new Error("Object fixture has no payload.");
  }
  return {
    snapshot,
    object,
    payload: Buffer.from(payloadBase64, "base64"),
  };
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(path.join(repositoryRoot, relativePath), "utf8"),
  ) as unknown;
}

test("loopback Host authenticates Debug Runtime and transfers a strict chunked capture", async (t) => {
  const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
  let peer: TestJsonLinePeer | undefined;
  t.after(async () => {
    peer?.destroy();
    await host.close();
  });
  assert.equal(host.endpoint.host, "127.0.0.1");
  assert.ok(host.endpoint.port > 0);

  const ready = await authenticateRuntime(host);
  peer = ready.peer;
  assert.equal(ready.session.state, "ready");
  assert.deepEqual(ready.session.selectedVersion, { major: 1, minor: 0 });
  assert.deepEqual(ready.session.enabledCapabilities, ["runtime.snapshot"]);

  const hostProof = computeLoopbackHostProof(authorizationToken, {
    connectionAttemptId: stringField(ready.challenge, "connection_attempt_id"),
    connectionId: stringField(ready.welcome, "connection_id"),
    hostNonce: stringField(ready.challenge, "nonce"),
    clientNonce: ready.clientNonce,
    runtimeInstanceId: ready.runtimeInstanceId,
    selectedVersion: versionField(ready.welcome, "selected_version"),
    enabledCapabilities: stringArrayField(ready.welcome, "enabled_capabilities"),
  });
  assert.equal(ready.welcome["host_proof"], hostProof);

  const fixture = await loadWireFixture();
  const capture = ready.session.captureSnapshot(captureCommand);
  const request = await withTimeout(ready.peer.next());
  assert.equal(request["type"], "capture_request");
  assert.deepEqual(request["command"], captureCommand);
  const requestId = stringField(request, "request_id");
  ready.peer.send({
    type: "capture_result",
    request_id: requestId,
    snapshot: fixture.snapshot,
    objects: [fixture.object],
  });
  ready.peer.send({
    type: "object_start",
    request_id: requestId,
    object_index: 0,
    hash: fixture.object["hash"],
    byte_size: fixture.object["byte_size"],
  });
  ready.peer.send({
    type: "object_chunk",
    request_id: requestId,
    object_index: 0,
    sequence: 0,
    data: fixture.payload.subarray(0, 3).toString("base64"),
  });
  ready.peer.send({
    type: "object_chunk",
    request_id: requestId,
    object_index: 0,
    sequence: 1,
    data: fixture.payload.subarray(3).toString("base64"),
  });
  ready.peer.send({
    type: "object_end",
    request_id: requestId,
    object_index: 0,
    chunk_count: 2,
  });
  ready.peer.send({ type: "capture_complete", request_id: requestId });

  const result = await withTimeout(capture);
  assert.deepEqual(result.snapshot, fixture.snapshot);
  assert.equal(result.objects.length, 1);
  assert.deepEqual(result.objects[0]?.ref, fixture.object);
  assert.deepEqual(await collect(result.objects[0]?.stream as ByteStream), fixture.payload);
});

test("bad token and Release build fail without exposing the authorization token", async () => {
  for (const candidate of [
    {
      proofToken: wrongAuthorizationToken,
      buildConfiguration: "debug" as const,
      expectedCode: "unauthenticated",
    },
    {
      proofToken: authorizationToken,
      buildConfiguration: "release" as const,
      expectedCode: "forbidden",
    },
    {
      proofToken: authorizationToken,
      buildConfiguration: "debug" as const,
      supportedVersions: [{ major: 2, minor: 0 }],
      expectedCode: "unsupported",
    },
    {
      proofToken: authorizationToken,
      buildConfiguration: "internal" as const,
      capabilities: ["runtime.events"],
      expectedCode: "unsupported",
    },
  ]) {
    const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
    const { peer, response } = await sendHelloForError(
      host,
      candidate.proofToken,
      candidate.buildConfiguration,
      "supportedVersions" in candidate ? candidate.supportedVersions : undefined,
      "capabilities" in candidate ? candidate.capabilities : undefined,
    );
    assert.equal(response["type"], "error");
    assert.equal(response["code"], candidate.expectedCode);
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes(authorizationToken), false);
    assert.equal(serialized.includes(wrongAuthorizationToken), false);
    peer.destroy();
    await host.close();
  }
});

test("listener is loopback-only and ClientHello must precede ready-state messages", async () => {
  await assert.rejects(
    LoopbackRuntimeHost.listen({
      token: authorizationToken,
      host: "0.0.0.0" as never,
    }),
    transportError("forbidden"),
  );

  const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
  const peer = await connectPeer(host);
  await withTimeout(peer.next());
  peer.send({
    type: "capture_result",
    request_id: "premature",
    snapshot: {},
    objects: [],
  });
  const response = await withTimeout(peer.next());
  assert.equal(response["type"], "error");
  assert.equal(response["code"], "protocol_error");
  peer.destroy();
  await host.close();
});

test("oversized, malformed, duplicate, and out-of-order object transfer fails closed", async () => {
  const fixture = await loadWireFixture();
  const cases: readonly {
    readonly name: string;
    readonly hostOptions?: Omit<LoopbackRuntimeHostOptions, "token">;
    readonly sendInvalid: (
      peer: TestJsonLinePeer,
      requestId: string,
      fixture: WireFixture,
    ) => void;
    readonly expectedCode: "resource_exhausted" | "protocol_error";
  }[] = [
    {
      name: "oversized object",
      hostOptions: { maximumObjectBytes: 4 },
      expectedCode: "resource_exhausted",
      sendInvalid(peer, requestId, value) {
        peer.send({
          type: "capture_result",
          request_id: requestId,
          snapshot: value.snapshot,
          objects: [value.object],
        });
      },
    },
    {
      name: "malformed Base64",
      expectedCode: "protocol_error",
      sendInvalid(peer, requestId, value) {
        sendResultAndStart(peer, requestId, value);
        peer.send({
          type: "object_chunk",
          request_id: requestId,
          object_index: 0,
          sequence: 0,
          data: "***not-base64***",
        });
      },
    },
    {
      name: "duplicate object",
      expectedCode: "protocol_error",
      sendInvalid(peer, requestId, value) {
        peer.send({
          type: "capture_result",
          request_id: requestId,
          snapshot: value.snapshot,
          objects: [value.object, value.object],
        });
      },
    },
    {
      name: "out-of-order chunk",
      expectedCode: "protocol_error",
      sendInvalid(peer, requestId, value) {
        sendResultAndStart(peer, requestId, value);
        peer.send({
          type: "object_chunk",
          request_id: requestId,
          object_index: 0,
          sequence: 1,
          data: value.payload.toString("base64"),
        });
      },
    },
    {
      name: "hash mismatch",
      expectedCode: "protocol_error",
      sendInvalid(peer, requestId, value) {
        sendResultAndStart(peer, requestId, value);
        const corrupted = Buffer.from(value.payload);
        corrupted[0] = (corrupted[0] as number) ^ 0xff;
        peer.send({
          type: "object_chunk",
          request_id: requestId,
          object_index: 0,
          sequence: 0,
          data: corrupted.toString("base64"),
        });
        peer.send({
          type: "object_end",
          request_id: requestId,
          object_index: 0,
          chunk_count: 1,
        });
      },
    },
  ];

  for (const candidate of cases) {
    const host = await LoopbackRuntimeHost.listen({
      token: authorizationToken,
      ...candidate.hostOptions,
    });
    const ready = await authenticateRuntime(host);
    const capture = ready.session.captureSnapshot(captureCommand);
    const rejected = assert.rejects(capture, transportError(candidate.expectedCode));
    const request = await withTimeout(ready.peer.next());
    candidate.sendInvalid(ready.peer, stringField(request, "request_id"), fixture);
    await withTimeout(rejected, 3_000, candidate.name);
    const error = await withTimeout(ready.peer.next());
    assert.equal(error["type"], "error", candidate.name);
    assert.equal(error["code"], candidate.expectedCode, candidate.name);
    ready.peer.destroy();
    await host.close();
  }
});

test("bounded JSON lines reject oversized input", async () => {
  const host = await LoopbackRuntimeHost.listen({
    token: authorizationToken,
    maximumLineBytes: 1_024,
  });
  const peer = await connectPeer(host);
  await withTimeout(peer.next());
  peer.sendRaw('{"type":"' + "x".repeat(1_100) + '"}\n');
  const response = await withTimeout(peer.next());
  assert.equal(response["type"], "error");
  assert.equal(response["code"], "resource_exhausted");
  peer.destroy();
  await host.close();
});

test("malformed JSON and non-UTF-8 input fail the JSON-line channel closed", async () => {
  for (const malformed of [Buffer.from('{"type":\n'), Buffer.from([0xc3, 0x28, 0x0a])]) {
    const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
    const peer = await connectPeer(host);
    await withTimeout(peer.next());
    peer.sendRaw(malformed);
    const response = await withTimeout(peer.next());
    assert.equal(response["type"], "error");
    assert.equal(response["code"], "protocol_error");
    peer.destroy();
    await host.close();
  }
});

test("advertised maximum chunk fits inside the bounded JSON-line envelope", async () => {
  const maximumLineBytes = 1_024;
  const host = await LoopbackRuntimeHost.listen({
    token: authorizationToken,
    maximumLineBytes,
    maximumObjectBytes: 2_048,
    maximumChunkBytes: 2_048,
  });
  const ready = await authenticateRuntime(host);
  const sessionPolicy = record(ready.welcome["session_policy"]);
  const maximumChunkBytes = numberField(sessionPolicy, "maximum_chunk_bytes");
  assert.ok(maximumChunkBytes > 0);
  assert.ok(maximumChunkBytes < 2_048);

  const payload = Buffer.alloc(maximumChunkBytes, 0xa5);
  const hash = "sha256:" + createHash("sha256").update(payload).digest("hex");
  const object = { hash, byte_size: payload.byteLength };
  const capture = ready.session.captureSnapshot(captureCommand);
  const request = await withTimeout(ready.peer.next());
  const requestId = stringField(request, "request_id");
  ready.peer.send({
    type: "capture_result",
    request_id: requestId,
    snapshot: {},
    objects: [object],
  });
  ready.peer.send({
    type: "object_start",
    request_id: requestId,
    object_index: 0,
    hash,
    byte_size: payload.byteLength,
  });
  const chunk = {
    type: "object_chunk",
    request_id: requestId,
    object_index: 0,
    sequence: 0,
    data: payload.toString("base64"),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(chunk), "utf8") <= maximumLineBytes);
  ready.peer.send(chunk);
  ready.peer.send({
    type: "object_end",
    request_id: requestId,
    object_index: 0,
    chunk_count: 1,
  });
  ready.peer.send({ type: "capture_complete", request_id: requestId });

  const result = await withTimeout(capture);
  assert.deepEqual(await collect(result.objects[0]?.stream as ByteStream), payload);
  ready.peer.destroy();
  await host.close();
});

test("abort drains a crossing completion and disconnect rejects pending capture", async () => {
  const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
  const ready = await authenticateRuntime(host);
  const fixture = await loadWireFixture();

  const controller = new AbortController();
  const cancelledCapture = ready.session.captureSnapshot(captureCommand, {
    signal: controller.signal,
  });
  const cancelled = assert.rejects(cancelledCapture, transportError("cancelled"));
  const firstRequest = await withTimeout(ready.peer.next());
  controller.abort();
  await withTimeout(cancelled);
  const cancelMessage = await withTimeout(ready.peer.next());
  assert.equal(cancelMessage["type"], "capture_cancel");
  assert.equal(cancelMessage["request_id"], firstRequest["request_id"]);
  // Completion won at the Runtime just before it observed the Host cancel. The
  // cancelled caller stays cancelled, while the crossing bounded frames are
  // drained instead of poisoning the authenticated session.
  ready.peer.send({
    type: "capture_result",
    request_id: firstRequest["request_id"],
    snapshot: fixture.snapshot,
    objects: [],
  });
  ready.peer.send({
    type: "capture_complete",
    request_id: firstRequest["request_id"],
  });

  const followingCapture = ready.session.captureSnapshot(captureCommand);
  const followingRequest = await withTimeout(ready.peer.next());
  ready.peer.send({
    type: "capture_error",
    request_id: followingRequest["request_id"],
    code: "capture_failed",
    message: "Runtime capture failed.",
  });
  await assert.rejects(followingCapture, transportError("remote_error"));
  assert.equal(ready.session.state, "ready");

  const pendingCapture = ready.session.captureSnapshot(captureCommand);
  await withTimeout(ready.peer.next());
  const disconnected = assert.rejects(pendingCapture, transportError("unavailable"));
  ready.peer.destroy();
  await withTimeout(disconnected);
  await host.close();
});

function sendResultAndStart(
  peer: TestJsonLinePeer,
  requestId: string,
  fixture: WireFixture,
): void {
  peer.send({
    type: "capture_result",
    request_id: requestId,
    snapshot: fixture.snapshot,
    objects: [fixture.object],
  });
  peer.send({
    type: "object_start",
    request_id: requestId,
    object_index: 0,
    hash: fixture.object["hash"],
    byte_size: fixture.object["byte_size"],
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Fixture value must be an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return record(value) as Record<string, unknown>;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") {
    throw new Error("Expected string field " + field + ".");
  }
  return candidate;
}

function numberField(value: Readonly<Record<string, unknown>>, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number") {
    throw new Error("Expected number field " + field + ".");
  }
  return candidate;
}

function stringArrayField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === "string")) {
    throw new Error("Expected string array field " + field + ".");
  }
  return candidate;
}

function versionField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): LoopbackProtocolVersion {
  const candidate = record(value[field]);
  if (typeof candidate["major"] !== "number" || typeof candidate["minor"] !== "number") {
    throw new Error("Expected protocol version field " + field + ".");
  }
  return {
    major: candidate["major"],
    minor: candidate["minor"],
  };
}

function transportError(
  code: LoopbackTransportError["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof LoopbackTransportError && error.code === code;
}

async function collect(stream: ByteStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds = 2_000,
  label = "transport operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for " + label + ".")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
