import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();

test("the host build includes standalone service entry points", async () => {
  const tsconfig = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "tsconfig.json"), "utf8"),
  );
  assert.ok(tsconfig.include.includes("services/**/*.ts"));
});

test("embedded Node entitlements contain only the V8 runtime exceptions", async () => {
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

test("the Studio packager remains credential-free and ad-hoc only", async () => {
  const source = await fs.readFile(
    path.join(
      repositoryRoot,
      "tools/release/package-studio-macos.sh",
    ),
    "utf8",
  );

  assert.match(source, /local arguments=\(--force --sign - --options runtime\)/u);
  assert.doesNotMatch(
    source,
    /\bVISTREA_[A-Z0-9_]+\b|--require-[a-z-]+|\/usr\/bin\/xcrun/gu,
  );
  for (const updateKey of [
    "SUFeedURL",
    "SUPublicEDKey",
    "SURequireSignedFeed",
    "SUVerifyUpdateBeforeExtraction",
  ]) {
    assert.match(source, new RegExp(`update_key in [^\\n]*${updateKey}`, "u"));
  }
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
