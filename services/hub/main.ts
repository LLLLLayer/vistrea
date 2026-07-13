#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import { startHubServer, type HubBindAddress } from "./hub-server.js";

const USAGE =
  "Usage: vistrea-hub (--project <project_id> --workspace <abs-path>)... " +
  "[--connection-file <abs-path>] [--host <address>] [--port <port>] " +
  "[--tls-cert <pem> --tls-key <pem>]\n";

const values = new Map<string, string>();
const projectPairs: { projectId: string; workspaceRoot?: string }[] = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  const value = args[index + 1];
  if (
    option === undefined ||
    value === undefined ||
    !["--workspace", "--project", "--connection-file", "--host", "--port", "--tls-cert", "--tls-key"].includes(option)
  ) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (option === "--project") {
    projectPairs.push({ projectId: value });
  } else if (option === "--workspace") {
    const current = projectPairs[projectPairs.length - 1];
    if (current === undefined || current.workspaceRoot !== undefined) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    current.workspaceRoot = value;
  } else {
    if (values.has(option)) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    values.set(option, value);
  }
  index += 1;
}
const hostValue = values.get("--host") ?? "127.0.0.1";
const portValue = values.get("--port") ?? "0";
const tlsCert = values.get("--tls-cert");
const tlsKey = values.get("--tls-key");
if (
  projectPairs.length === 0 ||
  projectPairs.some(
    (pair) => pair.workspaceRoot === undefined || !path.isAbsolute(pair.workspaceRoot),
  ) ||
  !/^(?:0|[1-9][0-9]{0,4})$/.test(portValue) ||
  Number(portValue) > 65_535 ||
  (tlsCert === undefined) !== (tlsKey === undefined) ||
  (tlsCert !== undefined && (!path.isAbsolute(tlsCert) || !path.isAbsolute(tlsKey as string)))
) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const validator = await createRepositoryProtocolValidator({
  repositoryRoot: process.cwd(),
});
const workspaceRoots = new Set(projectPairs.map((pair) => pair.workspaceRoot as string));
if (workspaceRoots.size !== projectPairs.length) {
  // Two namespaces over one Workspace would collapse the isolation they claim.
  process.stderr.write(USAGE);
  process.exit(2);
}
const openWorkspaces = [] as Awaited<ReturnType<typeof LocalDataWorkspace.open>>[];
const projects = [] as { project_id: string; workspace: never; objects: never }[];
for (const pair of projectPairs) {
  const workspace = await LocalDataWorkspace.open({
    workspaceRoot: pair.workspaceRoot as string,
    validator,
  });
  openWorkspaces.push(workspace);
  projects.push({
    project_id: pair.projectId,
    workspace: workspace.data as never,
    objects: workspace.objects as never,
  });
}
const hub = await startHubServer({
  host: hostValue as HubBindAddress,
  port: Number(portValue),
  projects,
  validator,
  ...(tlsCert === undefined
    ? {}
    : { tls: { certificatePath: tlsCert, privateKeyPath: tlsKey as string } }),
});

// The rotating token travels only through a private connection descriptor,
// exactly like the Host: never argv, stdout, or logs.
const connectionFile =
  values.get("--connection-file") ?? path.join(os.tmpdir(), `vistrea-hub-${process.pid}.json`);
await fs.mkdir(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
const handle = await fs.open(connectionFile, "wx", 0o600);
try {
  await handle.writeFile(
    `${JSON.stringify({
      hub_url: hub.baseUrl,
      projects: hub.projects.map((project) => ({
        project_id: project.project_id,
        hub_token: project.bearerToken,
        hub_read_token: project.readOnlyToken,
      })),
    })}\n`,
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
  for (const workspace of openWorkspaces) {
    await workspace.close();
  }
  await fs.rm(connectionFile, { force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
