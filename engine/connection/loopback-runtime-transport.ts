import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import net, { type Server, type Socket } from "node:net";

import type { ByteStream } from "../../data/api/index.js";
import {
  BoundedJsonLineChannel,
  JsonLineFailure,
} from "./loopback-json-lines.js";
import type {
  CaptureSnapshotCommand,
  RuntimeCapturedObject,
  RuntimeCaptureOptions,
  RuntimeCapturePort,
  RuntimeCaptureResult,
} from "./snapshot-engine.js";

const SNAPSHOT_CAPABILITY = "runtime.snapshot";
const AUTH_METHOD = "hmac-sha256";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const RUNTIME_INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const HEX_PROOF_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_MAXIMUM_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_OBJECT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAXIMUM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const MAXIMUM_CAPTURE_OBJECTS = 256;
const MAXIMUM_OBJECT_INDEX = MAXIMUM_CAPTURE_OBJECTS - 1;

export type LoopbackTransportErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "unsupported"
  | "protocol_error"
  | "resource_exhausted"
  | "cancelled"
  | "timeout"
  | "unavailable"
  | "remote_error";

export class LoopbackTransportError extends Error {
  constructor(readonly code: LoopbackTransportErrorCode, message: string) {
    super(message);
    this.name = "LoopbackTransportError";
  }
}

export interface LoopbackProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export type RuntimeBuildConfiguration = "debug" | "internal" | "release";

export interface LoopbackClientProofInput {
  readonly connectionAttemptId: string;
  readonly hostNonce: string;
  readonly clientNonce: string;
  readonly runtimeInstanceId: string;
  readonly buildConfiguration: RuntimeBuildConfiguration;
  readonly supportedVersions: readonly LoopbackProtocolVersion[];
  readonly capabilities: readonly string[];
}

export interface LoopbackHostProofInput {
  readonly connectionAttemptId: string;
  readonly connectionId: string;
  readonly hostNonce: string;
  readonly clientNonce: string;
  readonly runtimeInstanceId: string;
  readonly selectedVersion: LoopbackProtocolVersion;
  readonly enabledCapabilities: readonly string[];
}

export type LoopbackAuthorizationToken = string | Uint8Array;

export function computeLoopbackClientProof(
  token: LoopbackAuthorizationToken,
  input: LoopbackClientProofInput,
): string {
  const message = [
    "vistrea-runtime-client-v1",
    input.connectionAttemptId,
    input.hostNonce,
    input.clientNonce,
    input.runtimeInstanceId,
    input.buildConfiguration,
    normalizeVersions(input.supportedVersions)
      .map((version) => String(version.major) + "." + String(version.minor))
      .join(","),
    normalizeCapabilities(input.capabilities).join(","),
  ].join("\n");
  return hmacHex(token, message);
}

export function computeLoopbackHostProof(
  token: LoopbackAuthorizationToken,
  input: LoopbackHostProofInput,
): string {
  const message = [
    "vistrea-runtime-host-v1",
    input.connectionAttemptId,
    input.connectionId,
    input.hostNonce,
    input.clientNonce,
    input.runtimeInstanceId,
    String(input.selectedVersion.major) + "." + String(input.selectedVersion.minor),
    normalizeCapabilities(input.enabledCapabilities).join(","),
  ].join("\n");
  return hmacHex(token, message);
}

export interface LoopbackRuntimeHostOptions {
  readonly token: LoopbackAuthorizationToken;
  readonly host?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly maximumLineBytes?: number;
  readonly maximumObjectBytes?: number;
  readonly maximumChunkBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly captureTimeoutMs?: number;
}

export interface LoopbackRuntimeEndpoint {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}

interface TransportLimits {
  readonly maximumLineBytes: number;
  readonly maximumObjectBytes: number;
  readonly maximumChunkBytes: number;
  readonly handshakeTimeoutMs: number;
  readonly captureTimeoutMs: number;
}

interface SessionWaiter {
  readonly resolve: (session: LoopbackRuntimeSession) => void;
  readonly reject: (error: LoopbackTransportError) => void;
}

export class LoopbackRuntimeHost {
  readonly #server: Server;
  readonly #secret: Buffer;
  readonly #limits: TransportLimits;
  readonly #connections = new Set<HostRuntimeConnection>();
  readonly #readySessions: LoopbackRuntimeSession[] = [];
  readonly #waiters: SessionWaiter[] = [];
  #closed = false;

