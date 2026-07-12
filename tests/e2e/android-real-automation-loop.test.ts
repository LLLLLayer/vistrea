import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { startLocalHost, type LocalHostHandle } from "../../apps/host/index.js";
import { PROTOCOL_SCHEMA_IDS, type RuntimeSnapshot } from "../../data/api/index.js";
import { MemoryDataStore, createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { AdbAutomationProvider, AutomationEngine } from "../../engine/automation/index.js";
import { ScreenGraphEngine } from "../../engine/exploration/index.js";

const repositoryRoot = process.cwd();
const optInEnvironment = "VISTREA_RUN_ANDROID_REAL_AUTOMATION";
const scenarioId = "demo.navigation.basic";
const scenarioProfile = "baseline";
const homeStableId = "demo.home.open_catalog";
const catalogStableId = "demo.catalog.item_primary";
const debugPackage = "dev.vistrea.demo.debug";
const debugComponent = `${debugPackage}/dev.vistrea.demo.MainActivity`;
const androidHome =
  process.env["ANDROID_HOME"] ?? path.join(process.env["HOME"] ?? "", "Library/Android/sdk");
const adbPath = path.join(androidHome, "platform-tools/adb");
const emulatorPath = path.join(androidHome, "emulator/emulator");
const demoRoot = path.join(repositoryRoot, "examples/android/VistreaDemoApp");
const gradleWrapper = path.join(demoRoot, "gradlew");
const tokenInstaller = path.join(demoRoot, "tools/install-runtime-token.sh");
const debugApk = path.join(demoRoot, "app/build/outputs/apk/debug/app-debug.apk");
const commandOutputLimit = 16 * 1024 * 1024;
const settleMilliseconds = 1_500;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: Buffer;
  readonly timeoutMilliseconds?: number;
  readonly allowFailure?: boolean;
  readonly secrets?: readonly string[];
  readonly forbiddenEnvironmentSecrets?: readonly string[];
  readonly label?: string;
}

interface AndroidAvd {
  readonly name: string;
  readonly target: string;
  readonly apiLevel: number;
}

interface AcceptanceResources {
  emulator: ChildProcess | undefined;
  emulatorSerial: string | undefined;
  reversePort: number | undefined;
  host: LocalHostHandle | undefined;
}

const selectedAvd = discoverApi36Avd();
const skipReason = realAutomationSkipReason(selectedAvd);

