#!/usr/bin/env node
// WebDriverAgent bootstrap: one command from nothing to a ready loopback WDA
// endpoint, so operators never hand-manage a checkout, signing, or ports.
//
//   pnpm wda doctor                      report toolchain and signing readiness
//   pnpm wda prepare                     ensure the pinned checkout exists
//   pnpm wda up [--device <udid>]        boot WDA and print its loopback URL
//           [--simulator <udid>] [--port <n>] [--team <id>] [--app-project <p>]
//
// The checkout is pinned to one audited release; a checkout at any other
// commit is refused, never silently used. Signing needs only a team ID — the
// private key stays in the operator's Keychain and macOS mediates its use.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const WDA_REPOSITORY = "https://github.com/appium/WebDriverAgent";
const WDA_TAG = "v15.1.6";
const WDA_COMMIT = "5f8280e761dc0b5b9b28368e63a8f0cc8d868346";
const DEFAULT_PORT = 8100;
const READY_TIMEOUT_MILLISECONDS = 8 * 60 * 1000;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

const cacheRoot = path.join(os.homedir(), ".vistrea", "cache", "webdriveragent");
const checkoutDirectory = path.join(cacheRoot, WDA_COMMIT);

function note(message) {
  process.stderr.write(`${message}\n`);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message, hints = []) {
  note(`error: ${message}`);
  for (const hint of hints) {
    note(`  hint: ${hint}`);
  }
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function which(command) {
  return run("/usr/bin/which", [command]).ok;
}

// --- Checkout -----------------------------------------------------------

async function resolveCheckout() {
  const override = process.env["VISTREA_WDA_PROJECT"];
  if (override !== undefined && override.trim().length > 0) {
    // An operator-managed checkout keeps working; we only refuse to guess.
    if (!path.isAbsolute(override) || !override.endsWith(".xcodeproj")) {
      fail("VISTREA_WDA_PROJECT must be an absolute path to WebDriverAgent.xcodeproj.");
    }
    return { project: override, source: "VISTREA_WDA_PROJECT" };
  }
  return { project: path.join(checkoutDirectory, "WebDriverAgent.xcodeproj"), source: "pinned" };
}

async function checkoutState() {
  const head = run("git", ["-C", checkoutDirectory, "rev-parse", "HEAD"]);
  if (!head.ok) {
    return "missing";
  }
  return head.stdout === WDA_COMMIT ? "verified" : "mismatched";
}

async function prepare() {
  const { source } = await resolveCheckout();
  if (source === "VISTREA_WDA_PROJECT") {
    note("Using the operator-provided VISTREA_WDA_PROJECT checkout; nothing to prepare.");
    return;
  }
  const state = await checkoutState();
  if (state === "verified") {
    note(`WebDriverAgent ${WDA_TAG} is already prepared at ${checkoutDirectory}.`);
    return;
  }
  if (state === "mismatched") {
    // Never build an unaudited tree that happens to live in our cache path.
    fail(`The cached checkout at ${checkoutDirectory} is not at the pinned commit.`, [
      `Remove it and rerun: rm -rf ${checkoutDirectory}`,
    ]);
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
    fail(`git clone failed: ${clone.stderr.split("\n").pop()}`);
  }
  if ((await checkoutState()) !== "verified") {
    await fs.rm(checkoutDirectory, { recursive: true, force: true });
    fail(`The ${WDA_TAG} tag no longer resolves to the pinned commit ${WDA_COMMIT}.`, [
      "The upstream tag moved; treat this as a supply-chain signal, not an inconvenience.",
    ]);
  }
  note(`Prepared WebDriverAgent ${WDA_TAG} at ${checkoutDirectory}.`);
}

// --- Signing --------------------------------------------------------------

function keychainTeams() {
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (!identities.ok) {
    return [];
  }
  const teams = new Map();
  for (const line of identities.stdout.split("\n")) {
    // Only development identities can sign an XCUITest runner onto a device;
    // "Developer ID Application" is Mac distribution and must not match.
    const match = line.match(/"(Apple Development|iPhone Developer)[^"]*\(([A-Z0-9]{10})\)"/);
    if (match) {
      teams.set(match[2], match[1]);
    }
  }
  return [...teams.keys()];
}

async function teamFromProject(projectPath) {
  const candidates = [];
  const stat = await fs.stat(projectPath).catch(() => undefined);
  if (stat === undefined) {
    fail(`--app-project path does not exist: ${projectPath}`);
  }
  if (stat.isDirectory()) {
    candidates.push(path.join(projectPath, "project.pbxproj"));
    candidates.push(path.join(projectPath, "project.yml"));
    const entries = await fs.readdir(projectPath).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith(".xcodeproj")) {
        candidates.push(path.join(projectPath, entry, "project.pbxproj"));
      }
    }
  } else {
    candidates.push(projectPath);
  }
  for (const candidate of candidates) {
    const content = await fs.readFile(candidate, "utf8").catch(() => undefined);
    if (content === undefined) {
      continue;
    }
    const match = content.match(/DEVELOPMENT_TEAM[" =:]+"?([A-Z0-9]{10})"?/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

async function resolveTeam(options) {
  const explicit = options.team ?? process.env["VISTREA_WDA_TEAM_ID"];
  if (explicit !== undefined) {
    if (!TEAM_ID_PATTERN.test(explicit)) {
      fail("A team ID is exactly ten uppercase letters and digits.");
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
    return { teamId: teams[0], source: "keychain (single development identity)" };
  }
  if (teams.length === 0) {
    fail("No Apple Development signing identity found in the Keychain.", [
      "Sign into Xcode with an Apple ID (Settings > Accounts) to create one, then rerun.",
    ]);
  }
  fail(`Multiple development teams found in the Keychain: ${teams.join(", ")}.`, [
    "Pick one explicitly: pnpm wda up --device <udid> --team <id>",
  ]);
}

// --- Destination ----------------------------------------------------------

function bootedSimulators() {
  const list = run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (!list.ok) {
    return [];
  }
  const devices = JSON.parse(list.stdout).devices ?? {};
  return Object.values(devices)
    .flat()
    .filter((device) => device.state === "Booted")
    .map((device) => ({ udid: device.udid, name: device.name }));
}

function newestAvailableIphone() {
  const list = run("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  if (!list.ok) {
    return undefined;
  }
  const devices = JSON.parse(list.stdout).devices ?? {};
  const iphones = Object.entries(devices)
    .sort(([left], [right]) => right.localeCompare(left, undefined, { numeric: true }))
    .flatMap(([, entries]) => entries)
    .filter((device) => device.isAvailable && device.name.startsWith("iPhone"));
  return iphones[0] === undefined
    ? undefined
    : { udid: iphones[0].udid, name: iphones[0].name };
}

async function resolveSimulator(requestedUdid) {
  if (requestedUdid !== undefined) {
    run("xcrun", ["simctl", "boot", requestedUdid]);
    return { udid: requestedUdid, name: requestedUdid };
  }
  const booted = bootedSimulators();
  if (booted.length > 0) {
    return booted[0];
  }
  const candidate = newestAvailableIphone();
  if (candidate === undefined) {
    fail("No available iPhone Simulator found.", [
      "Install a Simulator runtime in Xcode (Settings > Platforms), then rerun.",
    ]);
  }
  note(`Booting Simulator ${candidate.name}...`);
  const boot = run("xcrun", ["simctl", "boot", candidate.udid]);
  if (!boot.ok && !boot.stderr.includes("Booted")) {
    fail(`Could not boot Simulator ${candidate.name}: ${boot.stderr}`);
  }
  return candidate;
}

// --- Device port forwarding ------------------------------------------------

function spawnForwarder(localPort, devicePort, udid, children) {
  if (which("iproxy")) {
    const forwarder = spawn("iproxy", [`${localPort}:${devicePort}`, "-u", udid], {
      stdio: "ignore",
    });
    children.push(forwarder);
    return "iproxy";
  }
  if (which("pymobiledevice3")) {
    const forwarder = spawn(
      "pymobiledevice3",
      ["usbmux", "forward", String(localPort), String(devicePort), "--serial", udid],
      { stdio: "ignore" },
    );
    children.push(forwarder);
    return "pymobiledevice3";
  }
  fail("A real device needs a USB port forwarder and neither iproxy nor pymobiledevice3 is installed.", [
    "brew install libimobiledevice   (provides iproxy)",
    "or: pipx install pymobiledevice3",
  ]);
}

// --- Up ---------------------------------------------------------------------

async function waitForReady(url, child) {
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

async function up(options) {
  if (!run("xcrun", ["--find", "xcodebuild"]).ok) {
    fail("xcodebuild was not found; install Xcode and its command-line tools first.");
  }
  await prepare();
  const { project } = await resolveCheckout();
  const port = options.port ?? DEFAULT_PORT;
  // Another agent already serving this port would satisfy the readiness probe
  // and hand the caller somebody else's device. Refuse instead of guessing.
  const occupied = await fetch(`http://127.0.0.1:${port}/status`, {
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined);
  if (occupied !== undefined) {
    fail(`Port ${port} is already serving something on 127.0.0.1.`, [
      `If that is another WebDriverAgent session, point the Host at it directly or pick a free port: pnpm wda up --port ${port + 27}`,
    ]);
  }
  const children = [];
  const logPath = path.join(os.tmpdir(), `vistrea-wda-${process.pid}.log`);
  const logHandle = await fs.open(logPath, "w");

  let destination;
  let teamId;
  const buildSettings = [`USE_PORT=${port}`];
  if (options.device !== undefined) {
    const resolved = await resolveTeam(options);
    teamId = resolved.teamId;
    note(`Signing with team ${teamId} (${resolved.source}).`);
    destination = { kind: "device", udid: options.device };
    buildSettings.push(
      `DEVELOPMENT_TEAM=${teamId}`,
      'CODE_SIGN_IDENTITY=Apple Development',
      // The default com.facebook bundle id collides across teams.
      `PRODUCT_BUNDLE_IDENTIFIER=dev.vistrea.wda.${teamId.toLowerCase()}`,
    );
  } else {
    const simulator = await resolveSimulator(options.simulator);
    destination = { kind: "simulator", udid: simulator.udid, name: simulator.name };
  }

  note(`Building and launching WebDriverAgent (log: ${logPath})...`);
  const xcodebuildArguments = [
    "-project",
    project,
    "-scheme",
    "WebDriverAgentRunner",
    "-destination",
    `id=${destination.udid}`,
    "-derivedDataPath",
    path.join(cacheRoot, "derived-data"),
    ...buildSettings,
    ...(options.device === undefined ? [] : ["-allowProvisioningUpdates"]),
    "test",
  ];
  const runner = spawn("xcodebuild", xcodebuildArguments, {
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  children.push(runner);

  if (options.device !== undefined) {
    const tool = spawnForwarder(port, port, options.device, children);
    note(`Forwarding 127.0.0.1:${port} to the device over USB via ${tool}.`);
  }

  const shutdown = () => {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const wdaUrl = `http://127.0.0.1:${port}`;
  const ready = await waitForReady(wdaUrl, runner);
  if (!ready) {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    note(log.split("\n").slice(-30).join("\n"));
    fail(`WebDriverAgent did not become ready at ${wdaUrl}/status.`, [
      `Full build log: ${logPath}`,
      ...(options.device === undefined
        ? []
        : [
            "On a first device run, open Settings > General > VPN & Device Management and trust the developer certificate, then rerun.",
            "Developer Mode (Settings > Privacy & Security) must be enabled on the device.",
          ]),
    ]);
  }

  emit({
    status: "ready",
    wda_url: wdaUrl,
    destination,
    ...(teamId === undefined ? {} : { team_id: teamId }),
    checkout: project,
    pinned: { tag: WDA_TAG, commit: WDA_COMMIT },
    next: `node .build/typescript/apps/host/serve.js --workspace <abs-path> --connection-file <abs-path> --automation wda --wda-url ${wdaUrl}`,
  });
  note("WebDriverAgent is running; press Ctrl+C to stop it.");
}

// --- Doctor -----------------------------------------------------------------

async function doctor() {
  const { project, source } = await resolveCheckout();
  emit({
    xcodebuild: run("xcrun", ["--find", "xcodebuild"]).ok,
    checkout:
      source === "VISTREA_WDA_PROJECT"
        ? { source, project }
        : { source, project, state: await checkoutState(), pinned: { tag: WDA_TAG, commit: WDA_COMMIT } },
    development_teams: keychainTeams(),
    booted_simulators: bootedSimulators(),
    usb_forwarders: {
      iproxy: which("iproxy"),
      pymobiledevice3: which("pymobiledevice3"),
    },
  });
}

// --- Entry -------------------------------------------------------------------

function parseOptions(argumentsValue) {
  const options = {};
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const key = argumentsValue[index];
    const value = argumentsValue[index + 1];
    if (key === "--device" || key === "--simulator" || key === "--team" || key === "--app-project") {
      if (value === undefined) {
        fail(`${key} needs a value.`);
      }
      options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else if (key === "--port") {
      if (!/^[1-9][0-9]{0,4}$/.test(value ?? "")) {
        fail("--port needs a positive port number.");
      }
      options.port = Number(value);
      index += 1;
    } else {
      fail(`Unknown option: ${key}`);
    }
  }
  return options;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "doctor" && rest.length === 0) {
  await doctor();
} else if (command === "prepare" && rest.length === 0) {
  await prepare();
} else if (command === "up") {
  await up(parseOptions(rest));
} else {
  note("Usage: pnpm wda <doctor|prepare|up> [--device <udid>] [--simulator <udid>] [--port <n>] [--team <id>] [--app-project <path>]");
  process.exit(2);
}