  private constructor(
    server: Server,
    secret: Buffer,
    limits: TransportLimits,
    readonly endpoint: LoopbackRuntimeEndpoint,
  ) {
    this.#server = server;
    this.#secret = secret;
    this.#limits = limits;
    this.#server.on("connection", (socket) => this.#acceptSocket(socket));
    this.#server.on("error", () => {
      void this.close();
    });
  }

  static async listen(options: LoopbackRuntimeHostOptions): Promise<LoopbackRuntimeHost> {
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new LoopbackTransportError(
        "forbidden",
        "The Runtime Host listener must bind to an explicit loopback address.",
      );
    }
    const port = normalizePort(options.port ?? 0);
    const limits = normalizeLimits(options);
    const secret = normalizeToken(options.token);
    const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: false });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (): void => {
          server.off("listening", onListening);
          reject(
            new LoopbackTransportError(
              "unavailable",
              "The loopback Runtime Host listener could not start.",
            ),
          );
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host, port, exclusive: true });
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new LoopbackTransportError(
          "unavailable",
          "The loopback Runtime Host listener has no TCP endpoint.",
        );
      }
      return new LoopbackRuntimeHost(server, secret, limits, {
        host,
        port: address.port,
      });
    } catch (error) {
      secret.fill(0);
      if (server.listening) {
        server.close();
      }
      throw error;
    }
  }

  acceptSession(): Promise<LoopbackRuntimeSession> {
    while (this.#readySessions.length > 0) {
      const session = this.#readySessions.shift();
      if (session?.state === "ready") {
        return Promise.resolve(session);
      }
    }
    if (this.#closed) {
      return Promise.reject(
        new LoopbackTransportError("unavailable", "The loopback Runtime Host is closed."),
      );
    }
    return new Promise<LoopbackRuntimeSession>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const error = new LoopbackTransportError(
      "unavailable",
      "The loopback Runtime Host is closed.",
    );
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
    for (const connection of [...this.#connections]) {
      connection.close();
    }
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
    this.#secret.fill(0);
  }

  #acceptSocket(socket: Socket): void {
    if (this.#closed || !isLoopbackAddress(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    try {
      const connection = new HostRuntimeConnection({
        socket,
        secret: this.#secret,
        limits: this.#limits,
        onReady: (session) => this.#publishReadySession(session),
        onClosed: (closed) => this.#connections.delete(closed),
      });
      this.#connections.add(connection);
    } catch {
      socket.destroy();
    }
  }

  #publishReadySession(session: LoopbackRuntimeSession): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#readySessions.push(session);
    } else {
      waiter.resolve(session);
    }
  }
}

interface HostRuntimeConnectionOptions {
  readonly socket: Socket;
  readonly secret: Buffer;
  readonly limits: TransportLimits;
  readonly onReady: (session: LoopbackRuntimeSession) => void;
  readonly onClosed: (connection: HostRuntimeConnection) => void;
}

type HandshakeState = "authenticating" | "ready" | "failed" | "closed";

class HostRuntimeConnection {
  readonly #secret: Buffer;
  readonly #limits: TransportLimits;
  readonly #onReady: (session: LoopbackRuntimeSession) => void;
  readonly #onClosed: (connection: HostRuntimeConnection) => void;
  readonly #channel: BoundedJsonLineChannel;
  readonly #connectionAttemptId = randomUUID();
  readonly #hostNonce = randomBytes(32).toString("base64url");
  readonly #handshakeTimer: ReturnType<typeof setTimeout>;
  #state: HandshakeState = "authenticating";
  #session: LoopbackRuntimeSession | undefined;

