import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HostClientError, type JsonObject } from "../shared/index.js";

// The iOS automation driver is WebDriverAgent, an XCUITest-hosted HTTP
// driver. `driver ios up` owns the whole path from nothing to a ready
// loopback endpoint — pinned checkout, signing, boot, readiness — so
// operators never hand-manage a checkout or learn xcodebuild flags. These
// are local toolchain commands, not Host operations: they appear in the CLI
// because the CLI is the product's one command surface, and they stay out of
// the operation catalog because no Host route backs them.

const WDA_REPOSITORY = "https://github.com/appium/WebDriverAgent";
const WDA_TAG = "v15.1.6";
const WDA_COMMIT = "5f8280e761dc0b5b9b28368e63a8f0cc8d868346";
const DEFAULT_PORT = 8100;
const READY_TIMEOUT_MILLISECONDS = 8 * 60 * 1000;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

const cacheRoot = path.join(os.homedir(), ".vistrea", "cache", "webdriveragent");
const checkoutDirectory = path.join(cacheRoot, WDA_COMMIT);

export interface IosDriverResult {
  readonly data: JsonObject;
  /** Present for `up`: resolves when the driver is torn down by a signal. */
  readonly untilShutdown?: Promise<void>;
}

/** Runs one `driver ios <verb>` command and returns the envelope data. */
export async function runIosDriverCommand(
  commandArguments: readonly string[],
): Promise<IosDriverResult> {
  const [verb, ...rest] = commandArguments;
  if (verb === "doctor" && rest.length === 0) {
    return { data: await doctor() };
  }
  if (verb === "prepare" && rest.length === 0) {
    return { data: await prepare() };
  }
  if (verb === "up") {
    return up(parseUpOptions(rest));
  }
  throw new HostClientError(
    "invalid_argument",
    "Usage: driver ios <doctor|prepare|up> [--device <udid>] [--simulator <udid>] [--port <n>] [--team <id>] [--app-project <path>]",
  );
}

interface UpOptions {
  device?: string;
  simulator?: string;
  team?: string;
  appProject?: string;
  port?: number;
}

function parseUpOptions(argumentsValue: readonly string[]): UpOptions {
  const options: UpOptions = {};
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const key = argumentsValue[index] as string;
    const value = argumentsValue[index + 1];
    if (key === "--device" || key === "--simulator" || key === "--team" || key === "--app-project") {
      if (value === undefined) {
        throw new HostClientError("invalid_argument", `${key} needs a value.`);
      }
      const property = key === "--app-project" ? "appProject" : (key.slice(2) as "device" | "simulator" | "team");
      options[property] = value;
      index += 1;
    } else if (key === "--port") {
      if (!/^[1-9][0-9]{0,4}$/.test(value ?? "")) {
        throw new HostClientError("invalid_argument", "--port needs a positive port number.");
      }
      options.port = Number(value);
      index += 1;
    } else {
      throw new HostClientError("invalid_argument", `Unknown driver option: ${key}.`);
    }
  }
  return options;
}

function note(message: string): void {
  // Progress belongs on stderr; the CLI's stdout is exactly one JSON envelope.
  process.stderr.write(`${message}\n`);
}

