import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
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
const optInEnvironment = "VISTREA_RUN_IOS_REAL_VERTICAL";
const scenarioId = "demo.navigation.basic";
const requiredStableId = "demo.home.open_catalog";
const demoBundleId = "dev.vistrea.demo";
const commandOutputLimit = 8 * 1024 * 1024;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMilliseconds?: number;
  readonly allowFailure?: boolean;
  readonly secrets?: readonly string[];
  readonly label?: string;
}

interface SimulatorSelection {
  readonly runtimeIdentifier: string;
  readonly runtimeVersion: string;
  readonly deviceTypeIdentifier: string;
  readonly deviceTypeName: string;
}

interface SnapshotEvidence {
  readonly snapshotId: string;
  readonly scenarioId: string;
  readonly nodeCount: number;
  readonly screenshotHash: string;
  readonly screenshotByteSize: number;
}

interface AcceptanceResources {
  simulatorId: string | undefined;
  host: LocalHostHandle | undefined;
  studio: ChildProcess | undefined;
}

const skipReason = realVerticalSkipReason();

test(
  "the real iOS Demo persists one Snapshot for Studio, CLI, and Host reopen",
  {
    timeout: 15 * 60 * 1_000,
    ...(skipReason === undefined ? {} : { skip: skipReason }),
  },
  async (t) => {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-ios-vertical-"));
    const workspaceRoot = path.join(testRoot, "workspace");
    const derivedData = path.join(testRoot, "ios-derived-data");
    const studioScratch = path.join(testRoot, "studio-build");
    const resources: AcceptanceResources = {
      simulatorId: undefined,
      host: undefined,
      studio: undefined,
    };
    const knownSecrets: string[] = [];
    t.after(async () => {
      await cleanupResources(resources, knownSecrets);
      await fs.rm(testRoot, { recursive: true, force: true });
    });

    const validator = await createRepositoryProtocolValidator({ repositoryRoot });
    const simulator = await selectSimulator();
    const simulatorName = `Vistrea Vertical ${process.pid} ${Date.now()}`;
    resources.simulatorId = (
      await runCommand(
        "xcrun",
        [
          "simctl",
          "create",
          simulatorName,
          simulator.deviceTypeIdentifier,
          simulator.runtimeIdentifier,
        ],
        { label: "Simulator creation" },
      )
    ).stdout.trim();
    assert.match(resources.simulatorId, /^[0-9A-Fa-f-]{36}$/);

    await runCommand("xcrun", ["simctl", "boot", resources.simulatorId], {
      label: "Simulator boot",
    });
    await runCommand("xcrun", ["simctl", "bootstatus", resources.simulatorId, "-b"], {
      label: "Simulator boot readiness",
      timeoutMilliseconds: 120_000,
    });

    await runCommand(
      "xcodebuild",
      [
        "-quiet",
        "-project",
        path.join(repositoryRoot, "examples/ios/VistreaDemoApp/VistreaDemoApp.xcodeproj"),
        "-scheme",
        "VistreaDemoApp",
        "-configuration",
        "Debug",
        "-destination",
        `id=${resources.simulatorId}`,
        "-derivedDataPath",
        derivedData,
        "ONLY_ACTIVE_ARCH=YES",
        "build",
      ],
      {
        label: "iOS Demo Debug build",
        timeoutMilliseconds: 5 * 60 * 1_000,
      },
    );
    const demoApp = path.join(
      derivedData,
      "Build/Products/Debug-iphonesimulator/VistreaDemoApp.app",
    );
    assert.equal((await fs.stat(demoApp)).isDirectory(), true);
    await runCommand("xcrun", ["simctl", "install", resources.simulatorId, demoApp], {
      label: "iOS Demo installation",
    });

    resources.host = await startLocalHost({
      workspaceRoot,
      validator,
      applicationVersion: "0.0.0",
    });
    rememberHostSecrets(resources.host, knownSecrets);
    const firstApiToken = resources.host.api.bearerToken;
    const firstRuntimeToken = resources.host.runtime.authorizationToken;

    const launchEnvironment = cleanEnvironment({
      SIMCTL_CHILD_VISTREA_SCENARIO_ID: scenarioId,
      SIMCTL_CHILD_VISTREA_SCENARIO_PROFILE: "baseline",
      SIMCTL_CHILD_VISTREA_RUNTIME_HOST: resources.host.runtime.host,
      SIMCTL_CHILD_VISTREA_RUNTIME_PORT: String(resources.host.runtime.port),
      SIMCTL_CHILD_VISTREA_RUNTIME_TOKEN: resources.host.runtime.authorizationToken,
    });
    const launchResult = await runCommand(
      "xcrun",
      [
        "simctl",
        "launch",
        "--terminate-running-process",
        resources.simulatorId,
        demoBundleId,
      ],
      {
        environment: launchEnvironment,
        secrets: knownSecrets,
        label: "iOS Demo launch",
      },
    );
    assert.match(launchResult.stdout.trim(), /^dev\.vistrea\.demo: [1-9][0-9]*$/);
    assertSecretsAbsentFromText(launchResult.stdout, knownSecrets);
    assertSecretsAbsentFromText(launchResult.stderr, knownSecrets);

    await resources.host.waitForRuntime(60_000);
    assert.equal(resources.host.runtimeConnected, true);

    const capturedSnapshot = await captureSnapshotThroughApi(
      resources.host,
      knownSecrets,
    );
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
        { label: "Vistrea Studio binary lookup" },
      )
    ).stdout.trim();
    const studioExecutable = path.join(studioBinaryDirectory, "VistreaStudio");
    const studioProbeExecutable = path.join(
      studioBinaryDirectory,
      "VistreaStudioAcceptanceProbe",
    );
    await fs.access(studioExecutable, fs.constants.X_OK);
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
      label: "Studio acceptance probe",
    });
    assertSecretsAbsentFromText(studioProbe.stdout, knownSecrets);
    assertSecretsAbsentFromText(studioProbe.stderr, knownSecrets);
    const studioEvidence = asRecord(JSON.parse(studioProbe.stdout) as unknown, "Studio evidence");
    assert.equal(studioEvidence["snapshot_id"], evidence.snapshotId);
    assert.equal(studioEvidence["scenario_id"], scenarioId);
    assert.equal(studioEvidence["node_count"], evidence.nodeCount);
    assert.equal(studioEvidence["screenshot_hash"], evidence.screenshotHash);
    assert.equal(studioEvidence["screenshot_byte_count"], evidence.screenshotByteSize);
    assert.equal(studioEvidence["runtime_connected"], true);

    resources.studio = spawn(studioExecutable, [], {
      cwd: repositoryRoot,
      env: hostEnvironment,
      stdio: "ignore",
    });
    await waitForSpawn(resources.studio);
    const windowProbe = await buildWindowProbe(testRoot);
    const windowResult = await runCommand(windowProbe, [String(resources.studio.pid)], {
      label: "Studio WindowServer visibility probe",
      timeoutMilliseconds: 30_000,
    });
    assert.equal(windowResult.stdout.trim(), "visible");
    assert.equal(resources.studio.exitCode, null);

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
        "request_ios_vertical_acceptance",
        "--trace-id",
        "trace_ios_vertical_acceptance",
        "--non-interactive",
      ],
      {
        environment: hostEnvironment,
        secrets: knownSecrets,
        label: "Vistrea CLI Snapshot read",
      },
    );
    assertSecretsAbsentFromText(cliResult.stdout, knownSecrets);
    assertSecretsAbsentFromText(cliResult.stderr, knownSecrets);
    const cliEnvelope = asRecord(JSON.parse(cliResult.stdout) as unknown, "CLI envelope");
    assert.equal(cliEnvelope["error"], null);
    assert.deepEqual(cliEnvelope["data"], capturedSnapshot);

    await stopChild(resources.studio);
    resources.studio = undefined;
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
    await terminateAndDeleteSimulator(resources, knownSecrets);
    await assertNoSecretArtifacts(testRoot, knownSecrets);

    t.diagnostic(
      JSON.stringify({
        scenario_id: scenarioId,
        simulator_runtime: simulator.runtimeVersion,
        simulator_device: simulator.deviceTypeName,
        snapshot_id: evidence.snapshotId,
        node_count: evidence.nodeCount,
        required_stable_id: requiredStableId,
        screenshot_hash: evidence.screenshotHash,
        screenshot_byte_size: evidence.screenshotByteSize,
        canonical_snapshot: "passed",
        studio_production_probe: "passed",
        studio_windowserver_window: "visible",
        cli_identical_snapshot: "passed",
        production_reopen: "passed",
        credentials_rotated: "passed",
        secret_artifact_scan: "clean",
      }),
    );
  },
);

