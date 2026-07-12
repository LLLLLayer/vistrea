import { DataError, type JsonObject, type JsonValue } from "../../data/api/index.js";
import {
  boundActionDigest,
  type AutomationProviderDescriptor,
  type AutomationProviderPort,
  type ProviderActionCommand,
  type ProviderActionResult,
} from "./automation-engine.js";

const LONG_PRESS_MILLISECONDS = 600;
const TAP_PRESS_MILLISECONDS = 60;
const DEFAULT_SWIPE_MILLISECONDS = 300;
const DEFAULT_SWIPE_DISTANCE_POINTS = 200;
const BACK_SWIPE_MILLISECONDS = 250;
const BACK_SWIPE_DISTANCE_POINTS = 220;
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const LOOPBACK_URL_PATTERN = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):[0-9]{1,5}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]{1,256}$/;

export interface WdaAutomationProviderOptions {
  /** A loopback WebDriverAgent endpoint, for example `http://127.0.0.1:8100`. */
  readonly baseUrl: string;
  readonly deviceKind?: "simulator" | "physical";
  readonly commandTimeoutMilliseconds?: number;
}

interface WdaPointerAction {
  readonly type: "pointerMove" | "pointerDown" | "pointerUp" | "pause";
  readonly duration?: number;
  readonly x?: number;
  readonly y?: number;
  readonly button?: number;
}

/**
 * Real iOS user-level input through a WebDriverAgent endpoint — the same
 * XCUITest-hosted driver Appium uses. The provider speaks the W3C actions
 * protocol with logical-point coordinates, which match the Snapshot's
 * `logical_point` geometry directly.
 *
 * The provider executes exactly one already resolved and authorized
 * operation. Injected input cannot prove the UI responded, so input actions
 * report `uncertain`; Engine-level capture comparison owns verification. iOS
 * has no system back key: `back` performs the interactive left-edge pop
 * gesture instead.
 */
export class WdaAutomationProvider implements AutomationProviderPort {
  readonly descriptor: AutomationProviderDescriptor;
  readonly #baseUrl: string;
  readonly #timeoutMilliseconds: number;
  #sessionId: string | undefined;
  #windowSize: { readonly width: number; readonly height: number } | undefined;

  constructor(options: WdaAutomationProviderOptions) {
    if (!LOOPBACK_URL_PATTERN.test(options.baseUrl)) {
      throw new DataError(
        "invalid_argument",
        "The WebDriverAgent endpoint must be an explicit loopback HTTP origin.",
      );
    }
    this.#baseUrl = options.baseUrl;
    this.#timeoutMilliseconds = options.commandTimeoutMilliseconds ?? 30_000;
    this.descriptor = {
      provider_id: "ios-wda",
      platform: "ios",
      device_kind: options.deviceKind ?? "simulator",
      action_kinds: ["tap", "long_press", "type_text", "swipe", "scroll", "back", "launch"],
      supports_system_alerts: false,
    };
  }