function run(
  command: string,
  argumentsValue: readonly string[],
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, argumentsValue as string[], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function which(command: string): boolean {
  return run("/usr/bin/which", [command]).ok;
}

// --- Checkout ---------------------------------------------------------------

function resolveCheckout(): { project: string; source: string } {
  const override = process.env["VISTREA_WDA_PROJECT"];
  if (override !== undefined && override.trim().length > 0) {
    if (!path.isAbsolute(override) || !override.endsWith(".xcodeproj")) {
      throw new HostClientError(
        "invalid_argument",
        "VISTREA_WDA_PROJECT must be an absolute path to WebDriverAgent.xcodeproj.",
      );
    }
    return { project: override, source: "VISTREA_WDA_PROJECT" };
  }
  return { project: path.join(checkoutDirectory, "WebDriverAgent.xcodeproj"), source: "pinned" };
}

function checkoutState(): "missing" | "verified" | "mismatched" {
  const head = run("git", ["-C", checkoutDirectory, "rev-parse", "HEAD"]);
  if (!head.ok) {
    return "missing";
  }
  return head.stdout === WDA_COMMIT ? "verified" : "mismatched";
}

async function prepare(): Promise<JsonObject> {
  const checkout = resolveCheckout();
  if (checkout.source === "VISTREA_WDA_PROJECT") {
    return { status: "operator_managed", project: checkout.project };
  }
  const state = checkoutState();
  if (state === "verified") {
    return { status: "verified", project: checkout.project, tag: WDA_TAG, commit: WDA_COMMIT };
  }
  if (state === "mismatched") {
    // Never build an unaudited tree that happens to live in our cache path.
    throw new HostClientError(
      "integrity_error",
      `The cached checkout at ${checkoutDirectory} is not at the pinned commit; remove it and rerun.`,
    );
  }
  note(`Cloning WebDriverAgent ${WDA_TAG}...`);
  await fs.mkdir(cacheRoot, { recursive: true });
  const clone = run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    WDA_TAG,
    WDA_REPOSITORY,
    checkoutDirectory,
  ]);
  if (!clone.ok) {
    throw new HostClientError(
      "unavailable",
      `git clone failed: ${clone.stderr.split("\n").pop() ?? "unknown error"}`,
    );
  }
  if (checkoutState() !== "verified") {
    await fs.rm(checkoutDirectory, { recursive: true, force: true });
    throw new HostClientError(
      "integrity_error",
      `The ${WDA_TAG} tag no longer resolves to the pinned commit ${WDA_COMMIT}; ` +
        "the upstream tag moved, which is a supply-chain signal, not an inconvenience.",
    );
  }
  return { status: "prepared", project: checkout.project, tag: WDA_TAG, commit: WDA_COMMIT };
}

// --- Signing ------------------------------------------------------------------

function keychainTeams(): string[] {
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (!identities.ok) {
    return [];
  }
  const teams = new Set<string>();
  for (const line of identities.stdout.split("\n")) {
    // Only development identities can sign an XCUITest runner onto a device;
    // "Developer ID Application" is Mac distribution and must not match.
    const match = line.match(/"(?:Apple Development|iPhone Developer)[^"]*\(([A-Z0-9]{10})\)"/);
    if (match) {
      teams.add(match[1] as string);
    }
  }
  return [...teams];
}

