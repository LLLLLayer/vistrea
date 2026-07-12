#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import { startHubServer, type HubBindAddress } from "./hub-server.js";

const USAGE =
  "Usage: vistrea-hub --workspace <abs-path> --project <project_id> " +
  "[--connection-file <abs-path>] [--host 127.0.0.1|::1] [--port <port>]\n";

const values = new Map<string, string>();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  const value = args[index + 1];
  if (
    option === undefined ||
    value === undefined ||
    !["--workspace", "--project", "--connection-file", "--host", "--port"].includes(option) ||
    values.has(option)
  ) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  values.set(option, value);
  index += 1;
}
const workspaceRoot = values.get("--workspace");
const projectId = values.get("--project");
const hostValue = values.get("--host") ?? "127.0.0.1";
const portValue = values.get("--port") ?? "0";
if (
  workspaceRoot === undefined ||
  !path.isAbsolute(workspaceRoot) ||
  projectId === undefined ||
  (hostValue !== "127.0.0.1" && hostValue !== "::1") ||
  !/^(?:0|[1-9][0-9]{0,4})$/.test(portValue) ||
  Number(portValue) > 65_535
) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const validator = await createRepositoryProtocolValidator({
  repositoryRoot: process.cwd(),
});
const workspace = await LocalDataWorkspace.open({ workspaceRoot, validator });
const hub = await startHubServer({
  host: hostValue as HubBindAddress,
  port: Number(portValue),
  projectId,
  workspace: workspace.data,
  objects: workspace.objects,
  validator,
});

// The rotating token travels only through a private connection descriptor,
// exactly like the Host: never argv, stdout, or logs.
const connectionFile =
  values.get("--connection-file") ?? path.join(os.tmpdir(), `vistrea-hub-${process.pid}.json`);
await fs.mkdir(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
const handle = await fs.open(connectionFile, "wx", 0o600);
try {
  await handle.writeFile(
    `${JSON.stringify({ hub_url: hub.baseUrl, hub_token: hub.bearerToken, project_id: projectId })}\n`,
    "utf8",
  );
} finally {
  await handle.close();
}
process.stdout.write(
  `${JSON.stringify({ status: "ready", hub_url: hub.baseUrl, connection_file: connectionFile })}\n`,
);

const shutdown = async (): Promise<void> => {
  await hub.close();
  await workspace.close();
  await fs.rm(connectionFile, { force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
