import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";

import type { ByteStream } from "../../data/api/index.js";
import {
  computeLoopbackClientProof,
  computeLoopbackHostProof,
  LoopbackRuntimeHost,
  LoopbackTransportError,
  type LoopbackRuntimeSession,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const packagePath = path.join(repositoryRoot, "sdks/ios");
const fixturePath = path.join(
  repositoryRoot,
  "protocol/fixtures/v1/runtime-snapshot/valid/minimal.json",
);
const authorizationToken = "vistrea-loopback-integration-token-0001";
const wrongAuthorizationToken = "vistrea-loopback-integration-token-9999";
const swiftAvailable =
  process.platform === "darwin" &&
  spawnSync("swift", ["--version"], { stdio: "ignore" }).status === 0;

test(
  "Swift Runtime dispatches coalesced welcome and capture lines, then stops at disconnect",
  { skip: swiftAvailable ? false : "Swift is unavailable on this host." },
  async (t) => {
    const rawHost = await listenRawHost();
    const child = spawnSwiftClient("127.0.0.1", rawHost.port, authorizationToken);
    const childOutput = collectChildOutput(child);
    let peer: RawJsonLinePeer | undefined;
    t.after(async () => {
      peer?.destroy();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await closeServer(rawHost.server);
    });

    const socket = await withTimeout(rawHost.socket, 60_000, "raw Swift Runtime socket");
    peer = new RawJsonLinePeer(socket);
    const handshake = await authenticateRawRuntime(peer, 16 * 1_024, 3);
    const requestID = "00000000-0000-4000-8000-000000000001";
    peer.sendRaw(
      JSON.stringify(handshake.welcome) +
        "\n" +
        JSON.stringify({
          type: "capture_request",
          request_id: requestID,
          command: {
            include: { paths: ["trees", "screenshot"] },
            screenshot: "reference",
            reason: "manual",
          },
        }) +
        "\n",
    );

    const messageTypes: string[] = [];
    const chunks: Buffer[] = [];
    while (messageTypes.at(-1) !== "capture_complete") {
      const message: Readonly<Record<string, unknown>> = await withTimeout(
        peer.next(),
        10_000,
        "coalesced capture response",
      );
      const type = stringField(message, "type");
      messageTypes.push(type);
      assert.equal(message["request_id"], requestID);
      if (type === "capture_result") {
        assert.equal(
          record(message["snapshot"])["snapshot_id"],
          "snapshot_019f0000-0000-7000-8000-000000000001",
        );
      } else if (type === "object_chunk") {
        chunks.push(Buffer.from(stringField(message, "data"), "base64"));
      }
    }
    assert.deepEqual(messageTypes, [
      "capture_result",
      "object_start",
      "object_chunk",
      "object_chunk",
      "object_chunk",
      "object_end",
      "capture_complete",
    ]);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "Vistrea");

    peer.sendRaw(JSON.stringify({ type: "disconnect" }) + "\nnot-json\n");
    const exit = await withTimeout(childOutput, 10_000, "coalesced disconnect exit");
    assert.equal(exit.code, 0, exit.stderr);
  },
);