async function teamFromProject(projectPath: string): Promise<string | undefined> {
  const stat = await fs.stat(projectPath).catch(() => undefined);
  if (stat === undefined) {
    throw new HostClientError("invalid_argument", `--app-project path does not exist: ${projectPath}`);
  }
  const candidates: string[] = [];
  if (stat.isDirectory()) {
    candidates.push(path.join(projectPath, "project.pbxproj"));
    candidates.push(path.join(projectPath, "project.yml"));
    for (const entry of await fs.readdir(projectPath).catch(() => [] as string[])) {
      if (entry.endsWith(".xcodeproj")) {
        candidates.push(path.join(projectPath, entry, "project.pbxproj"));
      }
    }
  } else {
    candidates.push(projectPath);
  }
  for (const candidate of candidates) {
    const content = await fs.readFile(candidate, "utf8").catch(() => undefined);
    const match = content?.match(/DEVELOPMENT_TEAM[" =:]+"?([A-Z0-9]{10})"?/);
    if (match) {
      return match[1] as string;
    }
  }
  return undefined;
}

async function resolveTeam(options: UpOptions): Promise<{ teamId: string; source: string }> {
  const explicit = options.team ?? process.env["VISTREA_WDA_TEAM_ID"];
  if (explicit !== undefined) {
    if (!TEAM_ID_PATTERN.test(explicit)) {
      throw new HostClientError(
        "invalid_argument",
        "A team ID is exactly ten uppercase letters and digits.",
      );
    }
    return { teamId: explicit, source: "explicit" };
  }
  if (options.appProject !== undefined) {
    const teamId = await teamFromProject(options.appProject);
    if (teamId !== undefined) {
      return { teamId, source: `app project ${options.appProject}` };
    }
    note(`No DEVELOPMENT_TEAM found in ${options.appProject}; falling back to the Keychain.`);
  }
  const teams = keychainTeams();
  if (teams.length === 1) {
    return { teamId: teams[0] as string, source: "keychain (single development identity)" };
  }
  if (teams.length === 0) {
    throw new HostClientError(
      "unavailable",
      "No Apple Development signing identity found in the Keychain; " +
        "sign into Xcode with an Apple ID (Settings > Accounts) to create one, then rerun.",
    );
  }
  throw new HostClientError(
    "invalid_argument",
    `Multiple development teams found in the Keychain: ${teams.join(", ")}. ` +
      "Pick one explicitly: driver ios up --device <udid> --team <id>",
  );
}

// --- Destination ----------------------------------------------------------------

interface SimulatorDescriptor {
  readonly udid: string;
  readonly name: string;
}

function bootedSimulators(): SimulatorDescriptor[] {
  const list = run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (!list.ok) {
    return [];
  }
  const devices = (JSON.parse(list.stdout) as { devices?: Record<string, JsonObject[]> }).devices ?? {};
  return Object.values(devices)
    .flat()
    .filter((device) => device["state"] === "Booted")
    .map((device) => ({ udid: device["udid"] as string, name: device["name"] as string }));
}

function newestAvailableIphone(): SimulatorDescriptor | undefined {
  const list = run("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  if (!list.ok) {
    return undefined;
  }
  const devices = (JSON.parse(list.stdout) as { devices?: Record<string, JsonObject[]> }).devices ?? {};
  const iphones = Object.entries(devices)
    .sort(([left], [right]) => right.localeCompare(left, undefined, { numeric: true }))
    .flatMap(([, entries]) => entries)
    .filter((device) => device["isAvailable"] === true && (device["name"] as string).startsWith("iPhone"));
  const first = iphones[0];
  return first === undefined
    ? undefined
    : { udid: first["udid"] as string, name: first["name"] as string };
}

function resolveSimulator(requestedUdid: string | undefined): SimulatorDescriptor {
  if (requestedUdid !== undefined) {
    run("xcrun", ["simctl", "boot", requestedUdid]);
    return { udid: requestedUdid, name: requestedUdid };
  }
  const booted = bootedSimulators();
  if (booted[0] !== undefined) {
    return booted[0];
  }
  const candidate = newestAvailableIphone();
  if (candidate === undefined) {
    throw new HostClientError(
      "unavailable",
      "No available iPhone Simulator found; install a Simulator runtime in Xcode (Settings > Platforms).",
    );
  }
  note(`Booting Simulator ${candidate.name}...`);
  const boot = run("xcrun", ["simctl", "boot", candidate.udid]);
  if (!boot.ok && !boot.stderr.includes("Booted")) {
    throw new HostClientError("unavailable", `Could not boot Simulator ${candidate.name}: ${boot.stderr}`);
  }
  return candidate;
}

// --- Device port forwarding --------------------------------------------------------

function spawnForwarder(
  localPort: number,
  devicePort: number,
  udid: string,
  children: ChildProcess[],
): string {
  if (which("iproxy")) {
    children.push(spawn("iproxy", [`${localPort}:${devicePort}`, "-u", udid], { stdio: "ignore" }));
    return "iproxy";
  }
  if (which("pymobiledevice3")) {
    children.push(
      spawn(
        "pymobiledevice3",
        ["usbmux", "forward", String(localPort), String(devicePort), "--serial", udid],
        { stdio: "ignore" },
      ),
    );
    return "pymobiledevice3";
  }
  throw new HostClientError(
    "unavailable",
    "A real device needs a USB port forwarder and neither iproxy nor pymobiledevice3 is installed; " +
      "brew install libimobiledevice, or pipx install pymobiledevice3.",
  );
}

// --- Up -----------------------------------------------------------------------------

async function waitForReady(url: string, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return false;
    }
    try {
      const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function up(options: UpOptions): Promise<IosDriverResult> {
  if (!run("xcrun", ["--find", "xcodebuild"]).ok) {
    throw new HostClientError(
      "unavailable",
      "xcodebuild was not found; install Xcode and its command-line tools first.",
    );
  }
  await prepare();
  const { project } = resolveCheckout();
  const port = options.port ?? DEFAULT_PORT;
  // Another agent already serving this port would satisfy the readiness probe
  // and hand the caller somebody else's device. Refuse instead of guessing.
  const occupied = await fetch(`http://127.0.0.1:${port}/status`, {
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined);
  if (occupied !== undefined) {
    throw new HostClientError(
      "conflict",
      `Port ${port} is already serving something on 127.0.0.1; if that is another ` +
        `WebDriverAgent session, point the Host at it directly or pick a free port with --port.`,
    );
  }

  const children: ChildProcess[] = [];
  const logPath = path.join(os.tmpdir(), `vistrea-ios-driver-${process.pid}.log`);
  const logHandle = await fs.open(logPath, "w");

  let destination: JsonObject;
  let teamId: string | undefined;
  const buildSettings = [`USE_PORT=${port}`];
  if (options.device !== undefined) {
    const resolved = await resolveTeam(options);
    teamId = resolved.teamId;
    note(`Signing with team ${teamId} (${resolved.source}).`);
    destination = { kind: "device", udid: options.device };
    buildSettings.push(
      `DEVELOPMENT_TEAM=${teamId}`,
      "CODE_SIGN_IDENTITY=Apple Development",
      // The default com.facebook bundle id collides across teams.
      `PRODUCT_BUNDLE_IDENTIFIER=dev.vistrea.wda.${teamId.toLowerCase()}`,
    );
  } else {
    const simulator = resolveSimulator(options.simulator);
    destination = { kind: "simulator", udid: simulator.udid, name: simulator.name };
  }

  note(`Building and launching WebDriverAgent (log: ${logPath})...`);
  const runner = spawn(
    "xcodebuild",
    [
      "-project",
      project,
      "-scheme",
      "WebDriverAgentRunner",
      "-destination",
      `id=${destination["udid"] as string}`,
      "-derivedDataPath",
      path.join(cacheRoot, "derived-data"),
      ...buildSettings,
      ...(options.device === undefined ? [] : ["-allowProvisioningUpdates"]),
      "test",
    ],
    { stdio: ["ignore", logHandle.fd, logHandle.fd] },
  );
  children.push(runner);

  if (options.device !== undefined) {
    const tool = spawnForwarder(port, port, options.device, children);
    note(`Forwarding 127.0.0.1:${port} to the device over USB via ${tool}.`);
  }

  const wdaUrl = `http://127.0.0.1:${port}`;
  const ready = await waitForReady(wdaUrl, runner);
  if (!ready) {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    note(log.split("\n").slice(-30).join("\n"));
    const deviceHints =
      options.device === undefined
        ? ""
        : " On a first device run, trust the developer certificate under Settings > General > " +
          "VPN & Device Management and enable Developer Mode under Privacy & Security, then rerun.";
    throw new HostClientError(
      "unavailable",
      `WebDriverAgent did not become ready at ${wdaUrl}/status; full build log: ${logPath}.${deviceHints}`,
    );
  }

  const untilShutdown = new Promise<void>((resolve) => {
    const shutdown = (): void => {
      for (const child of children) {
        child.kill("SIGTERM");
      }
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  note("WebDriverAgent is running; press Ctrl+C to stop it.");

  return {
    data: {
      status: "ready",
      wda_url: wdaUrl,
      destination,
      ...(teamId === undefined ? {} : { team_id: teamId }),
      checkout: project,
      pinned: { tag: WDA_TAG, commit: WDA_COMMIT },
      next:
        "node .build/typescript/apps/host/serve.js --workspace <abs-path> " +
        `--connection-file <abs-path> --automation wda --wda-url ${wdaUrl}`,
    },
    untilShutdown,
  };
}

// --- Doctor ------------------------------------------------------------------------

async function doctor(): Promise<JsonObject> {
  const checkout = resolveCheckout();
  return {
    xcodebuild: run("xcrun", ["--find", "xcodebuild"]).ok,
    checkout:
      checkout.source === "VISTREA_WDA_PROJECT"
        ? { source: checkout.source, project: checkout.project }
        : {
            source: checkout.source,
            project: checkout.project,
            state: checkoutState(),
            pinned: { tag: WDA_TAG, commit: WDA_COMMIT },
          },
    development_teams: keychainTeams(),
    booted_simulators: bootedSimulators() as unknown as JsonObject[],
    usb_forwarders: {
      iproxy: which("iproxy"),
      pymobiledevice3: which("pymobiledevice3"),
    },
  };
}
