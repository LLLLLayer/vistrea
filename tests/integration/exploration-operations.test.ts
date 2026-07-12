import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { startHostLocalApi } from "../../apps/host/index.js";
import { type JsonObject } from "../../data/api/index.js";
import {
  MemoryDataStore,
  SequenceClock,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import type { RuntimeCapturePort, RuntimeCaptureResult } from "../../engine/connection/index.js";
import {
  type AutomationProviderPort,
  type ProviderActionCommand,
  type ProviderActionResult,
} from "../../engine/automation/index.js";
import { HostLocalApiClient } from "../../integrations/shared/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

type FakeScreen = "home" | "catalog" | "detail";

const FAKE_SCREEN_NODES: Readonly<Record<FakeScreen, readonly { id: string; tap: boolean }[]>> = {
  home: [
    { id: "demo.home.root", tap: false },
    { id: "demo.home.open_catalog", tap: true },
  ],
  catalog: [
    { id: "demo.catalog.root", tap: false },
    { id: "demo.catalog.item_primary", tap: true },
  ],
  detail: [
    { id: "demo.detail.root", tap: false },
    { id: "demo.detail.open_form", tap: false },
  ],
};

/** A deterministic three-screen application the provider genuinely drives. */
class FakeApp {
  readonly stack: FakeScreen[] = ["home"];

  get current(): FakeScreen {
    return this.stack[this.stack.length - 1] as FakeScreen;
  }

  tap(stableId: string): void {
    if (this.current === "home" && stableId === "demo.home.open_catalog") {
      this.stack.push("catalog");
    } else if (this.current === "catalog" && stableId === "demo.catalog.item_primary") {
      this.stack.push("detail");
    }
  }

  back(): void {
    if (this.stack.length > 1) {
      this.stack.pop();
    }
  }
}

class FakeAppProvider implements AutomationProviderPort {
  readonly descriptor = {
    provider_id: "fake-app",
    platform: "android",
    device_kind: "virtual",
    action_kinds: ["tap", "back"],
    supports_system_alerts: false,
  } as const;

  constructor(private readonly app: FakeApp) {}

  async execute(command: ProviderActionCommand): Promise<ProviderActionResult> {
    if (command.kind === "tap") {
      const stableId = command.target?.provider_locator?.value;
      assert.ok(stableId !== undefined);
      this.app.tap(stableId);
      return { outcome: "uncertain" };
    }
    if (command.kind === "back") {
      this.app.back();
      return { outcome: "uncertain" };
    }
    return { outcome: "failed" };
  }
}

/** Serves the fake application through the transport-level capture port. */
class FakeAppRuntime implements RuntimeCapturePort {
  #sequence = 0;

  constructor(
    private readonly app: FakeApp,
    private readonly template: Record<string, unknown>,
  ) {}

  async captureSnapshot(): Promise<RuntimeCaptureResult> {
    this.#sequence += 1;
    const suffix = this.#sequence.toString(16).padStart(4, "0");
    const nodes = FAKE_SCREEN_NODES[this.app.current];
    const snapshot = structuredClone(this.template);
    snapshot["snapshot_id"] = `snapshot_019f0000-0000-7000-8000-00000000${suffix}`;
    const rootChildren = nodes
      .slice(1)
      .map(
        (_, index) =>
          `node_019f0000-0000-7000-8000-0000000000${(index + 2).toString(16).padStart(2, "0")}`,
      );
    (snapshot["trees"] as unknown[])[0] = {
      tree_id: "tree_019f0000-0000-7000-8000-000000000001",
      kind: "semantic",
      root_node_ids: ["node_019f0000-0000-7000-8000-000000000001"],
      payload: {
        inline_nodes: [
          {
            node_id: "node_019f0000-0000-7000-8000-000000000001",
            stable_id: nodes[0]?.id,
            child_ids: rootChildren,
            native_type: "ViewGroup",
            role: "container",
            frame: { x: 0, y: 0, width: 390, height: 844 },
            content: {},
            state: { visible: true, enabled: true },
            actions: [],
            capture_limitations: [],
            related_nodes: [],
            extensions: {},
          },
          ...nodes.slice(1).map((node, index) => ({
            node_id: rootChildren[index],
            parent_id: "node_019f0000-0000-7000-8000-000000000001",
            stable_id: node.id,
            child_ids: [],
            native_type: node.tap ? "Button" : "TextView",
            role: node.tap ? "button" : "text",
            frame: { x: 24, y: 120 + index * 80, width: 342, height: 52 },
            content: {},
            state: { visible: true, enabled: true },
            actions: node.tap ? ["tap"] : [],
            capture_limitations: [],
            related_nodes: [],
            extensions: {},
          })),
        ],
      },
      capture_limitations: [],
      extensions: {},
    };
    return { snapshot, objects: [] };
  }
}

async function operationsContext(t: TestContext, withProvider: boolean) {
  const validator = await validatorPromise;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-exploration-ops-"));
  t.after(async () => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const workspace = new MemoryDataStore({
    validator,
    clock: new SequenceClock("2026-07-12T16:00:00.000Z", 1_000),
    ids: new SequenceIdGenerator(400),
  });
  const objects = await FileObjectStore.open({ workspaceRoot });
  const template = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/minimal.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete template["screenshot"];
  const app = new FakeApp();
  const host = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: new FakeAppRuntime(app, template),
    workspace,
    objects,
    validator,
    ...(withProvider ? { automationProvider: new FakeAppProvider(app) } : {}),
  });
  t.after(() => host.close());
  const client = new HostLocalApiClient({
    baseUrl: host.baseUrl,
    bearerToken: host.bearerToken,
  });
  const runtimeContext = template["runtime_context"] as JsonObject;
  return { client, runtimeContext };
}

