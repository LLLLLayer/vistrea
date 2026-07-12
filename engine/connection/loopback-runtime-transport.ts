import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import net, { type Server, type Socket } from "node:net";

import type { ByteStream } from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "../design/uuid-v7.js";
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

const CONNECTION_IDS = new SecureUuidV7IdGenerator();
const SNAPSHOT_CAPABILITY = "runtime.snapshot";
const EVENTS_CAPABILITY = "runtime.events";
const TUNING_CAPABILITY = "design.tuning";
const AUTH_METHOD = "hmac-sha256";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const RUNTIME_INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const HEX_PROOF_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_EPOCH_PATTERN =
  /^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_MAXIMUM_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_OBJECT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAXIMUM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const MAXIMUM_CAPTURE_OBJECTS = 256;
const MAXIMUM_OBJECT_INDEX = MAXIMUM_CAPTURE_OBJECTS - 1;
const MAXIMUM_EVENT_KINDS = 16;
const MAXIMUM_EVENTS_PER_BATCH = 1_024;
const MAXIMUM_BUFFERED_EVENT_BATCHES = 64;

export type LoopbackTransportErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "unsupported"
  | "protocol_error"
  | "resource_exhausted"
  | "cancelled"
  | "timeout"
  | "unavailable"
  | "conflict"
  | "remote_error";

export class LoopbackTransportError extends Error {
  constructor(readonly code: LoopbackTransportErrorCode, message: string) {
    super(message);
    this.name = "LoopbackTransportError";
  }
}

/** Rejection carrying the Runtime's epoch recovery hints from `subscribe_error`. */
export class RuntimeEventSubscribeError extends LoopbackTransportError {
  readonly oldestAvailableSequence: number | undefined;
  readonly nextSequence: number | undefined;

  constructor(
    code: LoopbackTransportErrorCode,
    message: string,
    hints: {
      readonly oldestAvailableSequence?: number;
      readonly nextSequence?: number;
    } = {},
  ) {
    super(code, message);
    this.name = "RuntimeEventSubscribeError";
    this.oldestAvailableSequence = hints.oldestAvailableSequence;
    this.nextSequence = hints.nextSequence;
  }
}

export interface RuntimeEventEpochDescriptor {
  readonly eventEpochId: string;
  readonly oldestRetainedSequence: number;
  readonly nextSequence: number;
}

export type RuntimeEventStart =
  | { readonly mode: "after_sequence"; readonly sequence: number }
  | { readonly mode: "oldest_retained" }
  | { readonly mode: "tail" };

export interface SubscribeRuntimeEventsCommand {
  readonly eventEpochId: string;
  readonly eventKinds: readonly string[];
  readonly start: RuntimeEventStart;
  readonly maxBatchSize?: number;
}

export interface ApplyTuningWireCommand {
  /** A canonical TuningPatch value; the transport relays it untouched. */
  readonly patch: Readonly<Record<string, unknown>>;
  readonly expectedSnapshotId: string;
  readonly previewTtlMs?: number;
}

/** One ordered Runtime event stream negotiated over an authenticated session. */
export interface RuntimeEventSubscription {
  readonly subscriptionId: string;
  readonly eventEpochId: string;
  /**
   * Resolves the next untrusted RuntimeEventBatch candidate, or undefined when
   * the Runtime or the Host ended the stream normally.
   */
  nextBatch(): Promise<unknown | undefined>;
  /** Reports durable persistence so the Runtime may release retained events. */
  acknowledge(durableThroughSequence: number): void;
  close(): void;
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
    // Events are negotiated only when the Runtime offers the capability AND
    // declares its current epoch; offering the capability without an epoch
    // downgrades the session to Snapshot-only instead of failing it.
    const eventEpoch = capabilities.includes(EVENTS_CAPABILITY)
      ? parseEventEpoch(message["event_epoch"])
      : undefined;
    const tuningEnabled = capabilities.includes(TUNING_CAPABILITY);

