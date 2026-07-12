import { randomBytes } from "node:crypto";

import type { ProtocolValidator, WorkspaceDataSource } from "../../data/api/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import {
  LoopbackRuntimeHost,
  LoopbackTransportError,
  RuntimeEventPump,
  type ApplyTuningWireCommand,
  type CaptureSnapshotCommand,
  type LoopbackRuntimeEndpoint,
  type LoopbackRuntimeSession,
  type RuntimeCaptureOptions,
  type RuntimeCapturePort,
  type RuntimeCaptureResult,
  type RuntimeEventPumpStatus,
} from "../../engine/connection/index.js";
import { TuningEngine, type RuntimeTuningPort } from "../../engine/design/index.js";
import {
  startHostLocalApi,
  type HostLocalApiBindAddress,
  type HostLocalApiHandle,
} from "./local-api.js";

const RUNTIME_TOKEN_BYTES = 32;

export interface StartLocalHostOptions {
  readonly workspaceRoot: string;
  readonly validator: ProtocolValidator;
  readonly host?: HostLocalApiBindAddress;
  readonly runtimePort?: number;
  readonly apiPort?: number;
  readonly applicationVersion?: string;
}

export interface LocalRuntimeEndpoint extends LoopbackRuntimeEndpoint {
  /** Generated for this Host lifetime and never persisted in the Workspace. */
  readonly authorizationToken: string;
}

export interface LocalHostHandle {
  readonly workspaceRoot: string;
  readonly runtime: LocalRuntimeEndpoint;
  readonly api: HostLocalApiHandle;
  readonly runtimeConnected: boolean;
  waitForRuntime(timeoutMilliseconds?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts the production local composition owned by one Host process.
 *
 * SQLite metadata and file-backed Objects remain behind LocalDataWorkspace.
 * Runtime and Studio/Agent credentials are independent and rotate on restart.
 */
export async function startLocalHost(options: StartLocalHostOptions): Promise<LocalHostHandle> {
  const host = options.host ?? "127.0.0.1";
  const workspace = await LocalDataWorkspace.open({
    workspaceRoot: options.workspaceRoot,
    validator: options.validator,
    ...(options.applicationVersion === undefined
      ? {}
      : { applicationVersion: options.applicationVersion }),
  });

  let runtimeHost: LoopbackRuntimeHost | undefined;
  let api: HostLocalApiHandle | undefined;
  try {
    const authorizationToken = randomBytes(RUNTIME_TOKEN_BYTES).toString("base64url");
    runtimeHost = await LoopbackRuntimeHost.listen({
      token: authorizationToken,
      host,
      ...(options.runtimePort === undefined ? {} : { port: options.runtimePort }),
    });
    const runtime = new ActiveRuntimeCapturePort(workspace.data, options.validator);
    const acceptance = acceptRuntimeSessions(runtimeHost, runtime);
    api = await startHostLocalApi({
      host,
      ...(options.apiPort === undefined ? {} : { port: options.apiPort }),
      runtime,
      runtimeTuning: runtime,
      isRuntimeConnected: () => runtime.connected,
      runtimeEventsStatus: () => runtime.eventsStatus,
      workspace: workspace.data,
      objects: workspace.objects,
      validator: options.validator,
    });

    let closed = false;
    const activeRuntimeHost = runtimeHost;
    const activeApi = api;
    return {
      workspaceRoot: workspace.workspaceRoot,
      runtime: Object.freeze({
        ...activeRuntimeHost.endpoint,
        authorizationToken,
      }),
      api: activeApi,
      get runtimeConnected(): boolean {
        return runtime.connected;
      },
      waitForRuntime(timeoutMilliseconds = 30_000): Promise<void> {
        return runtime.waitUntilConnected(timeoutMilliseconds);
      },
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        const failures: unknown[] = [];
        try {
          await activeApi.close();
        } catch (error) {
          failures.push(error);
        }
        runtime.close();
        try {
          await activeRuntimeHost.close();
        } catch (error) {
          failures.push(error);
        }
        await acceptance;
        try {
          await workspace.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "The local Host could not close every owned resource.");
        }
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await api?.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await runtimeHost?.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await workspace.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    if (failures.length === 1) {
      throw error;
    }
    throw new AggregateError(failures, "The local Host failed to start and clean up.");
  }
}

class ActiveRuntimeCapturePort implements RuntimeCapturePort, RuntimeTuningPort {
  readonly #workspace: WorkspaceDataSource;
  readonly #validator: ProtocolValidator;
  readonly #tuning: TuningEngine;
  #session: LoopbackRuntimeSession | undefined;
  #eventPump: RuntimeEventPump | undefined;
  #closed = false;
  readonly #waiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (error: LoopbackTransportError) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(workspace: WorkspaceDataSource, validator: ProtocolValidator) {
    this.#workspace = workspace;
    this.#validator = validator;
    this.#tuning = new TuningEngine({ workspace, validator });
  }

  get connected(): boolean {
    return !this.#closed && this.#session?.state === "ready";
  }

  get connectionId(): string {
    const session = this.#session;
    if (this.#closed || session?.state !== "ready") {
      throw new LoopbackTransportError(
        "unavailable",
        "An authorized Runtime connection is not available.",
      );
    }
    return session.connectionId;
  }

  applyTuning(command: ApplyTuningWireCommand): Promise<unknown> {
    const session = this.#session;
    if (this.#closed || session?.state !== "ready") {
      return Promise.reject(
        new LoopbackTransportError(
          "unavailable",
          "An authorized Runtime connection is not available.",
        ),
      );
    }
    return session.applyTuning(command);
  }

  revertTuning(tuningApplicationId: string): Promise<unknown> {
    const session = this.#session;
    if (this.#closed || session?.state !== "ready") {
      return Promise.reject(
        new LoopbackTransportError(
          "unavailable",
          "An authorized Runtime connection is not available.",
        ),
      );
    }
    return session.revertTuning(tuningApplicationId);
  }

  get eventsStatus(): RuntimeEventPumpStatus | undefined {
    return this.#eventPump?.status();
  }

  attach(session: LoopbackRuntimeSession): void {
    if (this.#closed) {
      session.close();
      return;
    }
    if (this.#session !== undefined && this.#session !== session) {
      this.#session.close();
    }
    this.#session = session;
    this.#startEventPump(session);
    this.#drainRuntimeReversions(session);
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.#waiters.clear();
  }

  #drainRuntimeReversions(session: LoopbackRuntimeSession): void {
    // Self-reverted previews (for example TTL expiry) stay auditable even when
    // no caller is waiting; a broken report fails the drain, not the Host.
    void (async () => {
      for (;;) {
        const candidate = await session.nextRevertedTuning();
        if (candidate === undefined) {
          return;
        }
        this.#tuning.recordRuntimeReversion(candidate, session.connectionId);
      }
    })().catch(() => {});
  }

