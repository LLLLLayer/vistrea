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
import { ExplorationEngine, ScreenGraphEngine } from "../../engine/exploration/index.js";

const repositoryRoot = process.cwd();
const optInEnvironment = "VISTREA_RUN_ANDROID_REAL_AUTOMATION";
const scenarioId = "demo.navigation.basic";
const storefrontScenarioId = "demo.store.navigation";
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
  awakeHeartbeat: NodeJS.Timeout | undefined;
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
      awakeHeartbeat: undefined,
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
    // The default 30-second display sleep swallows injected input while
    // in-process capture keeps working, so the display must stay awake for
    // the whole automation walk.
    await runAdb(serial, ["shell", "svc", "power", "stayon", "true"], {
      allowFailure: true,
      label: "Android display stay-awake",
    });
    // stayon alone does not hold on every emulator image, and a slept display
    // silently swallows injected input while in-process capture keeps working.
    await runAdb(
      serial,
      ["shell", "settings", "put", "system", "screen_off_timeout", "2147483647"],
      { allowFailure: true, label: "Android screen timeout" },
    );
    // Under host load, SystemUI can ANR on a cold headless boot; its modal
    // "isn't responding" dialog covers the app and eats every injected tap
    // while rendering, focus, and coordinates all look perfectly healthy.
    await runAdb(serial, ["shell", "settings", "put", "global", "hide_error_dialogs", "1"], {
      allowFailure: true,
      label: "Android error dialog suppression",
    });
    // A cold boot reports boot_completed while the launcher is still
    // starting; launching the Demo into that churn races its capture surface
    // and connection, so wait for a focused launcher first.
    const launcherDeadline = Date.now() + 60_000;
    for (;;) {
      const focus = await runAdb(serial, ["shell", "dumpsys", "window", "windows"], {
        allowFailure: true,
        label: "Android launcher readiness",
      });
      const focused = /mCurrentFocus=Window\{[^}]*\}/.exec(focus.stdout)?.[0] ?? "";
      if (/launcher/i.test(focused) || Date.now() >= launcherDeadline) {
        break;
      }
      await delay(2_000);
    }
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

    // The one-shot token allows exactly one connection attempt, and a
    // cold-booted system can still be churning when the Demo starts, so a
    // failed attempt gets a fresh token and a clean relaunch.
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > 1) {
        await runAdb(serial, ["shell", "am", "force-stop", debugPackage], {
          allowFailure: true,
          label: "Android Demo relaunch stop",
        });
      }
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
      try {
        // A cold headless emulator under host load spends its first minute in
        // dexopt and boot storms; a short window misreads slowness as failure.
        await resources.host.waitForRuntime(90_000);
        break;
      } catch (error) {
        if (attempt >= 3) {
          await dumpDeviceEvidence(serial, "runtime-did-not-connect");
          throw error;
        }
      }
    }
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

    // The display must be interactive before any injected input.
    await ensureDisplayAwake(serial);
    // The emulator image ignores stayon often enough that a long automation
    // walk still finds a slept display, which silently swallows injected input
    // while in-process capture keeps working. A heartbeat keeps it interactive
    // for the whole run and is cleared with the other resources.
    resources.awakeHeartbeat = setInterval(() => {
      void ensureDisplayAwake(serial);
    }, 15_000);
    resources.awakeHeartbeat.unref();

    // Cold-boot SystemUI can raise an ANR dialog that swallows the first tap.
    const systemDeadline = Date.now() + 30_000;
    for (;;) {
      const dismissed = await dismissSystemDialogs(serial);
      if (!dismissed || Date.now() >= systemDeadline) {
        break;
      }
      await delay(2_000);
    }

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
    await waitForApplicationFocus(serial, debugPackage);
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

    // The catalog Snapshot proves the tap actually navigated. Real input on a
    // loaded host is noisy — a dialog, a focus race, or input-service churn
    // can swallow an injected tap that resolved to the right coordinates —
    // so the authorized action retries bounded times before failing.
    let catalogSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, catalogStableId),
    );
    for (let attempt = 1; attempt <= 3 && !hasStableId(catalogSnapshot, catalogStableId); attempt += 1) {
      await dismissSystemDialogs(serial);
      await ensureDisplayAwake(serial);
      await waitForApplicationFocus(serial, debugPackage);
      await automation.execute({
        automation_session_id: session.automation_session_id,
        kind: "tap",
        target: { stable_id: homeStableId },
        expected_snapshot_id: homeSnapshot["snapshot_id"] as string,
        intent: { requested_effect: `Open the catalog screen (input retry ${attempt})` },
      });
      await delay(settleMilliseconds);
      catalogSnapshot = await captureUntil(resources.host, knownSecrets, (snapshot) =>
        hasStableId(snapshot, catalogStableId),
      );
    }
    if (!hasStableId(catalogSnapshot, catalogStableId)) {
      console.error(
        `Tap resolution evidence: ${JSON.stringify({
          resolution: tapResult.target_resolution,
          display: homeSnapshot["display"],
        })}`,
      );
      await dumpDeviceEvidence(serial, "tap-did-not-navigate");
    }
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


    // automation.safety on the real device: a dangerous-classified action is
    // denied without a confirmation token, and the token bound to exactly
    // this session, action, and target authorizes it once for real.
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
    await ensureDisplayAwake(serial);
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
    let confirmedCatalog = await captureUntil(resources.host, knownSecrets, (snapshot) =>
      hasStableId(snapshot, catalogStableId),
    );
    for (
      let attempt = 1;
      attempt <= 3 && !hasStableId(confirmedCatalog, catalogStableId);
      attempt += 1
    ) {
      // Each retry authorizes a fresh confirmation token: the binding is per
      // execution, and real input remains retryable without weakening it.
      await dismissSystemDialogs(serial);
      await ensureDisplayAwake(serial);
      await waitForApplicationFocus(serial, debugPackage);
      const retryToken = automation.confirmationTokenFor(dangerousCommand);
      await automation.execute({
        ...dangerousCommand,
        intent: { ...dangerousCommand.intent, confirmation_token: retryToken },
      });
      await delay(settleMilliseconds);
      confirmedCatalog = await captureUntil(resources.host, knownSecrets, (snapshot) =>
        hasStableId(snapshot, catalogStableId),
      );
    }
    if (!hasStableId(confirmedCatalog, catalogStableId)) {
      await dumpDeviceEvidence(serial, "confirmed-tap-did-not-navigate");
    }
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

    // Deterministic exploration drives the same real device autonomously:
    // from Home it must rediscover both known states, add the Detail screen,
    // and physically return along system back.
    const graphEngine = new ScreenGraphEngine({ workspace: automationWorkspace, validator });
    const hostHandle = resources.host;
    const explorationCapture = {
      captureSnapshot: async (): Promise<RuntimeSnapshot> => {
        const captured = await captureSnapshotThroughApi(hostHandle, knownSecrets);
        const copy = { ...captured };
        delete copy["screenshot"];
        const unit = automationWorkspace.beginUnitOfWork("write");
        unit.snapshots.put(copy as unknown as RuntimeSnapshot);
        unit.commit();
        return copy as unknown as RuntimeSnapshot;
      },
    };
    const exploration = new ExplorationEngine({
      workspace: automationWorkspace,
      capture: explorationCapture,
      automation,
      graph: graphEngine,
    });
    const report = await exploration.explore({
      automation_session_id: session.automation_session_id,
      maximum_actions: 8,
      settle_milliseconds: settleMilliseconds,
      // The in-app Inspector launcher is Vistrea tooling, not app frontier;
      // tapping it traps the walk behind the Inspector overlay.
      excluded_stable_ids: ["android.debug.inspector.open"],
    });
    if (report.discovered_state_ids.length !== 3 || report.stopped_reason !== "frontier_exhausted") {
      console.error(`Exploration evidence: ${JSON.stringify(report)}`);
    }
    assert.equal(report.stopped_reason, "frontier_exhausted");
    assert.equal(report.discovered_state_ids.length, 3);
    const exploredGraph = graphEngine.getGraph({
      project_id: runtimeContext["project_id"] as string,
      application_id: runtimeContext["application_id"] as string,
    });
    assert.equal(exploredGraph.states.length, 3);
    assert.ok(exploredGraph.transitions.length >= 4);
    const version = exploration.tagGraphVersion({
      project_id: runtimeContext["project_id"] as string,
      application_id: runtimeContext["application_id"] as string,
      tag_name: "acceptance/explored",
    });
    assert.equal(version.state_count, 3);

    // Second walk: the storefront scenario proves exploration scales past a
    // toy graph. The same installed Demo relaunches into the deep scenario
    // (the Runtime token survives in app storage), the walk exhausts a
    // four-screen frontier, and the one materialized graph absorbs both
    // scenarios because they share the application identity.
    await runAdb(serial, ["shell", "am", "force-stop", debugPackage], {
      label: "Android Demo storefront stop",
    });
    // The Runtime token is one-shot per connection, so the relaunch installs
    // a fresh descriptor exactly like the first launch did.
    const storefrontTokenBytes = Buffer.from(resources.host.runtime.authorizationToken, "utf8");
    try {
      await runCommand(tokenInstaller, [], {
        cwd: demoRoot,
        environment: cleanEnvironment({
          ANDROID_HOME: androidHome,
          ANDROID_SERIAL: serial,
          ADB: adbPath,
          VISTREA_ANDROID_PACKAGE: debugPackage,
        }),
        input: storefrontTokenBytes,
        secrets: knownSecrets,
        forbiddenEnvironmentSecrets: [resources.host.runtime.authorizationToken],
        label: "one-shot Android Runtime token reinstallation",
      });
    } finally {
      storefrontTokenBytes.fill(0);
    }
    const storefrontLaunch = await runAdb(
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
        storefrontScenarioId,
        "--es",
        "vistrea.profile_id",
        scenarioProfile,
      ],
      {
        secrets: knownSecrets,
        forbiddenEnvironmentSecrets: [resources.host.runtime.authorizationToken],
        timeoutMilliseconds: 60_000,
        label: "Android Demo storefront launch",
      },
    );
    assert.match(storefrontLaunch.stdout, /Status:\s+ok/);
    await resources.host.waitForRuntime(30_000);
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
      excluded_stable_ids: ["android.debug.inspector.open"],
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
        exploration_states: report.discovered_state_ids.length,
        storefront_states: storefrontReport.discovered_state_ids.length,
        storefront_actions: storefrontReport.action_count,
        storefront_version_tag: storefrontVersion.tag_name,
        exploration_actions: report.action_count,
        exploration_stopped: report.stopped_reason,
        exploration_version_tag: version.tag_name,
      }),
    );
  },
);