  constructor(options: HostRuntimeConnectionOptions) {
    this.#secret = options.secret;
    this.#limits = options.limits;
    this.#onReady = options.onReady;
    this.#onClosed = options.onClosed;
    this.#channel = new BoundedJsonLineChannel({
      socket: options.socket,
      maximumLineBytes: options.limits.maximumLineBytes,
      onMessage: (message) => this.#receive(message),
      onFailure: (failure) => this.#channelFailure(failure),
      onClosed: () => this.#closed(),
    });
    this.#handshakeTimer = setTimeout(
      () =>
        this.#fail(
          new LoopbackTransportError("timeout", "The Runtime authentication handshake timed out."),
        ),
      this.#limits.handshakeTimeoutMs,
    );
    this.#handshakeTimer.unref();

    this.#channel.send({
      type: "host_challenge",
      connection_attempt_id: this.#connectionAttemptId,
      nonce: this.#hostNonce,
      supported_versions: [{ major: 1, minor: 0 }],
      supported_auth_methods: [AUTH_METHOD],
      host_identity: "vistrea-node-loopback-host",
    });
  }

  close(): void {
    if (this.#state === "closed") {
      return;
    }
    clearTimeout(this.#handshakeTimer);
    this.#session?.transportClosed(
      new LoopbackTransportError("unavailable", "The Runtime connection was closed."),
    );
    this.#channel.destroy();
  }

  #receive(message: Readonly<Record<string, unknown>>): void {
    if (this.#state === "failed" || this.#state === "closed") {
      return;
    }
    try {
      if (this.#state === "authenticating") {
        this.#authenticate(message);
      } else {
        this.#session?.receive(message);
      }
    } catch (error) {
      this.#fail(
        error instanceof LoopbackTransportError
          ? error
          : new LoopbackTransportError(
              "protocol_error",
              "The Runtime sent an invalid transport message.",
            ),
      );
    }
  }

  #authenticate(message: Readonly<Record<string, unknown>>): void {
    if (message["type"] !== "client_hello") {
      throw new LoopbackTransportError(
        "protocol_error",
        "ClientHello must immediately follow HostChallenge.",
      );
    }
    const connectionAttemptId = requireString(message, "connection_attempt_id", 128);
    const runtimeInstanceId = requireString(message, "runtime_instance_id", 256);
    const buildConfiguration = requireBuildConfiguration(message["build_configuration"]);
    const selectedAuthMethod = requireString(message, "selected_auth_method", 64);
    const clientNonce = requireString(message, "client_nonce", 256);
    const challengeResponse = requireString(message, "challenge_response", 128);
    const supportedVersions = parseVersions(message["supported_versions"]);
    const capabilities = parseCapabilities(message["capabilities"]);

    if (
      connectionAttemptId !== this.#connectionAttemptId ||
      selectedAuthMethod !== AUTH_METHOD ||
      !NONCE_PATTERN.test(clientNonce) ||
      !RUNTIME_INSTANCE_PATTERN.test(runtimeInstanceId)
    ) {
      throw new LoopbackTransportError("unauthenticated", "Runtime authentication failed.");
    }
    const expectedProof = computeLoopbackClientProof(this.#secret, {
      connectionAttemptId,
      hostNonce: this.#hostNonce,
      clientNonce,
      runtimeInstanceId,
      buildConfiguration,
      supportedVersions,
      capabilities,
    });
    if (!secureHexEquals(challengeResponse, expectedProof)) {
      throw new LoopbackTransportError("unauthenticated", "Runtime authentication failed.");
    }
    if (buildConfiguration === "release") {
      throw new LoopbackTransportError(
        "forbidden",
        "Release application builds cannot use the development Runtime transport.",
      );
    }
    if (!supportedVersions.some((version) => version.major === 1 && version.minor === 0)) {
      throw new LoopbackTransportError(
        "unsupported",
        "The Runtime and Host have no supported protocol version in common.",
      );
    }
    if (!capabilities.includes(SNAPSHOT_CAPABILITY)) {
      throw new LoopbackTransportError(
        "unsupported",
        "The Runtime does not support the required Snapshot capability.",
      );
    }

    const connectionId = randomUUID();
    const enabledCapabilities = [SNAPSHOT_CAPABILITY] as const;
    const selectedVersion = { major: 1, minor: 0 } as const;
    const hostProof = computeLoopbackHostProof(this.#secret, {
      connectionAttemptId,
      connectionId,
      hostNonce: this.#hostNonce,
      clientNonce,
      runtimeInstanceId,
      selectedVersion,
      enabledCapabilities,
    });

    this.#channel.send({
      type: "host_welcome",
      connection_id: connectionId,
      selected_version: selectedVersion,
      enabled_capabilities: enabledCapabilities,
      host_proof: hostProof,
      session_policy: {
        maximum_line_bytes: this.#limits.maximumLineBytes,
        maximum_object_bytes: this.#limits.maximumObjectBytes,
        maximum_chunk_bytes: this.#limits.maximumChunkBytes,
      },
    });
    clearTimeout(this.#handshakeTimer);
    this.#state = "ready";
    this.#session = new LoopbackRuntimeSession({
      channel: this.#channel,
      connectionId,
      runtimeInstanceId,
      selectedVersion,
      enabledCapabilities,
      limits: this.#limits,
      onFatal: (error) => this.#fail(error),
    });
    this.#onReady(this.#session);
  }

  #channelFailure(failure: JsonLineFailure): void {
    const error =
      failure.kind === "line_too_large"
        ? new LoopbackTransportError(
            "resource_exhausted",
            "A Runtime transport line exceeded the configured limit.",
          )
        : failure.kind === "socket_error"
          ? new LoopbackTransportError("unavailable", "The Runtime connection failed.")
          : new LoopbackTransportError(
              "protocol_error",
              "The Runtime sent malformed JSON-line data.",
            );
    this.#fail(error);
  }

  #fail(error: LoopbackTransportError): void {
    if (this.#state === "failed" || this.#state === "closed") {
      return;
    }
    this.#state = "failed";
    clearTimeout(this.#handshakeTimer);
    this.#session?.transportClosed(error);
    try {
      this.#channel.send({
        type: "error",
        code: error.code,
        message: publicErrorMessage(error.code),
      });
      this.#channel.end();
    } catch {
      this.#channel.destroy();
    }
  }

  #closed(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    clearTimeout(this.#handshakeTimer);
    this.#session?.transportClosed(
      new LoopbackTransportError("unavailable", "The Runtime connection disconnected."),
    );
    this.#onClosed(this);
  }
}