test(
  "real adb automation walks the navigation scenario into a deduplicated Screen Graph",
  {
    timeout: 15 * 60 * 1_000,
    ...(skipReason === undefined ? {} : { skip: skipReason }),
  },
  async (t) => {
    assert.ok(selectedAvd !== undefined);
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-android-automation-"));
    const workspaceRoot = path.join(testRoot, "workspace");
    const resources: AcceptanceResources = {
      emulator: undefined,
      emulatorSerial: undefined,
      reversePort: undefined,
      host: undefined,
    };
    const knownSecrets: string[] = [];
    t.after(async () => {
      await cleanupResources(resources, knownSecrets);
      await fs.rm(testRoot, { recursive: true, force: true });
    });

    const validator = await createRepositoryProtocolValidator({ repositoryRoot });
    const emulatorPort = await findAvailableEmulatorPort();
    resources.emulatorSerial = `emulator-${emulatorPort}`;
    resources.emulator = spawn(
      emulatorPath,
      [
        "-avd",
        selectedAvd.name,
        "-port",
        String(emulatorPort),
        "-read-only",
        "-no-snapshot",
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-metrics",
        "-netdelay",
        "none",
        "-netspeed",
        "full",
      ],
      {
        cwd: repositoryRoot,
        env: cleanEnvironment({ ANDROID_HOME: androidHome }),
        stdio: "ignore",
      },
    );
    await waitForSpawn(resources.emulator, "The dedicated Android emulator could not start.");

    const buildPromise = runCommand(gradleWrapper, ["--quiet", ":app:assembleDebug"], {
      cwd: demoRoot,
      environment: cleanEnvironment({ ANDROID_HOME: androidHome }),
      timeoutMilliseconds: 6 * 60 * 1_000,
      label: "Android Demo Debug build",
    });
    const bootPromise = waitForAndroidBoot(resources);
    await Promise.all([buildPromise, bootPromise]);

    const serial = requireResource(resources.emulatorSerial, "Android emulator serial");
    await runAdb(serial, ["shell", "wm", "dismiss-keyguard"], {
      allowFailure: true,
      label: "Android keyguard dismissal",
    });
    await runAdb(serial, ["shell", "am", "force-stop", debugPackage], {
      allowFailure: true,
      label: "stale Android Demo stop",
    });
    await runAdb(serial, ["uninstall", debugPackage], {
      allowFailure: true,
      label: "stale Android Demo removal",
    });
    await runAdb(serial, ["install", "-r", "-t", debugApk], {
      timeoutMilliseconds: 120_000,
      label: "Android Demo installation",
    });

    resources.host = await startLocalHost({
      workspaceRoot,
      validator,
      applicationVersion: "0.0.0",
    });
    knownSecrets.push(
      resources.host.api.bearerToken,
      resources.host.runtime.authorizationToken,
    );
    resources.reversePort = resources.host.runtime.port;
    await runAdb(
      serial,
      ["reverse", `tcp:${resources.host.runtime.port}`, `tcp:${resources.host.runtime.port}`],
      { secrets: knownSecrets, label: "Android Runtime adb reverse" },
    );

    const runtimeTokenBytes = Buffer.from(resources.host.runtime.authorizationToken, "utf8");
    try {
      await runCommand(tokenInstaller, [], {
        cwd: demoRoot,
        environment: cleanEnvironment({
          ANDROID_HOME: androidHome,
          ANDROID_SERIAL: serial,
          ADB: adbPath,
          VISTREA_ANDROID_PACKAGE: debugPackage,
        }),
        input: runtimeTokenBytes,
        secrets: knownSecrets,
        forbiddenEnvironmentSecrets: [resources.host.runtime.authorizationToken],
        label: "one-shot Android Runtime token installation",
      });
    } finally {
      runtimeTokenBytes.fill(0);
    }

    const launch = await runAdb(
      serial,
      [
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        debugComponent,
        "--es",
        "VISTREA_RUNTIME_HOST",
        "127.0.0.1",
        "--es",
        "VISTREA_RUNTIME_PORT",
        String(resources.host.runtime.port),
        "--es",
        "vistrea.scenario_id",
        scenarioId,
        "--es",
        "vistrea.profile_id",
        scenarioProfile,
      ],
      {
        secrets: knownSecrets,
        forbiddenEnvironmentSecrets: [resources.host.runtime.authorizationToken],
        timeoutMilliseconds: 60_000,
        label: "Android Demo Scenario launch",
      },
    );
    assert.match(launch.stdout, /Status:\s+ok/);
    await resources.host.waitForRuntime(60_000);
    assert.equal(resources.host.runtimeConnected, true);
    await delay(settleMilliseconds);

    // Home Snapshot and its Screen State observation through the product API.
    const homeSnapshot = await captureSnapshotThroughApi(resources.host, knownSecrets);
    validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, homeSnapshot);
    assert.equal(hasStableId(homeSnapshot, homeStableId), true);
    const homeObserved = await postJson(
      resources.host,
      "/v1/screen-graph/state-observations",
      { snapshot_id: homeSnapshot["snapshot_id"], title: "Home", entry: true },
      knownSecrets,
    );
    assert.equal(homeObserved["created"], true);
    const homeState = asRecord(homeObserved["screen_state"], "Home Screen State");

    // A real user-level tap through adb, resolved from the persisted Snapshot.
    // A real wall clock keeps authorization expiry meaningful for the
    // provider's freshness check.
    const automationWorkspace = new MemoryDataStore({
      validator,
      clock: { now: () => new Date().toISOString() },
    });
    {
      // Target resolution needs trees and display geometry only; the local
      // resolution copy drops the screenshot so no Object bytes are required.
      const resolutionSnapshot = { ...homeSnapshot };
      delete resolutionSnapshot["screenshot"];
      const unit = automationWorkspace.beginUnitOfWork("write");
      unit.snapshots.put(resolutionSnapshot as unknown as RuntimeSnapshot);
      unit.commit();
    }
    const automation = new AutomationEngine({
      workspace: automationWorkspace,
      validator,
      providers: [new AdbAutomationProvider({ adbPath, serial })],
    });
    const session = automation.openSession({
      provider_id: "android-adb-input",
      actor_id: "vistrea-automation-acceptance",
    });
    const tapResult = await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "tap",
      target: { stable_id: homeStableId },
      expected_snapshot_id: homeSnapshot["snapshot_id"] as string,
      intent: { requested_effect: "Open the catalog screen" },
    });
    assert.equal(tapResult.outcome, "uncertain");
    assert.equal(tapResult.target_resolution?.resolution_method, "accessibility");
    assert.equal(tapResult.target_resolution?.provider_locator?.value, homeStableId);
    assert.equal(tapResult.authorization.decision, "allow");
    await delay(settleMilliseconds);

    // The catalog Snapshot proves the tap actually navigated.
    const catalogSnapshot = await captureSnapshotThroughApi(resources.host, knownSecrets);
    validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, catalogSnapshot);
    assert.equal(hasStableId(catalogSnapshot, catalogStableId), true);
    assert.equal(hasStableId(catalogSnapshot, homeStableId), false);
    assert.notEqual(
      ScreenGraphEngine.computeStructuralIdentity(
        catalogSnapshot as unknown as RuntimeSnapshot,
      ).layout_digest,
      ScreenGraphEngine.computeStructuralIdentity(
        homeSnapshot as unknown as RuntimeSnapshot,
      ).layout_digest,
    );

    const catalogObserved = await postJson(
      resources.host,
      "/v1/screen-graph/state-observations",
      { snapshot_id: catalogSnapshot["snapshot_id"], title: "Catalog" },
      knownSecrets,
    );
    assert.equal(catalogObserved["created"], true);
    const catalogState = asRecord(catalogObserved["screen_state"], "Catalog Screen State");
    assert.notEqual(catalogState["screen_state_id"], homeState["screen_state_id"]);

    const transition = await postJson(
      resources.host,
      "/v1/screen-graph/transition-observations",
      {
        before_snapshot_id: homeSnapshot["snapshot_id"],
        after_snapshot_id: catalogSnapshot["snapshot_id"],
        action: {
          kind: "tap",
          requested_effect: "Open the catalog screen",
          target: { stable_id: homeStableId },
        },
        capture_source: "automation",
      },
      knownSecrets,
    );
    assert.equal(transition["created"], true);
    assert.equal(transition["source_state_id"], homeState["screen_state_id"]);
    assert.equal(transition["target_state_id"], catalogState["screen_state_id"]);

    // Real system back returns to a structurally identical Home: dedup, not a
    // third state.
    const backResult = await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "back",
      intent: { requested_effect: "Return to Home" },
    });
    assert.equal(backResult.outcome, "uncertain");
    await delay(settleMilliseconds);
    const homeAgainSnapshot = await captureSnapshotThroughApi(resources.host, knownSecrets);
    assert.equal(hasStableId(homeAgainSnapshot, homeStableId), true);
    assert.equal(
      ScreenGraphEngine.computeStructuralIdentity(
        homeAgainSnapshot as unknown as RuntimeSnapshot,
      ).layout_digest,
      ScreenGraphEngine.computeStructuralIdentity(
        homeSnapshot as unknown as RuntimeSnapshot,
      ).layout_digest,
    );
    const homeAgainObserved = await postJson(
      resources.host,
      "/v1/screen-graph/state-observations",
      { snapshot_id: homeAgainSnapshot["snapshot_id"] },
      knownSecrets,
    );
    assert.equal(homeAgainObserved["created"], false);
    assert.equal(
      asRecord(homeAgainObserved["screen_state"], "re-observed Home")["screen_state_id"],
      homeState["screen_state_id"],
    );

    const backTransition = await postJson(
      resources.host,
      "/v1/screen-graph/transition-observations",
      {
        before_snapshot_id: catalogSnapshot["snapshot_id"],
        after_snapshot_id: homeAgainSnapshot["snapshot_id"],
        action: { kind: "back", requested_effect: "Return to Home" },
        capture_source: "automation",
      },
      knownSecrets,
    );
    assert.equal(backTransition["created"], true);

    const runtimeContext = asRecord(homeSnapshot["runtime_context"], "Runtime context");
    const graph = await getJson(
      resources.host,
      `/v1/screen-graph?project_id=${encodeURIComponent(
        runtimeContext["project_id"] as string,
      )}&application_id=${encodeURIComponent(runtimeContext["application_id"] as string)}`,
      knownSecrets,
    );
    assert.equal(asArray(graph["states"], "graph states").length, 2);
    assert.equal(asArray(graph["transitions"], "graph transitions").length, 2);
    const paths = await getJson(
      resources.host,
      `/v1/screen-graph/paths?source_state_id=${encodeURIComponent(
        homeState["screen_state_id"] as string,
      )}&target_state_id=${encodeURIComponent(catalogState["screen_state_id"] as string)}`,
      knownSecrets,
    );
    assert.equal(asArray(paths["paths"], "graph paths").length, 1);

    automation.closeSession(session.automation_session_id);
    await resources.host.close();
    resources.host = undefined;
    await stopDedicatedEmulator(resources, knownSecrets);

    t.diagnostic(
      JSON.stringify({
        scenario_id: scenarioId,
        emulator_target: selectedAvd.target,
        home_snapshot_id: homeSnapshot["snapshot_id"],
        catalog_snapshot_id: catalogSnapshot["snapshot_id"],
        home_state_id: homeState["screen_state_id"],
        catalog_state_id: catalogState["screen_state_id"],
        real_tap: "uncertain-then-verified",
        real_back: "deduplicated",
        graph_states: 2,
        graph_transitions: 2,
        path_found: "passed",
      }),
    );
  },
);