/** Guarantees an interactive display before injected input. */
async function ensureDisplayAwake(serial: string): Promise<void> {
  const state = await runAdb(serial, ["shell", "dumpsys", "power"], {
    allowFailure: true,
    label: "Android display state",
  });
  if (/mWakefulness=Awake/.test(state.stdout)) {
    return;
  }
  await runAdb(serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    allowFailure: true,
    label: "Android display wake",
  });
  await runAdb(serial, ["shell", "wm", "dismiss-keyguard"], {
    allowFailure: true,
    label: "Android keyguard dismissal",
  });
  await delay(1_000);
}

/**
 * A cold-booted emulator can raise a system ANR dialog ("System UI isn't
 * responding") that swallows the next injected tap. The acceptance dismisses
 * it — the dialog is emulator churn, not application behavior, and letting it
 * eat an action would report a false navigation failure.
 */
async function dismissSystemDialogs(serial: string): Promise<boolean> {
  // API 36 stopped printing focus lines under `dumpsys window windows`, and
  // the CLOSE_SYSTEM_DIALOGS broadcast has been blocked since Android 12, so
  // the honest probe is the rendered tree itself and the honest cure is
  // tapping the dialog's own Wait button.
  await runAdb(serial, ["shell", "uiautomator", "dump", "/sdcard/vistrea-dialog-probe.xml"], {
    allowFailure: true,
    label: "Android system dialog probe dump",
  });
  const probe = await runAdb(serial, ["shell", "cat", "/sdcard/vistrea-dialog-probe.xml"], {
    allowFailure: true,
    label: "Android system dialog probe read",
  });
  if (!/isn&#39;t responding|isn't responding|has stopped|keeps stopping/i.test(probe.stdout)) {
    return false;
  }
  const wait = /text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(probe.stdout);
  if (wait !== null) {
    const x = Math.round((Number(wait[1]) + Number(wait[3])) / 2);
    const y = Math.round((Number(wait[2]) + Number(wait[4])) / 2);
    await runAdb(serial, ["shell", "input", "tap", String(x), String(y)], {
      allowFailure: true,
      label: "Android system dialog wait tap",
    });
  } else {
    await runAdb(serial, ["shell", "input", "keyevent", "KEYCODE_BACK"], {
      allowFailure: true,
      label: "Android system dialog back",
    });
  }
  await delay(1_000);
  return true;
}

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

