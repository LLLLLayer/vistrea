import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { ByteStream } from "../../data/api/index.js";
import {
  LoopbackRuntimeHost,
  LoopbackTransportError,
  type LoopbackRuntimeSession,
} from "../../engine/connection/index.js";

const repositoryRoot = process.cwd();
const androidSdkRoot = path.join(repositoryRoot, "sdks/android");
const gradleWrapper = path.join(androidSdkRoot, "gradlew");
const fixturePath = path.join(
  repositoryRoot,
  "protocol/fixtures/v1/runtime-snapshot/valid/minimal.json",
);
const authorizationToken = "vistrea-loopback-integration-token-0001";
const wrongAuthorizationToken = "vistrea-loopback-integration-token-9999";
const androidHome =
  process.env["ANDROID_HOME"] ?? path.join(process.env["HOME"] ?? "", "Library/Android/sdk");
const kotlinRuntimeAvailable =
  existsSync(gradleWrapper) &&
  existsSync(androidHome) &&
  spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;

test(
  "Kotlin Runtime client interoperates with the Node Host for capture, objects, cancellation, and close",
  { skip: kotlinRuntimeAvailable ? false : "The Android JVM toolchain is unavailable." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({
      token: authorizationToken,
      maximumChunkBytes: 3,
    });
    const child = spawnKotlinClient(host.endpoint.host, host.endpoint.port, authorizationToken);
    const childOutput = collectChildOutput(child);
    let session: LoopbackRuntimeSession | undefined;
    t.after(async () => {
      session?.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });

    session = await withTimeout(host.acceptSession(), 90_000, "Kotlin Runtime handshake");
    assert.equal(session.state, "ready");
    assert.deepEqual(session.selectedVersion, { major: 1, minor: 0 });
    assert.deepEqual(session.enabledCapabilities, ["runtime.snapshot"]);

    const first = await withTimeout(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "manual",
      }),
      10_000,
      "Kotlin Runtime capture",
    );
    assert.equal(
      record(first.snapshot)["snapshot_id"],
      "snapshot_019f0000-0000-7000-8000-000000000001",
    );
    assert.equal(first.objects.length, 1);
    assert.equal(record(first.objects[0]?.ref)["byte_size"], 7);
    assert.equal(
      (await collect(first.objects[0]?.stream as ByteStream)).toString("utf8"),
      "Vistrea",
    );

    await assert.rejects(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "review",
      }),
      (error: unknown) =>
        error instanceof LoopbackTransportError && error.code === "remote_error",
    );
    assert.equal(session.state, "ready");

    await assert.rejects(
      session.captureSnapshot({
        include: { paths: ["trees", "unknown"] },
        screenshot: "none",
        reason: "manual",
      }),
      (error: unknown) =>
        error instanceof LoopbackTransportError && error.code === "remote_error",
    );
    assert.equal(session.state, "ready");

    const controller = new AbortController();
    const cancelled = session.captureSnapshot(
      {
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "validation",
      },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(
      withTimeout(cancelled, 10_000, "Kotlin Runtime cancellation"),
      (error: unknown) =>
        error instanceof LoopbackTransportError && error.code === "cancelled",
    );

    const afterCancellation = await withTimeout(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "manual",
      }),
      10_000,
      "post-cancellation Kotlin Runtime capture",
    );
    assert.equal(afterCancellation.objects.length, 1);

    session.close();
    const exit = await withTimeout(childOutput, 20_000, "Kotlin Runtime process exit");
    assert.equal(exit.code, 0, exit.stderr);
    assertCredentialFree(exit);
  },
);