  #startEventPump(session: LoopbackRuntimeSession): void {
    const pump = new RuntimeEventPump({
      runtime: session,
      workspace: this.#workspace,
      validator: this.#validator,
    });
    this.#eventPump = pump;
    // The pump runs for the session lifetime; its status carries any failure
    // so a broken event stream degrades visibly instead of crashing the Host.
    void (async () => {
      await pump.start();
      await pump.whenSettled();
    })().catch(() => {});
  }

  captureSnapshot(
    command: CaptureSnapshotCommand,
    options?: RuntimeCaptureOptions,
  ): Promise<RuntimeCaptureResult> {
    const session = this.#session;
    if (this.#closed || session?.state !== "ready") {
      return Promise.reject(
        new LoopbackTransportError(
          "unavailable",
          "An authorized Runtime connection is not available.",
        ),
      );
    }
    return session.captureSnapshot(command, options);
  }

  waitUntilConnected(timeoutMilliseconds: number): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    if (
      this.#closed ||
      !Number.isInteger(timeoutMilliseconds) ||
      timeoutMilliseconds < 10 ||
      timeoutMilliseconds > 300_000
    ) {
      return Promise.reject(
        new LoopbackTransportError("unavailable", "The Runtime connection wait is unavailable."),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new LoopbackTransportError("timeout", "Timed out waiting for a Runtime connection."),
          );
        }, timeoutMilliseconds),
      };
      waiter.timer.unref();
      this.#waiters.add(waiter);
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    void this.#eventPump?.stop().catch(() => {});
    this.#eventPump = undefined;
    this.#session?.close();
    this.#session = undefined;
    const error = new LoopbackTransportError("unavailable", "The local Host is closed.");
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

async function acceptRuntimeSessions(
  host: LoopbackRuntimeHost,
  runtime: ActiveRuntimeCapturePort,
): Promise<void> {
  while (true) {
    try {
      runtime.attach(await host.acceptSession());
    } catch (error) {
      if (error instanceof LoopbackTransportError && error.code === "unavailable") {
        return;
      }
      runtime.close();
      return;
    }
  }
}
