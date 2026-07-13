import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { isDataError, type JsonObject, type RuntimeSnapshot } from "../../data/api/index.js";
import {
  MemoryDataStore,
  SequenceClock,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import {
  AutomationEngine,
  AutomationError,
  type AutomationProviderPort,
  type ProviderActionCommand,
  type ProviderActionResult,
  parseDisplayInteractive,
} from "../../engine/automation/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

class ScriptedAutomationProvider implements AutomationProviderPort {
  readonly descriptor = {
    provider_id: "scripted",
    platform: "ios",
    device_kind: "simulator",
    action_kinds: ["tap", "type_text", "back"],
    supports_system_alerts: false,
  } as const;

  readonly executed: ProviderActionCommand[] = [];
  delayMilliseconds = 0;

  async execute(
    command: ProviderActionCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderActionResult> {
    if (this.delayMilliseconds > 0) {
      await delay(this.delayMilliseconds, undefined, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    this.executed.push(command);
    return { outcome: "succeeded" };
  }
}

interface Context {
  readonly engine: AutomationEngine;
  readonly provider: ScriptedAutomationProvider;
  readonly snapshot: RuntimeSnapshot;
  readonly sessionId: string;
}

async function automationContext(isolated = false): Promise<Context> {
  const validator = await validatorPromise;
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T14:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(500),
  });
  const source = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete source["screenshot"];
  const snapshot = source as unknown as RuntimeSnapshot;
  const unit = workspace.beginUnitOfWork("write");
  unit.snapshots.put(snapshot);
  unit.commit();

  const provider = new ScriptedAutomationProvider();
  const engine = new AutomationEngine({
    workspace,
    validator,
    providers: [provider],
    ids: new SequenceIdGenerator(100),
    isolatedEnvironment: isolated,
  });
  const session = engine.openSession({ provider_id: "scripted", actor_id: "vistrea-tests" });
  assert.equal(session.state, "ready");
  return { engine, provider, snapshot, sessionId: session.automation_session_id };
}

test("automation resolves semantic targets and enforces stale preconditions", async () => {
  const { engine, provider, snapshot, sessionId } = await automationContext();

  const result = await engine.execute({
    automation_session_id: sessionId,
    kind: "tap",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Open the catalog" },
  });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.risk, "safe");
  assert.equal(result.authorization.decision, "allow");
  assert.equal(result.authorization.policy_id, "policy.vistrea.default-v1");
  assert.equal(result.authorization.actor_id, "vistrea-tests");
  const resolution = result.target_resolution;
  assert.ok(resolution !== undefined);
  assert.equal(resolution.resolution_method, "accessibility");
  assert.deepEqual(resolution.provider_locator, {
    strategy: "accessibility_id",
    value: "demo.home.open_catalog",
  });
  // The ios-uikit fixture button frame is x24 y120 w342 h52: center 195/146.
  assert.deepEqual(resolution.absolute_point, { x: 195, y: 146 });
  assert.equal(resolution.validated_snapshot_id, snapshot.snapshot_id);
  assert.equal(resolution.device_geometry_revision, "display-1");
  assert.equal(provider.executed.length, 1);
  assert.equal(
    provider.executed[0]?.authorization.bound_action_digest,
    result.authorization.bound_action_digest,
  );

  const normalized = await engine.execute({
    automation_session_id: sessionId,
    kind: "tap",
    target: { normalized_point: { x: 0.5, y: 0.25 } },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Tap mid-screen" },
  });
  assert.equal(normalized.target_resolution?.resolution_method, "coordinate");
  assert.deepEqual(normalized.target_resolution?.absolute_point, { x: 195, y: 211 });

  // Stale identity: a missing Snapshot and a vanished node both conflict
  // before the provider executes anything.
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "tap",
      target: { stable_id: "demo.home.open_catalog" },
      expected_snapshot_id: "snapshot_019f0000-0000-7000-8000-00000000dead",
      intent: { requested_effect: "Tap through a stale Snapshot" },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "tap",
      target: { stable_id: "demo.home.vanished" },
      expected_snapshot_id: snapshot.snapshot_id,
      intent: { requested_effect: "Tap a vanished node" },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "tap",
      target: {
        stable_id: "demo.home.open_catalog",
        expected_frame: { x: 24, y: 120, width: 342, height: 99 },
      },
      expected_snapshot_id: snapshot.snapshot_id,
      intent: { requested_effect: "Tap through a moved frame" },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "tap",
      target: { absolute_point: { x: 5_000, y: 5_000 } },
      expected_snapshot_id: snapshot.snapshot_id,
      intent: { requested_effect: "Tap outside the display" },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "scroll",
      target: { stable_id: "demo.home.open_catalog" },
      expected_snapshot_id: snapshot.snapshot_id,
      intent: { requested_effect: "Scroll with an unsupported provider" },
    }),
    (error: unknown) => isDataError(error, "unsupported"),
  );
  assert.equal(provider.executed.length, 2);
});