test(
  "Kotlin Runtime emits one terminal outcome under repeated near-completion cancellation races",
  { skip: kotlinRuntimeAvailable ? false : "The Android JVM toolchain is unavailable." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({
      token: authorizationToken,
      maximumChunkBytes: 3,
    });
    const child = spawnKotlinClient(host.endpoint.host, host.endpoint.port, authorizationToken);
    const childOutput = collectChildOutput(child);
    let session: LoopbackRuntimeSession | undefined;
    t.after(async () => {
      session?.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });

    session = await withTimeout(host.acceptSession(), 90_000, "racing Kotlin handshake");
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const controller = new AbortController();
      const capture = session.captureSnapshot(
        {
          include: { paths: ["trees", "screenshot"] },
          screenshot: "reference",
          reason: "manual",
        },
        { signal: controller.signal },
      );
      let cancel: () => void;
      if (iteration % 2 === 0) {
        const handle = setImmediate(() => controller.abort());
        cancel = () => clearImmediate(handle);
      } else {
        const handle = setTimeout(() => controller.abort(), 0);
        cancel = () => clearTimeout(handle);
      }
      try {
        await withTimeout(capture, 10_000, `racing capture ${String(iteration)}`);
      } catch (error) {
        assert.equal(
          error instanceof LoopbackTransportError && error.code === "cancelled",
          true,
        );
      } finally {
        cancel();
      }
      assert.equal(session.state, "ready");
    }

    const probe = await withTimeout(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "manual",
      }),
      10_000,
      "post-race Kotlin capture",
    );
    assert.equal(probe.objects.length, 1);
    assert.equal(session.state, "ready");

    session.close();
    const exit = await withTimeout(childOutput, 20_000, "racing Kotlin process exit");
    assert.equal(exit.code, 0, exit.stderr);
    assertCredentialFree(exit);
  },
);

test(
  "Kotlin Runtime enforces its 32-capture concurrency bound",
  { skip: kotlinRuntimeAvailable ? false : "The Android JVM toolchain is unavailable." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
    const child = spawnKotlinClient(host.endpoint.host, host.endpoint.port, authorizationToken);
    const childOutput = collectChildOutput(child);
    let session: LoopbackRuntimeSession | undefined;
    t.after(async () => {
      session?.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });

    session = await withTimeout(host.acceptSession(), 90_000, "bounded Kotlin handshake");
    const captures = Array.from({ length: 33 }, () =>
      session?.captureSnapshot({
        include: { paths: ["trees"] },
        screenshot: "none",
        reason: "validation",
      }) as ReturnType<LoopbackRuntimeSession["captureSnapshot"]>,
    );
    const settled = await withTimeout(
      Promise.allSettled(captures),
      10_000,
      "Kotlin concurrency rejection",
    );
    assert.equal(settled.every((result) => result.status === "rejected"), true);
    const exit = await withTimeout(childOutput, 20_000, "bounded Kotlin process exit");
    assert.notEqual(exit.code, 0);
    assertCredentialFree(exit);
  },
);

test(
  "Kotlin Runtime authentication failure never emits authorization material",
  { skip: kotlinRuntimeAvailable ? false : "The Android JVM toolchain is unavailable." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
    const child = spawnKotlinClient(
      host.endpoint.host,
      host.endpoint.port,
      wrongAuthorizationToken,
    );
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });

    const exit = await withTimeout(
      collectChildOutput(child),
      90_000,
      "rejected Kotlin Runtime process exit",
    );
    assert.notEqual(exit.code, 0);
    assertCredentialFree(exit);
  },
);