    // Tuning applications persist this value into TuningApplication records,
    // whose schema requires a typed UUIDv7 — never a bare UUID.
    const connectionId = CONNECTION_IDS.next("connection");
    const enabledCapabilities = [
      ...(tuningEnabled ? [TUNING_CAPABILITY] : []),
      ...(eventEpoch === undefined ? [] : [EVENTS_CAPABILITY]),
      SNAPSHOT_CAPABILITY,
    ] as const;
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
      ...(eventEpoch === undefined
        ? {}
        : {
            event_epoch: {
              event_epoch_id: eventEpoch.eventEpochId,
              oldest_retained_sequence: eventEpoch.oldestRetainedSequence,
              next_sequence: eventEpoch.nextSequence,
            },
          }),
    });
    clearTimeout(this.#handshakeTimer);
    this.#state = "ready";
    this.#session = new LoopbackRuntimeSession({
      channel: this.#channel,
      connectionId,
      runtimeInstanceId,
      selectedVersion,
      enabledCapabilities,
      ...(eventEpoch === undefined ? {} : { eventEpoch }),
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
  readonly eventEpoch?: RuntimeEventEpochDescriptor;
  readonly limits: TransportLimits;
  readonly onFatal: (error: LoopbackTransportError) => void;
}

interface PendingSubscribe {
  readonly requestId: string;
  readonly command: SubscribeRuntimeEventsCommand;
  readonly resolve: (subscription: RuntimeEventSubscription) => void;
  readonly reject: (error: LoopbackTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingTuning {
  readonly requestId: string;
  readonly resolve: (application: unknown) => void;
  readonly reject: (error: LoopbackTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface EventBatchWaiter {
  readonly resolve: (batch: unknown | undefined) => void;
  readonly reject: (error: LoopbackTransportError) => void;
}

class ActiveEventSubscription implements RuntimeEventSubscription {
  readonly subscriptionId: string;
  readonly eventEpochId: string;
  readonly #send: (message: Readonly<Record<string, unknown>>) => void;
  readonly #onLocalClose: (subscription: ActiveEventSubscription) => void;
  readonly #queue: unknown[] = [];
  readonly #waiters: EventBatchWaiter[] = [];
  #closed = false;
  #closeError: LoopbackTransportError | undefined;

  constructor(options: {
    readonly subscriptionId: string;
    readonly eventEpochId: string;
    readonly send: (message: Readonly<Record<string, unknown>>) => void;
    readonly onLocalClose: (subscription: ActiveEventSubscription) => void;
  }) {
    this.subscriptionId = options.subscriptionId;
    this.eventEpochId = options.eventEpochId;
    this.#send = options.send;
    this.#onLocalClose = options.onLocalClose;
  }

  get bufferedBatchCount(): number {
    return this.#queue.length;
  }

  nextBatch(): Promise<unknown | undefined> {
    if (this.#queue.length > 0) {
      return Promise.resolve(this.#queue.shift());
    }
    if (this.#closed) {
      return this.#closeError === undefined
        ? Promise.resolve(undefined)
        : Promise.reject(this.#closeError);
    }
    return new Promise<unknown | undefined>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  acknowledge(durableThroughSequence: number): void {
    if (this.#closed) {
      return;
    }
    if (!Number.isSafeInteger(durableThroughSequence) || durableThroughSequence < 0) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The event acknowledgement sequence is invalid.",
      );
    }
    try {
      this.#send({
        type: "acknowledge_events",
        subscription_id: this.subscriptionId,
        event_epoch_id: this.eventEpochId,
        durable_through_sequence: durableThroughSequence,
      });
    } catch {
      // A vanished connection already terminates the stream through the session.
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#send({ type: "unsubscribe_events", subscription_id: this.subscriptionId });
    } catch {
      // Local teardown still completes when the connection is already gone.
    }
    this.settle(undefined);
    this.#onLocalClose(this);
  }

  enqueue(batch: unknown): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(batch);
    } else {
      waiter.resolve(batch);
    }
  }

  /** Ends the stream: undefined for a normal end, an error for a failed one. */
  settle(error: LoopbackTransportError | undefined): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeError = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) {
        waiter.resolve(undefined);
      } else {
        waiter.reject(error);
      }
    }
  }
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
  readonly eventEpoch: RuntimeEventEpochDescriptor | undefined;
  readonly #channel: BoundedJsonLineChannel;
  readonly #limits: TransportLimits;
  readonly #onFatal: (error: LoopbackTransportError) => void;
  readonly #pending = new Map<string, PendingCapture>();
  readonly #cancelled = new Set<string>();
  readonly #pendingSubscribes = new Map<string, PendingSubscribe>();
  readonly #subscriptions = new Map<string, ActiveEventSubscription>();
  readonly #pendingTuning = new Map<string, PendingTuning>();
  readonly #revertedTuning: unknown[] = [];
  readonly #revertedTuningWaiters: EventBatchWaiter[] = [];
  #state: LoopbackRuntimeSessionState = "ready";

  constructor(options: LoopbackRuntimeSessionOptions) {
    this.#channel = options.channel;
    this.connectionId = options.connectionId;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.selectedVersion = Object.freeze({ ...options.selectedVersion });
    this.enabledCapabilities = Object.freeze([...options.enabledCapabilities]);
    this.eventEpoch =
      options.eventEpoch === undefined ? undefined : Object.freeze({ ...options.eventEpoch });
    this.#limits = options.limits;
    this.#onFatal = options.onFatal;
  }

  get state(): LoopbackRuntimeSessionState {
    return this.#state;
  }

  /** Sends one apply command and resolves the canonical TuningApplication candidate. */
  applyTuning(command: ApplyTuningWireCommand): Promise<unknown> {
    return this.#tuningRequest((requestId) => ({
      type: "apply_tuning",
      request_id: requestId,
      command: {
        patch: structuredClone(command.patch),
        expected_snapshot_id: command.expectedSnapshotId,
        ...(command.previewTtlMs === undefined
          ? {}
          : { preview_ttl_ms: command.previewTtlMs }),
      },
    }));
  }

  /** Requests precise reversion of one active application. */
  revertTuning(tuningApplicationId: string): Promise<unknown> {
    if (
      typeof tuningApplicationId !== "string" ||
      tuningApplicationId.length === 0 ||
      tuningApplicationId.length > 128
    ) {
      return Promise.reject(
        new LoopbackTransportError("protocol_error", "The tuning application ID is invalid."),
      );
    }
    return this.#tuningRequest((requestId) => ({
      type: "revert_tuning",
      request_id: requestId,
      tuning_application_id: tuningApplicationId,
    }));
  }

  /**
   * Resolves the next application the Runtime reverted on its own (for
   * example TTL expiry), or undefined when the session ends.
   */
  nextRevertedTuning(): Promise<unknown | undefined> {
    if (this.#revertedTuning.length > 0) {
      return Promise.resolve(this.#revertedTuning.shift());
    }
    if (this.#state !== "ready") {
      return Promise.resolve(undefined);
    }
    return new Promise<unknown | undefined>((resolve, reject) => {
      this.#revertedTuningWaiters.push({ resolve, reject });
    });
  }

  #tuningRequest(
    frame: (requestId: string) => Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (this.#state !== "ready") {
      return Promise.reject(
        new LoopbackTransportError("unavailable", "The Runtime session is not ready."),
      );
    }
    if (!this.enabledCapabilities.includes(TUNING_CAPABILITY)) {
      return Promise.reject(
        new LoopbackTransportError(
          "unsupported",
          "The Runtime session did not negotiate the tuning capability.",
        ),
      );
    }
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pendingTuning.get(requestId);
        if (pending !== undefined) {
          this.#pendingTuning.delete(requestId);
          pending.reject(
            new LoopbackTransportError("timeout", "The Runtime tuning request timed out."),
          );
        }
      }, this.#limits.captureTimeoutMs);
      timer.unref();
      this.#pendingTuning.set(requestId, { requestId, resolve, reject, timer });
      try {
        this.#channel.send(frame(requestId));
      } catch {
        this.#pendingTuning.delete(requestId);
        clearTimeout(timer);
        reject(
          new LoopbackTransportError("unavailable", "The Runtime connection is unavailable."),
        );
      }
    });
  }

  subscribeEvents(command: SubscribeRuntimeEventsCommand): Promise<RuntimeEventSubscription> {
    if (this.#state !== "ready") {
      return Promise.reject(
        new LoopbackTransportError("unavailable", "The Runtime session is not ready."),
      );
    }
    if (!this.enabledCapabilities.includes(EVENTS_CAPABILITY)) {
      return Promise.reject(
        new LoopbackTransportError(
          "unsupported",
          "The Runtime session did not negotiate the events capability.",
        ),
      );
    }
    if (this.#subscriptions.size > 0 || this.#pendingSubscribes.size > 0) {
      return Promise.reject(
        new LoopbackTransportError(
          "resource_exhausted",
          "The Runtime session already has an active event subscription.",
        ),
      );
    }
    let normalized: Readonly<Record<string, unknown>>;
    try {
      normalized = normalizeSubscribeCommand(command);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = randomUUID();
    return new Promise<RuntimeEventSubscription>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pendingSubscribes.get(requestId);
        if (pending !== undefined) {
          this.#pendingSubscribes.delete(requestId);
          pending.reject(
            new LoopbackTransportError("timeout", "The Runtime event subscription timed out."),
          );
        }
      }, this.#limits.captureTimeoutMs);
      timer.unref();
      this.#pendingSubscribes.set(requestId, { requestId, command, resolve, reject, timer });
      try {
        this.#channel.send({
          type: "subscribe_events",
          request_id: requestId,
          ...normalized,
        });
      } catch {
        this.#pendingSubscribes.delete(requestId);
        clearTimeout(timer);
        reject(
          new LoopbackTransportError("unavailable", "The Runtime connection is unavailable."),
        );
      }
    });
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
      if (type === "subscribe_result") {
        this.#subscribeResult(message);
        return;
      }
      if (type === "subscribe_error") {
        this.#subscribeError(message);
        return;
      }
      if (type === "event_batch") {
        this.#eventBatch(message);
        return;
      }
      if (type === "events_closed") {
        this.#eventsClosed(message);
        return;
      }
      if (type === "tuning_result" || type === "revert_result") {
        this.#tuningResult(message);
        return;
      }
      if (type === "tuning_error") {
        this.#tuningError(message);
        return;
      }
      if (type === "tuning_reverted") {
        this.#tuningReverted(message);
        return;
      }
      if (this.#drainCancelledCapture(message, type)) {
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

  #drainCancelledCapture(
    message: Readonly<Record<string, unknown>>,
    type: string,
  ): boolean {
    if (
      type !== "capture_result" &&
      type !== "object_start" &&
      type !== "object_chunk" &&
      type !== "object_end" &&
      type !== "capture_complete"
    ) {
      return false;
    }
    const requestId = requireString(message, "request_id", 128);
    if (!this.#cancelled.has(requestId)) {
      return false;
    }

    // Cancellation is best-effort. Frames already committed by the Runtime may
    // cross the Host's cancel request on the full-duplex channel. Drain only
    // this cancelled request until one terminal frame arrives; framing remains
    // bounded and any unrelated or post-tombstone message still fails closed.
    if (type === "capture_complete") {
      this.#cancelled.delete(requestId);
    }
    return true;
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

  #subscribeResult(message: Readonly<Record<string, unknown>>): void {
    const requestId = requireString(message, "request_id", 128);
    const subscriptionId = requireString(message, "subscription_id", 128);
    const pending = this.#pendingSubscribes.get(requestId);
    if (pending === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime confirmed an unknown event subscription.",
      );
    }
    if (this.#subscriptions.has(subscriptionId)) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime reused an event subscription identifier.",
      );
    }
    this.#pendingSubscribes.delete(requestId);
    clearTimeout(pending.timer);
    const subscription = new ActiveEventSubscription({
      subscriptionId,
      eventEpochId: pending.command.eventEpochId,
      send: (value) => this.#channel.send(value),
      onLocalClose: (closed) => this.#subscriptions.delete(closed.subscriptionId),
    });
    this.#subscriptions.set(subscriptionId, subscription);
    pending.resolve(subscription);
  }

  #subscribeError(message: Readonly<Record<string, unknown>>): void {
    const requestId = requireString(message, "request_id", 128);
    const pending = this.#pendingSubscribes.get(requestId);
    if (pending === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime rejected an unknown event subscription.",
      );
    }
    this.#pendingSubscribes.delete(requestId);
    clearTimeout(pending.timer);
    const code = message["code"] === "conflict" ? "conflict" : "remote_error";
    const oldest = optionalSafeUnsigned(message["oldest_available_sequence"]);
    const next = optionalSafeUnsigned(message["next_sequence"]);
    pending.reject(
      new RuntimeEventSubscribeError(
        code,
        code === "conflict"
          ? "The Runtime no longer retains the requested event range or epoch."
          : "The Runtime rejected the event subscription.",
        {
          ...(oldest === undefined ? {} : { oldestAvailableSequence: oldest }),
          ...(next === undefined ? {} : { nextSequence: next }),
        },
      ),
    );
  }

  #eventBatch(message: Readonly<Record<string, unknown>>): void {
    const subscriptionId = requireString(message, "subscription_id", 128);
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime streamed events for an unknown subscription.",
      );
    }
    const batch = requireRecord(message["batch"], "Runtime event batch");
    const events = batch["events"];
    if (!Array.isArray(events) || events.length > MAXIMUM_EVENTS_PER_BATCH) {
      throw new LoopbackTransportError(
        "resource_exhausted",
        "A Runtime event batch exceeds the configured event limit.",
      );
    }
    if (subscription.bufferedBatchCount >= MAXIMUM_BUFFERED_EVENT_BATCHES) {
      throw new LoopbackTransportError(
        "resource_exhausted",
        "The Host event batch buffer is full; the consumer is not draining.",
      );
    }
    subscription.enqueue(structuredClone(batch));
  }

  #eventsClosed(message: Readonly<Record<string, unknown>>): void {
    const subscriptionId = requireString(message, "subscription_id", 128);
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime closed an unknown event subscription.",
      );
    }
    this.#subscriptions.delete(subscriptionId);
    const code = message["code"];
    subscription.settle(
      code === undefined
        ? undefined
        : new LoopbackTransportError(
            code === "conflict" ? "conflict" : "remote_error",
            code === "conflict"
              ? "The Runtime reset its event epoch or discarded the subscribed range."
              : "The Runtime ended the event stream with an error.",
          ),
    );
  }

  #tuningResult(message: Readonly<Record<string, unknown>>): void {
    const requestId = requireString(message, "request_id", 128);
    const pending = this.#pendingTuning.get(requestId);
    if (pending === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime answered an unknown tuning request.",
      );
    }
    const application = requireRecord(message["application"], "Tuning application");
    this.#pendingTuning.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(structuredClone(application));
  }

  #tuningError(message: Readonly<Record<string, unknown>>): void {
    const requestId = requireString(message, "request_id", 128);
    const pending = this.#pendingTuning.get(requestId);
    if (pending === undefined) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime rejected an unknown tuning request.",
      );
    }
    this.#pendingTuning.delete(requestId);
    clearTimeout(pending.timer);
    const code = message["code"];
    pending.reject(
      new LoopbackTransportError(
        code === "conflict" ? "conflict" : "remote_error",
        code === "conflict"
          ? "The Runtime tuning state conflicts with the request."
          : "The Runtime rejected the tuning request.",
      ),
    );
  }

  #tuningReverted(message: Readonly<Record<string, unknown>>): void {
    if (!this.enabledCapabilities.includes(TUNING_CAPABILITY)) {
      throw new LoopbackTransportError(
        "protocol_error",
        "The Runtime reported tuning reversion without the capability.",
      );
    }
    const application = requireRecord(message["application"], "Tuning application");
    if (this.#revertedTuning.length >= MAXIMUM_BUFFERED_EVENT_BATCHES) {
      throw new LoopbackTransportError(
        "resource_exhausted",
        "The Host tuning-reversion buffer is full; the consumer is not draining.",
      );
    }
    const cloned = structuredClone(application);
    const waiter = this.#revertedTuningWaiters.shift();
    if (waiter === undefined) {
      this.#revertedTuning.push(cloned);
    } else {
      waiter.resolve(cloned);
    }
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
    for (const pending of [...this.#pendingSubscribes.values()]) {
      this.#pendingSubscribes.delete(pending.requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const subscription of [...this.#subscriptions.values()]) {
      this.#subscriptions.delete(subscription.subscriptionId);
      subscription.settle(error.code === "cancelled" ? undefined : error);
    }
    for (const pending of [...this.#pendingTuning.values()]) {
      this.#pendingTuning.delete(pending.requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const waiter of this.#revertedTuningWaiters.splice(0)) {
      waiter.resolve(undefined);
    }
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

function parseEventEpoch(value: unknown): RuntimeEventEpochDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, "ClientHello event epoch");
  const eventEpochId = requireString(record, "event_epoch_id", 128);
  const oldestRetainedSequence = requireSafeUnsigned(
    record["oldest_retained_sequence"],
    "oldest_retained_sequence",
  );
  const nextSequence = requireSafeUnsigned(record["next_sequence"], "next_sequence");
  if (!EVENT_EPOCH_PATTERN.test(eventEpochId) || oldestRetainedSequence > nextSequence) {
    throw new LoopbackTransportError(
      "protocol_error",
      "ClientHello event epoch is invalid.",
    );
  }
  return { eventEpochId, oldestRetainedSequence, nextSequence };
}

