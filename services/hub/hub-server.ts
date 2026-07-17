import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import https from "node:https";

import {
  DataError,
  isDataError,
  type JsonObject,
  type ObjectStore,
  type ProtocolValidator,
  type WorkspaceDataSource,
} from "../../data/api/index.js";
import { PACK_LOGICAL_NAME, PACK_MEDIA_TYPE, PackExchangeService } from "../../data/exchange/index.js";
import {
  HUB_AUDIT_ACTIONS,
  HUB_ROLES,
  MemoryHubAuditStore,
  type HubAuditAction,
  type HubAuditEvent,
  type HubAuditOutcome,
  type HubAuditStore,
  type RecordHubAuditEvent,
  type HubRole,
} from "./audit-store.js";
import {
  MemoryHubPermissionStore,
  type HubPermissionStore,
  type HubStoredAccessGrant,
} from "./permission-store.js";
import {
  MemoryHubDirectoryStore,
  type HubDirectoryStore,
  type HubDirectoryTeam,
  type HubStoredTeamGrant,
} from "./directory-store.js";

const TOKEN_BYTES = 32;
const MAXIMUM_JSON_BODY_BYTES = 64 * 1024;
const MAXIMUM_PACK_BYTES = 256 * 1024 * 1024;
export const HUB_SERVER_LIMITS = {
  projects: 128,
  teams: 128,
  principalsPerProject: 256,
  principalsPerTeam: 256,
} as const;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type HubBindAddress = string;

export interface HubAccessGrant {
  readonly principal_id: string;
  readonly role: HubRole;
}

export interface HubProject {
  readonly project_id: string;
  readonly organization_id?: string;
  readonly team_id?: string;
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
  /** Additional startup-managed principals. Bootstrap admin/viewer always exist. */
  readonly access?: readonly HubAccessGrant[];
}

export interface HubTeam {
  readonly organization_id: string;
  readonly team_id: string;
  /** Team grants inherit into every configured child project. */
  readonly access?: readonly HubAccessGrant[];
}

export interface HubTlsConfig {
  /** PEM certificate chain path; read once at startup. */
  readonly certificatePath: string;
  /** PEM private key path; read once at startup and never logged. */
  readonly privateKeyPath: string;
}

export interface StartHubServerOptions {
  /**
   * Plain HTTP binds loopback-only because the bearer token would otherwise
   * travel unencrypted; TLS unlocks non-loopback interfaces for cross-team
   * collaboration.
   */
  readonly host: HubBindAddress;
  readonly port?: number;
  /** Every served namespace; unknown projects are indistinguishable from invalid credentials. */
  readonly projects: readonly HubProject[];
  /** Optional team scopes whose grants inherit into associated projects. */
  readonly teams?: readonly HubTeam[];
  readonly validator: ProtocolValidator;
  readonly tls?: HubTlsConfig;
  /** Defaults to an in-memory store; standalone Hub composition supplies a durable store. */
  readonly audit?: HubAuditStore;
  /** Defaults to process-local roles; standalone Hub composition supplies a durable store. */
  readonly permissions?: HubPermissionStore;
  /** Defaults to process-local team membership; standalone composition supplies a durable store. */
  readonly directory?: HubDirectoryStore;
}

export interface HubIssuedAccessGrant extends HubAccessGrant {
  /** Rotates with this Hub process and is returned only through protected composition. */
  readonly bearerToken: string;
}

export interface HubProjectTokens {
  readonly project_id: string;
  /** Backward-compatible bootstrap admin token for this project only. */
  readonly bearerToken: string;
  /** Backward-compatible bootstrap viewer token for this project only. */
  readonly readOnlyToken: string;
  /** Every issued project principal, including the two bootstrap grants. */
  readonly accessGrants: readonly HubIssuedAccessGrant[];
}

export interface HubTeamTokens {
  readonly organization_id: string;
  readonly team_id: string;
  readonly bearerToken: string;
  readonly readOnlyToken: string;
  readonly accessGrants: readonly HubIssuedAccessGrant[];
}

export interface HubServerHandle {
  readonly host: HubBindAddress;
  readonly port: number;
  readonly baseUrl: string;
  /** Project-scoped bootstrap and named-principal grants; never persisted by the server. */
  readonly projects: readonly HubProjectTokens[];
  /** Team-scoped grants accepted by every associated project; never persisted as plaintext. */
  readonly teams: readonly HubTeamTokens[];
  close(): Promise<void>;
}

interface HubPrincipalRuntime {
  readonly principalId: string;
  readonly role: HubRole;
  readonly bearerDigest: Buffer;
}

interface HubPermissionSource extends JsonObject {
  readonly scope: "project" | "team";
  readonly role: HubRole;
  readonly organization_id?: string;
  readonly team_id?: string;
}

interface HubAuthorizedPrincipal extends HubPrincipalRuntime {
  readonly credentialScope: "project" | "team";
  readonly permissionSources: readonly HubPermissionSource[];
}

interface PublicHubPermission extends JsonObject {
  readonly principal_id: string;
  readonly role: HubRole;
  readonly capabilities: readonly string[];
}

interface HubProjectRuntime {
  readonly project: HubProject;
  readonly exchange: PackExchangeService;
  readonly principals: Map<string, HubPrincipalRuntime>;
  readonly permissions: HubPermissionStore;
  readonly team?: HubTeamRuntime;
  permissionMutation: Promise<void>;
}

interface HubTeamRuntime {
  readonly team: HubTeam;
  readonly principals: Map<string, HubPrincipalRuntime>;
  readonly directory: HubDirectoryStore;
  readonly projectIds: Set<string>;
  permissionMutation: Promise<void>;
}

interface PublicError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

class HubRequestError extends Error implements PublicError {
  readonly status: number;
  readonly code: string;

  constructor(error: PublicError) {
    super(error.message);
    this.name = "HubRequestError";
    this.status = error.status;
    this.code = error.code;
  }
}

/**
 * Optional cross-team pack relay with project-scoped RBAC, durable-audit port,
 * and a safe collaboration activity projection. Local Workspaces stay fully
 * usable without it.
 */