test(
  "Kotlin Runtime client streams negotiated, ordered, acknowledged event batches",
  { skip: kotlinRuntimeAvailable ? false : "The Android JVM toolchain is unavailable." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
    const child = spawnKotlinClient(host.endpoint.host, host.endpoint.port, authorizationToken, {
      VISTREA_RUNTIME_EVENTS: "scripted",
    });
    const childOutput = collectChildOutput(child);
    let session: LoopbackRuntimeSession | undefined;
    t.after(async () => {
      session?.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });

    session = await withTimeout(host.acceptSession(), 90_000, "Kotlin event handshake");
    assert.deepEqual(session.enabledCapabilities, ["runtime.events", "runtime.snapshot"]);
    const epoch = session.eventEpoch;
    assert.ok(epoch !== undefined);
    assert.match(
      epoch.eventEpochId,
      /^epoch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(epoch.oldestRetainedSequence, 1);
    assert.ok(epoch.nextSequence >= 3);

    const subscription = await withTimeout(
      session.subscribeEvents({
        eventEpochId: epoch.eventEpochId,
        eventKinds: ["transient_presented", "transient_dismissed", "layout_changed"],
        start: { mode: "oldest_retained" },
      }),
      10_000,
      "Kotlin event subscription",
    );

    const first = asRecord(await withTimeout(subscription.nextBatch(), 10_000, "first event batch"));
    assert.equal(first["event_epoch_id"], epoch.eventEpochId);
    assert.equal(first["first_sequence"], 1);
    assert.equal(first["dropped_event_count"], 0);
    const firstEvents = first["events"] as readonly Record<string, unknown>[];
    assert.ok(firstEvents.length >= 2);
    assert.equal(firstEvents[0]?.["kind"], "transient_presented");
    assert.equal(firstEvents[0]?.["sequence"], 1);
    assert.equal(firstEvents[0]?.["stable_id"], "demo.toast.success");
    assert.deepEqual(firstEvents[0]?.["payload"], { text: "Saved successfully" });
    assert.equal(firstEvents[1]?.["kind"], "transient_dismissed");
    subscription.acknowledge(first["last_sequence"] as number);

    let lastSequence = first["last_sequence"] as number;
    const deadline = Date.now() + 20_000;
    let sawLiveLayoutEvent = false;
    while (!sawLiveLayoutEvent && Date.now() < deadline) {
      const batch = asRecord(
        await withTimeout(subscription.nextBatch(), 15_000, "live event batch"),
      );
      assert.equal(batch["event_epoch_id"], epoch.eventEpochId);
      assert.equal((batch["first_sequence"] as number) > lastSequence, true);
      lastSequence = batch["last_sequence"] as number;
      subscription.acknowledge(lastSequence);
      const events = batch["events"] as readonly Record<string, unknown>[];
      sawLiveLayoutEvent = events.some((event) => event["kind"] === "layout_changed");
    }
    assert.equal(sawLiveLayoutEvent, true);

    session.close();
    const exit = await withTimeout(childOutput, 20_000, "Kotlin Runtime process exit");
    assert.equal(exit.code, 0, exit.stderr);
    assertCredentialFree(exit);
  },
);

test(
  "Kotlin Runtime client applies, reverts, and expires protected tuning previews",
  { skip: kotlinRuntimeAvailable ? false : "The Android JVM toolchain is unavailable." },
  async (t) => {
    const host = await LoopbackRuntimeHost.listen({ token: authorizationToken });
    const child = spawnKotlinClient(host.endpoint.host, host.endpoint.port, authorizationToken, {
      VISTREA_RUNTIME_TUNING: "scripted",
    });
    const childOutput = collectChildOutput(child);
    let session: LoopbackRuntimeSession | undefined;
    t.after(async () => {
      session?.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await host.close();
    });

    session = await withTimeout(host.acceptSession(), 90_000, "Kotlin tuning handshake");
    assert.deepEqual(session.enabledCapabilities, ["design.tuning", "runtime.snapshot"]);

    // A capture must establish the current Snapshot before tuning applies.
    const captured = await withTimeout(
      session.captureSnapshot({
        include: { paths: ["trees", "screenshot"] },
        screenshot: "reference",
        reason: "manual",
      }),
      10_000,
      "Kotlin tuning capture",
    );
    const snapshotId = record(captured.snapshot)["snapshot_id"] as string;

    const patch = {
      patch_id: "patch_019f0000-0000-7000-8000-000000000001",
      revision: 1,
      target_snapshot_id: snapshotId,
      changes: [
        {
          tuning_change_id: "tuningchange_019f0000-0000-7000-8000-000000000001",
          runtime_target: {
            snapshot_id: snapshotId,
            tree_id: "tree_019f0000-0000-7000-8000-000000000001",
            node_id: "node_019f0000-0000-7000-8000-000000000001",
            stable_id: "demo.home.root",
            extensions: {},
          },
          property: "alpha",
          original_value: { kind: "number", value: 1, unit: "ratio", extensions: {} },
          preview_value: { kind: "number", value: 0.5, unit: "ratio", extensions: {} },
        },
      ],
    };
    const applied = record(
      await withTimeout(
        session.applyTuning({ patch, expectedSnapshotId: snapshotId }),
        10_000,
        "Kotlin tuning apply",
      ),
    );
    assert.equal(applied["status"], "active");
    assert.equal(applied["patch_id"], patch.patch_id);
    assert.equal(applied["connection_id"], session.connectionId);
    assert.equal((applied["applied_changes"] as readonly unknown[]).length, 1);
    assert.deepEqual(applied["rejected_changes"], []);

    const reverted = record(
      await withTimeout(
        session.revertTuning(applied["tuning_application_id"] as string),
        10_000,
        "Kotlin tuning revert",
      ),
    );
    assert.equal(reverted["status"], "reverted");
    assert.equal(reverted["revision"], 2);
    assert.equal(reverted["reversion_reason"], "explicit_revert");

    // Reverting again conflicts because the preview is already restored.
    await assert.rejects(
      session.revertTuning(applied["tuning_application_id"] as string),
      (error: unknown) =>
        error instanceof LoopbackTransportError && error.code === "conflict",
    );

    // A stale expected Snapshot rejects every change explicitly.
    const stale = record(
      await withTimeout(
        session.applyTuning({
          patch: { ...patch, target_snapshot_id: snapshotId },
          expectedSnapshotId: "snapshot_019f0000-0000-7000-8000-000000000099",
        }),
        10_000,
        "Kotlin stale tuning apply",
      ),
    );
    assert.equal(stale["status"], "failed");
    assert.equal(
      (record((stale["rejected_changes"] as readonly unknown[])[0]))["reason_code"],
      "stale_snapshot",
    );

    // A TTL preview reverts itself and reports the terminal application.
    const expiring = record(
      await withTimeout(
        session.applyTuning({ patch, expectedSnapshotId: snapshotId, previewTtlMs: 400 }),
        10_000,
        "Kotlin TTL tuning apply",
      ),
    );
    assert.equal(expiring["status"], "active");
    const selfReverted = record(
      await withTimeout(session.nextRevertedTuning(), 10_000, "Kotlin TTL reversion"),
    );
    assert.equal(selfReverted["tuning_application_id"], expiring["tuning_application_id"]);
    assert.equal(selfReverted["status"], "expired");
    assert.equal(selfReverted["reversion_reason"], "ttl_expiry");

    session.close();
    const exit = await withTimeout(childOutput, 20_000, "Kotlin Runtime process exit");
    assert.equal(exit.code, 0, exit.stderr);
    assertCredentialFree(exit);
  },
);

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Readonly<Record<string, unknown>>;
}