interface LoopbackRuntimeSessionOptions {
  readonly channel: BoundedJsonLineChannel;
  readonly connectionId: string;
  readonly runtimeInstanceId: string;
  readonly selectedVersion: LoopbackProtocolVersion;
  readonly enabledCapabilities: readonly string[];
  readonly limits: TransportLimits;
  readonly onFatal: (error: LoopbackTransportError) => void;
}

type CapturePhase =
  | "awaiting_result"
  | "awaiting_object_start"
  | "receiving_object"
  | "awaiting_complete";

interface DeclaredObject {
  readonly ref: unknown;
  readonly hash: string;
  readonly byteSize: number;
}

interface ReceivingObject {
  readonly declaration: DeclaredObject;
  readonly index: number;
  readonly chunks: Buffer[];
  readonly digest: ReturnType<typeof createHash>;
  nextSequence: number;
  receivedBytes: number;
}

interface PendingCapture {
  readonly requestId: string;
  readonly resolve: (result: RuntimeCaptureResult) => void;
  readonly reject: (error: LoopbackTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
  phase: CapturePhase;
  snapshot: unknown;
  declarations: readonly DeclaredObject[];
  nextObjectIndex: number;
  current: ReceivingObject | undefined;
  receivedObjects: RuntimeCapturedObject[];
}

export type LoopbackRuntimeSessionState = "ready" | "failed" | "closed";

export class LoopbackRuntimeSession implements RuntimeCapturePort {
  readonly connectionId: string;
  readonly runtimeInstanceId: string;
  readonly selectedVersion: LoopbackProtocolVersion;
  readonly enabledCapabilities: readonly string[];
  readonly #channel: BoundedJsonLineChannel;
  readonly #limits: TransportLimits;
  readonly #onFatal: (error: LoopbackTransportError) => void;
  readonly #pending = new Map<string, PendingCapture>();
  readonly #cancelled = new Set<string>();
  #state: LoopbackRuntimeSessionState = "ready";

  constructor(options: LoopbackRuntimeSessionOptions) {
    this.#channel = options.channel;
    this.connectionId = options.connectionId;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.selectedVersion = Object.freeze({ ...options.selectedVersion });
    this.enabledCapabilities = Object.freeze([...options.enabledCapabilities]);
    this.#limits = options.limits;
    this.#onFatal = options.onFatal;
  }

  get state(): LoopbackRuntimeSessionState {
    return this.#state;
  }