export async function startHubServer(options: StartHubServerOptions): Promise<HubServerHandle> {
  if (options.projects.length === 0 || options.projects.length > HUB_SERVER_LIMITS.projects) {
    throw new DataError(
      "invalid_argument",
      `The Hub serves between 1 and ${HUB_SERVER_LIMITS.projects} projects per process.`,
    );
  }
  const projectIds = new Set<string>();
  for (const project of options.projects) {
    if (!PROJECT_ID_PATTERN.test(project.project_id)) {
      throw new DataError("invalid_argument", "A Hub project identifier is invalid.");
    }
    if (projectIds.has(project.project_id)) {
      throw new DataError("invalid_argument", "Hub project identifiers must be unique.");
    }
    projectIds.add(project.project_id);
  }
  const configuredTeams = options.teams ?? [];
  if (configuredTeams.length > HUB_SERVER_LIMITS.teams) {
    throw new DataError(
      "invalid_argument",
      `The Hub serves at most ${HUB_SERVER_LIMITS.teams} teams per process.`,
    );
  }
  const teamDefinitions = new Map<string, HubTeam>();
  for (const team of configuredTeams) {
    const key = hubTeamKey(team.organization_id, team.team_id);
    if (
      !SCOPE_ID_PATTERN.test(team.organization_id) ||
      !SCOPE_ID_PATTERN.test(team.team_id) ||
      teamDefinitions.has(key)
    ) {
      throw new DataError("invalid_argument", "Hub teams must have unique bounded identities.");
    }
    teamDefinitions.set(key, team);
  }
  const teamProjectCounts = new Map<string, number>(
    [...teamDefinitions.keys()].map((key) => [key, 0]),
  );
  for (const project of options.projects) {
    if ((project.organization_id === undefined) !== (project.team_id === undefined)) {
      throw new DataError(
        "invalid_argument",
        "A Hub project must name both organization and team or neither.",
      );
    }
    if (project.organization_id !== undefined) {
      const key = hubTeamKey(project.organization_id, project.team_id as string);
      const count = teamProjectCounts.get(key);
      if (count === undefined) {
        throw new DataError("invalid_argument", "A Hub project references an unknown team.");
      }
      teamProjectCounts.set(key, count + 1);
    }
  }
  if ([...teamProjectCounts.values()].some((count) => count === 0)) {
    throw new DataError("invalid_argument", "Every configured Hub team must own a project.");
  }
  // Validate the network boundary before issuing any plaintext credentials.
  const loopback = options.host === "127.0.0.1" || options.host === "::1";
  if (options.tls === undefined && !loopback) {
    throw new DataError(
      "invalid_argument",
      "The Hub binds loopback interfaces only without TLS.",
    );
  }
  if (!/^[A-Za-z0-9.:\-]{1,255}$/.test(options.host)) {
    throw new DataError("invalid_argument", "The Hub bind address is invalid.");
  }
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
  ) {
    throw new DataError("invalid_argument", "The Hub port must be an integer from 0 through 65535.");
  }
  const directory =
    options.directory ??
    new MemoryHubDirectoryStore(
      configuredTeams.map((team) => ({
        organization_id: team.organization_id,
        team_id: team.team_id,
        grants: team.access ?? [],
      } satisfies HubDirectoryTeam)),
    );
  const teams = new Map<string, HubTeamRuntime>();
  const teamTokens: HubTeamTokens[] = [];
  for (const team of configuredTeams) {
    const configuredTeam = {
      ...team,
      access: directory.listTeamGrants(team.organization_id, team.team_id),
    };
    const issued = issueTeamAccess(configuredTeam);
    teams.set(hubTeamKey(team.organization_id, team.team_id), {
      team: configuredTeam,
      principals: runtimePrincipals(issued.accessGrants),
      directory,
      projectIds: new Set(),
      permissionMutation: Promise.resolve(),
    });
    teamTokens.push({
      organization_id: team.organization_id,
      team_id: team.team_id,
      bearerToken: issued.bootstrapAdminToken,
      readOnlyToken: issued.bootstrapViewerToken,
      accessGrants: issued.accessGrants,
    });
  }
  const permissions =
    options.permissions ??
    new MemoryHubPermissionStore(
      options.projects.map((project) => ({
        project_id: project.project_id,
        grants: project.access ?? [],
      })),
    );
  const projects = new Map<string, HubProjectRuntime>();
  const projectTokens: HubProjectTokens[] = [];
  for (const project of options.projects) {
    const team =
      project.organization_id === undefined
        ? undefined
        : teams.get(hubTeamKey(project.organization_id, project.team_id as string));
    const configuredProject = {
      ...project,
      access: permissions.listProjectGrants(project.project_id),
    };
    const issued = issueProjectAccess(configuredProject);
    projects.set(project.project_id, {
      project: configuredProject,
      exchange: new PackExchangeService({
        data: project.workspace,
        objects: project.objects,
        validator: options.validator,
      }),
      principals: runtimePrincipals(issued.accessGrants),
      permissions,
      ...(team === undefined ? {} : { team }),
      permissionMutation: Promise.resolve(),
    });
    team?.projectIds.add(project.project_id);
    projectTokens.push({
      project_id: project.project_id,
      bearerToken: issued.bootstrapAdminToken,
      readOnlyToken: issued.bootstrapViewerToken,
      accessGrants: issued.accessGrants,
    });
  }
  const audit = options.audit ?? new MemoryHubAuditStore();

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void handleRequest(request, response, projects, teams, audit).catch((error: unknown) =>
      sendError(response, error),
    );
  };
  const server: Server =
    options.tls === undefined
      ? http.createServer({ maxHeaderSize: 16 * 1024 }, handler)
      : https.createServer(
          {
            maxHeaderSize: 16 * 1024,
            cert: readFileSync(options.tls.certificatePath),
            key: readFileSync(options.tls.privateKeyPath),
            minVersion: "TLSv1.3",
            maxVersion: "TLSv1.3",
          },
          handler,
        );
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  server.listen(options.port ?? 0, options.host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new DataError("internal", "The Hub did not expose a TCP endpoint.");
  }

  let closed = false;
  const scheme = options.tls === undefined ? "http" : "https";
  return {
    host: options.host,
    port: address.port,
    baseUrl: `${scheme}://${options.host === "::1" ? `[${options.host}]` : options.host}:${address.port}`,
    projects: projectTokens,
    teams: teamTokens,
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        try {
          await closeServer(server);
        } finally {
          for (const runtime of projects.values()) {
            await runtime.permissionMutation;
            for (const principal of runtime.principals.values()) {
              principal.bearerDigest.fill(0);
            }
          }
          for (const runtime of teams.values()) {
            await runtime.permissionMutation;
            for (const principal of runtime.principals.values()) {
              principal.bearerDigest.fill(0);
            }
          }
        }
      }
    },
  };
}