function hasStableId(snapshot: Record<string, unknown>, stableId: string): boolean {
  return asArray(snapshot["trees"], "Snapshot trees").some((treeValue) => {
    const tree = asRecord(treeValue, "Snapshot tree");
    const payload = asRecord(tree["payload"], "Snapshot tree payload");
    return asArray(payload["inline_nodes"], "Snapshot inline nodes").some(
      (node) => asRecord(node, "Snapshot UI node")["stable_id"] === stableId,
    );
  });
}

async function postJson(
  host: LocalHostHandle,
  route: string,
  body: Record<string, unknown>,
  secrets: readonly string[],
): Promise<Record<string, unknown>> {
  const response = await fetch(`${host.api.baseUrl}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${host.api.bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response, 201, `POST ${route}`, secrets);
}

async function getJson(
  host: LocalHostHandle,
  route: string,
  secrets: readonly string[],
): Promise<Record<string, unknown>> {
  const response = await fetch(`${host.api.baseUrl}${route}`, {
    headers: { authorization: `Bearer ${host.api.bearerToken}` },
  });
  return await readJsonResponse(response, 200, `GET ${route}`, secrets);
}

async function captureSnapshotThroughApi(
  host: LocalHostHandle,
  secrets: readonly string[],
): Promise<Record<string, unknown>> {
  const response = await fetch(`${host.api.baseUrl}/v1/captures`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${host.api.bearerToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  return await readJsonResponse(response, 201, "Snapshot capture", secrets);
}

async function readJsonResponse(
  response: Response,
  expectedStatus: number,
  label: string,
  secrets: readonly string[],
): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${redact(body, secrets)}`);
  }
  try {
    return asRecord(JSON.parse(body) as unknown, `${label} response`);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function realAutomationSkipReason(avd: AndroidAvd | undefined): string | undefined {
  if (process.env[optInEnvironment] !== "1") {
    return `Set ${optInEnvironment}=1 or use the dedicated package script to run this acceptance.`;
  }
  if (
    !existsSync(adbPath) ||
    !existsSync(emulatorPath) ||
    !existsSync(gradleWrapper) ||
    !existsSync(tokenInstaller) ||
    spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0
  ) {
    return "The Android SDK, emulator, Gradle wrapper, token helper, or Java toolchain is unavailable.";
  }
  if (avd === undefined) {
    return "No installed Android API 36 or newer AVD is available for the dedicated acceptance emulator.";
  }
  return undefined;
}

function discoverApi36Avd(): AndroidAvd | undefined {
  if (!existsSync(emulatorPath)) {
    return undefined;
  }
  const result = spawnSync(emulatorPath, ["-list-avds"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return undefined;
  }
  const avdHome =
    process.env["ANDROID_AVD_HOME"] ?? path.join(process.env["HOME"] ?? "", ".android/avd");
  const candidates: AndroidAvd[] = [];
  for (const name of result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    const iniPath = path.join(avdHome, `${name}.ini`);
    if (!existsSync(iniPath)) {
      continue;
    }
    const target = /^target=(android-([0-9]+(?:\.[0-9]+)?))$/mu.exec(readFileSync(iniPath, "utf8"));
    if (target === null) {
      continue;
    }
    const apiLevel = Number.parseInt(target[2] as string, 10);
    if (apiLevel >= 36) {
      candidates.push({ name, target: target[1] as string, apiLevel });
    }
  }
  return candidates.sort((left, right) => right.apiLevel - left.apiLevel)[0];
}

async function findAvailableEmulatorPort(): Promise<number> {
  for (let port = 5582; port <= 5680; port += 2) {
    if ((await canBind(port)) && (await canBind(port + 1))) {
      return port;
    }
  }
  throw new Error("No free dedicated Android emulator console/adb port pair is available.");
}

async function canBind(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function waitForAndroidBoot(resources: AcceptanceResources): Promise<void> {
  const serial = requireResource(resources.emulatorSerial, "Android emulator serial");
  await runAdb(serial, ["wait-for-device"], {
    timeoutMilliseconds: 180_000,
    label: "dedicated Android emulator discovery",
  });
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (resources.emulator?.exitCode !== null) {
      throw new Error("The dedicated Android emulator stopped before boot completed.");
    }
    const completed = await runAdb(serial, ["shell", "getprop", "sys.boot_completed"], {
      allowFailure: true,
      timeoutMilliseconds: 10_000,
      label: "Android boot state",
    });
    if (completed.exitCode === 0 && completed.stdout.trim() === "1") {
      return;
    }
    await delay(1_000);
  }
  throw new Error("The dedicated Android API 36+ emulator did not finish booting.");
}

async function runAdb(
  serial: string,
  arguments_: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await runCommand(adbPath, ["-s", serial, ...arguments_], {
    ...options,
    environment: options.environment ?? cleanEnvironment({ ANDROID_HOME: androidHome }),
  });
}

async function stopDedicatedEmulator(
  resources: AcceptanceResources,
  secrets: readonly string[],
): Promise<void> {
  const serial = resources.emulatorSerial;
  if (serial !== undefined) {
    if (resources.reversePort !== undefined) {
      await runAdb(serial, ["reverse", "--remove", `tcp:${resources.reversePort}`], {
        allowFailure: true,
        secrets,
        label: "Android Runtime reverse removal",
      });
    }
    await runAdb(serial, ["shell", "am", "force-stop", debugPackage], {
      allowFailure: true,
      secrets,
      label: "Android Demo stop",
    });
    await runAdb(serial, ["emu", "kill"], {
      allowFailure: true,
      secrets,
      label: "dedicated Android emulator shutdown",
    });
  }
  await stopChild(resources.emulator);
  resources.emulator = undefined;
  resources.emulatorSerial = undefined;
  resources.reversePort = undefined;
}

async function cleanupResources(
  resources: AcceptanceResources,
  secrets: readonly string[],
): Promise<void> {
  try {
    await resources.host?.close();
  } catch {
    // Preserve the primary failure while continuing deterministic cleanup.
  }
  resources.host = undefined;
  await stopDedicatedEmulator(resources, secrets);
}

async function waitForSpawn(child: ChildProcess, message: string): Promise<void> {
  await Promise.race([
    once(child, "spawn").then(() => undefined),
    once(child, "error").then(() => {
      throw new Error(message);
    }),
  ]);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const closed = await Promise.race([
    once(child, "close").then(() => true),
    delay(10_000).then(() => false),
  ]);
  if (!closed && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "close"), delay(5_000)]);
  }
}