  captureSnapshot(
    command: CaptureSnapshotCommand,
    options: RuntimeCaptureOptions = {},
  ): Promise<RuntimeCaptureResult> {
    if (this.#state !== "ready") {
      return Promise.reject(
        new LoopbackTransportError("unavailable", "The Runtime session is not ready."),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(
        new LoopbackTransportError("cancelled", "The Runtime capture was cancelled."),
      );
    }
    const normalizedCommand = normalizeCaptureCommand(command);
    const requestId = randomUUID();

    return new Promise<RuntimeCaptureResult>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#cancelPending(requestId, "timeout"),
        this.#limits.captureTimeoutMs,
      );
      timer.unref();
      const abortListener =
        options.signal === undefined
          ? undefined
          : (): void => this.#cancelPending(requestId, "cancelled");
      const pending: PendingCapture = {
        requestId,
        resolve,
        reject,
        timer,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(abortListener === undefined ? {} : { abortListener }),
        phase: "awaiting_result",
        snapshot: null,
        declarations: [],
        nextObjectIndex: 0,
        current: undefined,
        receivedObjects: [],
      };
      this.#pending.set(requestId, pending);
      options.signal?.addEventListener("abort", abortListener as () => void, { once: true });
      try {
        this.#channel.send({
          type: "capture_request",
          request_id: requestId,
          command: normalizedCommand,
        });
      } catch (error) {
        this.#finishRejected(
          pending,
          error instanceof JsonLineFailure && error.kind === "line_too_large"
            ? new LoopbackTransportError(
                "resource_exhausted",
                "The CaptureSnapshot request exceeds the configured line limit.",
              )
            : new LoopbackTransportError(
                "unavailable",
                "The Runtime connection is unavailable.",
              ),
        );
      }
    });
  }

  receive(message: Readonly<Record<string, unknown>>): void {
    if (this.#state !== "ready") {
      return;
    }
    try {
      const type = requireString(message, "type", 64);
      if (type === "capture_cancelled") {
        this.#captureCancelled(message);
        return;
      }
      if (type === "capture_error") {
        this.#captureError(message);
        return;
      }
      const pending = this.#pendingFor(message, type);
      switch (type) {
        case "capture_result":
          this.#captureResult(pending, message);
          break;
        case "object_start":
          this.#objectStart(pending, message);
          break;
        case "object_chunk":
          this.#objectChunk(pending, message);
          break;
        case "object_end":
          this.#objectEnd(pending, message);
          break;
        case "capture_complete":
          this.#captureComplete(pending);
          break;
        default:
          throw new LoopbackTransportError(
            "protocol_error",
            "The Runtime sent an unsupported ready-state message.",
          );
      }
    } catch (error) {
      const transportError =
        error instanceof LoopbackTransportError
          ? error
          : new LoopbackTransportError(
              "protocol_error",
              "The Runtime sent an invalid capture message.",
            );
      this.#state = "failed";
      this.#failAll(transportError);
      this.#onFatal(transportError);
    }
  }

  close(): void {
    if (this.#state !== "ready") {
      return;
    }
    this.#state = "closed";
    this.#failAll(
      new LoopbackTransportError("cancelled", "The Runtime session was closed."),
    );
    try {
      this.#channel.send({ type: "disconnect" });
      this.#channel.end();
    } catch {
      this.#channel.destroy();
    }
  }

  transportClosed(error: LoopbackTransportError): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = error.code === "unavailable" ? "closed" : "failed";
    this.#failAll(error);
  }

  #pendingFor(
    message: Readonly<Record<string, unknown>>,
    type: string,
  ): PendingCapture {
    const requestId = requireString(message, "request_id", 128);
    if (this.#cancelled.has(requestId)) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime continued a capture after cancellation.",
      );
    }
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime referenced an unknown capture request.",
      );
    }
    if (type !== "capture_result" && pending.phase === "awaiting_result") {
      throw new LoopbackTransportError(
        "protocol_error",
        "Capture object data arrived before CaptureSnapshotResult.",
      );
    }
    return pending;
  }

  #captureResult(
    pending: PendingCapture,
    message: Readonly<Record<string, unknown>>,
  ): void {
    if (pending.phase !== "awaiting_result" || !("snapshot" in message)) {
      throw new LoopbackTransportError(
        "protocol_error",
        "CaptureSnapshotResult is missing or duplicated.",
      );
    }
    const objectValues = message["objects"];
    if (!Array.isArray(objectValues) || objectValues.length > MAXIMUM_CAPTURE_OBJECTS) {
      throw new LoopbackTransportError(
        "resource_exhausted",
        "CaptureSnapshotResult contains too many objects.",
      );
    }
    const hashes = new Set<string>();
    let declaredBytes = 0;
    const declarations = objectValues.map((value): DeclaredObject => {
      const ref = requireRecord(value, "Capture ObjectRef");
      const hash = requireString(ref, "hash", 80);
      const byteSize = requireSafeUnsigned(ref["byte_size"], "byte_size");
      if (!HASH_PATTERN.test(hash)) {
        throw new LoopbackTransportError(
          "protocol_error",
          "CaptureSnapshotResult contains an invalid object hash.",
        );
      }
      if (hashes.has(hash)) {
        throw new LoopbackTransportError(
          "protocol_error",
          "CaptureSnapshotResult contains a duplicate object hash.",
        );
      }
      if (byteSize > this.#limits.maximumObjectBytes - declaredBytes) {
        throw new LoopbackTransportError(
          "resource_exhausted",
          "Captured objects exceed the configured byte limit.",
        );
      }
      declaredBytes += byteSize;
      hashes.add(hash);
      return { ref: structuredClone(value), hash, byteSize };
    });
    pending.snapshot = structuredClone(message["snapshot"]);
    pending.declarations = declarations;
    pending.phase = declarations.length === 0 ? "awaiting_complete" : "awaiting_object_start";
  }

  #objectStart(
    pending: PendingCapture,
    message: Readonly<Record<string, unknown>>,
  ): void {
    if (pending.phase !== "awaiting_object_start") {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object transfer started out of order.",
      );
    }
    const objectIndex = requireSafeUnsigned(message["object_index"], "object_index");
    const hash = requireString(message, "hash", 80);
    const byteSize = requireSafeUnsigned(message["byte_size"], "byte_size");
    const declaration = pending.declarations[pending.nextObjectIndex];
    if (
      declaration === undefined ||
      objectIndex !== pending.nextObjectIndex ||
      hash !== declaration.hash ||
      byteSize !== declaration.byteSize
    ) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object transfer does not match declared order or identity.",
      );
    }
    pending.current = {
      declaration,
      index: objectIndex,
      chunks: [],
      digest: createHash("sha256"),
      nextSequence: 0,
      receivedBytes: 0,
    };
    pending.phase = "receiving_object";
  }

  #objectChunk(
    pending: PendingCapture,
    message: Readonly<Record<string, unknown>>,
  ): void {
    const current = pending.current;
    if (pending.phase !== "receiving_object" || current === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object chunk arrived outside an object transfer.",
      );
    }
    const objectIndex = requireSafeUnsigned(message["object_index"], "object_index");
    const sequence = requireSafeUnsigned(message["sequence"], "sequence");
    const data = requireString(
      message,
      "data",
      Math.ceil((this.#limits.maximumChunkBytes * 4) / 3) + 8,
    );
    if (objectIndex !== current.index || sequence !== current.nextSequence) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object chunks must be contiguous and ordered.",
      );
    }
    const bytes = decodeCanonicalBase64(data);
    if (bytes.byteLength === 0 || bytes.byteLength > this.#limits.maximumChunkBytes) {
      throw new LoopbackTransportError(
        "resource_exhausted",
        "An object chunk exceeds the configured byte limit.",
      );
    }
    if (
      current.receivedBytes + bytes.byteLength > current.declaration.byteSize ||
      current.receivedBytes + bytes.byteLength > this.#limits.maximumObjectBytes
    ) {
      throw new LoopbackTransportError(
        "resource_exhausted",
        "Object transfer bytes exceed the declared or configured size.",
      );
    }
    current.chunks.push(bytes);
    current.digest.update(bytes);
    current.receivedBytes += bytes.byteLength;
    current.nextSequence += 1;
  }

  #objectEnd(
    pending: PendingCapture,
    message: Readonly<Record<string, unknown>>,
  ): void {
    const current = pending.current;
    if (pending.phase !== "receiving_object" || current === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object end arrived outside an object transfer.",
      );
    }
    const objectIndex = requireSafeUnsigned(message["object_index"], "object_index");
    const chunkCount = requireSafeUnsigned(message["chunk_count"], "chunk_count");
    if (objectIndex !== current.index || chunkCount !== current.nextSequence) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object end does not match the transferred chunk sequence.",
      );
    }
    if (current.receivedBytes !== current.declaration.byteSize) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object transfer size does not match its declared ObjectRef.",
      );
    }
    const actualHash = "sha256:" + current.digest.digest("hex");
    if (actualHash !== current.declaration.hash) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Object transfer hash does not match its declared ObjectRef.",
      );
    }
    pending.receivedObjects.push({
      ref: structuredClone(current.declaration.ref),
      stream: streamBuffers(current.chunks),
    });
    pending.nextObjectIndex += 1;
    pending.current = undefined;
    pending.phase =
      pending.nextObjectIndex === pending.declarations.length
        ? "awaiting_complete"
        : "awaiting_object_start";
  }

  #captureComplete(pending: PendingCapture): void {
    if (
      pending.phase !== "awaiting_complete" ||
      pending.nextObjectIndex !== pending.declarations.length
    ) {
      throw new LoopbackTransportError(
        "protocol_error",
        "Capture completed before every declared object was transferred.",
      );
    }
    const result: RuntimeCaptureResult = {
      snapshot: structuredClone(pending.snapshot),
      objects: pending.receivedObjects.map((object) => ({
        ref: structuredClone(object.ref),
        stream: object.stream,
      })),
    };
    this.#finishResolved(pending, result);
  }

  #captureError(message: Readonly<Record<string, unknown>>): void {
    const requestId = requireString(message, "request_id", 128);
    if (this.#cancelled.delete(requestId)) {
      return;
    }
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime reported an error for an unknown capture request.",
      );
    }
    this.#finishRejected(
      pending,
      new LoopbackTransportError("remote_error", "The Runtime capture failed."),
    );
  }

  #captureCancelled(message: Readonly<Record<string, unknown>>): void {
    const requestId = requireString(message, "request_id", 128);
    if (this.#cancelled.delete(requestId)) {
      return;
    }
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime cancelled an unknown capture request.",
      );
    }
    this.#finishRejected(
      pending,
      new LoopbackTransportError("cancelled", "The Runtime capture was cancelled."),
    );
  }

  #cancelPending(requestId: string, code: "cancelled" | "timeout"): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.#cancelled.add(requestId);
    try {
      this.#channel.send({ type: "capture_cancel", request_id: requestId });
    } catch {
      // The pending request still terminates locally if the connection is already gone.
    }
    this.#finishRejected(
      pending,
      new LoopbackTransportError(
        code,
        code === "timeout"
          ? "The Runtime capture timed out."
          : "The Runtime capture was cancelled.",
      ),
    );
    const cleanup = setTimeout(
      () => this.#cancelled.delete(requestId),
      this.#limits.captureTimeoutMs,
    );
    cleanup.unref();
  }

  #finishResolved(pending: PendingCapture, result: RuntimeCaptureResult): void {
    this.#cleanupPending(pending);
    pending.resolve(result);
  }

  #finishRejected(pending: PendingCapture, error: LoopbackTransportError): void {
    this.#cleanupPending(pending);
    pending.reject(error);
  }

  #cleanupPending(pending: PendingCapture): void {
    this.#pending.delete(pending.requestId);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  #failAll(error: LoopbackTransportError): void {
    for (const pending of [...this.#pending.values()]) {
      this.#finishRejected(pending, error);
    }
    this.#cancelled.clear();
  }
}

