import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { isDataError, type JsonObject, type RuntimeSnapshot } from "../../data/api/index.js";
import {
  MemoryDataStore,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import {
  AutomationEngine,
  WdaAutomationProvider,
  boundActionDigest,
} from "../../engine/automation/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

interface RecordedRequest {
  readonly method: string;
  readonly route: string;
  readonly body: JsonObject | undefined;
}

class FakeWdaServer {
  readonly requests: RecordedRequest[] = [];
  sessionCounter = 0;
  failNextActionsWithInvalidSession = false;
  #server: http.Server | undefined;
  #baseUrl = "";

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async start(): Promise<void> {
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text.length === 0 ? undefined : (JSON.parse(text) as JsonObject);
        const route = request.url ?? "";
        this.requests.push({ method: request.method ?? "", route, body });
        const reply = (status: number, value: unknown): void => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ value }));
        };
        if (request.method === "POST" && route === "/session") {
          this.sessionCounter += 1;
          reply(200, { sessionId: `wda-session-${this.sessionCounter}`, capabilities: {} });
          return;
        }
        const sessionRoute = /^\/session\/(wda-session-[0-9]+)(\/.*)$/.exec(route);
        if (sessionRoute === null) {
          reply(404, { error: "unknown command" });
          return;
        }
        const suffix = sessionRoute[2] as string;
        if (suffix === "/actions") {
          if (this.failNextActionsWithInvalidSession) {
            this.failNextActionsWithInvalidSession = false;
            reply(404, { error: "invalid session id" });
            return;
          }
          reply(200, null);
          return;
        }
        if (suffix === "/wda/keys" || suffix === "/wda/apps/launch") {
          reply(200, null);
          return;
        }
        if (suffix === "/element") {
          reply(200, { "element-6066-11e4-a52e-4f735466cecf": "fixture-element" });
          return;
        }
        if (suffix === "/element/fixture-element/clear" || suffix === "/alert/dismiss") {
          reply(200, null);
          return;
        }
        if (suffix === "/window/size") {
          reply(200, { width: 390, height: 844 });
          return;
        }
        reply(404, { error: "unknown command" });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  bodiesFor(route: string): readonly JsonObject[] {
    return this.requests
      .filter((request) => request.route.endsWith(route))
      .map((request) => request.body ?? {});
  }
}

