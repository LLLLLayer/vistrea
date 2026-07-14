#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import { FileHubAuditStore, HUB_ROLES, type HubRole } from "./audit-store.js";
import { FileHubPermissionStore } from "./permission-store.js";
import {
  HUB_SERVER_LIMITS,
  startHubServer,
  type HubAccessGrant,
  type HubBindAddress,
} from "./hub-server.js";

const USAGE =
  "Usage: vistrea-hub (--project <project_id> --workspace <abs-path>)... " +
  "[--grant <principal_id:role>]... " +
  "[--connection-file <abs-path>] [--host <address>] [--port <port>] " +
  "[--tls-cert <pem> --tls-key <pem>] [--audit-log <abs-path>] " +
  "[--permission-file <abs-path>]\n";
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const values = new Map<string, string>();
const projectPairs: {
  projectId: string;
  workspaceRoot?: string;
  grants: HubAccessGrant[];
}[] = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  const value = args[index + 1];
  if (
    option === undefined ||
    value === undefined ||
    ![
      "--workspace",
      "--project",
      "--grant",
      "--connection-file",
      "--host",
      "--port",
      "--tls-cert",
      "--tls-key",
      "--audit-log",
      "--permission-file",
    ].includes(option)
  ) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (option === "--project") {
    projectPairs.push({ projectId: value, grants: [] });
  } else if (option === "--workspace") {
    const current = projectPairs[projectPairs.length - 1];
    if (current === undefined || current.workspaceRoot !== undefined) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    current.workspaceRoot = value;
  } else if (option === "--grant") {
    const current = projectPairs[projectPairs.length - 1];
    const separator = value.lastIndexOf(":");
    const principalId = value.slice(0, separator);
    const role = value.slice(separator + 1) as HubRole;
    if (
      current === undefined ||
      separator <= 0 ||
      !PRINCIPAL_ID_PATTERN.test(principalId) ||
      !HUB_ROLES.includes(role) ||
      current.grants.length >= HUB_SERVER_LIMITS.principalsPerProject - 2 ||
      current.grants.some((grant) => grant.principal_id === principalId) ||
      principalId === "hub-bootstrap-admin" ||
      principalId === "hub-bootstrap-viewer"
    ) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    current.grants.push({ principal_id: principalId, role });
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
const configuredConnectionFile = values.get("--connection-file");
const configuredAuditLog = values.get("--audit-log");
const configuredPermissionFile = values.get("--permission-file");
if (
  projectPairs.length === 0 ||
  projectPairs.length > HUB_SERVER_LIMITS.projects ||
  projectPairs.some(
    (pair) => pair.workspaceRoot === undefined || !path.isAbsolute(pair.workspaceRoot),
  ) ||
  !/^(?:0|[1-9][0-9]{0,4})$/.test(portValue) ||
  Number(portValue) > 65_535 ||
  (tlsCert === undefined) !== (tlsKey === undefined) ||
  (tlsCert !== undefined && (!path.isAbsolute(tlsCert) || !path.isAbsolute(tlsKey as string))) ||
  (configuredConnectionFile !== undefined && !path.isAbsolute(configuredConnectionFile)) ||
  (configuredAuditLog !== undefined && !path.isAbsolute(configuredAuditLog)) ||
  (configuredPermissionFile !== undefined && !path.isAbsolute(configuredPermissionFile))
) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const validator = await createRepositoryProtocolValidator({
  repositoryRoot: process.cwd(),
});
const workspaceRoots = new Set(projectPairs.map((pair) => pair.workspaceRoot as string));
const projectIds = new Set(projectPairs.map((pair) => pair.projectId));
if (workspaceRoots.size !== projectPairs.length || projectIds.size !== projectPairs.length) {
  // Namespaces and writable Workspaces both have one active owner.
  process.stderr.write(USAGE);
  process.exit(2);
}
const auditLog =
  configuredAuditLog ??
  path.join(projectPairs[0]?.workspaceRoot as string, ".hub", "audit.jsonl");
const permissionFile =
  configuredPermissionFile ??
  path.join(projectPairs[0]?.workspaceRoot as string, ".hub", "permissions.json");
const connectionFile =
  configuredConnectionFile ?? path.join(os.tmpdir(), `vistrea-hub-${process.pid}.json`);
if (new Set([auditLog, permissionFile, connectionFile]).size !== 3) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const openWorkspaces = [] as Awaited<ReturnType<typeof LocalDataWorkspace.open>>[];
let audit: FileHubAuditStore | undefined;
let permissions: FileHubPermissionStore | undefined;
let hub: Awaited<ReturnType<typeof startHubServer>> | undefined;
let connectionFileCreated = false;
try {
  const projects = [] as {
    project_id: string;
    workspace: never;
    objects: never;
    access: readonly HubAccessGrant[];
  }[];
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
      access: [],
    });
  }
  permissions = await FileHubPermissionStore.open(
    permissionFile,
    projectPairs.map((pair) => ({
      project_id: pair.projectId,
      grants: pair.grants,
    })),
  );
  for (const project of projects) {
    project.access = permissions.listProjectGrants(project.project_id);
  }
  audit = await FileHubAuditStore.open(auditLog);
  hub = await startHubServer({
    host: hostValue as HubBindAddress,
    port: Number(portValue),
    projects,
    validator,
    audit,
    permissions,
    ...(tlsCert === undefined
      ? {}
      : { tls: { certificatePath: tlsCert, privateKeyPath: tlsKey as string } }),
  });

  // Startup tokens travel only through a private connection descriptor,
  // exactly like the Host: never argv, stdout, or logs. Later grant/rotation
  // calls return a replacement exactly once through the authenticated API.
  await fs.mkdir(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
  const handle = await fs.open(connectionFile, "wx", 0o600);
  connectionFileCreated = true;
  try {
    await handle.writeFile(
      `${JSON.stringify({
        hub_url: hub.baseUrl,
        projects: hub.projects.map((project) => ({
          project_id: project.project_id,
          hub_token: project.bearerToken,
          hub_read_token: project.readOnlyToken,
          access_grants: project.accessGrants.map((grant) => ({
            principal_id: grant.principal_id,
            role: grant.role,
            hub_token: grant.bearerToken,
          })),
        })),
        audit_log: auditLog,
        permission_file: permissionFile,
      })}\n`,
      "utf8",
    );
  } finally {
    await handle.close();
  }
} catch (error) {
  await hub?.close().catch(() => {});
  await audit?.close().catch(() => {});
  await permissions?.close().catch(() => {});
  for (const workspace of openWorkspaces.reverse()) {
    await workspace.close().catch(() => {});
  }
  if (connectionFileCreated) {
    await fs.rm(connectionFile, { force: true }).catch(() => {});
  }
  throw error;
}

const runningHub = hub;
const runningAudit = audit;
const runningPermissions = permissions;
if (runningHub === undefined || runningAudit === undefined || runningPermissions === undefined) {
  throw new Error("The Hub composition did not finish startup.");
}
process.stdout.write(
  `${JSON.stringify({ status: "ready", hub_url: runningHub.baseUrl, connection_file: connectionFile })}\n`,
);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  let firstError: unknown;
  for (const operation of [
    () => runningHub.close(),
    () => runningAudit.close(),
    () => runningPermissions.close(),
    ...openWorkspaces.reverse().map((workspace) => () => workspace.close()),
    () => fs.rm(connectionFile, { force: true }),
  ]) {
    try {
      await operation();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
  process.exit(0);
};
const handleSignal = (): void => {
  void shutdown().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown shutdown error";
    process.stderr.write(`Vistrea Hub shutdown failed: ${message}\n`);
    process.exit(1);
  });
};
process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);