function normalizeSubscribeCommand(
  command: SubscribeRuntimeEventsCommand,
): Readonly<Record<string, unknown>> {
  if (command === null || typeof command !== "object") {
    throw new LoopbackTransportError(
      "protocol_error",
      "SubscribeRuntimeEvents command must be an object.",
    );
  }
  if (
    typeof command.eventEpochId !== "string" ||
    !EVENT_EPOCH_PATTERN.test(command.eventEpochId)
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "SubscribeRuntimeEvents event epoch is invalid.",
    );
  }
  if (
    !Array.isArray(command.eventKinds) ||
    command.eventKinds.length === 0 ||
    command.eventKinds.length > MAXIMUM_EVENT_KINDS ||
    new Set(command.eventKinds).size !== command.eventKinds.length ||
    !command.eventKinds.every(
      (kind) => typeof kind === "string" && EVENT_KIND_PATTERN.test(kind),
    )
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "SubscribeRuntimeEvents event kinds are invalid.",
    );
  }
  const start = command.start;
  if (
    start === null ||
    typeof start !== "object" ||
    (start.mode !== "after_sequence" && start.mode !== "oldest_retained" && start.mode !== "tail")
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "SubscribeRuntimeEvents start mode is invalid.",
    );
  }
  if (
    start.mode === "after_sequence" &&
    (!Number.isSafeInteger(start.sequence) || start.sequence < 0)
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "SubscribeRuntimeEvents resume sequence is invalid.",
    );
  }
  if (
    command.maxBatchSize !== undefined &&
    (!Number.isSafeInteger(command.maxBatchSize) ||
      command.maxBatchSize < 1 ||
      command.maxBatchSize > MAXIMUM_EVENTS_PER_BATCH)
  ) {
    throw new LoopbackTransportError(
      "protocol_error",
      "SubscribeRuntimeEvents batch size is invalid.",
    );
  }
  return {
    event_epoch_id: command.eventEpochId,
    event_kinds: [...command.eventKinds].sort(),
    start:
      start.mode === "after_sequence"
        ? { mode: "after_sequence", sequence: start.sequence }
        : { mode: start.mode },
    ...(command.maxBatchSize === undefined ? {} : { max_batch_size: command.maxBatchSize }),
  };
}

function optionalSafeUnsigned(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LoopbackTransportError(
      "protocol_error",
      "A Runtime transport integer field is invalid.",
    );
  }
  return value as number;
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
    case "conflict":
      return "Runtime state conflicts with the requested operation.";
    case "remote_error":
      return "Runtime reported an operation failure.";
    case "protocol_error":
      return "Runtime transport protocol violation.";
  }
}