async function* streamBuffers(chunks: readonly Uint8Array[]): ByteStream {
  for (const chunk of chunks) {
    yield new Uint8Array(chunk);
  }
}

function normalizeCaptureCommand(
  command: CaptureSnapshotCommand,
): Readonly<Record<string, unknown>> {
  if (command === null || typeof command !== "object") {
    throw new LoopbackTransportError(
      "protocol_error",
      "CaptureSnapshot command must be an object.",
    );
  }
  if (command.screenshot !== "none" && command.screenshot !== "reference") {
    throw new LoopbackTransportError(
      "protocol_error",
      "CaptureSnapshot screenshot mode is invalid.",
    );
  }
  const reasons = ["manual", "before_action", "after_action", "review", "validation"];
  if (!reasons.includes(command.reason)) {
    throw new LoopbackTransportError(
      "protocol_error",
      "CaptureSnapshot reason is invalid.",
    );
  }
  if (
    command.include === null ||
    typeof command.include !== "object" ||
    !Array.isArray(command.include.paths) ||
    !command.include.paths.every(
      (path) => typeof path === "string" && path.length > 0 && path.length <= 256,
    )
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "CaptureSnapshot field mask is invalid.",
    );
  }
  return {
    include: { paths: [...command.include.paths] },
    screenshot: command.screenshot,
    reason: command.reason,
  };
}