async function handleTeamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  resource: string,
  runtime: HubTeamRuntime,
  principal: HubPrincipalRuntime,
  projects: ReadonlyMap<string, HubProjectRuntime>,
  audit: HubAuditStore,
): Promise<void> {
  const organizationId = runtime.team.organization_id;
  const teamId = runtime.team.team_id;
  const auditDetails: JsonObject = {
    permission_scope: "team",
    organization_id: organizationId,
    team_id: teamId,
  };

  if (resource === "projects" && request.method === "GET") {
    assertNoSearchParameters(url);
    await assertEmptyBody(request);
    await requireTeamRole(audit, runtime, principal, "viewer", resource);
    const items = [...runtime.projectIds]
      .sort()
      .map((projectId) => {
        const project = projects.get(projectId);
        if (project === undefined) {
          throw new DataError("integrity_error", "A Hub team references a missing project.");
        }
        const role = effectiveRoleForPrincipal(project, principal.principalId);
        return {
          project_id: projectId,
          organization_id: organizationId,
          team_id: teamId,
          role,
          capabilities: capabilitiesForRole(role),
        };
      });
    await recordTeamAudit(audit, runtime, principal, "team_projects_listed", resource, {
      ...auditDetails,
      project_count: items.length,
    });
    writeJson(response, 200, { items });
    return;
  }

  if (resource === "permissions" && request.method === "GET") {
    assertNoSearchParameters(url);
    await assertEmptyBody(request);
    await requireTeamRole(audit, runtime, principal, "admin", resource);
    const items = [...runtime.principals.values()]
      .map((candidate) => ({
        ...publicPermission(candidate),
        permission_scope: "team",
        organization_id: organizationId,
        team_id: teamId,
      }))
      .sort((left, right) => left.principal_id.localeCompare(right.principal_id));
    await recordTeamAudit(audit, runtime, principal, "permissions_listed", resource, auditDetails);
    writeJson(response, 200, { items });
    return;
  }

  if (resource === "permissions:grant" && request.method === "POST") {
    assertNoSearchParameters(url);
    await requireTeamRole(audit, runtime, principal, "admin", resource);
    const body = await readJsonBody(request);
    assertExactBodyKeys(body, ["principal_id", "role"]);
    const targetPrincipalId = parseMutableTeamPrincipalId(body["principal_id"]);
    const role = parseRole(body["role"]);
    const result = await auditedTeamOperation(
      audit,
      runtime,
      principal,
      "permission_granted",
      resource,
      {
        ...auditDetails,
        target_principal_id: targetPrincipalId,
        target_role: role,
      },
      async () =>
        mutateTeamPermissions(runtime, async () => {
          if (runtime.principals.has(targetPrincipalId)) {
            throw new HubRequestError({
              status: 409,
              code: "already_exists",
              message: "The Hub principal already has team access.",
            });
          }
          if (runtime.principals.size >= HUB_SERVER_LIMITS.principalsPerTeam) {
            throw new DataError(
              "resource_exhausted",
              `A Hub team supports at most ${HUB_SERVER_LIMITS.principalsPerTeam} principals.`,
            );
          }
          const bearerToken = issueBearerToken();
          const created: HubPrincipalRuntime = {
            principalId: targetPrincipalId,
            role,
            bearerDigest: digestToken(bearerToken),
          };
          const next = new Map(runtime.principals);
          next.set(targetPrincipalId, created);
          try {
            await runtime.directory.replaceTeamGrants(
              organizationId,
              teamId,
              storedTeamGrants(next),
            );
          } catch (error) {
            created.bearerDigest.fill(0);
            throw error;
          }
          runtime.principals.set(targetPrincipalId, created);
          return { ...publicPermission(created), bearer_token: bearerToken };
        }),
    );
    writeJson(response, 201, result);
    return;
  }

  const rotateMatch = /^permissions\/([^/]+):rotate-token$/.exec(resource);
  if (rotateMatch !== null && request.method === "POST") {
    assertNoSearchParameters(url);
    await requireTeamRole(audit, runtime, principal, "admin", "permissions");
    await assertEmptyBody(request);
    const targetPrincipalId = parsePrincipalId(decodePathComponent(rotateMatch[1] as string));
    const result = await auditedTeamOperation(
      audit,
      runtime,
      principal,
      "permission_token_rotated",
      "permissions",
      { ...auditDetails, target_principal_id: targetPrincipalId },
      async () =>
        mutateTeamPermissions(runtime, async () => {
          const existing = requiredTeamPrincipal(runtime, targetPrincipalId);
          const bearerToken = issueBearerToken();
          const rotated: HubPrincipalRuntime = {
            principalId: existing.principalId,
            role: existing.role,
            bearerDigest: digestToken(bearerToken),
          };
          runtime.principals.set(targetPrincipalId, rotated);
          existing.bearerDigest.fill(0);
          return { ...publicPermission(rotated), bearer_token: bearerToken };
        }),
    );
    writeJson(response, 200, result);
    return;
  }

  const permissionMatch = /^permissions\/([^/]+)$/.exec(resource);
  if (permissionMatch !== null && request.method === "PATCH") {
    assertNoSearchParameters(url);
    await requireTeamRole(audit, runtime, principal, "admin", "permissions");
    const targetPrincipalId = parseMutableTeamPrincipalId(
      decodePathComponent(permissionMatch[1] as string),
    );
    const body = await readJsonBody(request);
    assertExactBodyKeys(body, ["role"]);
    const role = parseRole(body["role"]);
    const result = await auditedTeamOperation(
      audit,
      runtime,
      principal,
      "permission_role_updated",
      "permissions",
      {
        ...auditDetails,
        target_principal_id: targetPrincipalId,
        target_role: role,
      },
      async () =>
        mutateTeamPermissions(runtime, async () => {
          const existing = requiredTeamPrincipal(runtime, targetPrincipalId);
          const updated: HubPrincipalRuntime = {
            principalId: existing.principalId,
            role,
            bearerDigest: existing.bearerDigest,
          };
          const next = new Map(runtime.principals);
          next.set(targetPrincipalId, updated);
          await runtime.directory.replaceTeamGrants(
            organizationId,
            teamId,
            storedTeamGrants(next),
          );
          runtime.principals.set(targetPrincipalId, updated);
          return publicPermission(updated);
        }),
    );
    writeJson(response, 200, result);
    return;
  }

  if (permissionMatch !== null && request.method === "DELETE") {
    assertNoSearchParameters(url);
    await requireTeamRole(audit, runtime, principal, "admin", "permissions");
    await assertEmptyBody(request);
    const targetPrincipalId = parseMutableTeamPrincipalId(
      decodePathComponent(permissionMatch[1] as string),
    );
    await auditedTeamOperation(
      audit,
      runtime,
      principal,
      "permission_revoked",
      "permissions",
      { ...auditDetails, target_principal_id: targetPrincipalId },
      async () =>
        mutateTeamPermissions(runtime, async () => {
          const existing = requiredTeamPrincipal(runtime, targetPrincipalId);
          const next = new Map(runtime.principals);
          next.delete(targetPrincipalId);
          await runtime.directory.replaceTeamGrants(
            organizationId,
            teamId,
            storedTeamGrants(next),
          );
          runtime.principals.delete(targetPrincipalId);
          existing.bearerDigest.fill(0);
        }),
    );
    response.writeHead(204);
    response.end();
    return;
  }

  throw new HubRequestError({
    status: 404,
    code: "not_found",
    message: "The requested Hub team route does not exist.",
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projects: ReadonlyMap<string, HubProjectRuntime>,
  teams: ReadonlyMap<string, HubTeamRuntime>,
  audit: HubAuditStore,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  const teamMatch = /^\/v1\/organizations\/([^/]+)\/teams\/([^/]+)\/(.+)$/.exec(pathname);
  if (teamMatch !== null) {
    const organizationId = decodePathComponent(teamMatch[1] as string);
    const teamId = decodePathComponent(teamMatch[2] as string);
    const team = teams.get(hubTeamKey(organizationId, teamId));
    const principal = team === undefined ? undefined : authorize(request, team.principals.values());
    if (team === undefined || principal === undefined) {
      throw new HubRequestError({
        status: 401,
        code: "unauthenticated",
        message: "A valid Hub bearer token for this team is required.",
      });
    }
    await handleTeamRequest(
      request,
      response,
      url,
      teamMatch[3] as string,
      team,
      principal,
      projects,
      audit,
    );
    return;
  }

  const projectMatch = /^\/v1\/projects\/([^/]+)\/(.+)$/.exec(pathname);
  if (projectMatch === null) {
    throw new HubRequestError({
      status: 404,
      code: "not_found",
      message: "The requested Hub route does not exist.",
    });
  }
  const projectId = decodePathComponent(projectMatch[1] as string);
  const runtime = projects.get(projectId);
  // The token is checked against THIS project, so a token for another
  // namespace is indistinguishable from no token at all.
  const principal = runtime === undefined ? undefined : authorizeProject(request, runtime);
  if (runtime === undefined || principal === undefined) {
    throw new HubRequestError({
      status: 401,
      code: "unauthenticated",
      message: "A valid Hub bearer token for this project is required.",
    });
  }
  const exchange = runtime.exchange;
  const workspace = runtime.project.workspace;
  const objects = runtime.project.objects;
  const resource = projectMatch[2] as string;

  if (resource === "me" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    writeJson(response, 200, {
      principal_id: principal.principalId,
      role: principal.role,
      capabilities: capabilitiesForRole(principal.role),
      credential_scope: principal.credentialScope,
      permission_sources: principal.permissionSources,
      ...(runtime.team === undefined
        ? {}
        : {
            organization_id: runtime.team.team.organization_id,
            team_id: runtime.team.team.team_id,
          }),
    });
    return;
  }

  if (resource === "permissions" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "admin", resource);
    const items = publicProjectPermissions(runtime);
    await audit.record({
      project_id: projectId,
      principal_id: principal.principalId,
      role: principal.role,
      action: "permissions_listed",
      outcome: "succeeded",
      resource,
    });
    writeJson(response, 200, { items });
    return;
  }

  if (resource === "permissions:grant" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "admin", resource);
    const body = await readJsonBody(request);
    assertExactBodyKeys(body, ["principal_id", "role"]);
    const targetPrincipalId = parseMutablePrincipalId(body["principal_id"]);
    const role = parseRole(body["role"]);
    const result = await auditedOperation(
      audit,
      auditContext(projectId, principal, "permission_granted", resource, {
        target_principal_id: targetPrincipalId,
        target_role: role,
      }),
      true,
      () =>
        mutateProjectPermissions(runtime, async () => {
          if (runtime.principals.has(targetPrincipalId)) {
            throw new HubRequestError({
              status: 409,
              code: "already_exists",
              message: "The Hub principal already has project access.",
            });
          }
          if (runtime.principals.size >= HUB_SERVER_LIMITS.principalsPerProject) {
            throw new DataError(
              "resource_exhausted",
              `A Hub project supports at most ${HUB_SERVER_LIMITS.principalsPerProject} principals.`,
            );
          }
          const bearerToken = issueBearerToken();
          const created: HubPrincipalRuntime = {
            principalId: targetPrincipalId,
            role,
            bearerDigest: digestToken(bearerToken),
          };
          const next = new Map(runtime.principals);
          next.set(targetPrincipalId, created);
          try {
            await runtime.permissions.replaceProjectGrants(projectId, storedGrants(next));
          } catch (error) {
            created.bearerDigest.fill(0);
            throw error;
          }
          runtime.principals.set(targetPrincipalId, created);
          return { ...publicPermission(created), bearer_token: bearerToken };
        }),
    );
    writeJson(response, 201, result);
    return;
  }

  const rotatePermissionMatch = /^permissions\/([^/]+):rotate-token$/.exec(resource);
  if (rotatePermissionMatch !== null && request.method === "POST") {
    await requireRole(audit, projectId, principal, "admin", "permissions");
    await assertEmptyBody(request);
    const targetPrincipalId = parsePrincipalId(
      decodePathComponent(rotatePermissionMatch[1] as string),
    );
    const result = await auditedOperation(
      audit,
      auditContext(projectId, principal, "permission_token_rotated", "permissions", {
        target_principal_id: targetPrincipalId,
      }),
      true,
      () =>
        mutateProjectPermissions(runtime, async () => {
          const existing = requiredPrincipal(runtime, targetPrincipalId);
          const bearerToken = issueBearerToken();
          const rotated: HubPrincipalRuntime = {
            principalId: existing.principalId,
            role: existing.role,
            bearerDigest: digestToken(bearerToken),
          };
          runtime.principals.set(targetPrincipalId, rotated);
          existing.bearerDigest.fill(0);
          return { ...publicPermission(rotated), bearer_token: bearerToken };
        }),
    );
    writeJson(response, 200, result);
    return;
  }

  const permissionMatch = /^permissions\/([^/]+)$/.exec(resource);
  if (permissionMatch !== null && request.method === "PATCH") {
    await requireRole(audit, projectId, principal, "admin", "permissions");
    const targetPrincipalId = parseMutablePrincipalId(
      decodePathComponent(permissionMatch[1] as string),
    );
    const body = await readJsonBody(request);
    assertExactBodyKeys(body, ["role"]);
    const role = parseRole(body["role"]);
    const result = await auditedOperation(
      audit,
      auditContext(projectId, principal, "permission_role_updated", "permissions", {
        target_principal_id: targetPrincipalId,
        target_role: role,
      }),
      true,
      () =>
        mutateProjectPermissions(runtime, async () => {
          const existing = requiredPrincipal(runtime, targetPrincipalId);
          const updated: HubPrincipalRuntime = {
            principalId: existing.principalId,
            role,
            bearerDigest: existing.bearerDigest,
          };
          const next = new Map(runtime.principals);
          next.set(targetPrincipalId, updated);
          await runtime.permissions.replaceProjectGrants(projectId, storedGrants(next));
          runtime.principals.set(targetPrincipalId, updated);
          return publicPermission(updated);
        }),
    );
    writeJson(response, 200, result);
    return;
  }

  if (permissionMatch !== null && request.method === "DELETE") {
    await requireRole(audit, projectId, principal, "admin", "permissions");
    await assertEmptyBody(request);
    const targetPrincipalId = parseMutablePrincipalId(
      decodePathComponent(permissionMatch[1] as string),
    );
    await auditedOperation(
      audit,
      auditContext(projectId, principal, "permission_revoked", "permissions", {
        target_principal_id: targetPrincipalId,
      }),
      true,
      () =>
        mutateProjectPermissions(runtime, async () => {
          const existing = requiredPrincipal(runtime, targetPrincipalId);
          const next = new Map(runtime.principals);
          next.delete(targetPrincipalId);
          await runtime.permissions.replaceProjectGrants(projectId, storedGrants(next));
          runtime.principals.delete(targetPrincipalId);
          existing.bearerDigest.fill(0);
        }),
    );
    response.writeHead(204);
    response.end();
    return;
  }

  if (resource === "audit-events" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "admin", resource);
    const pagination = parseEventPagination(url);
    const page = await audit.list({
      project_id: projectId,
      after_sequence: pagination.afterSequence,
      limit: pagination.limit,
    });
    await audit.record({
      project_id: projectId,
      principal_id: principal.principalId,
      role: principal.role,
      action: "audit_listed",
      outcome: "succeeded",
      resource,
      details: { after_sequence: pagination.afterSequence, limit: pagination.limit },
    });
    writeJson(response, 200, page);
    return;
  }

  if (resource === "events" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const pagination = parseEventPagination(url);
    const page = await audit.list({
      project_id: projectId,
      after_sequence: pagination.afterSequence,
      limit: pagination.limit,
      actions: [...HUB_AUDIT_ACTIONS].filter(isCollaborationAction),
      outcomes: ["succeeded"],
    });
    writeJson(response, 200, {
      items: page.items.map(collaborationEvent),
      next_cursor: page.next_cursor,
    });
    return;
  }

  if (resource === "refs" && request.method === "GET") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const page = await auditedOperation(
      audit,
      auditContext(projectId, principal, "refs_listed", resource),
      false,
      async () => {
        const unit = workspace.beginUnitOfWork("read");
        try {
          return unit.versions.listRefs();
        } finally {
          unit.rollback();
        }
      },
    );
    writeJson(response, 200, { items: page.items } as unknown as JsonObject);
    return;
  }

  if (resource === "refs:resolve" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const body = await readJsonBody(request);
    const name = body["name"];
    if (typeof name !== "string" || name.length === 0 || name.length > 255) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "refs:resolve requires a bounded ref name.",
      });
    }
    const ref = await auditedOperation(
      audit,
      auditContext(projectId, principal, "ref_resolved", resource, { ref_name: name }),
      false,
      async () => {
        const unit = workspace.beginUnitOfWork("read");
        try {
          return unit.versions.resolveRef(name);
        } finally {
          unit.rollback();
        }
      },
    );
    writeJson(response, 200, ref as unknown as JsonObject);
    return;
  }

  if (resource === "refs:update" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "maintainer", resource);
    const body = await readJsonBody(request);
    const name = body["name"];
    const commitId = body["commit_id"];
    const precondition = body["precondition"];
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 255 ||
      typeof commitId !== "string" ||
      precondition === null ||
      typeof precondition !== "object" ||
      Array.isArray(precondition)
    ) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "refs:update requires name, commit_id, and an explicit precondition.",
      });
    }
    const ref = await auditedOperation(
      audit,
      auditContext(projectId, principal, "ref_updated", resource, { ref_name: name }),
      true,
      async () => {
        const unit = workspace.beginUnitOfWork("write");
        try {
          const updated = unit.versions.updateRef(name, commitId, precondition as never);
          unit.commit();
          return updated;
        } catch (error) {
          try {
            unit.rollback();
          } catch {
            // The original failure is the meaningful error.
          }
          throw error;
        }
      },
    );
    writeJson(response, 200, ref as unknown as JsonObject);
    return;
  }

  if (resource === "packs:import" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "maintainer", resource);
    if (request.headers["content-type"] !== PACK_MEDIA_TYPE) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: `Pack imports require the ${PACK_MEDIA_TYPE} media type.`,
      });
    }
    const result = await auditedOperation(
      audit,
      auditContext(projectId, principal, "pack_imported", resource),
      true,
      async () => {
        const stream = (async function* () {
          let received = 0;
          for await (const chunk of request) {
            const bytes = chunk as Buffer;
            received += bytes.byteLength;
            if (received > MAXIMUM_PACK_BYTES) {
              throw new DataError("resource_exhausted", "The pack exceeds the Hub upload limit.");
            }
            yield bytes;
          }
        })();
        // Metadata must match exportPack's exactly: the same deterministic
        // bytes re-exported later would otherwise conflict on immutable metadata.
        const pack = await objects.put(stream, {
          media_type: PACK_MEDIA_TYPE,
          compression: "none",
          logical_name: PACK_LOGICAL_NAME,
        });
        if (pack.byte_size === 0) {
          throw new HubRequestError({
            status: 400,
            code: "invalid_argument",
            message: "An empty pack upload is not a valid container.",
          });
        }
        workspace.registerVerifiedObjects([pack]);
        return await exchange.importPack({ pack });
      },
    );
    writeJson(response, 201, result as unknown as JsonObject);
    return;
  }

  if (resource === "packs:export" && request.method === "POST") {
    await requireRole(audit, projectId, principal, "viewer", resource);
    const body = await readJsonBody(request);
    assertExportCommand(body);
    // Streamed, never persisted: one stored object per export would let any
    // caller grow the Hub's disk without bound.
    const context = auditContext(projectId, principal, "pack_exported", resource);
    try {
      const bytes = await exchange.exportPackBytes(
        body as unknown as Parameters<PackExchangeService["exportPackBytes"]>[0],
      );
      response.writeHead(200, { "content-type": PACK_MEDIA_TYPE });
      for await (const chunk of bytes) {
        if (!response.write(chunk)) {
          const settled = new AbortController();
          try {
            await Promise.race([
              once(response, "drain", { signal: settled.signal }).catch(() => {}),
              once(response, "close", { signal: settled.signal }).catch(() => {}),
            ]);
          } finally {
            settled.abort();
          }
        }
        if (response.destroyed) {
          throw new HubRequestError({
            status: 499,
            code: "connection_closed",
            message: "The Hub pack export connection closed before completion.",
          });
        }
      }
      await audit.record({ ...context, outcome: "succeeded" });
      response.end();
    } catch (error) {
      await audit.record({
        ...context,
        outcome: "failed",
        details: { ...(context.details ?? {}), error_code: publicErrorCode(error) },
      });
      throw error;
    }
    return;
  }

  throw new HubRequestError({
    status: 404,
    code: "not_found",
    message: "The requested Hub route does not exist.",
  });
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "The Hub path contains invalid percent encoding.",
    });
  }
}