async function pollUntilSettled(
  client: HostLocalApiClient,
  operationId: string,
): Promise<JsonObject> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const record = (await client.execute("GetExplorationOperation", {
      operation_id: operationId,
    })) as JsonObject;
    const state = (record["operation"] as JsonObject)["state"];
    if (state !== "queued" && state !== "running") {
      return record;
    }
    if (Date.now() >= deadline) {
      throw new Error("The exploration operation never settled.");
    }
    await delay(50);
  }
}

test("exploration runs as one auditable Operation through the Host API", async (t) => {
  const { client, runtimeContext } = await operationsContext(t, true);

  const started = (await client.execute("RunExploration", {
    maximum_actions: 20,
    settle_milliseconds: 0,
  })) as JsonObject;
  assert.equal(started["kind"], "RunExploration");
  assert.equal(started["state"], "running");

  const record = await pollUntilSettled(client, started["operation_id"] as string);
  const operation = record["operation"] as JsonObject;
  assert.equal(operation["state"], "succeeded", JSON.stringify(record));
  const events = record["events"] as readonly JsonObject[];
  assert.equal(events[0]?.["kind"], "created");
  assert.equal(events[1]?.["kind"], "started");
  assert.equal(record["revision"], events.length);
  const result = record["result"] as JsonObject;
  assert.equal(result["result_type"], "ExplorationReport");
  const report = result["value"] as JsonObject;
  assert.equal((report["discovered_state_ids"] as readonly string[]).length, 3);
  assert.equal(report["stopped_reason"], "frontier_exhausted");
  // Every executed step reported progress on the wire.
  const progressed = events.filter((event) => event["kind"] === "progressed");
  assert.equal(progressed.length, (report["steps"] as readonly JsonObject[]).length);

  // The walk landed in the same persisted Screen Graph the product reads.
  const graph = (await client.execute("GetScreenGraph", {
    project_id: runtimeContext["project_id"],
    application_id: runtimeContext["application_id"],
  })) as JsonObject;
  assert.equal((graph["states"] as readonly JsonObject[]).length, 3);

  // A concurrent start conflicts; cancellation terminates honestly.
  const second = (await client.execute("RunExploration", {
    maximum_actions: 100,
    settle_milliseconds: 200,
  })) as JsonObject;
  await assert.rejects(
    client.execute("RunExploration", { maximum_actions: 5 }),
    (error: unknown) =>
      typeof error === "object" && error !== null && (error as { code?: string }).code === "conflict",
  );
  const cancelRef = (await client.execute("CancelExploration", {
    operation_id: second["operation_id"],
  })) as JsonObject;
  assert.equal(cancelRef["operation_id"], second["operation_id"]);
  const cancelled = await pollUntilSettled(client, second["operation_id"] as string);
  assert.equal((cancelled["operation"] as JsonObject)["state"], "cancelled");
  assert.equal(cancelled["result"], undefined);
});

test("exploration fails closed when no automation provider is configured", async (t) => {
  const { client } = await operationsContext(t, false);
  await assert.rejects(
    client.execute("RunExploration", { maximum_actions: 5 }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "unsupported",
  );
});