function normalizeLimits(options: LoopbackRuntimeHostOptions): TransportLimits {
  const maximumLineBytes = normalizePositiveLimit(
    options.maximumLineBytes ?? DEFAULT_MAXIMUM_LINE_BYTES,
    "maximumLineBytes",
    1_024,
    64 * 1024 * 1024,
  );
  const maximumObjectBytes = normalizePositiveLimit(
    options.maximumObjectBytes ?? DEFAULT_MAXIMUM_OBJECT_BYTES,
    "maximumObjectBytes",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const requestedMaximumChunkBytes = normalizePositiveLimit(
    options.maximumChunkBytes ?? Math.min(DEFAULT_MAXIMUM_CHUNK_BYTES, maximumObjectBytes),
    "maximumChunkBytes",
    1,
    Math.min(maximumObjectBytes, 4 * 1024 * 1024),
  );
  const maximumChunkBytes = Math.min(
    requestedMaximumChunkBytes,
    maximumObjectChunkBytesForLine(maximumLineBytes),
  );
  return {
    maximumLineBytes,
    maximumObjectBytes,
    maximumChunkBytes,
    handshakeTimeoutMs: normalizePositiveLimit(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      "handshakeTimeoutMs",
      10,
      300_000,
    ),
    captureTimeoutMs: normalizePositiveLimit(
      options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
      "captureTimeoutMs",
      10,
      3_600_000,
    ),
  };
}

function maximumObjectChunkBytesForLine(maximumLineBytes: number): number {
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({
      type: "object_chunk",
      request_id: "00000000-0000-0000-0000-000000000000",
      object_index: MAXIMUM_OBJECT_INDEX,
      sequence: Number.MAX_SAFE_INTEGER,
      data: "",
    }),
    "utf8",
  );
  const base64Characters = maximumLineBytes - envelopeBytes;
  const maximumBytes = Math.floor(base64Characters / 4) * 3;
  if (maximumBytes < 1) {
    throw new LoopbackTransportError(
      "protocol_error",
      "maximumLineBytes cannot contain one object chunk envelope.",
    );
  }
  return maximumBytes;
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new LoopbackTransportError(
      "protocol_error",
      "The loopback Runtime Host port is invalid.",
    );
  }
  return value;
}

function normalizePositiveLimit(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LoopbackTransportError(
      "protocol_error",
      "The loopback Runtime Host " + name + " option is invalid.",
    );
  }
  return value;
}

function normalizeToken(token: LoopbackAuthorizationToken): Buffer {
  const value =
    typeof token === "string"
      ? Buffer.from(token, "utf8")
      : token instanceof Uint8Array
        ? Buffer.from(token)
        : Buffer.alloc(0);
  if (value.byteLength < 32 || value.byteLength > 4_096) {
    value.fill(0);
    throw new LoopbackTransportError(
      "unauthenticated",
      "A per-run development authorization token is required.",
    );
  }
  return value;
}

