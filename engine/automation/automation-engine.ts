import { createHash } from "node:crypto";

import {
  DataError,
  isDataError,
  type DataUnitOfWork,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type ProtocolValidator,
  type RuntimeSnapshot,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "../design/index.js";
import { ACTION_KINDS, ACTION_RISKS } from "../exploration/index.js";

export type AutomationActionKind = (typeof ACTION_KINDS)[number];
export type AutomationActionRisk = (typeof ACTION_RISKS)[number];

export type AutomationErrorCode = "timeout" | "cancelled";

/** Terminal execution outcomes that are not Data-layer failures. */
export class AutomationError extends Error {
  constructor(readonly code: AutomationErrorCode, message: string) {
    super(message);
    this.name = "AutomationError";
  }
}

const MUTATING_TIMEOUT_DEFAULT_MS = 10_000;
const MUTATING_TIMEOUT_MAXIMUM_MS = 120_000;
const AUTHORIZATION_LIFETIME_MS = 60_000;
const CONFIRMATION_LIFETIME_MS = 5 * 60_000;
const DEFAULT_POLICY_ID = "policy.vistrea.default-v1";

export interface AutomationProviderDescriptor {
  readonly provider_id: string;
  readonly platform: "ios" | "android" | "any";
  readonly device_kind: "simulator" | "emulator" | "physical" | "virtual";
  readonly action_kinds: readonly AutomationActionKind[];
  readonly supports_system_alerts: boolean;
}

export interface ProviderLocator {
  readonly strategy: "accessibility_id";
  readonly value: string;
}

export interface AutomationPoint {
  readonly x: number;
  readonly y: number;
}

export interface AutomationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ResolvedActionTarget {
  readonly resolution_method: "accessibility" | "runtime_node" | "coordinate";
  readonly provider_locator?: ProviderLocator;
  readonly absolute_point?: AutomationPoint;
  readonly resolved_frame?: AutomationRect;
  readonly validated_snapshot_id?: string;
  readonly device_geometry_revision: string;
}

export interface ActionAuthorization {
  readonly decision_id: string;
  readonly decision: "allow" | "allow_once" | "deny";
  readonly risk: AutomationActionRisk;
  readonly policy_id: string;
  readonly bound_action_digest: string;
  readonly actor_id: string;
  readonly session_id: string;
  readonly expires_at: string;
}

export interface ProviderActionCommand {
  readonly automation_session_id: string;
  readonly kind: AutomationActionKind;
  readonly target?: ResolvedActionTarget;
  readonly authorization: ActionAuthorization;
  readonly payload?: JsonObject;
  readonly timeout_ms: number;
}

export interface ProviderActionResult {
  readonly outcome: "succeeded" | "failed" | "blocked" | "uncertain";
  readonly detail?: string;
  readonly system_alert?: JsonObject;
}

/**
 * Executes one already resolved and authorized operation on a real device
 * boundary. Providers never interpret Runtime Snapshot identity or policy.
 */
export interface AutomationProviderPort {
  readonly descriptor: AutomationProviderDescriptor;
  execute(
    command: ProviderActionCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderActionResult>;
}

export interface AutomationEngineDependencies {
  readonly workspace: WorkspaceDataSource;
  readonly validator: ProtocolValidator;
  readonly providers: readonly AutomationProviderPort[];
  readonly ids?: IdGenerator;
  /**
   * Marks the execution environment as explicitly isolated and pre-authorized
   * for dangerous actions. Defaults to false; forbidden actions never run.
   */
  readonly isolatedEnvironment?: boolean;
}

export interface OpenAutomationSessionCommand {
  readonly provider_id: string;
  readonly actor_id: string;
}

export interface AutomationSessionDescriptor {
  readonly automation_session_id: string;
  readonly provider: AutomationProviderDescriptor;
  readonly state: "ready" | "busy" | "closed";
}

export interface SemanticActionTarget {
  readonly stable_id?: string;
  readonly node_id?: string;
  readonly normalized_point?: AutomationPoint;
  readonly absolute_point?: AutomationPoint;
  readonly expected_frame?: AutomationRect;
}

export interface ExecuteSemanticActionCommand {
  readonly automation_session_id: string;
  readonly kind: AutomationActionKind;
  readonly target?: SemanticActionTarget;
  readonly expected_snapshot_id?: string;
  readonly intent: {
    readonly requested_effect: string;
    readonly caller_classification?: AutomationActionRisk;
    readonly confirmation_token?: string;
  };
  readonly payload?: JsonObject;
  readonly timeout_ms?: number;
}

export interface AutomationActionResult {
  readonly action_id: string;
  readonly provider: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly outcome: "succeeded" | "failed" | "blocked" | "uncertain";
  readonly risk: AutomationActionRisk;
  readonly authorization: ActionAuthorization;
  readonly target_resolution?: ResolvedActionTarget;
  readonly detail?: string;
  readonly system_alert?: JsonObject;
}

interface SessionState {
  readonly id: string;
  readonly provider: AutomationProviderPort;
  readonly actorId: string;
  state: "ready" | "busy" | "closed";
}

/**
 * Semantic device automation over provider adapters.
 *
 * The engine owns target resolution against persisted Snapshots, stale
 * preconditions, and safety policy. Provider adapters execute exactly one
 * resolved, authorized operation at a time per session.
 */
export class AutomationEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #providers: ReadonlyMap<string, AutomationProviderPort>;
  readonly #ids: IdGenerator;
  readonly #isolatedEnvironment: boolean;
  readonly #sessions = new Map<string, SessionState>();

  constructor(dependencies: AutomationEngineDependencies) {
    this.#workspace = dependencies.workspace;
    const providers = new Map<string, AutomationProviderPort>();
    for (const provider of dependencies.providers) {
      if (providers.has(provider.descriptor.provider_id)) {
        throw new DataError("invalid_argument", "Provider identifiers must be unique.", {
          details: { provider_id: provider.descriptor.provider_id },
        });
      }
      providers.set(provider.descriptor.provider_id, provider);
    }
    this.#providers = providers;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
    this.#isolatedEnvironment = dependencies.isolatedEnvironment === true;
  }

  listProviders(): readonly AutomationProviderDescriptor[] {
    return [...this.#providers.values()].map((provider) => provider.descriptor);
  }

  openSession(command: OpenAutomationSessionCommand): AutomationSessionDescriptor {
    const provider = this.#providers.get(command.provider_id);
    if (provider === undefined) {
      throw new DataError("not_found", "The requested automation provider is not registered.", {
        details: { provider_id: command.provider_id },
      });
    }
    if (typeof command.actor_id !== "string" || command.actor_id.length === 0) {
      throw new DataError("invalid_argument", "An automation session requires an actor.");
    }
    const session: SessionState = {
      id: this.#ids.next("automationsession"),
      provider,
      actorId: command.actor_id,
      state: "ready",
    };
    this.#sessions.set(session.id, session);
    return this.#describe(session);
  }

  closeSession(sessionId: string): void {
    const session = this.#requireSession(sessionId);
    session.state = "closed";
  }

  getSession(sessionId: string): AutomationSessionDescriptor {
    return this.#describe(this.#requireSession(sessionId));
  }

  async execute(
    command: ExecuteSemanticActionCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AutomationActionResult> {
    const session = this.#requireSession(command.automation_session_id);
    if (session.state === "closed") {
      throw new DataError("conflict", "The automation session is closed.", {
        details: { automation_session_id: session.id },
      });
    }
    return await this.#executeOnSession(session, command, options);
  }

  async #executeOnSession(
    session: SessionState,
    command: ExecuteSemanticActionCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AutomationActionResult> {
    if (!ACTION_KINDS.includes(command.kind)) {
      throw new DataError("invalid_argument", "The action kind is not part of the protocol.", {
        details: { kind: command.kind },
      });
    }
    if (!session.provider.descriptor.action_kinds.includes(command.kind)) {
      throw new DataError(
        "unsupported",
        "The provider does not support the requested action kind.",
        { details: { kind: command.kind, provider: session.provider.descriptor.provider_id } },
      );
    }
    const timeout = command.timeout_ms ?? MUTATING_TIMEOUT_DEFAULT_MS;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > MUTATING_TIMEOUT_MAXIMUM_MS
    ) {
      throw new DataError("invalid_argument", "timeout_ms is outside the supported range.");
    }
    if (command.kind === "type_text") {
      const text = command.payload?.["text_input"];
      if (typeof text !== "string" || text.length === 0) {
        throw new DataError("invalid_argument", "type_text requires payload.text_input.");
      }
    }

    // Only one mutating action runs per session; concurrent submissions conflict.
    if (session.state !== "ready") {
      throw new DataError("conflict", "The automation session is busy with another action.", {
        details: { automation_session_id: session.id },
      });
    }

    const resolution = this.#resolveTarget(command);
    const risk = this.#classifyRisk(command);
    const authorization = this.#authorize(session, command, resolution, risk);
    if (authorization.decision === "deny") {
      const now = this.#workspace.clock.now();
      return {
        action_id: this.#ids.next("action"),
        provider: session.provider.descriptor.provider_id,
        started_at: now,
        finished_at: now,
        outcome: "blocked",
        risk,
        authorization,
        ...(resolution === undefined ? {} : { target_resolution: resolution }),
        detail: "The safety policy blocked this action before provider execution.",
      };
    }

    session.state = "busy";
    const startedAt = this.#workspace.clock.now();
    try {
      const result = await this.#executeWithTimeout(
        session,
        {
          automation_session_id: session.id,
          kind: command.kind,
          ...(resolution === undefined ? {} : { target: resolution }),
          authorization,
          ...(command.payload === undefined ? {} : { payload: command.payload }),
          timeout_ms: timeout,
        },
        timeout,
        options?.signal,
      );
      return {
        action_id: this.#ids.next("action"),
        provider: session.provider.descriptor.provider_id,
        started_at: startedAt,
        finished_at: this.#workspace.clock.now(),
        outcome: result.outcome,
        risk,
        authorization,
        ...(resolution === undefined ? {} : { target_resolution: resolution }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        ...(result.system_alert === undefined ? {} : { system_alert: result.system_alert }),
      };
    } finally {
      if (session.state === "busy") {
        session.state = "ready";
      }
    }
  }

  async #executeWithTimeout(
    session: SessionState,
    command: ProviderActionCommand,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ProviderActionResult> {
    if (signal?.aborted === true) {
      throw new AutomationError("cancelled", "The automation action was cancelled.");
    }
    const abort = new AbortController();
    const forwardAbort = (): void => abort.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new AutomationError("timeout", "The provider did not finish inside timeout_ms."));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        session.provider.execute(command, { signal: abort.signal }),
        timedOut,
      ]);
    } catch (error) {
      const timedOutFirst = error instanceof AutomationError && error.code === "timeout";
      // The initial aborted check narrows the flag to false, but a caller can
      // abort at any moment while the provider runs; re-read the live value.
      const abortedNow = (signal as AbortSignal | undefined)?.aborted === true;
      if (abortedNow && !timedOutFirst) {
        throw new AutomationError("cancelled", "The automation action was cancelled.");
      }
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  #resolveTarget(command: ExecuteSemanticActionCommand): ResolvedActionTarget | undefined {
    const target = command.target;
    const targetlessKinds: readonly AutomationActionKind[] = ["back", "launch", "dismiss"];
    if (target === undefined) {
      if (!targetlessKinds.includes(command.kind)) {
        throw new DataError("invalid_argument", "This action kind requires a target.");
      }
      if (command.expected_snapshot_id !== undefined) {
        this.#requireSnapshot(command.expected_snapshot_id);
      }
      return undefined;
    }

    if (command.expected_snapshot_id === undefined) {
      // Pure coordinates are the only resolution that can skip Snapshot identity.
      const point = target.absolute_point;
      if (point === undefined || target.stable_id !== undefined || target.node_id !== undefined) {
        throw new DataError(
          "invalid_argument",
          "Semantic targets require expected_snapshot_id; only absolute points may skip it.",
        );
      }
      return {
        resolution_method: "coordinate",
        absolute_point: point,
        device_geometry_revision: "unvalidated",
      };
    }

    const snapshot = this.#requireSnapshot(command.expected_snapshot_id);
    const display = snapshot["display"] as JsonObject;
    const logicalSize = display["logical_size"] as { width: number; height: number };
    const geometryRevision = (display["geometry_revision"] as string | undefined) ?? "unknown";

    if (target.stable_id !== undefined || target.node_id !== undefined) {
      const node = findNode(snapshot, target.stable_id, target.node_id);
      if (node === undefined) {
        throw new DataError(
          "conflict",
          "The semantic target no longer exists in the expected Snapshot.",
          {
            details: {
              expected_snapshot_id: command.expected_snapshot_id,
              ...(target.stable_id === undefined ? {} : { stable_id: target.stable_id }),
              ...(target.node_id === undefined ? {} : { node_id: target.node_id }),
            },
          },
        );
      }
      const frame = node["frame"] as AutomationRect | undefined;
      if (frame === undefined || frame.width <= 0 || frame.height <= 0) {
        throw new DataError("conflict", "The resolved node has no actionable geometry.");
      }
      if (
        target.expected_frame !== undefined &&
        (target.expected_frame.x !== frame.x ||
          target.expected_frame.y !== frame.y ||
          target.expected_frame.width !== frame.width ||
          target.expected_frame.height !== frame.height)
      ) {
        throw new DataError(
          "conflict",
          "The live node frame no longer matches the expected frame.",
        );
      }
      const stableId = node["stable_id"] as string | undefined;
      return {
        resolution_method: stableId === undefined ? "runtime_node" : "accessibility",
        ...(stableId === undefined
          ? {}
          : { provider_locator: { strategy: "accessibility_id", value: stableId } }),
        absolute_point: {
          x: frame.x + frame.width / 2,
          y: frame.y + frame.height / 2,
        },
        resolved_frame: frame,
        validated_snapshot_id: command.expected_snapshot_id,
        device_geometry_revision: geometryRevision,
      };
    }

    const normalized = target.normalized_point;
    const absolute = target.absolute_point;
    if (normalized !== undefined) {
      if (normalized.x < 0 || normalized.x > 1 || normalized.y < 0 || normalized.y > 1) {
        throw new DataError("invalid_argument", "Normalized points must be within [0, 1].");
      }
      return {
        resolution_method: "coordinate",
        absolute_point: {
          x: normalized.x * logicalSize.width,
          y: normalized.y * logicalSize.height,
        },
        validated_snapshot_id: command.expected_snapshot_id,
        device_geometry_revision: geometryRevision,
      };
    }
    if (absolute !== undefined) {
      if (
        absolute.x < 0 ||
        absolute.y < 0 ||
        absolute.x > logicalSize.width ||
        absolute.y > logicalSize.height
      ) {
        throw new DataError("conflict", "The absolute point is outside the display geometry.");
      }
      return {
        resolution_method: "coordinate",
        absolute_point: absolute,
        validated_snapshot_id: command.expected_snapshot_id,
        device_geometry_revision: geometryRevision,
      };
    }
    throw new DataError("invalid_argument", "The action target resolves to nothing.");
  }

  #classifyRisk(command: ExecuteSemanticActionCommand): AutomationActionRisk {
    // Caller classification is untrusted input: it may only raise risk.
    const baseline: AutomationActionRisk =
      command.kind === "type_text" || command.kind === "clear_text" ? "sensitive" : "safe";
    const claimed = command.intent.caller_classification;
    if (claimed === undefined) {
      return baseline;
    }
    if (!ACTION_RISKS.includes(claimed)) {
      throw new DataError("invalid_argument", "The caller risk classification is invalid.");
    }
    const order: readonly AutomationActionRisk[] = ["safe", "sensitive", "dangerous", "forbidden"];
    return order.indexOf(claimed) > order.indexOf(baseline) ? claimed : baseline;
  }

  #authorize(
    session: SessionState,
    command: ExecuteSemanticActionCommand,
    resolution: ResolvedActionTarget | undefined,
    risk: AutomationActionRisk,
  ): ActionAuthorization {
    const digest = boundActionDigest(session.id, command.kind, resolution);
    const expiry = new Date(
      Date.parse(this.#workspace.clock.now()) + AUTHORIZATION_LIFETIME_MS,
    ).toISOString();
    let decision: ActionAuthorization["decision"];
    if (risk === "forbidden") {
      decision = "deny";
    } else if (risk === "dangerous") {
      const confirmed =
        command.intent.confirmation_token !== undefined &&
        this.#acceptableConfirmationTokens(session, command.kind, resolution).includes(
          command.intent.confirmation_token,
        );
      decision = confirmed || this.#isolatedEnvironment ? "allow_once" : "deny";
    } else {
      decision = "allow";
    }
    return {
      decision_id: this.#ids.next("decision"),
      decision,
      risk,
      policy_id: DEFAULT_POLICY_ID,
      bound_action_digest: digest,
      actor_id: session.actorId,
      session_id: session.id,
      expires_at: expiry,
    };
  }

  /**
   * The confirmation token a caller must echo to run one dangerous action.
   * It binds the policy, actor, session, action kind, resolved target, and a
   * time window, so a UI change, a different action, another actor, or a
   * stale token cannot reuse it.
   */
  confirmationTokenFor(command: ExecuteSemanticActionCommand): string {
    const session = this.#requireSession(command.automation_session_id);
    const resolution = this.#resolveTarget(command);
    return this.#acceptableConfirmationTokens(session, command.kind, resolution)[0] as string;
  }

  /** Tokens for the current and previous window, so a boundary never races. */
  #acceptableConfirmationTokens(
    session: SessionState,
    kind: string,
    resolution: ResolvedActionTarget | undefined,
  ): readonly string[] {
    const window = Math.floor(
      Date.parse(this.#workspace.clock.now()) / CONFIRMATION_LIFETIME_MS,
    );
    return [window, window - 1].map((value) =>
      confirmationDigest(session, kind, resolution, value),
    );
  }

  #requireSession(sessionId: string): SessionState {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new DataError("not_found", "The automation session does not exist.", {
        details: { automation_session_id: sessionId },
      });
    }
    return session;
  }

  #requireSnapshot(snapshotId: string): RuntimeSnapshot {
    const unit: DataUnitOfWork = this.#workspace.beginUnitOfWork("read");
    try {
      return unit.snapshots.get(snapshotId);
    } catch (error) {
      if (isDataError(error) && error.code === "not_found") {
        throw new DataError("conflict", "The expected Snapshot is not persisted.", {
          details: { expected_snapshot_id: snapshotId },
        });
      }
      throw error;
    } finally {
      unit.rollback();
    }
  }

  #describe(session: SessionState): AutomationSessionDescriptor {
    return {
      automation_session_id: session.id,
      provider: session.provider.descriptor,
      state: session.state,
    };
  }
}

