import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { startLocalHost, type LocalHostHandle } from "../../apps/host/index.js";
import {
  PROTOCOL_SCHEMA_IDS,
  type ProtocolValidator,
} from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";

const repositoryRoot = process.cwd();
const optInEnvironment = "VISTREA_RUN_ANDROID_REAL_VERTICAL";
const scenarioId = "demo.navigation.basic";
const scenarioProfile = "baseline";
const requiredStableId = "demo.home.open_catalog";
const debugPackage = "dev.vistrea.demo.debug";
const debugComponent = `${debugPackage}/dev.vistrea.demo.MainActivity`;
const tokenRelativePath = "files/vistrea/runtime-token";
const tokenTemporaryRelativePath = `${tokenRelativePath}.tmp`;
const androidHome =
  process.env["ANDROID_HOME"] ?? path.join(process.env["HOME"] ?? "", "Library/Android/sdk");
const adbPath = path.join(androidHome, "platform-tools/adb");
const emulatorPath = path.join(androidHome, "emulator/emulator");
const demoRoot = path.join(repositoryRoot, "examples/android/VistreaDemoApp");
const gradleWrapper = path.join(demoRoot, "gradlew");
const tokenInstaller = path.join(demoRoot, "tools/install-runtime-token.sh");
const debugApk = path.join(demoRoot, "app/build/outputs/apk/debug/app-debug.apk");
const commandOutputLimit = 16 * 1024 * 1024;

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

interface SnapshotEvidence {
  readonly snapshotId: string;
  readonly scenarioId: string;
  readonly nodeCount: number;
  readonly screenshotHash: string;
  readonly screenshotByteSize: number;
}

interface AcceptanceResources {
  emulator: ChildProcess | undefined;
  emulatorSerial: string | undefined;
  reversePort: number | undefined;
  host: LocalHostHandle | undefined;
}

const selectedAvd = discoverApi36Avd();
const skipReason = realVerticalSkipReason(selectedAvd);

