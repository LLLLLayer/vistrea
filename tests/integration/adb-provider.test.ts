import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { type RuntimeSnapshot } from "../../data/api/index.js";
import {
  MemoryDataStore,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import { AdbAutomationProvider, AutomationEngine } from "../../engine/automation/index.js";

const repositoryRoot = process.cwd();
const validatorPromise = createRepositoryProtocolValidator({ repositoryRoot });

async function fakeAdb(t: TestContext): Promise<{
  readonly executable: string;
  readonly readInvocations: () => Promise<readonly string[][]>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vistrea-fake-adb-"));
  const executable = path.join(root, "adb.mjs");
  const log = path.join(root, "invocations.ndjson");
  const source = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const command = args.join(" ");
if (command.endsWith("shell dumpsys window")) {
  process.stdout.write("mDreamingLockscreen=false\\nmShowingLockscreen=false\\nmCurrentFocus=Window{demo}\\n");
} else if (command.endsWith("shell dumpsys power")) {
  process.stdout.write("mWakefulness=Awake\\nDisplay Power: state=ON\\n");
} else if (command.endsWith("shell wm density")) {
  process.stdout.write("Physical density: 160\\n");
} else if (command.includes(" shell am start ")) {
  process.stdout.write("Status: ok\\n");
} else if (command.includes(" shell monkey ")) {
  process.stdout.write("Events injected: 1\\n");
}
`;
  await fs.writeFile(executable, source, { mode: 0o755 });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return {
    executable,
    readInvocations: async () => {
      const text = await fs.readFile(log, "utf8");
      return text
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

test("the adb provider clears text, dismisses targets and overlays, and launches packages", async (t) => {
  const validator = await validatorPromise;
  const adb = await fakeAdb(t);
  const workspace = new MemoryDataStore({
    validator,
    clock: { now: () => new Date().toISOString() },
    ids: new SequenceIdGenerator(500),
  });
  const source = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "protocol/fixtures/v1/runtime-snapshot/valid/android-view.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  delete source["screenshot"];
  const snapshot = source as unknown as RuntimeSnapshot;
  const unit = workspace.beginUnitOfWork("write");
  unit.snapshots.put(snapshot);
  unit.commit();

  const provider = new AdbAutomationProvider({
    adbPath: adb.executable,
    serial: "fixture-device",
  });
  const engine = new AutomationEngine({
    workspace,
    validator,
    providers: [provider],
    ids: new SequenceIdGenerator(100),
  });
  const session = engine.openSession({
    provider_id: "android-adb-input",
    actor_id: "vistrea-tests",
  });

  const cleared = await engine.execute({
    automation_session_id: session.automation_session_id,
    kind: "clear_text",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Clear the focused field" },
  });
  assert.equal(cleared.outcome, "uncertain");

  const targetedDismiss = await engine.execute({
    automation_session_id: session.automation_session_id,
    kind: "dismiss",
    target: { stable_id: "demo.home.open_catalog" },
    expected_snapshot_id: snapshot.snapshot_id,
    intent: { requested_effect: "Dismiss the visible overlay" },
  });
  assert.equal(targetedDismiss.outcome, "uncertain");

  const backDismiss = await engine.execute({
    automation_session_id: session.automation_session_id,
    kind: "dismiss",
    intent: { requested_effect: "Dismiss the topmost overlay" },
  });
  assert.equal(backDismiss.outcome, "uncertain");

  const launch = await engine.execute({
    automation_session_id: session.automation_session_id,
    kind: "launch",
    intent: { requested_effect: "Launch the Demo App" },
    payload: { package_id: "dev.vistrea.demo" },
  });
  assert.equal(launch.outcome, "succeeded");

  const calls = await adb.readInvocations();
  const clearKeys = calls.find(
    (args) => args[3] === "input" && args[4] === "keyevent" && args[5] === "KEYCODE_MOVE_END",
  );
  assert.ok(clearKeys !== undefined);
  assert.equal(clearKeys.length, 6 + 256);
  assert.equal(clearKeys.slice(6).every((key) => key === "KEYCODE_DEL"), true);
  assert.ok(
    calls.some(
      (args) =>
        args[3] === "input" && args[4] === "keyevent" && args[5] === "KEYCODE_BACK",
    ),
  );
  assert.ok(
    calls.some(
      (args) =>
        args[3] === "monkey" &&
        args.slice(4).join(" ") ===
          "-p dev.vistrea.demo -c android.intent.category.LAUNCHER 1",
    ),
  );
});