test(
  "Swift Runtime applies the negotiated inbound line limit to a coalesced ready line",
  { skip: swiftAvailable ? false : "Swift is unavailable on this host." },
  async (t) => {
    const rawHost = await listenRawHost();
    const child = spawnSwiftClient("127.0.0.1", rawHost.port, authorizationToken);
    const childOutput = collectChildOutput(child);
    let peer: RawJsonLinePeer | undefined;
    t.after(async () => {
      peer?.destroy();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await closeServer(rawHost.server);
    });

    const socket = await withTimeout(rawHost.socket, 60_000, "bounded raw Runtime socket");
    peer = new RawJsonLinePeer(socket);
    const handshake = await authenticateRawRuntime(peer, 1_024, 128);
    const oversizedReadyLine = JSON.stringify({
      type: "ping",
      padding: "x".repeat(1_100),
    });
    assert.ok(Buffer.byteLength(oversizedReadyLine, "utf8") > 1_024);
    peer.sendRaw(JSON.stringify(handshake.welcome) + "\n" + oversizedReadyLine + "\n");

    const exit = await withTimeout(childOutput, 10_000, "negotiated-limit rejection");
    assert.notEqual(exit.code, 0);
    assert.equal(exit.stderr.includes(authorizationToken), false);
  },
);
test(
  "Swift Runtime client interoperates with the Node Host for capture, objects, cancellation, and close",
  { skip: swiftAvailable ? false : "Swift is unavailable on this host." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({
      token: authorizationToken,
      maximumChunkBytes: 3,
    });
    const child = spawnSwiftClient(host.endpoint.host, host.endpoint.port, authorizationToken);
    const childOutput = collectChildOutput(child);
    let session: LoopbackRuntimeSession | undefined;
    t.after(async () => {
      session?.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });

    session = await withTimeout(host.acceptSession(), 60_000, "Swift Runtime handshake");
    assert.equal(session.state, "ready");
    assert.deepEqual(session.selectedVersion, { major: 1, minor: 0 });
    assert.deepEqual(session.enabledCapabilities, ["runtime.snapshot"]);

    const first = await withTimeout(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "manual",
      }),
      10_000,
      "Swift Runtime capture",
    );
    assert.equal(record(first.snapshot)["snapshot_id"], "snapshot_019f0000-0000-7000-8000-000000000001");
    assert.equal(first.objects.length, 1);
    assert.equal(record(first.objects[0]?.ref)["byte_size"], 7);
    assert.equal(
      (await collect(first.objects[0]?.stream as ByteStream)).toString("utf8"),
      "Vistrea",
    );

    await assert.rejects(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "review",
      }),
      (error: unknown) =>
        error instanceof LoopbackTransportError && error.code === "remote_error",
    );
    assert.equal(session.state, "ready");

    const controller = new AbortController();
    const cancelledCapture = session.captureSnapshot(
      {
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "validation",
      },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(
      withTimeout(cancelledCapture, 10_000, "Swift Runtime cancellation"),
      (error: unknown) =>
        error instanceof LoopbackTransportError && error.code === "cancelled",
    );

    const afterCancellation = await withTimeout(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "manual",
      }),
      10_000,
      "post-cancellation Swift Runtime capture",
    );
    assert.equal(afterCancellation.objects.length, 1);

    session.close();
    const exit = await withTimeout(childOutput, 10_000, "Swift Runtime process exit");
    assert.equal(exit.code, 0, exit.stderr);
    assert.equal(exit.stdout.includes(authorizationToken), false);
    assert.equal(exit.stderr.includes(authorizationToken), false);
  },
);

test(
  "Swift Runtime authentication failure never emits authorization material",
  { skip: swiftAvailable ? false : "Swift is unavailable on this host." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
    const child = spawnSwiftClient(
      host.endpoint.host,
      host.endpoint.port,
      wrongAuthorizationToken,
    );
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });
    const exit = await withTimeout(
      collectChildOutput(child),
      60_000,
      "rejected Swift Runtime process exit",
    );
    assert.notEqual(exit.code, 0);
    for (const secret of [authorizationToken, wrongAuthorizationToken]) {
      assert.equal(exit.stdout.includes(secret), false);
      assert.equal(exit.stderr.includes(secret), false);
    }
  },
);

function spawnSwiftClient(
  host: string,
  port: number,
  token: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    "swift",
    [
      "run",
      "--quiet",
      "--package-path",
      packagePath,
      "VistreaRuntimeInteropFixtureClient",
      "--host",
      host,
      "--port",
      String(port),
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        VISTREA_RUNTIME_TOKEN: token,
        VISTREA_RUNTIME_FIXTURE: fixturePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

interface RawHost {
  readonly server: Server;
  readonly port: number;
  readonly socket: Promise<Socket>;
}

class RawJsonLinePeer {
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
    this.#socket.setNoDelay(true);
    this.#socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#socket.on("error", () => this.#close());
    this.#socket.on("close", () => this.#close());
  }

  send(message: Readonly<Record<string, unknown>>): void {
    this.sendRaw(JSON.stringify(message) + "\n");
  }

  sendRaw(value: string): void {
    this.#socket.write(value);
  }

  next(): Promise<Readonly<Record<string, unknown>>> {
    const message = this.#messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    if (this.#closed) {
      return Promise.reject(new Error("Raw Runtime peer closed."));
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  destroy(): void {
    this.#socket.destroy();
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
      const message = record(value);
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#messages.push(message);
      } else {
        waiter.resolve(message);
      }
    }
  }

  #close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new Error("Raw Runtime peer closed."));
    }
  }
}

