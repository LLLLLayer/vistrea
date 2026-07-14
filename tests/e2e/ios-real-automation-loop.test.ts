import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { startLocalHost, type LocalHostHandle } from "../../apps/host/index.js";
import { PROTOCOL_SCHEMA_IDS, type RuntimeSnapshot } from "../../data/api/index.js";
import { MemoryDataStore, createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { AutomationEngine, WdaAutomationProvider } from "../../engine/automation/index.js";
import { ExplorationEngine, ScreenGraphEngine } from "../../engine/exploration/index.js";

const repositoryRoot = process.cwd();
const optInEnvironment = "VISTREA_RUN_IOS_REAL_AUTOMATION";
/**
 * Path to a WebDriverAgent checkout (github.com/appium/WebDriverAgent). The
 * acceptance boots the XCUITest-hosted driver against its dedicated
 * Simulator; without the project the test is skipped, never faked.
 */
const wdaProjectEnvironment = "VISTREA_WDA_PROJECT";
const scenarioId = "demo.navigation.basic";
const storefrontScenarioId = "demo.store.navigation";
const searchScenarioId = "demo.store.search";
const sheetScenarioId = "demo.store.sheet";
const homeStableId = "demo.home.open_catalog";
const catalogStableId = "demo.catalog.item_primary";
const demoBundleId = "dev.vistrea.demo";
const wdaPort = 8100;
const commandOutputLimit = 8 * 1024 * 1024;
const settleMilliseconds = 1_500;

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
  readonly deviceTypeIdentifier: string;
}

interface AcceptanceResources {
  simulatorId: string | undefined;
  host: LocalHostHandle | undefined;
  wdaRunner: ChildProcess | undefined;
}

const skipReason = realAutomationSkipReason();