function cleanEnvironment(additions: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("VISTREA_HOST_") ||
      key.startsWith("VISTREA_RUNTIME_") ||
      key.startsWith("SIMCTL_CHILD_VISTREA_") ||
      key === "ANDROID_SERIAL"
    ) {
      delete environment[key];
    }
  }
  Object.assign(environment, additions);
  return environment;
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const secrets = options.secrets ?? [];
  if (secrets.some((secret) => arguments_.some((argument) => argument.includes(secret)))) {
    throw new Error("A protected Host credential was placed in process arguments.");
  }
  const environment = options.environment ?? cleanEnvironment();
  for (const secret of options.forbiddenEnvironmentSecrets ?? []) {
    if (Object.values(environment).some((value) => value?.includes(secret) === true)) {
      throw new Error("The Android Runtime credential was placed in a child environment.");
    }
  }
  const child = spawn(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(options.input);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let overflow = false;
  const collect = (target: Buffer[]) => (chunkValue: Buffer | string): void => {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    outputBytes += chunk.byteLength;
    if (outputBytes > commandOutputLimit) {
      overflow = true;
      child.kill("SIGKILL");
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 120_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMilliseconds);
  const result = await new Promise<CommandResult>((resolve, reject) => {
    child.once("error", () => reject(new Error(`${options.label ?? "Command"} could not start.`)));
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  }).finally(() => clearTimeout(timeout));
  if (timedOut) {
    throw new Error(`${options.label ?? "Command"} timed out.`);
  }
  if (overflow) {
    throw new Error(`${options.label ?? "Command"} exceeded the bounded output limit.`);
  }
  assertSecretFree(result, secrets, options.label ?? "Command");
  if (result.exitCode !== 0 && options.allowFailure !== true) {
    const output = redact(`${result.stdout}\n${result.stderr}`.trim(), secrets);
    throw new Error(
      `${options.label ?? "Command"} failed with exit ${result.exitCode}.` +
        (output.length === 0 ? "" : `\n${output}`),
    );
  }
  return result;
}

function assertSecretFree(
  result: Pick<CommandResult, "stdout" | "stderr">,
  secrets: readonly string[],
  label: string,
): void {
  for (const secret of secrets) {
    if (result.stdout.includes(secret) || result.stderr.includes(secret)) {
      throw new Error(`${label} emitted a protected Host credential.`);
    }
  }
}

function redact(source: string, secrets: readonly string[]): string {
  let result = source;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join("<redacted>");
    }
  }
  return result;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function requireResource<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) {
    throw new Error(`${label} is unavailable.`);
  }
  return value;
}