async function listenRawHost(): Promise<RawHost> {
  let resolveSocket: ((socket: Socket) => void) | undefined;
  const socket = new Promise<Socket>((resolve) => {
    resolveSocket = resolve;
  });
  const server = net.createServer({ allowHalfOpen: false }, (connection) => {
    resolveSocket?.(connection);
    resolveSocket = undefined;
  });
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Raw Runtime Host has no TCP endpoint.");
  }
  return { server, port: address.port, socket };
}

async function authenticateRawRuntime(
  peer: RawJsonLinePeer,
  maximumLineBytes: number,
  maximumChunkBytes: number,
): Promise<{ readonly welcome: Readonly<Record<string, unknown>> }> {
  const connectionAttemptID = "attempt-coalesced-0001";
  const hostNonce = "host_nonce_abcdefghijklmnop";
  peer.send({
    type: "host_challenge",
    connection_attempt_id: connectionAttemptID,
    nonce: hostNonce,
    supported_versions: [{ major: 1, minor: 0 }],
    supported_auth_methods: ["hmac-sha256"],
    host_identity: "vistrea-raw-test-host",
  });
  const hello = await withTimeout(peer.next(), 10_000, "raw ClientHello");
  assert.equal(hello["type"], "client_hello");
  assert.deepEqual(hello["supported_versions"], [{ major: 1, minor: 0 }]);
  assert.deepEqual(hello["capabilities"], ["runtime.snapshot"]);
  assert.equal(hello["build_configuration"], "debug");
  const clientNonce = stringField(hello, "client_nonce");
  const runtimeInstanceID = stringField(hello, "runtime_instance_id");
  assert.equal(
    hello["challenge_response"],
    computeLoopbackClientProof(authorizationToken, {
      connectionAttemptId: connectionAttemptID,
      hostNonce,
      clientNonce,
      runtimeInstanceId: runtimeInstanceID,
      buildConfiguration: "debug",
      supportedVersions: [{ major: 1, minor: 0 }],
      capabilities: ["runtime.snapshot"],
    }),
  );

  const connectionID = "connection-coalesced-0001";
  const enabledCapabilities = ["runtime.snapshot"];
  const selectedVersion = { major: 1, minor: 0 };
  return {
    welcome: {
      type: "host_welcome",
      connection_id: connectionID,
      selected_version: selectedVersion,
      enabled_capabilities: enabledCapabilities,
      host_proof: computeLoopbackHostProof(authorizationToken, {
        connectionAttemptId: connectionAttemptID,
        connectionId: connectionID,
        hostNonce,
        clientNonce,
        runtimeInstanceId: runtimeInstanceID,
        selectedVersion,
        enabledCapabilities,
      }),
      session_policy: {
        maximum_line_bytes: maximumLineBytes,
        maximum_object_bytes: 1_024 * 1_024,
        maximum_chunk_bytes: maximumChunkBytes,
      },
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function collectChildOutput(
  child: ChildProcessWithoutNullStreams,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
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
  return Promise.race([
    once(child, "close").then(([code]) => ({
      code: typeof code === "number" ? code : null,
      stdout,
      stderr,
    })),
    once(child, "error").then(([error]) => Promise.reject(error)),
  ]);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object value.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") {
    throw new Error("Expected string field " + field + ".");
  }
  return candidate;
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
  milliseconds: number,
  label: string,
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