function realVerticalSkipReason(): string | undefined {
  if (process.env[optInEnvironment] !== "1") {
    return `Set ${optInEnvironment}=1 or use the dedicated package script to run this acceptance.`;
  }
  if (process.platform !== "darwin") {
    return "The real iOS vertical acceptance requires macOS.";
  }
  const xcodebuild = spawnSync("xcrun", ["--find", "xcodebuild"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (xcodebuild.status !== 0 || xcodebuild.stdout.trim().length === 0) {
    return "The real iOS vertical acceptance requires an active Xcode developer directory.";
  }
  const simulator = spawnSync("xcrun", ["--find", "simctl"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (simulator.status !== 0 || simulator.stdout.trim().length === 0) {
    return "The real iOS vertical acceptance requires CoreSimulator.";
  }
  return undefined;
}

async function selectSimulator(): Promise<SimulatorSelection> {
  const result = await runCommand("xcrun", ["simctl", "list", "runtimes", "--json"], {
    label: "Simulator runtime discovery",
  });
  const decoded = asRecord(JSON.parse(result.stdout) as unknown, "Simulator runtime list");
  const runtimes = asArray(decoded["runtimes"], "Simulator runtimes")
    .map((candidate) => asRecord(candidate, "Simulator runtime"))
    .filter(
      (runtime) =>
        runtime["isAvailable"] === true &&
        typeof runtime["identifier"] === "string" &&
        runtime["identifier"].includes(".iOS-"),
    )
    .sort((left, right) =>
      compareVersionStrings(String(right["version"]), String(left["version"])),
    );
  const runtime = runtimes[0];
  if (runtime === undefined) {
    throw new Error("No available iOS Simulator runtime is installed.");
  }
  const deviceTypes = asArray(runtime["supportedDeviceTypes"], "Simulator device types")
    .map((candidate) => asRecord(candidate, "Simulator device type"))
    .filter(
      (deviceType) =>
        deviceType["productFamily"] === "iPhone" &&
        typeof deviceType["identifier"] === "string" &&
        typeof deviceType["name"] === "string",
    );
  const deviceType =
    deviceTypes.find((candidate) => candidate["name"] === "iPhone 15 Pro") ??
    deviceTypes[0];
  if (deviceType === undefined) {
    throw new Error("The selected iOS Simulator runtime has no supported iPhone device type.");
  }
  return {
    runtimeIdentifier: String(runtime["identifier"]),
    runtimeVersion: String(runtime["version"]),
    deviceTypeIdentifier: String(deviceType["identifier"]),
    deviceTypeName: String(deviceType["name"]),
  };
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
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
    const body = redact(await response.text(), secrets);
    throw new Error(`Object read failed with HTTP ${response.status}: ${body}`);
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
    throw new Error(
      `${label} failed with HTTP ${response.status}: ${redact(body, secrets)}`,
    );
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
    `The real UIKit tree must contain ${requiredStableId}.`,
  );

  const screenshot = asRecord(snapshot["screenshot"], "Snapshot screenshot");
  const object = asRecord(screenshot["object"], "Screenshot ObjectRef");
  const screenshotHash = requireString(object["hash"], "Screenshot hash");
  const screenshotByteSize = requireSafeInteger(
    object["byte_size"],
    "Screenshot byte size",
  );
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

async function buildWindowProbe(testRoot: string): Promise<string> {
  const source = path.join(testRoot, "window-visibility-probe.swift");
  const executable = path.join(testRoot, "window-visibility-probe");
  await fs.writeFile(
    source,
    `import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let target = Int32(CommandLine.arguments[1]) else {
    exit(2)
}

let deadline = Date().addingTimeInterval(20)
repeat {
    if let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] {
        let visible = windows.contains { window in
            let owner = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
            let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue
            let onScreen = (window[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue
            let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue
            return owner == target && layer == 0 && onScreen == true && (alpha ?? 0) > 0
        }
        if visible {
            print("visible")
            exit(0)
        }
    }
    Thread.sleep(forTimeInterval: 0.2)
} while Date() < deadline

exit(1)
`,
    "utf8",
  );
  await runCommand("xcrun", ["swiftc", "-O", source, "-o", executable], {
    label: "WindowServer probe build",
  });
  return executable;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await Promise.race([
    once(child, "spawn").then(() => undefined),
    once(child, "error").then(() => {
      throw new Error("The native Studio process could not start.");
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
    delay(5_000).then(() => false),
  ]);
  if (!closed && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "close"), delay(5_000)]);
  }
}

async function terminateAndDeleteSimulator(
  resources: AcceptanceResources,
  secrets: readonly string[],
): Promise<void> {
  const simulatorId = resources.simulatorId;
  if (simulatorId === undefined) {
    return;
  }
  await runCommand("xcrun", ["simctl", "terminate", simulatorId, demoBundleId], {
    allowFailure: true,
    secrets,
    label: "iOS Demo termination",
  });
  await runCommand("xcrun", ["simctl", "shutdown", simulatorId], {
    allowFailure: true,
    secrets,
    label: "Simulator shutdown",
  });
  await runCommand("xcrun", ["simctl", "delete", simulatorId], {
    secrets,
    label: "Simulator deletion",
  });
  resources.simulatorId = undefined;
}

async function cleanupResources(
  resources: AcceptanceResources,
  secrets: readonly string[],
): Promise<void> {
  await stopChild(resources.studio);
  resources.studio = undefined;
  try {
    await resources.host?.close();
  } catch {
    // The primary assertion retains its failure; cleanup still releases the Simulator.
  }
  resources.host = undefined;
  const simulatorId = resources.simulatorId;
  if (simulatorId !== undefined) {
    await runCommand("xcrun", ["simctl", "terminate", simulatorId, demoBundleId], {
      allowFailure: true,
      secrets,
      label: "cleanup Demo termination",
    });
    await runCommand("xcrun", ["simctl", "shutdown", simulatorId], {
      allowFailure: true,
      secrets,
      label: "cleanup Simulator shutdown",
    });
    await runCommand("xcrun", ["simctl", "delete", simulatorId], {
      allowFailure: true,
      secrets,
      label: "cleanup Simulator deletion",
    });
    resources.simulatorId = undefined;
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
      key.startsWith("SIMCTL_CHILD_VISTREA_")
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
  const child = spawn(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.environment ?? cleanEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    child.once("error", () => {
      reject(new Error(`${options.label ?? "Command"} could not start.`));
    });
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  }).finally(() => clearTimeout(timeout));
  const secrets = options.secrets ?? [];
  if (timedOut) {
    throw new Error(`${options.label ?? "Command"} timed out.`);
  }
  if (overflow) {
    throw new Error(`${options.label ?? "Command"} exceeded the bounded output limit.`);
  }
  if (result.exitCode !== 0 && options.allowFailure !== true) {
    const output = redact(`${result.stdout}\n${result.stderr}`.trim(), secrets);
    throw new Error(
      `${options.label ?? "Command"} failed with exit ${result.exitCode}.` +
        (output.length === 0 ? "" : `\n${output}`),
    );
  }
  return result;
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

function assertSecretsAbsentFromText(source: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    assert.equal(source.includes(secret), false, "Command output contained a Host credential.");
  }
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
        assert.equal(
          block.indexOf(secret),
          -1,
          `A generated acceptance artifact contains a Host credential: ${filename}`,
        );
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