  async execute(
    command: ProviderActionCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderActionResult> {
    this.#assertAuthorization(command);
    switch (command.kind) {
      case "tap": {
        const point = requirePoint(command);
        await this.#performPointerActions(
          pressSequence(point.x, point.y, TAP_PRESS_MILLISECONDS),
          options,
        );
        return { outcome: "uncertain", detail: "Tap injected through WebDriverAgent." };
      }
      case "long_press": {
        const point = requirePoint(command);
        await this.#performPointerActions(
          pressSequence(point.x, point.y, LONG_PRESS_MILLISECONDS),
          options,
        );
        return { outcome: "uncertain", detail: "Long press injected through WebDriverAgent." };
      }
      case "type_text": {
        const text = command.payload?.["text_input"];
        if (typeof text !== "string" || text.length === 0 || text.length > 1_024) {
          return { outcome: "failed", detail: "type_text requires bounded payload.text_input." };
        }
        const point = command.target?.absolute_point;
        if (point !== undefined) {
          await this.#performPointerActions(
            pressSequence(point.x, point.y, TAP_PRESS_MILLISECONDS),
            options,
          );
        }
        await this.#sessionRequest("POST", "/wda/keys", { value: [text] }, options);
        return { outcome: "uncertain", detail: "Text injected through WebDriverAgent." };
      }
      case "swipe":
      case "scroll": {
        const point = requirePoint(command);
        const deltaX = numberOr(command.payload?.["delta_x"], 0);
        const deltaY = numberOr(
          command.payload?.["delta_y"],
          command.kind === "scroll" ? -DEFAULT_SWIPE_DISTANCE_POINTS : 0,
        );
        const duration = numberOr(command.payload?.["duration_ms"], DEFAULT_SWIPE_MILLISECONDS);
        if (deltaX === 0 && deltaY === 0) {
          return { outcome: "failed", detail: "A swipe requires a non-zero delta." };
        }
        await this.#performPointerActions(
          dragSequence(point.x, point.y, point.x + deltaX, point.y + deltaY, duration),
          options,
        );
        return { outcome: "uncertain", detail: "Swipe injected through WebDriverAgent." };
      }
      case "back": {
        // iOS has no system back key; the interactive pop gesture is the
        // genuine user-level equivalent.
        const size = await this.#getWindowSize(options);
        const y = Math.round(size.height / 2);
        await this.#performPointerActions(
          dragSequence(1, y, BACK_SWIPE_DISTANCE_POINTS, y, BACK_SWIPE_MILLISECONDS),
          options,
        );
        return {
          outcome: "uncertain",
          detail: "Left-edge pop gesture injected through WebDriverAgent.",
        };
      }
      case "launch": {
        const bundleId = command.payload?.["bundle_id"] ?? command.payload?.["component"];
        if (typeof bundleId !== "string" || !BUNDLE_ID_PATTERN.test(bundleId)) {
          return { outcome: "failed", detail: "launch requires payload.bundle_id." };
        }
        await this.#sessionRequest("POST", "/wda/apps/launch", { bundleId }, options);
        return { outcome: "succeeded", detail: "WebDriverAgent confirmed the launch." };
      }
      default:
        return { outcome: "failed", detail: "The provider does not implement this action kind." };
    }
  }

  #assertAuthorization(command: ProviderActionCommand): void {
    const authorization = command.authorization;
    const expected = boundActionDigest(
      command.automation_session_id,
      command.kind,
      command.target,
    );
    const expiresAt = Date.parse(authorization.expires_at);
    if (
      authorization.decision === "deny" ||
      authorization.session_id !== command.automation_session_id ||
      authorization.bound_action_digest !== expected ||
      // An unparseable expiry (NaN) must fail closed, so require proof of life.
      !(expiresAt > Date.now())
    ) {
      throw new DataError(
        "invalid_argument",
        "The provider rejected a missing, expired, mismatched, or denied authorization.",
      );
    }
  }

  async #performPointerActions(
    actions: readonly WdaPointerAction[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    await this.#sessionRequest(
      "POST",
      "/actions",
      {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: actions as unknown as JsonValue,
          },
        ],
      },
      options,
    );
  }

  async #getWindowSize(options?: {
    readonly signal?: AbortSignal;
  }): Promise<{ readonly width: number; readonly height: number }> {
    if (this.#windowSize !== undefined) {
      return this.#windowSize;
    }
    const value = await this.#sessionRequest("GET", "/window/size", undefined, options);
    const size = value as { readonly width?: unknown; readonly height?: unknown } | null;
    const width = size?.width;
    const height = size?.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !(width > 0) ||
      !(height > 0)
    ) {
      throw new DataError("internal", "WebDriverAgent did not report a usable window size.");
    }
    this.#windowSize = { width, height };
    return this.#windowSize;
  }

  /**
   * Sends one request inside the cached WebDriverAgent session, creating the
   * session lazily and re-creating it exactly once when the driver reports
   * the cached session as invalid.
   */
  async #sessionRequest(
    method: "GET" | "POST",
    route: string,
    body: JsonObject | undefined,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonValue> {
    let sessionId = await this.#ensureSession(options);
    try {
      return await this.#request(method, `/session/${sessionId}${route}`, body, options);
    } catch (error) {
      if (!isInvalidSessionError(error)) {
        throw error;
      }
      this.#sessionId = undefined;
      this.#windowSize = undefined;
      sessionId = await this.#ensureSession(options);
      return await this.#request(method, `/session/${sessionId}${route}`, body, options);
    }
  }

  async #ensureSession(options?: { readonly signal?: AbortSignal }): Promise<string> {
    if (this.#sessionId !== undefined) {
      return this.#sessionId;
    }
    const created = await this.#request(
      "POST",
      "/session",
      { capabilities: { alwaysMatch: {} } },
      options,
    );
    const sessionId = (created as { readonly sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new DataError("internal", "WebDriverAgent did not return a session identifier.");
    }
    this.#sessionId = sessionId;
    return sessionId;
  }

  async #request(
    method: "GET" | "POST",
    route: string,
    body: JsonObject | undefined,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonValue> {
    const abort = new AbortController();
    const forwardAbort = (): void => abort.abort();
    if (options?.signal?.aborted) {
      // A signal aborted before registration never replays its event.
      forwardAbort();
    } else {
      options?.signal?.addEventListener("abort", forwardAbort, { once: true });
    }
    const timer = setTimeout(() => abort.abort(), this.#timeoutMilliseconds);
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.#baseUrl}${route}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: abort.signal,
      });
      const raw = await response.arrayBuffer();
      if (raw.byteLength > MAXIMUM_RESPONSE_BYTES) {
        throw new DataError("internal", "WebDriverAgent returned an oversized response.");
      }
      text = Buffer.from(raw).toString("utf8");
    } catch (error) {
      if (error instanceof DataError) {
        throw error;
      }
      throw new DataError(
        "internal",
        "The WebDriverAgent endpoint is unreachable or timed out.",
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", forwardAbort);
    }
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new DataError("internal", "WebDriverAgent returned invalid JSON.");
    }
    const envelope = parsed as { readonly value?: unknown } | null;
    const value = (envelope?.value ?? null) as JsonValue;
    const errorCode = wdaErrorCode(value);
    if (!response.ok || errorCode !== undefined) {
      throw new WdaRequestError(
        errorCode ?? `http_${response.status}`,
        "WebDriverAgent rejected the request.",
      );
    }
    // W3C places sessionId inside value; legacy WDA also mirrors it at the top
    // level. Normalize so session creation reads one shape.
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as JsonObject)["sessionId"] === undefined
    ) {
      const topLevel = (parsed as JsonObject | null)?.["sessionId"];
      if (typeof topLevel === "string") {
        return { ...(value as JsonObject), sessionId: topLevel };
      }
    }
    return value;
  }
}