function hmacHex(token: LoopbackAuthorizationToken, message: string): string {
  const secret = normalizeToken(token);
  try {
    return createHmac("sha256", secret).update(message, "utf8").digest("hex");
  } finally {
    secret.fill(0);
  }
}

function normalizeVersions(
  versions: readonly LoopbackProtocolVersion[],
): readonly LoopbackProtocolVersion[] {
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > 32) {
    throw new LoopbackTransportError(
      "protocol_error",
      "The Runtime protocol version list is invalid.",
    );
  }
  const normalized = versions.map((version) => {
    if (
      version === null ||
      typeof version !== "object" ||
      !Number.isInteger(version.major) ||
      !Number.isInteger(version.minor) ||
      version.major < 0 ||
      version.major > 4_294_967_295 ||
      version.minor < 0 ||
      version.minor > 4_294_967_295
    ) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime protocol version list is invalid.",
      );
    }
    return { major: version.major, minor: version.minor };
  });
  const keys = normalized.map((value) => String(value.major) + "." + String(value.minor));
  if (new Set(keys).size !== keys.length) {
    throw new LoopbackTransportError(
      "protocol_error",
      "The Runtime protocol version list contains duplicates.",
    );
  }
  return normalized.sort(
    (left, right) => left.major - right.major || left.minor - right.minor,
  );
}

function normalizeCapabilities(capabilities: readonly string[]): readonly string[] {
  if (!Array.isArray(capabilities) || capabilities.length > 256) {
    throw new LoopbackTransportError(
      "protocol_error",
      "The Runtime capability list is invalid.",
    );
  }
  const values = capabilities.map((capability) => {
    if (
      typeof capability !== "string" ||
      capability.length > 128 ||
      !CAPABILITY_PATTERN.test(capability)
    ) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime capability list is invalid.",
      );
    }
    return capability;
  });
  if (new Set(values).size !== values.length) {
    throw new LoopbackTransportError(
      "protocol_error",
      "The Runtime capability list contains duplicates.",
    );
  }
  return values.sort();
}

function parseVersions(value: unknown): readonly LoopbackProtocolVersion[] {
  if (!Array.isArray(value)) {
    throw new LoopbackTransportError(
      "protocol_error",
      "ClientHello supported_versions is invalid.",
    );
  }
  const candidates = value.map((candidate) => {
    const record = requireRecord(candidate, "Protocol version");
    return {
      major: requireSafeUnsigned(record["major"], "major"),
      minor: requireSafeUnsigned(record["minor"], "minor"),
    };
  });
  return normalizeVersions(candidates);
}

function parseCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new LoopbackTransportError(
      "protocol_error",
      "ClientHello capabilities is invalid.",
    );
  }
  return normalizeCapabilities(value as readonly string[]);
}

function requireBuildConfiguration(value: unknown): RuntimeBuildConfiguration {
  if (value !== "debug" && value !== "internal" && value !== "release") {
    throw new LoopbackTransportError(
      "protocol_error",
      "ClientHello build configuration is invalid.",
    );
  }
  return value;
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LoopbackTransportError("protocol_error", name + " must be an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(
  value: Readonly<Record<string, unknown>>,
  field: string,
  maximumLength: number,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > maximumLength
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "A Runtime transport string field is invalid.",
    );
  }
  return candidate;
}

function requireSafeUnsigned(value: unknown, _field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LoopbackTransportError(
      "protocol_error",
      "A Runtime transport integer field is invalid.",
    );
  }
  return value as number;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "An object chunk is not canonical Base64.",
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new LoopbackTransportError(
      "protocol_error",
      "An object chunk is not canonical Base64.",
    );
  }
  return bytes;
}

function secureHexEquals(actual: string, expected: string): boolean {
  if (!HEX_PROOF_PATTERN.test(actual) || !HEX_PROOF_PATTERN.test(expected)) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return timingSafeEqual(actualBytes, expectedBytes);
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function publicErrorMessage(code: LoopbackTransportErrorCode): string {
  switch (code) {
    case "unauthenticated":
      return "Runtime authentication failed.";
    case "forbidden":
      return "Runtime connection policy rejected the client.";
    case "unsupported":
      return "Runtime protocol or capability negotiation failed.";
    case "resource_exhausted":
      return "Runtime transport limits were exceeded.";
    case "timeout":
      return "Runtime transport operation timed out.";
    case "cancelled":
      return "Runtime transport operation was cancelled.";
    case "unavailable":
      return "Runtime connection is unavailable.";
    case "remote_error":
      return "Runtime reported an operation failure.";
    case "protocol_error":
      return "Runtime transport protocol violation.";
  }
}