test("automation enforces risk policy, confirmation binding, and session lifecycle", async () => {
  const { engine, provider, snapshot, sessionId } = await automationContext();

  // type_text is sensitive by default and still allowed; the caller's
  // classification may only raise risk.
  const typed = await engine.execute({
    automation_session_id: sessionId,
    kind: "type_text",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Type a search phrase" },
    payload: { text_input: "vistrea" },
  });
  assert.equal(typed.risk, "sensitive");
  assert.equal(typed.outcome, "succeeded");

  const dangerousCommand = {
    automation_session_id: sessionId,
    kind: "tap" as const,
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: {
      requested_effect: "Delete the demo account",
      caller_classification: "dangerous" as const,
    },
  };
  const blocked = await engine.execute(dangerousCommand);
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.authorization.decision, "deny");
  assert.equal(provider.executed.length, 1);

  // A confirmation token is bound to kind, resolved target, and session.
  const token = engine.confirmationTokenFor(dangerousCommand);
  const confirmed = await engine.execute({
    ...dangerousCommand,
    intent: { ...dangerousCommand.intent, confirmation_token: token },
  });
  assert.equal(confirmed.outcome, "succeeded");
  assert.equal(confirmed.authorization.decision, "allow_once");
  const wrongTokenCommand = {
    ...dangerousCommand,
    kind: "type_text" as const,
    payload: { text_input: "vistrea" },
    intent: { ...dangerousCommand.intent, confirmation_token: token },
  };
  const rebound = await engine.execute(wrongTokenCommand);
  assert.equal(rebound.outcome, "blocked");

  // Forbidden never executes, even in an isolated environment.
  const isolated = await automationContext(true);
  const forbidden = await isolated.engine.execute({
    automation_session_id: isolated.sessionId,
    kind: "tap",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: isolated.snapshot.snapshot_id,
    intent: { requested_effect: "Wipe the device", caller_classification: "forbidden" },
  });
  assert.equal(forbidden.outcome, "blocked");
  assert.equal(forbidden.authorization.decision, "deny");
  const dangerousIsolated = await isolated.engine.execute({
    automation_session_id: isolated.sessionId,
    kind: "tap",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: isolated.snapshot.snapshot_id,
    intent: { requested_effect: "Reset demo data", caller_classification: "dangerous" },
  });
  assert.equal(dangerousIsolated.outcome, "succeeded");
  assert.equal(dangerousIsolated.authorization.decision, "allow_once");

  // Timeout, cancellation, busy gating, and close.
  provider.delayMilliseconds = 5_000;
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "tap",
      target: { stable_id: "demo.home.open_catalog" },
      expected_snapshot_id: snapshot.snapshot_id,
      intent: { requested_effect: "Tap slowly" },
      timeout_ms: 50,
    }),
    (error: unknown) => error instanceof AutomationError && error.code === "timeout",
  );
  assert.equal(engine.getSession(sessionId).state, "ready");

  const controller = new AbortController();
  const cancelled = engine.execute(
    {
      automation_session_id: sessionId,
      kind: "tap",
      target: { stable_id: "demo.home.open_catalog" },
      expected_snapshot_id: snapshot.snapshot_id,
      intent: { requested_effect: "Tap then cancel" },
      timeout_ms: 10_000,
    },
    { signal: controller.signal },
  );
  await delay(20);
  assert.equal(engine.getSession(sessionId).state, "busy");
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "back",
      intent: { requested_effect: "Go back while busy" },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  controller.abort();
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof AutomationError && error.code === "cancelled",
  );
  assert.equal(engine.getSession(sessionId).state, "ready");

  engine.closeSession(sessionId);
  assert.equal(engine.getSession(sessionId).state, "closed");
  await assert.rejects(
    engine.execute({
      automation_session_id: sessionId,
      kind: "back",
      intent: { requested_effect: "Act on a closed session" },
    }),
    (error: unknown) => isDataError(error, "conflict"),
  );
  assert.deepEqual(
    engine.listProviders().map((descriptor) => descriptor.provider_id),
    ["scripted"],
  );
});

test("display interactivity judgment refuses locked and sleeping screens", () => {
  const awake = "mWakefulness=Awake";
  const asleep = "mWakefulness=Asleep";
  const unlocked = "isKeyguardShowing=false\n  mCurrentFocus=Window{a1 u0 dev.vistrea.demo.debug/dev.vistrea.demo.MainActivity}";
  const keyguard = "isKeyguardShowing=true\n  mCurrentFocus=Window{b2 u0 NotificationShade}";
  const keyguardFocus = "isKeyguardShowing=false\n  mCurrentFocus=Window{c3 u0 Keyguard}";

  assert.equal(parseDisplayInteractive(unlocked, awake).interactive, true);
  assert.equal(parseDisplayInteractive(keyguard, awake).interactive, false);
  assert.match(parseDisplayInteractive(keyguard, awake).reason, /keyguard is showing/);
  assert.equal(parseDisplayInteractive(unlocked, asleep).interactive, false);
  assert.match(parseDisplayInteractive(unlocked, asleep).reason, /display is asleep/);
  assert.equal(parseDisplayInteractive(keyguardFocus, awake).interactive, false);
});