async function wdaContext(t: TestContext): Promise<{
  server: FakeWdaServer;
  engine: AutomationEngine;
  provider: WdaAutomationProvider;
  snapshot: RuntimeSnapshot;
  sessionId: string;
}> {
  const validator = await validatorPromise;
  const server = new FakeWdaServer();
  await server.start();
  t.after(() => server.close());
  const workspace = new MemoryDataStore({
    validator,
    clock: { now: () => new Date().toISOString() },
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
  const provider = new WdaAutomationProvider({ baseUrl: server.baseUrl });
  const engine = new AutomationEngine({
    workspace,
    validator,
    providers: [provider],
    ids: new SequenceIdGenerator(100),
  });
  const session = engine.openSession({ provider_id: "ios-wda", actor_id: "vistrea-tests" });
  return { server, engine, provider, snapshot, sessionId: session.automation_session_id };
}

function pointerActions(body: JsonObject): readonly JsonObject[] {
  const actions = (body["actions"] as readonly JsonObject[])[0] as JsonObject;
  assert.equal(actions["type"], "pointer");
  assert.deepEqual(actions["parameters"], { pointerType: "touch" });
  return actions["actions"] as readonly JsonObject[];
}

test("the WDA provider drives tap, back, text, clear, dismiss, and launch through the wire protocol", async (t) => {
  const { server, engine, snapshot, sessionId } = await wdaContext(t);

  const tap = await engine.execute({
    automation_session_id: sessionId,
    kind: "tap",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Open the catalog" },
  });
  assert.equal(tap.outcome, "uncertain");
  const tapBodies = server.bodiesFor("/actions");
  assert.equal(tapBodies.length, 1);
  const tapSequence = pointerActions(tapBodies[0] as JsonObject);
  // The ios-uikit fixture button frame center is 195/146 in logical points;
  // WDA consumes logical points directly.
  assert.deepEqual(tapSequence[0], { type: "pointerMove", duration: 0, x: 195, y: 146 });
  assert.equal(tapSequence[1]?.["type"], "pointerDown");
  assert.equal(tapSequence[3]?.["type"], "pointerUp");
  assert.equal(server.sessionCounter, 1);

  const back = await engine.execute({
    automation_session_id: sessionId,
    kind: "back",
    intent: { requested_effect: "Pop the navigation stack" },
  });
  assert.equal(back.outcome, "uncertain");
  assert.equal(server.bodiesFor("/window/size").length, 1);
  const backSequence = pointerActions(server.bodiesFor("/actions")[1] as JsonObject);
  assert.deepEqual(backSequence[0], { type: "pointerMove", duration: 0, x: 1, y: 422 });
  assert.equal(backSequence[2]?.["x"], 220);

  const typed = await engine.execute({
    automation_session_id: sessionId,
    kind: "type_text",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Type a search phrase" },
    payload: { text_input: "vistrea" },
  });
  assert.equal(typed.outcome, "uncertain");
  assert.deepEqual(server.bodiesFor("/wda/keys"), [{ value: ["vistrea"] }]);
  // Typing with a target taps the field first to focus it.
  assert.equal(server.bodiesFor("/actions").length, 3);

  const cleared = await engine.execute({
    automation_session_id: sessionId,
    kind: "clear_text",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Clear the search field" },
  });
  assert.equal(cleared.outcome, "uncertain");
  assert.deepEqual(server.bodiesFor("/element"), [
    { using: "accessibility id", value: "demo.home.open_catalog" },
  ]);
  assert.equal(server.bodiesFor("/element/fixture-element/clear").length, 1);

  const targetedDismiss = await engine.execute({
    automation_session_id: sessionId,
    kind: "dismiss",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Dismiss the visible overlay" },
  });
  assert.equal(targetedDismiss.outcome, "uncertain");
  assert.equal(server.bodiesFor("/actions").length, 4);

  const alertDismiss = await engine.execute({
    automation_session_id: sessionId,
    kind: "dismiss",
    intent: { requested_effect: "Dismiss the system alert" },
  });
  assert.equal(alertDismiss.outcome, "uncertain");
  assert.equal(server.bodiesFor("/alert/dismiss").length, 1);

  const launch = await engine.execute({
    automation_session_id: sessionId,
    kind: "launch",
    intent: { requested_effect: "Launch the Demo App" },
    payload: { bundle_id: "dev.vistrea.demo" },
  });
  assert.equal(launch.outcome, "succeeded");
  assert.deepEqual(server.bodiesFor("/wda/apps/launch"), [{ bundleId: "dev.vistrea.demo" }]);

  // One cached WebDriverAgent session served every action.
  assert.equal(server.sessionCounter, 1);
});

test("the WDA provider recreates an invalid session once and rejects tampered authorization", async (t) => {
  const { server, engine, provider, snapshot, sessionId } = await wdaContext(t);

  // A driver restart invalidates the cached session; the provider recreates
  // it exactly once and replays the action.
  const first = await engine.execute({
    automation_session_id: sessionId,
    kind: "tap",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Open the catalog" },
  });
  assert.equal(first.outcome, "uncertain");
  assert.equal(server.sessionCounter, 1);
  server.failNextActionsWithInvalidSession = true;
  const retried = await engine.execute({
    automation_session_id: sessionId,
    kind: "tap",
    target: { stable_id: "demo.home.root" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Tap the root container" },
  });
  assert.equal(retried.outcome, "uncertain");
  assert.equal(server.sessionCounter, 2);

  // The provider re-verifies the bound digest before touching the wire.
  const requestCountBefore = server.requests.length;
  await assert.rejects(
    provider.execute({
      automation_session_id: sessionId,
      kind: "tap",
      target: {
        resolution_method: "coordinate",
        absolute_point: { x: 10, y: 10 },
        device_geometry_revision: "display-1",
      },
      authorization: {
        decision_id: "decision_019f0000-0000-7000-8000-000000000001",
        decision: "allow",
        risk: "safe",
        policy_id: "policy.vistrea.default-v1",
        bound_action_digest: boundActionDigest(sessionId, "back", undefined),
        actor_id: "vistrea-tests",
        session_id: sessionId,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      timeout_ms: 5_000,
    }),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
  assert.equal(server.requests.length, requestCountBefore);

  // Only explicit loopback origins are accepted.
  assert.throws(
    () => new WdaAutomationProvider({ baseUrl: "http://192.168.1.5:8100" }),
    (error: unknown) => isDataError(error, "invalid_argument"),
  );
});
