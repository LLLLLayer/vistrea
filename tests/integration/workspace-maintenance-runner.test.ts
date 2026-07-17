import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { isDataError } from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";

const repositoryRoot = process.cwd();
const runnerPath = path.join(
  repositoryRoot,
  ".build/typescript/apps/host/workspace-maintenance.js",
);
const validatorPromise = createRepositoryProtocolValidator({
  repositoryRoot,
});

test("the one-shot Workspace maintenance runner restores and applies only a matching GC plan", async (t) => {
  const validator = await validatorPromise;
  const workspaceRoot = await temporaryWorkspace(t);
  const workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
  const recoveryPoint = await workspace.createRecoveryPoint({
    reason: "Runner restore acceptance point.",
    source: "manual",
    retention: {
      policy_id: "workspace-recovery:runner-test",
      reason: "Keep the runner acceptance backup.",
    },
  });

  const lockedRestore = await runMaintenance(workspaceRoot, {
    format_version: 1,
    operation: "restore",
    backup_hash: recoveryPoint.recovery_point_id,
  });
  assert.equal(lockedRestore.exitCode, 1);
  assert.deepEqual(lockedRestore.envelope, {
    format_version: 1,
    status: "failed",
    operation: "restore",
    error: {
      code: "conflict",
      message: "The request conflicts with the current Workspace state.",
      retryable: true,
    },
  });

  await workspace.close();
  const restored = await runMaintenance(workspaceRoot, {
    format_version: 1,
    operation: "restore",
    backup_hash: recoveryPoint.recovery_point_id,
  });
  assert.equal(restored.exitCode, 0);
  assert.equal(restored.envelope["status"], "succeeded");
  assert.equal(restored.envelope["operation"], "restore");
  const restoreResult = restored.envelope["result"] as Record<string, unknown>;
  assert.equal(
    (restoreResult["backup"] as Record<string, unknown>)["hash"],
    recoveryPoint.recovery_point_id,
  );
  assert.match(String(restoreResult["recovery_id"]), /^restore-/);

  const objects = await FileObjectStore.open({ workspaceRoot });
  const orphan = await objects.put(bytesOf(Buffer.from("runner-orphan", "utf8")), {
    media_type: "application/octet-stream",
    compression: "none",
    logical_name: "runner-orphan.bin",
  });
  const dryRun = await runMaintenance(workspaceRoot, {
    format_version: 1,
    operation: "collect_garbage",
    dry_run: true,
    minimum_age_seconds: 0,
  });
  assert.equal(dryRun.exitCode, 0);
  const dryRunResult = dryRun.envelope["result"] as Record<string, unknown>;
  assert.equal(dryRunResult["dry_run"], true);
  assert.equal(
    (dryRunResult["candidate_hashes"] as readonly string[]).includes(orphan.hash),
    true,
  );
  const planDigest = String(dryRunResult["plan_digest"]);
  assert.match(planDigest, /^sha256:[0-9a-f]{64}$/);

  const mismatchedApply = await runMaintenance(workspaceRoot, {
    format_version: 1,
    operation: "collect_garbage",
    dry_run: false,
    minimum_age_seconds: 0,
    expected_plan_digest: `sha256:${"f".repeat(64)}`,
  });
  assert.equal(mismatchedApply.exitCode, 1);
  assert.equal(
    (mismatchedApply.envelope["error"] as Record<string, unknown>)["code"],
    "conflict",
  );
  assert.equal((await objects.stat(orphan.hash)).hash, orphan.hash);

  const applied = await runMaintenance(workspaceRoot, {
    format_version: 1,
    operation: "collect_garbage",
    dry_run: false,
    minimum_age_seconds: 0,
    expected_plan_digest: planDigest,
  });
  assert.equal(applied.exitCode, 0);
  const appliedResult = applied.envelope["result"] as Record<string, unknown>;
  assert.equal(appliedResult["dry_run"], false);
  assert.equal(appliedResult["deleted_objects"], 1);
  await assert.rejects(
    objects.stat(orphan.hash),
    (error: unknown) => isDataError(error, "not_found"),
  );
});

test("the one-shot Workspace maintenance runner rejects duplicate and unknown input fields", async (t) => {
  const workspaceRoot = await temporaryWorkspace(t);
  const duplicate = await runMaintenanceSource(
    workspaceRoot,
    '{"format_version":1,"operation":"recover_stale_lock","operation":"restore"}',
  );
  assert.equal(duplicate.exitCode, 1);
  assert.deepEqual(duplicate.envelope, {
    format_version: 1,
    status: "failed",
    operation: "unknown",
    error: {
      code: "invalid_argument",
      message: "The Workspace maintenance request is invalid.",
      retryable: false,
    },
  });

  const unknown = await runMaintenanceSource(
    workspaceRoot,
    JSON.stringify({
      format_version: 1,
      operation: "recover_interrupted_restore",
      physical_path: "/private/should-not-be-echoed",
    }),
  );
  assert.equal(unknown.exitCode, 1);
  assert.equal(unknown.envelope["operation"], "recover_interrupted_restore");
  assert.equal(unknown.stdout.includes("/private/should-not-be-echoed"), false);
});

interface RunnerInvocation {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly envelope: Record<string, unknown>;
}

async function runMaintenance(
  workspaceRoot: string,
  request: Readonly<Record<string, unknown>>,
): Promise<RunnerInvocation> {
  return await runMaintenanceSource(workspaceRoot, JSON.stringify(request));
}

async function runMaintenanceSource(
  workspaceRoot: string,
  source: string,
): Promise<RunnerInvocation> {
  const child = spawn(process.execPath, [runnerPath, "--workspace", workspaceRoot], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutPromise = collect(child.stdout);
  const stderrPromise = collect(child.stderr);
  child.stdin.end(source);
  const [close, stdoutBytes, stderrBytes] = await Promise.all([
    once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>,
    stdoutPromise,
    stderrPromise,
  ]);
  const stdout = stdoutBytes.toString("utf8");
  const stderr = stderrBytes.toString("utf8");
  assert.equal(stderr, "");
  const lines = stdout.split("\n");
  assert.equal(lines.length, 2, `runner stdout must contain one JSON line: ${stdout}`);
  assert.equal(lines[1], "");
  const envelope = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope).sort(),
    envelope["status"] === "succeeded"
      ? ["format_version", "operation", "result", "status"]
      : ["error", "format_version", "operation", "status"]);
  return { exitCode: close[0], stdout, envelope };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

async function temporaryWorkspace(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-maintenance-runner-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function* bytesOf(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}
