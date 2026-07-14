import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = process.cwd();
const validator = path.join(
  repositoryRoot,
  "tools/release/validate-studio-release-version.mjs",
);

test("Studio release versions advance every published semantic version", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-studio-release-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tags = path.join(directory, "tags.txt");
  await fs.writeFile(tags, "other-v99.0.0\nstudio-v1.9.9\nstudio-v2.0.0\n", "utf8");

  const accepted = runVersionCheck("2.0.1", tags);
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const rejected of ["2.0.0", "1.99.99", "02.0.1", "2.0"]) {
    const result = runVersionCheck(rejected, tags);
    assert.notEqual(result.status, 0, `${rejected} unexpectedly passed`);
  }
});

test("the host build includes standalone service entry points", async () => {
  const tsconfig = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "tsconfig.json"), "utf8"),
  );
  assert.ok(tsconfig.include.includes("services/**/*.ts"));
});

test("distribution Node entitlements contain only the V8 runtime exceptions", async () => {
  const source = await fs.readFile(
    path.join(
      repositoryRoot,
      "tools/release/host-runtime/Node.entitlements",
    ),
    "utf8",
  );
  const keys = [...source.matchAll(/<key>([^<]+)<\/key>/gu)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(keys, [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ]);
  assert.doesNotMatch(source, /disable-library-validation|get-task-allow/gu);
});

test("the embedded Host lock resolves only through the public npm registry", async () => {
  const lock = JSON.parse(
    await fs.readFile(
      path.join(
        repositoryRoot,
        "tools/release/host-runtime/package-lock.json",
      ),
      "utf8",
    ),
  );
  const resolvedURLs = Object.values(lock.packages)
    .map((entry) => entry.resolved)
    .filter((value) => typeof value === "string");

  assert.ok(resolvedURLs.length > 0);
  for (const source of resolvedURLs) {
    const url = new URL(source);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "registry.npmjs.org");
  }
});

function runVersionCheck(candidate, tags) {
  return spawnSync(
    process.execPath,
    [validator, "--candidate", candidate, "--published-tags-file", tags],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}