test(
  "the real Android Demo persists one Snapshot for Studio, CLI, and Host reopen",
  {
    timeout: 15 * 60 * 1_000,
    ...(skipReason === undefined ? {} : { skip: skipReason }),
  },
  async (t) => {
    assert.ok(selectedAvd !== undefined);
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-android-vertical-"));
    const workspaceRoot = path.join(testRoot, "workspace");
    const studioScratch = path.join(testRoot, "studio-build");
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
    assert.equal((await fs.stat(debugApk)).isFile(), true);

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
    await runAdb(serial, ["logcat", "-c"], { label: "Android log reset" });

    resources.host = await startLocalHost({
      workspaceRoot,
      validator,
      applicationVersion: "0.0.0",
    });
    rememberHostSecrets(resources.host, knownSecrets);
    const firstApiToken = resources.host.api.bearerToken;
    const firstRuntimeToken = resources.host.runtime.authorizationToken;

    resources.reversePort = resources.host.runtime.port;
    await runAdb(
      serial,
      [
        "reverse",
        `tcp:${resources.host.runtime.port}`,
        `tcp:${resources.host.runtime.port}`,
      ],
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
    const tokenMode = await runAsShell(
      serial,
      `stat -c %a ${tokenRelativePath}`,
      knownSecrets,
      "one-shot token mode check",
    );
    assert.equal(tokenMode.stdout.trim(), "600");
    const tokenSize = await runAsShell(
      serial,
      `stat -c %s ${tokenRelativePath}`,
      knownSecrets,
      "one-shot token size check",
    );
    assert.equal(tokenSize.stdout.trim(), String(firstRuntimeToken.length));

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
        forbiddenEnvironmentSecrets: [firstRuntimeToken],
        timeoutMilliseconds: 60_000,
        label: "Android Demo Scenario launch",
      },
    );
    assert.match(launch.stdout, /Status:\s+ok/);
    await resources.host.waitForRuntime(60_000);
    assert.equal(resources.host.runtimeConnected, true);
    await assertOneShotTokenConsumed(serial, knownSecrets);

    const capturedSnapshot = await captureSnapshotThroughApi(resources.host, knownSecrets);
    const evidence = validateSnapshot(capturedSnapshot, validator);
    const screenshotBytes = await getObjectThroughApi(
      resources.host,
      evidence.screenshotHash,
      knownSecrets,
    );
    validatePngObject(screenshotBytes, evidence);

    await runCommand(
      "swift",
      [
        "build",
        "--package-path",
        path.join(repositoryRoot, "apps/studio-macos"),
        "--scratch-path",
        studioScratch,
        "-c",
        "release",
      ],
      {
        secrets: knownSecrets,
        label: "Vistrea Studio Release build",
        timeoutMilliseconds: 5 * 60 * 1_000,
      },
    );
    const studioBinaryDirectory = (
      await runCommand(
        "swift",
        [
          "build",
          "--package-path",
          path.join(repositoryRoot, "apps/studio-macos"),
          "--scratch-path",
          studioScratch,
          "-c",
          "release",
          "--show-bin-path",
        ],
        { secrets: knownSecrets, label: "Vistrea Studio binary lookup" },
      )
    ).stdout.trim();
    const studioProbeExecutable = path.join(
      studioBinaryDirectory,
      "VistreaStudioAcceptanceProbe",
    );
    await fs.access(studioProbeExecutable, fs.constants.X_OK);
    const hostEnvironment = cleanEnvironment({
      VISTREA_HOST_URL: resources.host.api.baseUrl,
      VISTREA_HOST_TOKEN: resources.host.api.bearerToken,
    });
    const studioProbe = await runCommand(studioProbeExecutable, [], {
      environment: {
        ...hostEnvironment,
        VISTREA_SNAPSHOT_ID: evidence.snapshotId,
      },
      secrets: knownSecrets,
      forbiddenEnvironmentSecrets: [firstRuntimeToken],
      label: "Studio Android Snapshot acceptance probe",
    });
    const studioEvidence = asRecord(JSON.parse(studioProbe.stdout) as unknown, "Studio evidence");
    assert.equal(studioEvidence["snapshot_id"], evidence.snapshotId);
    assert.equal(studioEvidence["scenario_id"], scenarioId);
    assert.equal(studioEvidence["node_count"], evidence.nodeCount);
    assert.equal(studioEvidence["screenshot_hash"], evidence.screenshotHash);
    assert.equal(studioEvidence["screenshot_byte_count"], evidence.screenshotByteSize);
    assert.equal(studioEvidence["runtime_connected"], true);

    const cliResult = await runCommand(
      process.execPath,
      [
        path.join(repositoryRoot, ".build/typescript/integrations/cli/main.js"),
        "snapshot",
        "get",
        evidence.snapshotId,
        "--format",
        "json",
        "--request-id",
        "request_android_vertical_acceptance",
        "--trace-id",
        "trace_android_vertical_acceptance",
        "--non-interactive",
      ],
      {
        environment: hostEnvironment,
        secrets: knownSecrets,
        forbiddenEnvironmentSecrets: [firstRuntimeToken],
        label: "Vistrea CLI Android Snapshot read",
      },
    );
    const cliEnvelope = asRecord(JSON.parse(cliResult.stdout) as unknown, "CLI envelope");
    assert.equal(cliEnvelope["error"], null);
    assert.deepEqual(cliEnvelope["data"], capturedSnapshot);

    const packageDump = await runAdb(serial, ["shell", "dumpsys", "package", debugPackage], {
      secrets: knownSecrets,
      label: "Android package dumpsys",
    });
    const activityDump = await runAdb(serial, ["shell", "dumpsys", "activity", "activities"], {
      secrets: knownSecrets,
      label: "Android activity dumpsys",
    });
    const logcat = await runAdb(serial, ["logcat", "-d", "-v", "threadtime"], {
      secrets: knownSecrets,
      label: "Android Runtime logcat capture",
    });
    assertSecretFree(packageDump, knownSecrets, "dumpsys package");
    assertSecretFree(activityDump, knownSecrets, "dumpsys activity");
    assertSecretFree(logcat, knownSecrets, "logcat");

    await resources.host.close();
    resources.host = undefined;
    resources.host = await startLocalHost({
      workspaceRoot,
      validator,
      applicationVersion: "0.0.0",
    });
    rememberHostSecrets(resources.host, knownSecrets);
    if (
      resources.host.api.bearerToken === firstApiToken ||
      resources.host.runtime.authorizationToken === firstRuntimeToken
    ) {
      throw new Error("The reopened Host did not rotate every per-run credential.");
    }
    const reopenedSnapshot = await getSnapshotThroughApi(
      resources.host,
      evidence.snapshotId,
      knownSecrets,
    );
    assert.deepEqual(reopenedSnapshot, capturedSnapshot);
    const reopenedScreenshot = await getObjectThroughApi(
      resources.host,
      evidence.screenshotHash,
      knownSecrets,
    );
    assert.deepEqual(reopenedScreenshot, screenshotBytes);

    await resources.host.close();
    resources.host = undefined;
    await stopDedicatedEmulator(resources, knownSecrets);
    await assertNoSecretArtifacts(testRoot, knownSecrets);
    await assertFileExcludesSecrets(
      debugApk,
      knownSecrets.map((secret) => Buffer.from(secret, "utf8")),
    );

    t.diagnostic(
      JSON.stringify({
        scenario_id: scenarioId,
        emulator_target: selectedAvd.target,
        snapshot_id: evidence.snapshotId,
        node_count: evidence.nodeCount,
        required_stable_id: requiredStableId,
        screenshot_hash: evidence.screenshotHash,
        screenshot_byte_size: evidence.screenshotByteSize,
        canonical_snapshot: "passed",
        one_shot_token: "consumed",
        studio_production_probe: "passed",
        cli_identical_snapshot: "passed",
        production_reopen: "passed",
        credentials_rotated: "passed",
        dumpsys_logcat_secret_scan: "clean",
        generated_artifact_secret_scan: "clean",
      }),
    );
  },
);