function authorize(
  request: IncomingMessage,
  principals: Iterable<HubPrincipalRuntime>,
): HubPrincipalRuntime | undefined {
  const header = request.headers.authorization;
  const match =
    typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{1,1024})$/i.exec(header) : null;
  const candidate = digestToken(match?.[1] ?? "");
  let authorized: HubPrincipalRuntime | undefined;
  for (const principal of principals) {
    if (match !== null && timingSafeEqual(candidate, principal.bearerDigest)) {
      authorized = principal;
    }
  }
  candidate.fill(0);
  return authorized;
}

function authorizeProject(
  request: IncomingMessage,
  runtime: HubProjectRuntime,
): HubAuthorizedPrincipal | undefined {
  const directCredential = authorize(request, runtime.principals.values());
  const teamCredential =
    runtime.team === undefined ? undefined : authorize(request, runtime.team.principals.values());
  const credential = directCredential ?? teamCredential;
  if (credential === undefined) {
    return undefined;
  }
  const direct = runtime.principals.get(credential.principalId);
  const inherited = runtime.team?.principals.get(credential.principalId);
  const permissionSources: HubPermissionSource[] = [];
  if (direct !== undefined) {
    permissionSources.push({ scope: "project", role: direct.role });
  }
  if (inherited !== undefined && runtime.team !== undefined) {
    permissionSources.push({
      scope: "team",
      role: inherited.role,
      organization_id: runtime.team.team.organization_id,
      team_id: runtime.team.team.team_id,
    });
  }
  return {
    principalId: credential.principalId,
    role: permissionSources.reduce(
      (role, source) => higherRole(role, source.role),
      "viewer" as HubRole,
    ),
    bearerDigest: credential.bearerDigest,
    credentialScope: directCredential === undefined ? "team" : "project",
    permissionSources,
  };
}

