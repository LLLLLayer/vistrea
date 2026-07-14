import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/pull-request-ci.yml",
);

test("the pull request CI matrix covers every supported implementation surface", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");

  assert.match(workflow, /^\s*pull_request:\s*$/mu);
  assert.match(workflow, /^\s*push:\s*$/mu);
  assert.match(workflow, /^\s*- main\s*$/mu);
  assert.match(workflow, /cancel-in-progress: true/u);

  for (const job of [
    "node-host",
    "studio",
    "ios-sdk",
    "ios-demo",
    "android-sdk",
    "android-demo",
  ]) {
    assert.match(workflow, new RegExp(`^  ${job}:$`, "mu"));
  }

  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm check",
    "pnpm build:host",
    "swift test --package-path apps/studio-macos",
    "swift build -c release --package-path apps/studio-macos",
    "node --test .build/typescript/tests/integration/ios-runtime-client-interop.test.js",
    "swift test --package-path sdks/ios",
    "swift build -c release --package-path sdks/ios",
    "xcodegen generate",
    "git diff --exit-code -- VistreaDemoApp.xcodeproj",
    "platform=iOS Simulator,id=$IOS_SIMULATOR_ID",
    "generic/platform=iOS Simulator",
    '"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"',
    '"platforms;android-36"',
    '"build-tools;36.0.0"',
    ":runtime-android:assembleRelease",
    ":runtime-compose:assembleRelease",
    "node --test .build/typescript/tests/integration/android-runtime-client-interop.test.js",
    "./tools/verify-runtime-release-boundary.sh",
    "./gradlew assembleDebug assembleRelease test lintDebug",
  ]) {
    assert.ok(workflow.includes(command), `missing CI command: ${command}`);
  }

  assert.match(workflow, /java-version: "17"/u);
  assert.match(workflow, /git status --short --untracked-files=all/u);
  assert.doesNotMatch(workflow, /connectedDebugAndroidTest/u);
  assert.doesNotMatch(workflow, /test:e2e:/u);
});

test("all pull request workflow actions are pinned to immutable commits", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)]
    .map((match) => match[1]);

  assert.ok(actions.length > 0);
  for (const action of actions) {
    assert.match(
      action,
      /^[^@\s]+@[0-9a-f]{40}$/u,
      `action is not pinned to a full commit SHA: ${action}`,
    );
  }
});

test("the canonical iOS project spec is regenerated with a verified XcodeGen", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");
  const installer = await fs.readFile(
    path.join(repositoryRoot, "tools/ci/install-xcodegen.sh"),
    "utf8",
  );

  assert.match(workflow, /tools\/ci\/install-xcodegen\.sh/u);
  assert.match(workflow, /xcrun simctl list devices available --json/u);
  assert.match(installer, /XCODEGEN_VERSION="2\.45\.4"/u);
  assert.match(installer, /XCODEGEN_SHA256="[0-9a-f]{64}"/u);
  assert.match(installer, /actual_sha256/u);
  await Promise.all(
    ["project.yml", "VistreaDemoApp.xcodeproj/project.pbxproj"].map((entry) =>
      fs.access(
        path.join(repositoryRoot, "examples/ios/VistreaDemoApp", entry),
      ),
    ),
  );
});
