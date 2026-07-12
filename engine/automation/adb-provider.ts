import { spawn } from "node:child_process";

import { DataError } from "../../data/api/index.js";
import {
  boundActionDigest,
  type AutomationProviderDescriptor,
  type AutomationProviderPort,
  type ProviderActionCommand,
  type ProviderActionResult,
} from "./automation-engine.js";

const DENSITY_BASELINE_DPI = 160;
const LONG_PRESS_MILLISECONDS = 600;
const DEFAULT_SWIPE_MILLISECONDS = 300;
const DEFAULT_SWIPE_DISTANCE_LOGICAL = 200;
// `input text` cannot represent arbitrary shell input safely; stay inside a
// conservative charset instead of guessing device shell quoting rules.
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9 ._,:@-]{1,256}$/;
const COMPONENT_PATTERN = /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/;

export interface AdbAutomationProviderOptions {
  readonly adbPath: string;
  readonly serial: string;
  readonly deviceKind?: "emulator" | "physical";
  readonly commandTimeoutMilliseconds?: number;
}

/**
 * Real Android user-level input through `adb shell input`, the same
 * InputManager injection layer UIAutomator uses, plus activity launches.
 *
 * The provider executes exactly one already resolved and authorized
 * operation. Injected input cannot prove the UI responded, so input actions
 * report `uncertain`; Engine-level capture comparison owns verification.
 */
export class AdbAutomationProvider implements AutomationProviderPort {
  readonly descriptor: AutomationProviderDescriptor;
  readonly #adbPath: string;
  readonly #serial: string;
  readonly #timeoutMilliseconds: number;
  #pixelsPerLogicalPoint: number | undefined;

  constructor(options: AdbAutomationProviderOptions) {
    this.#adbPath = options.adbPath;
    this.#serial = options.serial;
    this.#timeoutMilliseconds = options.commandTimeoutMilliseconds ?? 30_000;
    this.descriptor = {
      provider_id: "android-adb-input",
      platform: "android",
      device_kind: options.deviceKind ?? "emulator",
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
        const point = await this.#pixelPoint(command, options);
        await this.#shell(["input", "tap", point.x, point.y], options);
        return { outcome: "uncertain", detail: "Tap injected through InputManager." };
      }
      case "long_press": {
        const point = await this.#pixelPoint(command, options);
        await this.#shell(
          [
            "input",
            "swipe",
            point.x,
            point.y,
            point.x,
            point.y,
            String(LONG_PRESS_MILLISECONDS),
          ],
          options,
        );
        return { outcome: "uncertain", detail: "Long press injected through InputManager." };
      }
      case "type_text": {
        const text = command.payload?.["text_input"];
        if (typeof text !== "string" || !SAFE_TEXT_PATTERN.test(text)) {
          return {
            outcome: "failed",
            detail: "text_input is outside the provider's safe input charset.",
          };
        }
        if (command.target?.absolute_point !== undefined) {
          const point = await this.#pixelPoint(command, options);
          await this.#shell(["input", "tap", point.x, point.y], options);
        }
        await this.#shell(["input", "text", text.replaceAll(" ", "%s")], options);
        return { outcome: "uncertain", detail: "Text injected through InputManager." };
      }
      case "swipe":
      case "scroll": {
        const point = await this.#pixelPoint(command, options);
        const scale = await this.#scale(options);
        const deltaX = numberOr(command.payload?.["delta_x"], 0) * scale;
        const deltaY = numberOr(
          command.payload?.["delta_y"],
          command.kind === "scroll" ? -DEFAULT_SWIPE_DISTANCE_LOGICAL : 0,
        ) * scale;
        const duration = numberOr(command.payload?.["duration_ms"], DEFAULT_SWIPE_MILLISECONDS);
        if (deltaX === 0 && deltaY === 0) {
          return { outcome: "failed", detail: "A swipe requires a non-zero delta." };
        }
        await this.#shell(
          [
            "input",
            "swipe",
            point.x,
            point.y,
            String(Math.round(Number(point.x) + deltaX)),
            String(Math.round(Number(point.y) + deltaY)),
            String(Math.max(1, Math.round(duration))),
          ],
          options,
        );
        return { outcome: "uncertain", detail: "Swipe injected through InputManager." };
      }
      case "back": {
        await this.#shell(["input", "keyevent", "4"], options);
        return { outcome: "uncertain", detail: "Back key injected through InputManager." };
      }
      case "launch": {
        const component = command.payload?.["component"];
        if (typeof component !== "string" || !COMPONENT_PATTERN.test(component)) {
          return { outcome: "failed", detail: "launch requires payload.component." };
        }
        const output = await this.#shell(["am", "start", "-W", "-n", component], options);
        return /Status:\s+ok/.test(output)
          ? { outcome: "succeeded", detail: "The activity manager confirmed the launch." }
          : { outcome: "failed", detail: "The activity manager did not confirm the launch." };
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
    if (
      authorization.decision === "deny" ||
      authorization.session_id !== command.automation_session_id ||
      authorization.bound_action_digest !== expected ||
      Date.parse(authorization.expires_at) <= Date.now()
    ) {
      throw new DataError(
        "invalid_argument",
        "The provider rejected a missing, expired, mismatched, or denied authorization.",
      );
    }
  }

  async #pixelPoint(
    command: ProviderActionCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly x: string; readonly y: string }> {
    const point = command.target?.absolute_point;
    if (point === undefined) {
      throw new DataError("invalid_argument", "This action requires a resolved absolute point.");
    }
    const scale = await this.#scale(options);
    return {
      x: String(Math.round(point.x * scale)),
      y: String(Math.round(point.y * scale)),
    };
  }

  async #scale(options?: { readonly signal?: AbortSignal }): Promise<number> {
    if (this.#pixelsPerLogicalPoint !== undefined) {
      return this.#pixelsPerLogicalPoint;
    }
    const output = await this.#shell(["wm", "density"], options);
    const override = /Override density:\s*([0-9]+)/.exec(output);
    const physical = /Physical density:\s*([0-9]+)/.exec(output);
    const dpi = Number(override?.[1] ?? physical?.[1]);
    if (!Number.isFinite(dpi) || dpi <= 0) {
      throw new DataError("internal", "The device did not report a usable display density.");
    }
    this.#pixelsPerLogicalPoint = dpi / DENSITY_BASELINE_DPI;
    return this.#pixelsPerLogicalPoint;
  }

  async #shell(
    shellArguments: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    return await this.#run(["-s", this.#serial, "shell", ...shellArguments], options);
  }

  async #run(
    adbArguments: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.#adbPath, adbArguments, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (action: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          options?.signal?.removeEventListener("abort", onAbort);
          action();
        }
      };
      const onAbort = (): void => {
        child.kill("SIGKILL");
        settle(() =>
          reject(new DataError("internal", "The adb invocation was aborted.", { retryable: true })),
        );
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() =>
          reject(new DataError("internal", "The adb invocation timed out.", { retryable: true })),
        );
      }, this.#timeoutMilliseconds);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) =>
        settle(() =>
          reject(new DataError("internal", `adb could not start: ${error.message}`)),
        ),
      );
      child.once("close", (code) =>
        settle(() => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(
              new DataError("internal", "adb exited with a failure.", {
                details: { exit_code: code, stderr: stderr.slice(0, 512) },
              }),
            );
          }
        }),
      );
    });
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