function runtimePrincipals(
  grants: readonly HubIssuedAccessGrant[],
): Map<string, HubPrincipalRuntime> {
  return new Map(
    grants.map((grant) => [
      grant.principal_id,
      {
        principalId: grant.principal_id,
        role: grant.role,
        bearerDigest: digestToken(grant.bearerToken),
      },
    ]),
  );
}

function issueProjectAccess(project: HubProject): {
  readonly bootstrapAdminToken: string;
  readonly bootstrapViewerToken: string;
  readonly accessGrants: readonly HubIssuedAccessGrant[];
} {
  if ((project.access?.length ?? 0) > HUB_SERVER_LIMITS.principalsPerProject - 2) {
    throw new DataError(
      "resource_exhausted",
      `A Hub project supports at most ${HUB_SERVER_LIMITS.principalsPerProject} principals.`,
    );
  }
  const bootstrapAdminToken = issueBearerToken();
  const bootstrapViewerToken = issueBearerToken();
  const accessGrants: HubIssuedAccessGrant[] = [
    {
      principal_id: "hub-bootstrap-admin",
      role: "admin",
      bearerToken: bootstrapAdminToken,
    },
    {
      principal_id: "hub-bootstrap-viewer",
      role: "viewer",
      bearerToken: bootstrapViewerToken,
    },
  ];
  const principals = new Set(accessGrants.map((grant) => grant.principal_id));
  for (const grant of project.access ?? []) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(grant.principal_id) ||
      !HUB_ROLES.includes(grant.role) ||
      principals.has(grant.principal_id)
    ) {
      throw new DataError(
        "invalid_argument",
        "Hub access grants require unique bounded principals and supported roles.",
      );
    }
    principals.add(grant.principal_id);
    accessGrants.push({
      principal_id: grant.principal_id,
      role: grant.role,
      bearerToken: issueBearerToken(),
    });
  }
  return { bootstrapAdminToken, bootstrapViewerToken, accessGrants };
}