function spawnKotlinClient(
  host: string,
  port: number,
  token: string,
  environment: Readonly<Record<string, string>> = {},
): ChildProcessWithoutNullStreams {
  return spawn(
    gradleWrapper,
    [
      "--quiet",
      ":runtime-connection:runInteropFixtureClient",
      `--args=--host ${host} --port ${String(port)}`,
    ],
    {
      cwd: androidSdkRoot,
      env: {
        ...process.env,
        ANDROID_HOME: androidHome,
        VISTREA_RUNTIME_TOKEN: token,
        VISTREA_RUNTIME_FIXTURE: fixturePath,
        ...environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

interface ChildOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function collectChildOutput(child: ChildProcessWithoutNullStreams): Promise<ChildOutput> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    stdout += value;
  });
  child.stderr.on("data", (value: string) => {
    stderr += value;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assertCredentialFree(output: ChildOutput): void {
  for (const secret of [authorizationToken, wrongAuthorizationToken]) {
    assert.equal(output.stdout.includes(secret), false);
    assert.equal(output.stderr.includes(secret), false);
  }
}

async function collect(stream: ByteStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Readonly<Record<string, unknown>>;
}

async function withTimeout<Value>(
  value: Promise<Value>,
  milliseconds: number,
  label: string,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds);
  });
  try {
    return await Promise.race([value, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