function findNode(
  snapshot: RuntimeSnapshot,
  stableId: string | undefined,
  nodeId: string | undefined,
): JsonObject | undefined {
  const trees = snapshot["trees"] as readonly JsonObject[];
  for (const tree of trees) {
    const payload = tree["payload"] as JsonObject;
    for (const node of (payload["inline_nodes"] ?? []) as readonly JsonObject[]) {
      if (stableId !== undefined && node["stable_id"] === stableId) {
        return node;
      }
      if (stableId === undefined && nodeId !== undefined && node["node_id"] === nodeId) {
        return node;
      }
    }
  }
  return undefined;
}

export function boundActionDigest(
  sessionId: string,
  kind: string,
  resolution: ResolvedActionTarget | undefined,
): string {
  const canonical = canonicalJson({
    session_id: sessionId,
    kind,
    target: (resolution ?? null) as unknown as JsonValue,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function confirmationDigest(
  session: SessionState,
  kind: string,
  resolution: ResolvedActionTarget | undefined,
  window: number,
): string {
  const canonical = canonicalJson({
    purpose: "confirmation",
    policy_id: DEFAULT_POLICY_ID,
    actor_id: session.actorId,
    session_id: session.id,
    kind,
    target: (resolution ?? null) as unknown as JsonValue,
    window,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry as JsonValue)}`);
  return `{${entries.join(",")}}`;
}