function issueTeamAccess(team: HubTeam): {
  readonly bootstrapAdminToken: string;
  readonly bootstrapViewerToken: string;
  readonly accessGrants: readonly HubIssuedAccessGrant[];
} {
  if ((team.access?.length ?? 0) > HUB_SERVER_LIMITS.principalsPerTeam - 2) {
    throw new DataError(
      "resource_exhausted",
      `A Hub team supports at most ${HUB_SERVER_LIMITS.principalsPerTeam} principals.`,
    );
  }
  const bootstrapAdminToken = issueBearerToken();
  const bootstrapViewerToken = issueBearerToken();
  const accessGrants: HubIssuedAccessGrant[] = [
    {
      principal_id: "hub-team-bootstrap-admin",
      role: "admin",
      bearerToken: bootstrapAdminToken,
    },
    {
      principal_id: "hub-team-bootstrap-viewer",
      role: "viewer",
      bearerToken: bootstrapViewerToken,
    },
  ];
  const principals = new Set(accessGrants.map((grant) => grant.principal_id));
  for (const grant of team.access ?? []) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(grant.principal_id) ||
      !HUB_ROLES.includes(grant.role) ||
      principals.has(grant.principal_id)
    ) {
      throw new DataError(
        "invalid_argument",
        "Hub team grants require unique bounded principals and supported roles.",
      );
    }
    principals.add(grant.principal_id);
    accessGrants.push({
      principal_id: grant.principal_id,
      role: grant.role,
      bearerToken: issueBearerToken(),
    });
  }
  return { bootstrapAdminToken, bootstrapViewerToken, accessGrants };
}

