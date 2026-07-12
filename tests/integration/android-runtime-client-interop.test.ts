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

function spawnKotlinClient(
  host: string,
  port: number,
  token: string,
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