function realVerticalSkipReason(avd: AndroidAvd | undefined): string | undefined {
  if (process.env[optInEnvironment] !== "1") {
    return `Set ${optInEnvironment}=1 or use the dedicated package script to run this acceptance.`;
  }
  if (process.platform !== "darwin") {
    return "The complete Android vertical acceptance currently requires macOS for the Studio probe.";
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
  const swift = spawnSync("xcrun", ["--find", "swift"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (swift.status !== 0 || swift.stdout.trim().length === 0) {
    return "The macOS Studio acceptance probe requires the Xcode Swift toolchain.";
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
    const target = /^target=(android-([0-9]+(?:\.[0-9]+)?))$/mu.exec(
      readFileSync(iniPath, "utf8"),
    );
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
  for (let port = 5580; port <= 5680; port += 2) {
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
      const api = await runAdb(serial, ["shell", "getprop", "ro.build.version.sdk"], {
        label: "Android API level",
      });
      const apiLevel = Number.parseInt(api.stdout.trim(), 10);
      assert.equal(Number.isInteger(apiLevel) && apiLevel >= 36, true);
      return;
    }
    await delay(1_000);
  }
  throw new Error("The dedicated Android API 36+ emulator did not finish booting.");
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

async function getSnapshotThroughApi(
  host: LocalHostHandle,
  snapshotId: string,
  secrets: readonly string[],
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${host.api.baseUrl}/v1/snapshots/${encodeURIComponent(snapshotId)}`,
    { headers: { authorization: `Bearer ${host.api.bearerToken}` } },
  );
  return await readJsonResponse(response, 200, "Snapshot read", secrets);
}

async function getObjectThroughApi(
  host: LocalHostHandle,
  hash: string,
  secrets: readonly string[],
): Promise<Buffer> {
  const response = await fetch(
    `${host.api.baseUrl}/v1/objects/${encodeURIComponent(hash)}`,
    { headers: { authorization: `Bearer ${host.api.bearerToken}` } },
  );
  if (response.status !== 200) {
    throw new Error(
      `Object read failed with HTTP ${response.status}: ${redact(await response.text(), secrets)}`,
    );
  }
  assert.equal(response.headers.get("etag"), `"${hash}"`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
  return bytes;
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

function validateSnapshot(
  snapshot: Record<string, unknown>,
  validator: ProtocolValidator,
): SnapshotEvidence {
  validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, snapshot);
  const snapshotId = requireString(snapshot["snapshot_id"], "Snapshot ID");
  const extensions = asRecord(snapshot["extensions"], "Snapshot extensions");
  const capturedScenarioId = requireString(
    extensions["vistrea.scenario_id"],
    "Snapshot Scenario ID",
  );
  assert.equal(capturedScenarioId, scenarioId);
  const nodes = asArray(snapshot["trees"], "Snapshot trees").flatMap((treeValue) => {
    const tree = asRecord(treeValue, "Snapshot tree");
    const payload = asRecord(tree["payload"], "Snapshot tree payload");
    return asArray(payload["inline_nodes"], "Snapshot inline nodes").map((node) =>
      asRecord(node, "Snapshot UI node"),
    );
  });
  assert.equal(
    nodes.some((node) => node["stable_id"] === requiredStableId),
    true,
    `The real Android View tree must contain ${requiredStableId}.`,
  );
  const screenshot = asRecord(snapshot["screenshot"], "Snapshot screenshot");
  const object = asRecord(screenshot["object"], "Screenshot ObjectRef");
  const screenshotHash = requireString(object["hash"], "Screenshot hash");
  const screenshotByteSize = requireSafeInteger(object["byte_size"], "Screenshot byte size");
  assert.equal(object["media_type"], "image/png");
  assert.equal(object["compression"], "none");
  return {
    snapshotId,
    scenarioId: capturedScenarioId,
    nodeCount: nodes.length,
    screenshotHash,
    screenshotByteSize,
  };
}

function validatePngObject(bytes: Buffer, evidence: SnapshotEvidence): void {
  assert.equal(bytes.byteLength, evidence.screenshotByteSize);
  assert.equal(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    evidence.screenshotHash,
  );
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
}

async function assertOneShotTokenConsumed(
  serial: string,
  secrets: readonly string[],
): Promise<void> {
  const result = await runAsShell(
    serial,
    `test ! -e ${tokenRelativePath} && test ! -e ${tokenTemporaryRelativePath}`,
    secrets,
    "one-shot token consumption check",
  );
  assert.equal(result.exitCode, 0);
}

async function runAsShell(
  serial: string,
  command: string,
  secrets: readonly string[],
  label: string,
): Promise<CommandResult> {
  return await runAdb(
    serial,
    ["shell", `run-as ${debugPackage} sh -c 'cd \"$HOME\"; ${command}'`],
    { secrets, label },
  );
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

function rememberHostSecrets(host: LocalHostHandle, target: string[]): void {
  target.push(host.api.bearerToken, host.runtime.authorizationToken);
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

async function assertNoSecretArtifacts(
  root: string,
  secrets: readonly string[],
): Promise<void> {
  const encoded = secrets.map((secret) => Buffer.from(secret, "utf8"));
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(candidate);
      } else if (entry.isFile()) {
        await assertFileExcludesSecrets(candidate, encoded);
      }
    }
  }
}

async function assertFileExcludesSecrets(
  filename: string,
  secrets: readonly Buffer[],
): Promise<void> {
  const maximumSecretBytes = Math.max(0, ...secrets.map((secret) => secret.byteLength));
  const handle = await fs.open(filename, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      const block = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      for (const secret of secrets) {
        if (block.indexOf(secret) >= 0) {
          throw new Error(`A generated acceptance artifact contains a Host credential: ${filename}`);
        }
      }
      const carryLength = Math.min(Math.max(0, maximumSecretBytes - 1), block.byteLength);
      carry = Buffer.from(block.subarray(block.byteLength - carryLength));
    }
  } finally {
    await handle.close();
  }
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireResource<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) {
    throw new Error(`${label} is unavailable.`);
  }
  return value;
}