/** A WebDriverAgent-level rejection with the driver's error identifier. */
export class WdaRequestError extends Error {
  constructor(readonly wdaError: string, message: string) {
    super(message);
    this.name = "WdaRequestError";
  }
}

function isInvalidSessionError(error: unknown): boolean {
  return error instanceof WdaRequestError && error.wdaError === "invalid session id";
}

function wdaErrorCode(value: JsonValue): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const code = (value as JsonObject)["error"];
  return typeof code === "string" ? code : undefined;
}

function requirePoint(command: ProviderActionCommand): { readonly x: number; readonly y: number } {
  const point = command.target?.absolute_point;
  if (point === undefined) {
    throw new DataError("invalid_argument", "This action requires a resolved absolute point.");
  }
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function pressSequence(x: number, y: number, holdMilliseconds: number): WdaPointerAction[] {
  return [
    { type: "pointerMove", duration: 0, x, y },
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: holdMilliseconds },
    { type: "pointerUp", button: 0 },
  ];
}

function dragSequence(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMilliseconds: number,
): WdaPointerAction[] {
  return [
    { type: "pointerMove", duration: 0, x: Math.round(fromX), y: Math.round(fromY) },
    { type: "pointerDown", button: 0 },
    {
      type: "pointerMove",
      duration: Math.max(1, Math.round(durationMilliseconds)),
      x: Math.round(toX),
      y: Math.round(toY),
    },
    { type: "pointerUp", button: 0 },
  ];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