async function mutateProjectPermissions<T>(
  runtime: HubProjectRuntime,
  operation: () => Promise<T>,
): Promise<T> {
  const result = runtime.permissionMutation.then(operation);
  runtime.permissionMutation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function mutateTeamPermissions<T>(
  runtime: HubTeamRuntime,
  operation: () => Promise<T>,
): Promise<T> {
  const result = runtime.permissionMutation.then(operation);
  runtime.permissionMutation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function requiredPrincipal(
  runtime: HubProjectRuntime,
  principalId: string,
): HubPrincipalRuntime {
  const principal = runtime.principals.get(principalId);
  if (principal === undefined) {
    throw new HubRequestError({
      status: 404,
      code: "not_found",
      message: "The Hub principal does not have project access.",
    });
  }
  return principal;
}

function requiredTeamPrincipal(
  runtime: HubTeamRuntime,
  principalId: string,
): HubPrincipalRuntime {
  const principal = runtime.principals.get(principalId);
  if (principal === undefined) {
    throw new HubRequestError({
      status: 404,
      code: "not_found",
      message: "The Hub principal does not have team access.",
    });
  }
  return principal;
}

function storedGrants(
  principals: ReadonlyMap<string, HubPrincipalRuntime>,
): readonly HubStoredAccessGrant[] {
  return [...principals.values()]
    .filter(
      (principal) =>
        principal.principalId !== "hub-bootstrap-admin" &&
        principal.principalId !== "hub-bootstrap-viewer",
    )
    .map((principal) => ({
      principal_id: principal.principalId,
      role: principal.role,
    }))
    .sort((left, right) => left.principal_id.localeCompare(right.principal_id));
}

function storedTeamGrants(
  principals: ReadonlyMap<string, HubPrincipalRuntime>,
): readonly HubStoredTeamGrant[] {
  return [...principals.values()]
    .filter(
      (principal) =>
        principal.principalId !== "hub-team-bootstrap-admin" &&
        principal.principalId !== "hub-team-bootstrap-viewer",
    )
    .map((principal) => ({
      principal_id: principal.principalId,
      role: principal.role,
    }))
    .sort((left, right) => left.principal_id.localeCompare(right.principal_id));
}

function publicPermission(principal: HubPrincipalRuntime): PublicHubPermission {
  return {
    principal_id: principal.principalId,
    role: principal.role,
    capabilities: capabilitiesForRole(principal.role),
  };
}

function publicProjectPermissions(runtime: HubProjectRuntime): readonly JsonObject[] {
  const principalIds = new Set(runtime.principals.keys());
  for (const principalId of runtime.team?.principals.keys() ?? []) {
    principalIds.add(principalId);
  }
  return [...principalIds]
    .sort()
    .map((principalId) => {
      const direct = runtime.principals.get(principalId);
      const inherited = runtime.team?.principals.get(principalId);
      const role = effectiveRoleForPrincipal(runtime, principalId);
      const sources: HubPermissionSource[] = [];
      if (direct !== undefined) {
        sources.push({ scope: "project", role: direct.role });
      }
      if (inherited !== undefined && runtime.team !== undefined) {
        sources.push({
          scope: "team",
          role: inherited.role,
          organization_id: runtime.team.team.organization_id,
          team_id: runtime.team.team.team_id,
        });
      }
      return {
        principal_id: principalId,
        role,
        capabilities: capabilitiesForRole(role),
        permission_sources: sources,
      };
    });
}

function parseMutablePrincipalId(value: unknown): string {
  const principalId = parsePrincipalId(value);
  if (principalId === "hub-bootstrap-admin" || principalId === "hub-bootstrap-viewer") {
    throw new HubRequestError({
      status: 409,
      code: "conflict",
      message: "Bootstrap Hub grants cannot be added, changed, or revoked.",
    });
  }
  return principalId;
}

function parseMutableTeamPrincipalId(value: unknown): string {
  const principalId = parsePrincipalId(value);
  if (
    principalId === "hub-team-bootstrap-admin" ||
    principalId === "hub-team-bootstrap-viewer"
  ) {
    throw new HubRequestError({
      status: 409,
      code: "conflict",
      message: "Bootstrap Hub team grants cannot be added, changed, or revoked.",
    });
  }
  return principalId;
}

function parsePrincipalId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "A bounded Hub principal identifier is required.",
    });
  }
  return value;
}

function parseRole(value: unknown): HubRole {
  if (typeof value !== "string" || !HUB_ROLES.includes(value as HubRole)) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "A supported Hub role is required.",
    });
  }
  return value as HubRole;
}

function assertExactBodyKeys(body: JsonObject, expected: readonly string[]): void {
  const keys = Object.keys(body).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "The Hub permission request contains unsupported fields.",
    });
  }
}

function issueBearerToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

const HUB_ROLE_ORDER: Readonly<Record<HubRole, number>> = {
  viewer: 0,
  contributor: 1,
  reviewer: 2,
  maintainer: 3,
  admin: 4,
};

function higherRole(left: HubRole, right: HubRole): HubRole {
  return HUB_ROLE_ORDER[left] >= HUB_ROLE_ORDER[right] ? left : right;
}

function hubTeamKey(organizationId: string, teamId: string): string {
  return `${organizationId}\u0000${teamId}`;
}

function effectiveRoleForPrincipal(runtime: HubProjectRuntime, principalId: string): HubRole {
  const direct = runtime.principals.get(principalId)?.role;
  const inherited = runtime.team?.principals.get(principalId)?.role;
  if (direct === undefined) {
    return inherited ?? "viewer";
  }
  return inherited === undefined ? direct : higherRole(direct, inherited);
}

async function requireRole(
  audit: HubAuditStore,
  projectId: string,
  principal: HubPrincipalRuntime,
  required: HubRole,
  resource: string,
): Promise<void> {
  if (HUB_ROLE_ORDER[principal.role] >= HUB_ROLE_ORDER[required]) {
    return;
  }
  await audit.record({
    project_id: projectId,
    principal_id: principal.principalId,
    role: principal.role,
    action: "access_denied",
    outcome: "denied",
    resource,
    details: { required_role: required },
  });
  throw new HubRequestError({
    status: 403,
    code: "forbidden",
    message: "The Hub principal does not have permission for this operation.",
  });
}

async function requireTeamRole(
  audit: HubAuditStore,
  runtime: HubTeamRuntime,
  principal: HubPrincipalRuntime,
  required: HubRole,
  resource: string,
): Promise<void> {
  if (HUB_ROLE_ORDER[principal.role] >= HUB_ROLE_ORDER[required]) {
    return;
  }
  await recordTeamAudit(
    audit,
    runtime,
    principal,
    "access_denied",
    resource,
    {
      permission_scope: "team",
      organization_id: runtime.team.organization_id,
      team_id: runtime.team.team_id,
      required_role: required,
    },
    "denied",
  );
  throw new HubRequestError({
    status: 403,
    code: "forbidden",
    message: "The Hub principal does not have permission for this team operation.",
  });
}

function capabilitiesForRole(role: HubRole): readonly string[] {
  const capabilities = ["refs.read", "packs.export", "events.read"];
  if (HUB_ROLE_ORDER[role] >= HUB_ROLE_ORDER.contributor) {
    capabilities.push("collaboration.contribute");
  }
  if (HUB_ROLE_ORDER[role] >= HUB_ROLE_ORDER.reviewer) {
    capabilities.push("collaboration.review");
  }
  if (HUB_ROLE_ORDER[role] >= HUB_ROLE_ORDER.maintainer) {
    capabilities.push("refs.update", "packs.import", "retention.manage");
  }
  if (role === "admin") {
    capabilities.push("permissions.read", "permissions.write", "tokens.rotate", "audit.read");
  }
  return capabilities;
}