/**
 * Screenshots remain the final visual truth: when injected input has no
 * visible effect, the acceptance preserves what the device actually showed.
 */
/**
 * Waits until the Demo window holds input focus. A cold emulator under host
 * load can render a window whose taps still go nowhere; injecting before
 * focus lands is indistinguishable from a missed tap.
 */
async function waitForApplicationFocus(serial: string, packageName: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const window = await runAdb(serial, ["shell", "dumpsys", "window"], {
      allowFailure: true,
      label: "Android focus readiness",
    });
    const focused = /mCurrentFocus=Window\{[^}]*\}/.exec(window.stdout)?.[0] ?? "";
    if (focused.includes(packageName) || Date.now() >= deadline) {
      return;
    }
    await delay(1_000);
  }
}

async function dumpDeviceEvidence(serial: string, label: string): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `vistrea-acceptance-${label}-`));
  const logcat = await runAdb(serial, ["logcat", "-d", "-t", "400"], {
    allowFailure: true,
    label: "logcat evidence",
  });
  await fs.writeFile(path.join(directory, "logcat.txt"), `${logcat.stdout}\n`, "utf8");
  // API 36 no longer prints focus lines under the `windows` subcommand.
  const focus = await runAdb(serial, ["shell", "dumpsys", "window"], {
    allowFailure: true,
    label: "window focus evidence",
  });
  const focusLines = focus.stdout
    .split("\n")
    .filter((line) => /mCurrentFocus|mFocusedApp|mObscuring|keyguard/i.test(line))
    .join("\n");
  await fs.writeFile(path.join(directory, "window-focus.txt"), `${focusLines}\n`, "utf8");
  await runAdb(serial, ["shell", "uiautomator", "dump", "/sdcard/vistrea-evidence.xml"], {
    allowFailure: true,
    label: "ui dump evidence",
  });
  const tree = await runAdb(serial, ["shell", "cat", "/sdcard/vistrea-evidence.xml"], {
    allowFailure: true,
    label: "ui dump read",
  });
  await fs.writeFile(path.join(directory, "ui-dump.xml"), tree.stdout, "utf8");
  await runAdb(serial, ["shell", "screencap", "-p", "/sdcard/vistrea-evidence.png"], {
    allowFailure: true,
    label: "screen evidence capture",
  });
  await runAdb(serial, ["pull", "/sdcard/vistrea-evidence.png", path.join(directory, "screen.png")], {
    allowFailure: true,
    label: "screen evidence pull",
  });
  console.error(`Device evidence preserved under ${directory}`);
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
  if (resources.awakeHeartbeat !== undefined) {
    clearInterval(resources.awakeHeartbeat);
    resources.awakeHeartbeat = undefined;
  }
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