test(
  "real WDA automation walks the navigation scenario into a deduplicated Screen Graph",
  {
    timeout: 20 * 60 * 1_000,
    ...(skipReason === undefined ? {} : { skip: skipReason }),
  },
  async (t) => {
    const wdaProject = process.env[wdaProjectEnvironment] as string;
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-ios-automation-"));
    const workspaceRoot = path.join(testRoot, "workspace");
    const derivedData = path.join(testRoot, "ios-derived-data");
    const wdaDerivedData = path.join(testRoot, "wda-derived-data");
    const resources: AcceptanceResources = {
      simulatorId: undefined,
      host: undefined,
      wdaRunner: undefined,
    };
    const knownSecrets: string[] = [];
    t.after(async () => {
      await cleanupResources(resources, knownSecrets);
      await fs.rm(testRoot, { recursive: true, force: true });
    });

    const validator = await createRepositoryProtocolValidator({ repositoryRoot });
    const simulator = await selectSimulator();
    const simulatorName = `Vistrea Automation ${process.pid} ${Date.now()}`;
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
    // A freshly created simulator's first boot migrates and seeds system
    // state; under host load that regularly outlives two minutes without
    // being unhealthy, so the window matches a loaded machine.
    await runCommand("xcrun", ["simctl", "bootstatus", resources.simulatorId, "-b"], {
      label: "Simulator boot readiness",
      timeoutMilliseconds: 360_000,
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
      { label: "iOS Demo Debug build", timeoutMilliseconds: 5 * 60 * 1_000 },
    );
    const demoApp = path.join(
      derivedData,
      "Build/Products/Debug-iphonesimulator/VistreaDemoApp.app",
    );
    await runCommand("xcrun", ["simctl", "install", resources.simulatorId, demoApp], {
      label: "iOS Demo installation",
    });

    // Boot WebDriverAgent as the XCUITest-hosted driver on the dedicated
    // Simulator and wait until its HTTP status endpoint is ready.
    resources.wdaRunner = spawn(
      "xcodebuild",
      [
        "-project",
        wdaProject,
        "-scheme",
        "WebDriverAgentRunner",
        "-destination",
        `id=${resources.simulatorId}`,
        "-derivedDataPath",
        wdaDerivedData,
        `USE_PORT=${wdaPort}`,
        "test",
      ],
      {
        cwd: repositoryRoot,
        env: cleanEnvironment(),
        stdio: "ignore",
      },
    );
    await waitForSpawn(resources.wdaRunner, "WebDriverAgent could not start.");
    const wdaBaseUrl = `http://127.0.0.1:${wdaPort}`;
    await waitForWdaReady(wdaBaseUrl, resources);

    resources.host = await startLocalHost({
      workspaceRoot,
      validator,
      applicationVersion: "0.0.0",
    });
    knownSecrets.push(
      resources.host.api.bearerToken,
      resources.host.runtime.authorizationToken,
    );
    const launchEnvironment = cleanEnvironment({
      SIMCTL_CHILD_VISTREA_SCENARIO_ID: scenarioId,
      SIMCTL_CHILD_VISTREA_SCENARIO_PROFILE: "baseline",
      SIMCTL_CHILD_VISTREA_RUNTIME_HOST: resources.host.runtime.host,
      SIMCTL_CHILD_VISTREA_RUNTIME_PORT: String(resources.host.runtime.port),
      SIMCTL_CHILD_VISTREA_RUNTIME_TOKEN: resources.host.runtime.authorizationToken,
    });
    const launchResult = await runCommand(
      "xcrun",
      ["simctl", "launch", "--terminate-running-process", resources.simulatorId, demoBundleId],
      { environment: launchEnvironment, secrets: knownSecrets, label: "iOS Demo launch" },
    );
    assert.match(launchResult.stdout.trim(), /^dev\.vistrea\.demo: [1-9][0-9]*$/);
    await resources.host.waitForRuntime(60_000);
    assert.equal(resources.host.runtimeConnected, true);
    await delay(settleMilliseconds);

    // Home Snapshot and its Screen State observation through the product API.
    const homeSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, homeStableId),
    );
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

    // A real user-level tap through WebDriverAgent, resolved from the
    // persisted Snapshot in logical points.
    const automationWorkspace = new MemoryDataStore({
      validator,
      clock: { now: () => new Date().toISOString() },
    });
    const persistForResolution = (snapshot: Record<string, unknown>): void => {
      const copy = { ...snapshot };
      delete copy["screenshot"];
      const unit = automationWorkspace.beginUnitOfWork("write");
      unit.snapshots.put(copy as unknown as RuntimeSnapshot);
      unit.commit();
    };
    persistForResolution(homeSnapshot);
    const automation = new AutomationEngine({
      workspace: automationWorkspace,
      validator,
      providers: [new WdaAutomationProvider({ baseUrl: wdaBaseUrl })],
    });
    const session = automation.openSession({
      provider_id: "ios-wda",
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
    await delay(settleMilliseconds);

    const catalogSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, catalogStableId),
    );
    assert.equal(hasStableId(catalogSnapshot, catalogStableId), true);
    assert.notEqual(
      ScreenGraphEngine.computeStructuralIdentity(
        catalogSnapshot as unknown as RuntimeSnapshot,
      ).layout_digest,
      ScreenGraphEngine.computeStructuralIdentity(
        homeSnapshot as unknown as RuntimeSnapshot,
      ).layout_digest,
    );
    persistForResolution(catalogSnapshot);
    const catalogObserved = await postJson(
      resources.host,
      "/v1/screen-graph/state-observations",
      { snapshot_id: catalogSnapshot["snapshot_id"], title: "Catalog" },
      knownSecrets,
    );
    assert.equal(catalogObserved["created"], true);
    const catalogState = asRecord(catalogObserved["screen_state"], "Catalog Screen State");
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

    // The interactive left-edge pop gesture is the genuine iOS back; the
    // returned Home must deduplicate under one structural identity.
    const backResult = await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "back",
      intent: { requested_effect: "Return to Home" },
    });
    assert.equal(backResult.outcome, "uncertain");
    await delay(settleMilliseconds);
    const homeAgainSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, homeStableId),
    );
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
    await postJson(
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


    // automation.safety on the real Simulator: a dangerous-classified action
    // is denied without a confirmation token, and the bound token authorizes
    // it exactly once for real.
    const dangerousCommand = {
      automation_session_id: session.automation_session_id,
      kind: "tap" as const,
      target: { stable_id: homeStableId },
      expected_snapshot_id: homeSnapshot["snapshot_id"] as string,
      intent: {
        requested_effect: "Open the catalog under a dangerous classification",
        caller_classification: "dangerous" as const,
      },
    };
    const denied = await automation.execute(dangerousCommand);
    assert.equal(denied.authorization.decision, "deny");
    assert.equal(denied.outcome, "blocked");
    const stillHome = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, homeStableId),
    );
    assert.equal(hasStableId(stillHome, catalogStableId), false);

    const confirmationToken = automation.confirmationTokenFor(dangerousCommand);
    const confirmed = await automation.execute({
      ...dangerousCommand,
      intent: { ...dangerousCommand.intent, confirmation_token: confirmationToken },
    });
    assert.equal(confirmed.authorization.decision, "allow_once");
    assert.equal(confirmed.outcome, "uncertain");
    await delay(settleMilliseconds);
    const confirmedCatalog = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, catalogStableId),
    );
    assert.equal(hasStableId(confirmedCatalog, catalogStableId), true);

    // Physically return so exploration starts from Home as before.
    await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "back",
      intent: { requested_effect: "Return to Home after the confirmed action" },
    });
    await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, homeStableId),
    );

    // Deterministic exploration drives the same real Simulator autonomously.
    const hostHandle = resources.host;
    const graphEngine = new ScreenGraphEngine({ workspace: automationWorkspace, validator });
    const exploration = new ExplorationEngine({
      workspace: automationWorkspace,
      capture: {
        captureSnapshot: async (): Promise<RuntimeSnapshot> => {
          const captured = await captureSnapshotThroughApi(hostHandle, knownSecrets);
          persistForResolution(captured);
          const copy = { ...captured };
          delete copy["screenshot"];
          return copy as unknown as RuntimeSnapshot;
        },
      },
      automation,
      graph: graphEngine,
    });
    const report = await exploration.explore({
      automation_session_id: session.automation_session_id,
      maximum_actions: 8,
      settle_milliseconds: settleMilliseconds,
      // The in-app Inspector launcher is Vistrea tooling and "BackButton" is
      // UIKit's own navigation-bar chrome: neither is application frontier,
      // and physical back is already the engine's return mechanism.
      excluded_stable_ids: ["vistrea.inspector.capture", "BackButton"],
    });
    if (report.discovered_state_ids.length !== 3 || report.stopped_reason !== "frontier_exhausted") {
      console.error(`Exploration evidence: ${JSON.stringify(report)}`);
    }
    assert.equal(report.stopped_reason, "frontier_exhausted");
    assert.equal(report.discovered_state_ids.length, 3);
    const version = exploration.tagGraphVersion({
      project_id: runtimeContext["project_id"] as string,
      application_id: runtimeContext["application_id"] as string,
      tag_name: "acceptance/explored",
    });
    assert.equal(version.state_count, 3);

    // Second walk: the storefront scenario proves exploration scales past a
    // toy graph. The same process relaunches into the deep scenario, the walk
    // exhausts a four-screen frontier, and the one materialized graph absorbs
    // both scenarios because they share the application identity.
    const storefrontEnvironment = cleanEnvironment({
      SIMCTL_CHILD_VISTREA_SCENARIO_ID: storefrontScenarioId,
      SIMCTL_CHILD_VISTREA_SCENARIO_PROFILE: "baseline",
      SIMCTL_CHILD_VISTREA_RUNTIME_HOST: resources.host.runtime.host,
      SIMCTL_CHILD_VISTREA_RUNTIME_PORT: String(resources.host.runtime.port),
      SIMCTL_CHILD_VISTREA_RUNTIME_TOKEN: resources.host.runtime.authorizationToken,
    });
    const storefrontLaunch = await runCommand(
      "xcrun",
      ["simctl", "launch", "--terminate-running-process", resources.simulatorId, demoBundleId],
      {
        environment: storefrontEnvironment,
        secrets: knownSecrets,
        label: "iOS Demo storefront launch",
      },
    );
    assert.match(storefrontLaunch.stdout.trim(), /^dev\.vistrea\.demo: [1-9][0-9]*$/);
    await resources.host.waitForRuntime(60_000);
    assert.equal(resources.host.runtimeConnected, true);
    await delay(settleMilliseconds);
    const storefrontSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, "demo.store.catalog_item_primary"),
    );
    validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, storefrontSnapshot);
    const storefrontReport = await exploration.explore({
      automation_session_id: session.automation_session_id,
      maximum_actions: 16,
      settle_milliseconds: settleMilliseconds,
      excluded_stable_ids: ["vistrea.inspector.capture", "BackButton"],
    });
    if (
      storefrontReport.discovered_state_ids.length !== 4 ||
      storefrontReport.stopped_reason !== "frontier_exhausted"
    ) {
      console.error(`Storefront exploration evidence: ${JSON.stringify(storefrontReport)}`);
    }
    assert.equal(storefrontReport.stopped_reason, "frontier_exhausted");
    assert.equal(storefrontReport.discovered_state_ids.length, 4);
    const storefrontVersion = exploration.tagGraphVersion({
      project_id: runtimeContext["project_id"] as string,
      application_id: runtimeContext["application_id"] as string,
      tag_name: "acceptance/explored-store",
    });
    assert.equal(storefrontVersion.state_count, 7);

    // Provider actions that are easy to fake at the wire boundary still need
    // real UIKit evidence. Type and clear the canonical search field, then
    // prove both structural variants through fresh Runtime captures.
    const searchEnvironment = cleanEnvironment({
      SIMCTL_CHILD_VISTREA_SCENARIO_ID: searchScenarioId,
      SIMCTL_CHILD_VISTREA_SCENARIO_PROFILE: "baseline",
      SIMCTL_CHILD_VISTREA_RUNTIME_HOST: resources.host.runtime.host,
      SIMCTL_CHILD_VISTREA_RUNTIME_PORT: String(resources.host.runtime.port),
      SIMCTL_CHILD_VISTREA_RUNTIME_TOKEN: resources.host.runtime.authorizationToken,
    });
    await runCommand(
      "xcrun",
      ["simctl", "launch", "--terminate-running-process", resources.simulatorId, demoBundleId],
      {
        environment: searchEnvironment,
        secrets: knownSecrets,
        label: "iOS Demo search launch",
      },
    );
    await resources.host.waitForRuntime(60_000);
    await delay(settleMilliseconds);
    const searchSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, "demo.search.field"),
    );
    persistForResolution(searchSnapshot);
    const typedSearch = await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "type_text",
      target: { stable_id: "demo.search.field" },
      expected_snapshot_id: searchSnapshot["snapshot_id"] as string,
      intent: { requested_effect: "Filter the catalog for Aurora" },
      payload: { text_input: "Aurora" },
    });
    assert.equal(typedSearch.outcome, "uncertain");
    await delay(settleMilliseconds);
    const filteredSearchSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, "demo.state.search-filtered.root"),
    );
    persistForResolution(filteredSearchSnapshot);
    const clearedSearch = await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "clear_text",
      target: { stable_id: "demo.search.field" },
      expected_snapshot_id: filteredSearchSnapshot["snapshot_id"] as string,
      intent: { requested_effect: "Restore the unfiltered catalog" },
    });
    assert.equal(clearedSearch.outcome, "uncertain");
    await delay(settleMilliseconds);
    const clearedSearchSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, "demo.state.search.root"),
    );
    assert.equal(hasStableId(clearedSearchSnapshot, "demo.state.search-filtered.root"), false);

    // Targeted dismiss is distinct from system-alert dismissal: it must tap
    // the Runtime-resolved control and remove the in-tree overlay.
    const sheetEnvironment = cleanEnvironment({
      SIMCTL_CHILD_VISTREA_SCENARIO_ID: sheetScenarioId,
      SIMCTL_CHILD_VISTREA_SCENARIO_PROFILE: "baseline",
      SIMCTL_CHILD_VISTREA_RUNTIME_HOST: resources.host.runtime.host,
      SIMCTL_CHILD_VISTREA_RUNTIME_PORT: String(resources.host.runtime.port),
      SIMCTL_CHILD_VISTREA_RUNTIME_TOKEN: resources.host.runtime.authorizationToken,
    });
    await runCommand(
      "xcrun",
      ["simctl", "launch", "--terminate-running-process", resources.simulatorId, demoBundleId],
      {
        environment: sheetEnvironment,
        secrets: knownSecrets,
        label: "iOS Demo sheet launch",
      },
    );
    await resources.host.waitForRuntime(60_000);
    await delay(settleMilliseconds);
    const sheetBaseSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, "demo.sheet.open"),
    );
    persistForResolution(sheetBaseSnapshot);
    await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "tap",
      target: { stable_id: "demo.sheet.open" },
      expected_snapshot_id: sheetBaseSnapshot["snapshot_id"] as string,
      intent: { requested_effect: "Open sort options" },
    });
    await delay(settleMilliseconds);
    const sheetOpenSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, "demo.sheet.dismiss"),
    );
    persistForResolution(sheetOpenSnapshot);
    const dismissedSheet = await automation.execute({
      automation_session_id: session.automation_session_id,
      kind: "dismiss",
      target: { stable_id: "demo.sheet.dismiss" },
      expected_snapshot_id: sheetOpenSnapshot["snapshot_id"] as string,
      intent: { requested_effect: "Dismiss sort options" },
    });
    assert.equal(dismissedSheet.outcome, "uncertain");
    await delay(settleMilliseconds);
    const sheetDismissedSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, "demo.state.sheet-base.root"),
    );
    assert.equal(hasStableId(sheetDismissedSnapshot, "demo.sheet.container"), false);

    automation.closeSession(session.automation_session_id);
    await resources.host.close();
    resources.host = undefined;

    t.diagnostic(
      JSON.stringify({
        scenario_id: scenarioId,
        home_snapshot_id: homeSnapshot["snapshot_id"],
        catalog_snapshot_id: catalogSnapshot["snapshot_id"],
        home_state_id: homeState["screen_state_id"],
        catalog_state_id: catalogState["screen_state_id"],
        real_tap: "uncertain-then-verified",
        real_back: "edge-pop-deduplicated",
        exploration_states: report.discovered_state_ids.length,
        storefront_states: storefrontReport.discovered_state_ids.length,
        storefront_actions: storefrontReport.action_count,
        storefront_version_tag: storefrontVersion.tag_name,
        clear_text: "real-input-then-structure-verified",
        dismiss: "real-input-then-overlay-removal-verified",
        exploration_actions: report.action_count,
        exploration_version_tag: version.tag_name,
      }),
    );
  },
);