type AuditOperationContext = Omit<RecordHubAuditEvent, "outcome">;

function auditContext(
  projectId: string,
  principal: HubPrincipalRuntime,
  action: HubAuditAction,
  resource: string,
  details: JsonObject = {},
): AuditOperationContext {
  return {
    project_id: projectId,
    principal_id: principal.principalId,
    role: principal.role,
    action,
    resource,
    details,
  };
}

async function auditedOperation<T>(
  audit: HubAuditStore,
  context: AuditOperationContext,
  mutating: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (mutating) {
    await audit.record({ ...context, outcome: "attempted" });
  }
  try {
    const result = await operation();
    await audit.record({ ...context, outcome: "succeeded" });
    return result;
  } catch (error) {
    await audit.record({
      ...context,
      outcome: "failed",
      details: { ...(context.details ?? {}), error_code: publicErrorCode(error) },
    });
    throw error;
  }
}

async function auditedTeamOperation<T>(
  audit: HubAuditStore,
  runtime: HubTeamRuntime,
  principal: HubPrincipalRuntime,
  action: HubAuditAction,
  resource: string,
  details: JsonObject,
  operation: () => Promise<T>,
): Promise<T> {
  await recordTeamAudit(audit, runtime, principal, action, resource, details, "attempted");
  try {
    const result = await operation();
    await recordTeamAudit(audit, runtime, principal, action, resource, details, "succeeded");
    return result;
  } catch (error) {
    await recordTeamAudit(
      audit,
      runtime,
      principal,
      action,
      resource,
      { ...details, error_code: publicErrorCode(error) },
      "failed",
    );
    throw error;
  }
}

async function recordTeamAudit(
  audit: HubAuditStore,
  runtime: HubTeamRuntime,
  principal: HubPrincipalRuntime,
  action: HubAuditAction,
  resource: string,
  details: JsonObject,
  outcome: HubAuditOutcome = "succeeded",
): Promise<void> {
  for (const projectId of [...runtime.projectIds].sort()) {
    await audit.record({
      project_id: projectId,
      principal_id: principal.principalId,
      role: principal.role,
      action,
      outcome,
      resource,
      details,
    });
  }
}

function publicErrorCode(error: unknown): string {
  if (error instanceof HubRequestError || isDataError(error)) {
    return error.code;
  }
  return "internal";
}

function parseEventPagination(url: URL): { readonly afterSequence: number; readonly limit: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== "cursor" && key !== "limit") {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "Hub event pagination accepts only cursor and limit.",
      });
    }
  }
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "Hub event pagination values must be unique.",
    });
  }
  const cursor = url.searchParams.get("cursor") ?? "0";
  const limitSource = url.searchParams.get("limit") ?? "100";
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(cursor) || !/^[1-9][0-9]{0,2}$/.test(limitSource)) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "Hub event pagination is invalid.",
    });
  }
  const afterSequence = Number(cursor);
  const limit = Number(limitSource);
  if (!Number.isSafeInteger(afterSequence) || limit > 500) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "Hub event pagination is invalid.",
    });
  }
  return { afterSequence, limit };
}

function isCollaborationAction(action: HubAuditAction): boolean {
  return (
    action === "ref_updated" ||
    action === "pack_imported" ||
    action === "pack_exported" ||
    action === "permission_granted" ||
    action === "permission_role_updated" ||
    action === "permission_revoked" ||
    action === "permission_token_rotated"
  );
}

function collaborationEvent(event: HubAuditEvent): JsonObject {
  const kind =
    event.action === "ref_updated"
      ? "RefUpdated"
      : event.action === "pack_imported"
        ? "HubPackImported"
        : event.action === "pack_exported"
          ? "HubPackExported"
          : "PermissionChanged";
  return {
    event_id: event.event_id,
    sequence: event.sequence,
    occurred_at: event.occurred_at,
    kind,
    actor: { principal_id: event.principal_id, role: event.role ?? "viewer" },
    resource: event.resource,
    details: event.details,
  };
}

function assertNoSearchParameters(url: URL): void {
  if ([...url.searchParams.keys()].length !== 0) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "This Hub operation does not accept search parameters.",
    });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    received += bytes.byteLength;
    if (received > MAXIMUM_JSON_BODY_BYTES) {
      throw new HubRequestError({
        status: 400,
        code: "resource_exhausted",
        message: "The request body exceeds the Hub limit.",
      });
    }
    chunks.push(bytes);
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const parsed = JSON.parse(source) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JsonObject;
  } catch {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "The request body must be a JSON object.",
    });
  }
}

async function assertEmptyBody(request: IncomingMessage): Promise<void> {
  for await (const chunk of request) {
    if ((chunk as Buffer).byteLength > 0) {
      throw new HubRequestError({
        status: 400,
        code: "invalid_argument",
        message: "This Hub operation does not accept a request body.",
      });
    }
  }
}

function writeJson(response: ServerResponse, status: number, body: JsonObject): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  let status = 500;
  let code = "internal";
  let message = "The Hub could not complete the request.";
  if (error instanceof HubRequestError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (isDataError(error)) {
    code = error.code;
    message = error.message;
    status =
      error.code === "invalid_argument"
        ? 400
        : error.code === "not_found"
          ? 404
          : error.code === "conflict" || error.code === "already_exists"
            ? 409
            : error.code === "resource_exhausted"
              ? 413
              : error.code === "unsupported"
                ? 501
                : 500;
  }
  writeJson(response, status, { error: { code, message } });
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
}

/** Export commands come from the network: their shape is not assumed. */
function assertExportCommand(body: JsonObject): void {
  const refNames = body["ref_names"];
  const commitIds = body["commit_ids"];
  const prerequisites = body["prerequisite_commit_ids"];
  const message = body["message"];
  const isStringArray = (value: unknown): boolean =>
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 64 &&
      value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256));
  if (
    !isStringArray(refNames) ||
    !isStringArray(commitIds) ||
    !isStringArray(prerequisites) ||
    body["created_by"] === null ||
    typeof body["created_by"] !== "object" ||
    Array.isArray(body["created_by"]) ||
    (message !== undefined &&
      (typeof message !== "string" || message.length === 0 || message.length > 2048))
  ) {
    throw new HubRequestError({
      status: 400,
      code: "invalid_argument",
      message: "packs:export requires bounded ref names, commit ids, and an actor.",
    });
  }
}
