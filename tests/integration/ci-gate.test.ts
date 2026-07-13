import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { startHostLocalApi } from "../../apps/host/index.js";
import { type RuntimeSnapshot } from "../../data/api/index.js";
import { createRepositoryProtocolValidator, MemoryDataStore } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import {
  FixtureRuntimeCapturePort,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });
const emittedCiPath = path.join(repositoryRoot, ".build/typescript/integrations/ci/main.js");

interface GateResult {
  readonly exitCode: number;
  readonly report: Record<string, unknown>;
}

async function runGate(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<GateResult> {
  const child = spawn(process.execPath, [emittedCiPath, ...arguments_], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    stdout += value;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, report: JSON.parse(stdout) as Record<string, unknown> };
}

async function loadSnapshot(mutate?: (copy: Record<string, unknown>) => void): Promise<
  Record<string, unknown>
> {
  const source = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete source["screenshot"];
  mutate?.(source);
  return source;
}

async function startGateHost(
  t: TestContext,
  snapshot: Record<string, unknown>,
  others: readonly Record<string, unknown>[] = [],
): Promise<NodeJS.ProcessEnv> {
  const validator = await validatorPromise;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-ci-gate-"));
  t.after(async () => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const workspace = new MemoryDataStore({ validator });
  const objects = await FileObjectStore.open({ workspaceRoot });
  const unit = workspace.beginUnitOfWork("write");
  unit.snapshots.put(snapshot as unknown as RuntimeSnapshot);
  for (const other of others) {
    unit.snapshots.put(other as unknown as RuntimeSnapshot);
  }
  unit.commit();
  const api = await startHostLocalApi({
    host: "127.0.0.1",
    runtime: new FixtureRuntimeCapturePort({
      snapshot: snapshot as unknown as RuntimeSnapshot,
      objects: [],
    }),
    workspace,
    objects,
    validator,
  });
  t.after(() => api.close());
  return {
    ...process.env,
    VISTREA_HOST_URL: api.baseUrl,
    VISTREA_HOST_TOKEN: api.bearerToken,
  };
}

test("the CI gate passes a clean Snapshot and emits a machine-readable report", async (t) => {
  const environment = await startGateHost(t, await loadSnapshot());
  const { exitCode, report } = await runGate([], environment);
  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(report["status"], "passed");
  const runs = report["runs"] as readonly Record<string, unknown>[];
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.["kind"], "snapshot");
  assert.equal(runs[0]?.["state"], "succeeded");
});

test("the CI gate fails on open findings at the configured severity", async (t) => {
  const problem = await loadSnapshot((copy) => {
    const tree = (copy["trees"] as Record<string, unknown>[])[0] as {
      payload: { inline_nodes: Record<string, unknown>[] };
    };
    const root = tree.payload.inline_nodes[0] as { node_id: string; child_ids: string[] };
    const duplicate = structuredClone(
      tree.payload.inline_nodes[1],
    ) as Record<string, unknown>;
    duplicate["node_id"] = "node_019f0000-0000-7000-8000-00000000c101";
    duplicate["parent_id"] = root.node_id;
    root.child_ids = [...root.child_ids, duplicate["node_id"] as string];
    tree.payload.inline_nodes.push(duplicate);
  });
  const environment = await startGateHost(t, problem);

  const failed = await runGate([], environment);
  assert.equal(failed.exitCode, 1, JSON.stringify(failed.report));
  assert.equal(failed.report["status"], "failed");
  assert.equal(failed.report["worst_open_severity"], "error");
  const runs = failed.report["runs"] as readonly Record<string, unknown>[];
  const findings = runs[0]?.["findings"] as readonly Record<string, unknown>[];
  assert.equal(
    findings.some((finding) => finding["rule_id"] === "structural.duplicate-stable-id"),
    true,
  );

  // Raising the threshold above the worst severity passes the gate.
  const tolerated = await runGate(["--fail-on", "critical"], environment);
  assert.equal(tolerated.exitCode, 0, JSON.stringify(tolerated.report));
  assert.equal(tolerated.report["status"], "passed");
});

test("the CI gate validates the newest Snapshot, not the first captured", async (t) => {
  const newestId = "snapshot_02a00000-0000-7000-8000-0000000000aa";
  const cleanOldest = await loadSnapshot();
  const brokenNewest = await loadSnapshot((copy) => {
    copy["snapshot_id"] = newestId;
    const tree = (copy["trees"] as Record<string, unknown>[])[0] as {
      payload: { inline_nodes: Record<string, unknown>[] };
    };
    const root = tree.payload.inline_nodes[0] as { node_id: string; child_ids: string[] };
    const duplicate = structuredClone(tree.payload.inline_nodes[1]) as Record<string, unknown>;
    duplicate["node_id"] = "node_019f0000-0000-7000-8000-00000000c102";
    duplicate["parent_id"] = root.node_id;
    root.child_ids = [...root.child_ids, duplicate["node_id"] as string];
    tree.payload.inline_nodes.push(duplicate);
  });
  // Seed the newest snapshot first so only true recency ordering can win.
  const environment = await startGateHost(t, brokenNewest, [cleanOldest]);

  const gated = await runGate([], environment);
  assert.equal(gated.exitCode, 1, JSON.stringify(gated.report));
  const runs = gated.report["runs"] as readonly Record<string, unknown>[];
  assert.equal(runs[0]?.["target"], newestId);
});

test("the CI gate reports usage errors and unavailable Hosts distinctly", async () => {
  const usage = await runGate(["--fail-on", "not-a-severity"], {
    ...process.env,
    VISTREA_HOST_URL: "http://127.0.0.1:1",
    VISTREA_HOST_TOKEN: "x".repeat(43),
  });
  assert.equal(usage.exitCode, 2);
  assert.equal(usage.report["status"], "usage_error");

  const baselineWithoutBuilds = await runGate(["--baseline-tag", "release/1.0"], {
    ...process.env,
    VISTREA_HOST_URL: "http://127.0.0.1:1",
    VISTREA_HOST_TOKEN: "x".repeat(43),
  });
  assert.equal(baselineWithoutBuilds.exitCode, 2);
  assert.equal(baselineWithoutBuilds.report["status"], "usage_error");

  const unavailable = await runGate([], {
    ...process.env,
    VISTREA_HOST_URL: "http://127.0.0.1:1",
    VISTREA_HOST_TOKEN: "x".repeat(43),
  });
  assert.equal(unavailable.exitCode, 3);
  assert.equal(unavailable.report["status"], "unavailable");
});