/**
 * Polls real captures until the screen settles into the expected structure.
 * Cold-start navigation regularly outlasts one fixed settle delay, so the
 * acceptance waits for evidence; on deadline it returns the last capture so
 * the caller's assertions fail with the actually observed screen.
 */
async function captureUntil(
  host: LocalHostHandle,
  secrets: readonly string[],
  predicate: (snapshot: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const snapshot = await captureSnapshotThroughApi(host, secrets);
    if (predicate(snapshot) || Date.now() >= deadline) {
      return snapshot;
    }
    await delay(1_000);
  }
}

function hasStableId(snapshot: Record<string, unknown>, stableId: string): boolean {
  return asArray(snapshot["trees"], "Snapshot trees").some((treeValue) => {
    const tree = asRecord(treeValue, "Snapshot tree");
    const payload = asRecord(tree["payload"], "Snapshot tree payload");
    return asArray(payload["inline_nodes"], "Snapshot inline nodes").some(
      (node) => asRecord(node, "Snapshot UI node")["stable_id"] === stableId,
    );
  });
}

async function waitForWdaReady(
  baseUrl: string,
  resources: AcceptanceResources,
): Promise<void> {
  const deadline = Date.now() + 8 * 60 * 1_000;
  while (Date.now() < deadline) {
    if (resources.wdaRunner?.exitCode !== null) {
      throw new Error("WebDriverAgent stopped before becoming ready.");
    }
    try {
      const response = await fetch(`${baseUrl}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { value?: { ready?: boolean } };
        if (body.value?.ready === true) {
          return;
        }
      }
    } catch {
      // Not listening yet; WebDriverAgent compiles on first run.
    }
    await delay(2_000);
  }
  throw new Error("WebDriverAgent did not become ready in time.");
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

function realAutomationSkipReason(): string | undefined {
  if (process.env[optInEnvironment] !== "1") {
    return `Set ${optInEnvironment}=1 or use the dedicated package script to run this acceptance.`;
  }
  if (process.platform !== "darwin") {
    return "The iOS automation acceptance requires macOS with Xcode.";
  }
  const wdaProject = process.env[wdaProjectEnvironment];
  if (wdaProject === undefined || !existsSync(wdaProject)) {
    return (
      `Set ${wdaProjectEnvironment} to a WebDriverAgent.xcodeproj checkout ` +
      "(github.com/appium/WebDriverAgent) so the XCUITest driver can be booted."
    );
  }
  const xcodebuild = spawnSync("xcrun", ["--find", "xcodebuild"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (xcodebuild.status !== 0 || xcodebuild.stdout.trim().length === 0) {
    return "The iOS automation acceptance requires the Xcode toolchain.";
  }
  if (
    !existsSync(
      path.join(repositoryRoot, "examples/ios/VistreaDemoApp/VistreaDemoApp.xcodeproj"),
    )
  ) {
    return "Generate the iOS Demo project with xcodegen before running this acceptance.";
  }
  return undefined;
}

async function selectSimulator(): Promise<SimulatorSelection> {
  const result = await runCommand("xcrun", ["simctl", "list", "runtimes", "--json"], {
    label: "Simulator runtime discovery",
  });
  const parsed = JSON.parse(result.stdout) as {
    runtimes?: readonly {
      identifier?: string;
      isAvailable?: boolean;
      platform?: string;
      version?: string;
      supportedDeviceTypes?: readonly { identifier?: string; productFamily?: string }[];
    }[];
  };
  const runtimes = (parsed.runtimes ?? [])
    .filter(
      (runtime) =>
        runtime.isAvailable === true &&
        runtime.platform === "iOS" &&
        typeof runtime.identifier === "string",
    )
    .sort((left, right) => (right.version ?? "").localeCompare(left.version ?? "", "en"));
  for (const runtime of runtimes) {
    const device = (runtime.supportedDeviceTypes ?? []).find(
      (candidate) =>
        candidate.productFamily === "iPhone" && typeof candidate.identifier === "string",
    );
    if (device !== undefined) {
      return {
        runtimeIdentifier: runtime.identifier as string,
        deviceTypeIdentifier: device.identifier as string,
      };
    }
  }
  throw new Error("No available iOS Simulator runtime supports an iPhone device type.");
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
  await stopChild(resources.wdaRunner);
  resources.wdaRunner = undefined;
  const simulatorId = resources.simulatorId;
  if (simulatorId !== undefined) {
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
      allowFailure: true,
      secrets,
      label: "Simulator deletion",
    });
    resources.simulatorId = undefined;
  }
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
  const secrets = options.secrets ?? [];
  if (secrets.some((secret) => arguments_.some((argument) => argument.includes(secret)))) {
    throw new Error("A protected Host credential was placed in process arguments.");
  }
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
  for (const secret of secrets) {
    if (result.stdout.includes(secret) || result.stderr.includes(secret)) {
      throw new Error(`${options.label ?? "Command"} emitted a protected Host credential.`);
    }
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
