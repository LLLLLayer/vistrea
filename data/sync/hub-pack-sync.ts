import {
  DataError,
  PROTOCOL_SCHEMA_IDS,
  type ImportPackResult,
  type JsonObject,
  type ObjectStore,
  type ProtocolValidator,
  type Ref,
  type WorkspaceDataSource,
} from "../api/index.js";
import { PACK_LOGICAL_NAME, PACK_MEDIA_TYPE, PackExchangeService } from "../exchange/index.js";

// Plain HTTP stays loopback-only so the bearer token never leaves the
// machine unencrypted; HTTPS remotes may live anywhere. The port is optional:
// a deployed Hub answers on the default 443 and states no port, and demanding
// one rejected every real remote while accepting only local test servers.
const REMOTE_URL_PATTERN =
  /^(?:http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)|https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,253}[A-Za-z0-9])?)(?::[0-9]{1,5})?$/;
const MAXIMUM_PACK_BYTES = 256 * 1024 * 1024;

export interface HubRemote {
  /** A loopback Hub origin, for example `http://127.0.0.1:45870`. */
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly projectId: string;
}

export interface HubPackSyncOptions {
  readonly workspace: WorkspaceDataSource;
  readonly objects: ObjectStore;
  readonly validator: ProtocolValidator;
  readonly timeoutMilliseconds?: number;
}

export interface PushRefsCommand {
  readonly remote: HubRemote;
  readonly ref_names: readonly string[];
  readonly created_by: JsonObject;
  readonly message?: string;
}

export interface FetchRefsCommand {
  readonly remote: HubRemote;
  readonly ref_names: readonly string[];
  readonly created_by: JsonObject;
}

export interface HubRefsStatus {
  readonly remote_refs: readonly Ref[];
}

export type HubRole = "viewer" | "contributor" | "reviewer" | "maintainer" | "admin";

export interface HubPermissionSource extends JsonObject {
  readonly scope: "project" | "team";
  readonly role: HubRole;
  readonly organization_id?: string;
  readonly team_id?: string;
}

export interface HubIdentity extends JsonObject {
  readonly principal_id: string;
  readonly role: HubRole;
  readonly capabilities: readonly string[];
  readonly credential_scope: "project" | "team";
  readonly permission_sources: readonly HubPermissionSource[];
  readonly organization_id?: string;
  readonly team_id?: string;
}

export interface HubProjectAccess extends JsonObject {
  readonly project_id: string;
  readonly organization_id?: string;
  readonly team_id?: string;
  readonly role: HubRole;
  readonly capabilities: readonly string[];
}

export interface HubActivityEvent extends JsonObject {
  readonly event_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly kind: "RefUpdated" | "HubPackImported" | "HubPackExported" | "PermissionChanged";
  readonly actor: JsonObject & { readonly principal_id: string; readonly role: HubRole };
  readonly resource: string;
  readonly details: JsonObject;
}

export interface HubActivityPage extends JsonObject {
  readonly items: readonly HubActivityEvent[];
  readonly next_cursor: string;
}

/** The push outcome: the import report plus explicit fast-forward moves. */
export interface PushRefsResult {
  readonly import: ImportPackResult;
  /** Remote refs advanced with a `must_match` precondition (fast-forwards). */
  readonly advanced_refs: readonly Ref[];
  /** Divergent refs left untouched for a human or merge decision. */
  readonly remaining_conflicts: ImportPackResult["conflicting_refs"];
}

/**
 * The first Hub synchronization slice: push and fetch move immutable commits
 * and content-addressed objects as portable packs over the optional Hub's
 * `packs:import`/`packs:export` endpoints. Ref conflicts surface in the
 * import report on the receiving side; nothing is ever forced.
 */
export class HubPackSync {
  readonly #workspace: WorkspaceDataSource;
  readonly #objects: ObjectStore;
  readonly #exchange: PackExchangeService;
  readonly #validator: ProtocolValidator;
  readonly #timeoutMilliseconds: number;

  constructor(options: HubPackSyncOptions) {
    this.#workspace = options.workspace;
    this.#objects = options.objects;
    this.#validator = options.validator;
    this.#exchange = new PackExchangeService({
      data: options.workspace,
      objects: options.objects,
      validator: options.validator,
    });
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  }

  /** Remote refs, for status displays and prerequisite negotiation. */
  async listRemoteRefs(remote: HubRemote): Promise<HubRefsStatus> {
    const value = await this.#requestJson(remote, "GET", "refs", undefined);
    const page = asRecord(value);
    const items = page?.["items"];
    if (
      page === undefined ||
      !hasOnlyKeys(page, ["items"]) ||
      !Array.isArray(items) ||
      items.length > 500
    ) {
      throw new DataError("integrity_error", "The Hub returned an invalid ref listing.");
    }
    const refs = items.map((item) => this.#validateRemoteRef(item));
    if (new Set(refs.map((ref) => ref.name)).size !== refs.length) {
      throw new DataError("integrity_error", "The Hub returned duplicate refs.");
    }
    return { remote_refs: refs };
  }

  /** Effective caller identity and capability projection for the selected project. */
  async getIdentity(remote: HubRemote): Promise<HubIdentity> {
    return validateIdentity(await this.#requestJson(remote, "GET", "me", undefined));
  }

  /**
   * Lists projects visible through a team credential. A project-scoped
   * credential deliberately receives only its selected project instead of
   * attempting a broader team route it is not authorized to call.
   */
  async listAccessibleProjects(
    remote: HubRemote,
    identity?: HubIdentity,
  ): Promise<readonly HubProjectAccess[]> {
    const resolvedIdentity = identity ?? (await this.getIdentity(remote));
    if (
      resolvedIdentity.credential_scope !== "team" ||
      resolvedIdentity.organization_id === undefined ||
      resolvedIdentity.team_id === undefined
    ) {
      return [
        {
          project_id: remote.projectId,
          role: resolvedIdentity.role,
          capabilities: resolvedIdentity.capabilities,
          ...(resolvedIdentity.organization_id === undefined
            ? {}
            : { organization_id: resolvedIdentity.organization_id }),
          ...(resolvedIdentity.team_id === undefined ? {} : { team_id: resolvedIdentity.team_id }),
        },
      ];
    }
    const path =
      `/v1/organizations/${encodeURIComponent(resolvedIdentity.organization_id)}` +
      `/teams/${encodeURIComponent(resolvedIdentity.team_id)}/projects`;
    const value = await this.#requestHubJson(remote, "GET", path, undefined);
    const items = asRecord(value)?.["items"];
    if (!Array.isArray(items)) {
      throw new DataError("integrity_error", "The Hub returned an invalid project listing.");
    }
    if (items.length > 128) {
      throw new DataError("integrity_error", "The Hub returned too many project entries.");
    }
    const projects = items.map(validateProjectAccess);
    if (
      new Set(projects.map((project) => project.project_id)).size !== projects.length ||
      !projects.some((project) => project.project_id === remote.projectId) ||
      projects.some(
        (project) =>
          project.organization_id !== resolvedIdentity.organization_id ||
          project.team_id !== resolvedIdentity.team_id,
      )
    ) {
      throw new DataError("integrity_error", "The Hub returned an inconsistent project listing.");
    }
    return projects;
  }

  /** Safe, token-free collaboration activity after one project-local cursor. */
  async listActivity(
    remote: HubRemote,
    options: { readonly after_sequence?: number; readonly limit?: number } = {},
  ): Promise<HubActivityPage> {
    const parameters = new URLSearchParams();
    if (options.after_sequence !== undefined) {
      parameters.set("cursor", String(options.after_sequence));
    }
    if (options.limit !== undefined) {
      parameters.set("limit", String(options.limit));
    }
    const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    const page = validateActivityPage(
      await this.#requestJson(remote, "GET", `events${suffix}`, undefined),
    );
    const after = options.after_sequence ?? 0;
    const next = Number(page.next_cursor);
    if (
      !Number.isSafeInteger(next) ||
      next < after ||
      page.items.some((event) => event.sequence <= after || event.sequence > next)
    ) {
      throw new DataError("integrity_error", "The Hub returned an invalid activity cursor.");
    }
    return page;
  }

  /**
   * Exports the named local refs, imports them into the Hub, and advances
   * remote refs whose current target is an ancestor of the pushed commit
   * with an explicit `must_match` precondition. Divergent refs stay reported
   * as conflicts; nothing is ever forced.
   */
  async push(command: PushRefsCommand): Promise<PushRefsResult> {
    const pack = await this.#exchange.exportPack({
      ref_names: command.ref_names,
      created_by: command.created_by,
      ...(command.message === undefined ? {} : { message: command.message }),
    });
    this.#workspace.registerVerifiedObjects([pack]);
    const bytes = await this.#readObject(pack.hash);
    const value = await this.#request(
      command.remote,
      "POST",
      "packs:import",
      bytes,
      PACK_MEDIA_TYPE,
    );
    const imported = validateImportResult(value, this.#validator);

    const advanced: Ref[] = [];
    const remaining: ImportPackResult["conflicting_refs"][number][] = [];
    for (const conflict of imported.conflicting_refs) {
      if (this.#isAncestor(conflict.local_commit_id, conflict.pack_commit_id)) {
        const body = Buffer.from(
          JSON.stringify({
            name: conflict.name,
            commit_id: conflict.pack_commit_id,
            precondition: {
              mode: "must_match",
              expected_commit_id: conflict.local_commit_id,
            },
          }),
          "utf8",
        );
        const updated = await this.#requestJson(command.remote, "POST", "refs:update", body);
        advanced.push(this.#validateRemoteRef(updated));
      } else {
        remaining.push(conflict);
      }
    }
    return { import: imported, advanced_refs: advanced, remaining_conflicts: remaining };
  }

  /** True when `ancestorId` is reachable from `commitId` in local history. */
  #isAncestor(ancestorId: string, commitId: string): boolean {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      const seen = new Set<string>();
      const queue = [commitId];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        if (current === ancestorId) {
          return true;
        }
        if (seen.has(current)) {
          continue;
        }
        seen.add(current);
        try {
          const commit = unit.versions.getCommit(current);
          queue.push(...((commit["manifest"] as JsonObject)["parents"] as readonly string[]));
        } catch (error) {
          if (!(error instanceof DataError && error.code === "not_found")) {
            throw error;
          }
        }
      }
      return false;
    } finally {
      unit.rollback();
    }
  }

  /** Asks the Hub to export the named refs and imports the pack locally. */
  async fetch(command: FetchRefsCommand): Promise<ImportPackResult> {
    const body = Buffer.from(
      JSON.stringify({
        ref_names: command.ref_names,
        created_by: command.created_by,
      }),
      "utf8",
    );
    const packBytes = await this.#request(
      command.remote,
      "POST",
      "packs:export",
      body,
      "application/json",
    );
    const pack = await this.#objects.put(
      (async function* () {
        yield packBytes;
      })(),
      { media_type: PACK_MEDIA_TYPE, compression: "none", logical_name: PACK_LOGICAL_NAME },
    );
    this.#workspace.registerVerifiedObjects([pack]);
    return await this.#exchange.importPack({ pack });
  }

  async #requestJson(
    remote: HubRemote,
    method: "GET" | "POST",
    resource: string,
    body?: Buffer,
  ): Promise<unknown> {
    const bytes = await this.#request(remote, method, resource, body, "application/json");
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new DataError("integrity_error", "The Hub returned invalid JSON.");
    }
  }

  async #requestHubJson(
    remote: HubRemote,
    method: "GET" | "POST",
    path: string,
    body?: Buffer,
  ): Promise<unknown> {
    const bytes = await this.#requestHub(remote, method, path, body, "application/json");
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new DataError("integrity_error", "The Hub returned invalid JSON.");
    }
  }

  async #request(
    remote: HubRemote,
    method: "GET" | "POST",
    resource: string,
    body: Buffer | undefined,
    contentType: string,
  ): Promise<Buffer> {
    return await this.#requestHub(
      remote,
      method,
      `/v1/projects/${encodeURIComponent(remote.projectId)}/${resource}`,
      body,
      contentType,
    );
  }

  async #requestHub(
    remote: HubRemote,
    method: "GET" | "POST",
    path: string,
    body: Buffer | undefined,
    contentType: string,
  ): Promise<Buffer> {
    if (
      !REMOTE_URL_PATTERN.test(remote.baseUrl) ||
      !PROJECT_ID_PATTERN.test(remote.projectId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(remote.bearerToken)
    ) {
      throw new DataError(
        "invalid_argument",
        "The Hub remote requires a loopback HTTP or HTTPS origin, a canonical Project ID, and a 43-character bearer token.",
      );
    }
    const route = `${remote.baseUrl}${path}`;
    const abort = AbortSignal.timeout(this.#timeoutMilliseconds);
    let response: Response;
    try {
      response = await fetch(route, {
        method,
        headers: {
          authorization: `Bearer ${remote.bearerToken}`,
          ...(body === undefined ? {} : { "content-type": contentType }),
        },
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
        signal: abort,
      });
    } catch {
      throw new DataError("internal", "The Hub remote is unreachable or timed out.", {
        retryable: true,
      });
    }
    const raw = await readResponseWithLimit(response, MAXIMUM_PACK_BYTES);
    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as {
          error?: { code?: string; message?: string };
        };
        const candidate = parsed.error?.code;
        if (typeof candidate === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(candidate)) {
          code = candidate;
        }
      } catch {
        // The HTTP-derived code stands when the error body is not JSON.
      }
      throw new DataError(
        code === "not_found" ? "not_found" : code === "conflict" ? "conflict" : "internal",
        "The Hub rejected the request.",
        { details: { hub_error_code: code } },
      );
    }
    return raw;
  }

  async #readObject(hash: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.#objects.open(hash)) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Remote refs are untrusted input; anything off-schema is an integrity failure. */
  #validateRemoteRef(value: unknown): Ref {
    try {
      this.#validator.assert(PROTOCOL_SCHEMA_IDS.ref, value);
    } catch {
      throw new DataError("integrity_error", "The Hub returned an invalid ref.");
    }
    return value as Ref;
  }
}

const HUB_ROLES = new Set<HubRole>([
  "viewer",
  "contributor",
  "reviewer",
  "maintainer",
  "admin",
]);
const HUB_ACTIVITY_KINDS = new Set<HubActivityEvent["kind"]>([
  "RefUpdated",
  "HubPackImported",
  "HubPackExported",
  "PermissionChanged",
]);
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PROJECT_ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const COMMIT_ID_PATTERN = /^commit:sha256:[0-9a-f]{64}$/;
const OBJECT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REF_NAME_PATTERN =
  /^(?:users|teams|builds|baselines|releases)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/;

function validateIdentity(value: unknown): HubIdentity {
  const record = asRecord(value);
  const principalId = record?.["principal_id"];
  const role = record?.["role"];
  const capabilities = record?.["capabilities"];
  const credentialScope = record?.["credential_scope"];
  const permissionSources = record?.["permission_sources"];
  const organizationId = record?.["organization_id"];
  const teamId = record?.["team_id"];
  if (
    record === undefined ||
    typeof principalId !== "string" ||
    !PRINCIPAL_ID_PATTERN.test(principalId) ||
    typeof role !== "string" ||
    !HUB_ROLES.has(role as HubRole) ||
    !isCapabilities(capabilities) ||
    (credentialScope !== "project" && credentialScope !== "team") ||
    !Array.isArray(permissionSources) ||
    permissionSources.length > 2 ||
    (organizationId !== undefined &&
      (typeof organizationId !== "string" || !SCOPE_ID_PATTERN.test(organizationId))) ||
    (teamId !== undefined && (typeof teamId !== "string" || !SCOPE_ID_PATTERN.test(teamId))) ||
    (organizationId === undefined) !== (teamId === undefined)
  ) {
    throw new DataError("integrity_error", "The Hub returned an invalid caller identity.");
  }
  const sources = permissionSources.map(validatePermissionSource);
  if (
    credentialScope === "team" &&
    (organizationId === undefined || teamId === undefined || !sources.some((item) => item.scope === "team"))
  ) {
    throw new DataError("integrity_error", "The Hub returned an inconsistent caller identity.");
  }
  return {
    principal_id: principalId,
    role: role as HubRole,
    capabilities,
    credential_scope: credentialScope,
    permission_sources: sources,
    ...(organizationId === undefined ? {} : { organization_id: organizationId }),
    ...(teamId === undefined ? {} : { team_id: teamId }),
  };
}

function validatePermissionSource(value: unknown): HubPermissionSource {
  const record = asRecord(value);
  const scope = record?.["scope"];
  const role = record?.["role"];
  const organizationId = record?.["organization_id"];
  const teamId = record?.["team_id"];
  if (
    record === undefined ||
    (scope !== "project" && scope !== "team") ||
    typeof role !== "string" ||
    !HUB_ROLES.has(role as HubRole) ||
    (organizationId !== undefined &&
      (typeof organizationId !== "string" || !SCOPE_ID_PATTERN.test(organizationId))) ||
    (teamId !== undefined && (typeof teamId !== "string" || !SCOPE_ID_PATTERN.test(teamId))) ||
    (scope === "team" && (organizationId === undefined || teamId === undefined)) ||
    (scope === "project" && (organizationId !== undefined || teamId !== undefined))
  ) {
    throw new DataError("integrity_error", "The Hub returned an invalid permission source.");
  }
  return {
    scope,
    role: role as HubRole,
    ...(organizationId === undefined ? {} : { organization_id: organizationId }),
    ...(teamId === undefined ? {} : { team_id: teamId }),
  };
}

function validateProjectAccess(value: unknown): HubProjectAccess {
  const record = asRecord(value);
  const projectId = record?.["project_id"];
  const organizationId = record?.["organization_id"];
  const teamId = record?.["team_id"];
  const role = record?.["role"];
  const capabilities = record?.["capabilities"];
  if (
    record === undefined ||
    typeof projectId !== "string" ||
    !PROJECT_ID_PATTERN.test(projectId) ||
    (organizationId !== undefined &&
      (typeof organizationId !== "string" || !SCOPE_ID_PATTERN.test(organizationId))) ||
    (teamId !== undefined && (typeof teamId !== "string" || !SCOPE_ID_PATTERN.test(teamId))) ||
    (organizationId === undefined) !== (teamId === undefined) ||
    typeof role !== "string" ||
    !HUB_ROLES.has(role as HubRole) ||
    !isCapabilities(capabilities)
  ) {
    throw new DataError("integrity_error", "The Hub returned an invalid project listing.");
  }
  return {
    project_id: projectId,
    role: role as HubRole,
    capabilities,
    ...(organizationId === undefined ? {} : { organization_id: organizationId }),
    ...(teamId === undefined ? {} : { team_id: teamId }),
  };
}

function validateActivityPage(value: unknown): HubActivityPage {
  const record = asRecord(value);
  const items = record?.["items"];
  const nextCursor = record?.["next_cursor"];
  if (
    record === undefined ||
    !hasOnlyKeys(record, ["items", "next_cursor"]) ||
    !Array.isArray(items) ||
    items.length > 500 ||
    typeof nextCursor !== "string" ||
    !/^(?:0|[1-9][0-9]{0,15})$/.test(nextCursor)
  ) {
    throw new DataError("integrity_error", "The Hub returned an invalid activity page.");
  }
  const events = items.map(validateActivityEvent);
  if (
    new Set(events.map((event) => event.event_id)).size !== events.length ||
    new Set(events.map((event) => event.sequence)).size !== events.length
  ) {
    throw new DataError("integrity_error", "The Hub returned duplicate activity events.");
  }
  return { items: events, next_cursor: nextCursor };
}

function validateActivityEvent(value: unknown): HubActivityEvent {
  const record = asRecord(value);
  const actor = asRecord(record?.["actor"]);
  const kind = record?.["kind"];
  if (
    record === undefined ||
    typeof record["event_id"] !== "string" ||
    !/^hub_audit_[0-9a-f-]{36}$/.test(record["event_id"]) ||
    !Number.isSafeInteger(record["sequence"]) ||
    (record["sequence"] as number) < 1 ||
    typeof record["occurred_at"] !== "string" ||
    !Number.isFinite(Date.parse(record["occurred_at"])) ||
    typeof kind !== "string" ||
    !HUB_ACTIVITY_KINDS.has(kind as HubActivityEvent["kind"]) ||
    actor === undefined ||
    typeof actor["principal_id"] !== "string" ||
    !PRINCIPAL_ID_PATTERN.test(actor["principal_id"]) ||
    typeof actor["role"] !== "string" ||
    !HUB_ROLES.has(actor["role"] as HubRole) ||
    typeof record["resource"] !== "string" ||
    record["resource"].length === 0 ||
    record["resource"].length > 256 ||
    asRecord(record["details"]) === undefined ||
    !hasOnlyKeys(record, [
      "event_id",
      "sequence",
      "occurred_at",
      "kind",
      "actor",
      "resource",
      "details",
    ]) ||
    !hasOnlyKeys(actor, ["principal_id", "role"])
  ) {
    throw new DataError("integrity_error", "The Hub returned an invalid activity event.");
  }
  return {
    event_id: record["event_id"],
    sequence: record["sequence"] as number,
    occurred_at: record["occurred_at"],
    kind: kind as HubActivityEvent["kind"],
    actor: {
      principal_id: actor["principal_id"],
      role: actor["role"] as HubRole,
    },
    resource: record["resource"],
    details: validateActivityDetails(
      kind as HubActivityEvent["kind"],
      record["details"],
    ),
  };
}

function validateActivityDetails(kind: HubActivityEvent["kind"], value: unknown): JsonObject {
  const details = asRecord(value);
  if (details === undefined) {
    throw new DataError("integrity_error", "The Hub returned invalid activity details.");
  }
  if (kind === "HubPackImported" || kind === "HubPackExported") {
    if (!hasOnlyKeys(details, [])) {
      throw new DataError("integrity_error", "The Hub returned invalid pack activity details.");
    }
    return {};
  }
  if (kind === "RefUpdated") {
    const refName = details["ref_name"];
    if (
      !hasOnlyKeys(details, ["ref_name"]) ||
      typeof refName !== "string" ||
      !/^(?:users|teams|builds|baselines|releases)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/.test(
        refName,
      )
    ) {
      throw new DataError("integrity_error", "The Hub returned invalid ref activity details.");
    }
    return { ref_name: refName };
  }
  const organizationId = details["organization_id"];
  const teamId = details["team_id"];
  const targetPrincipalId = details["target_principal_id"];
  const targetRole = details["target_role"];
  if (
    !hasOnlyKeys(details, [
      "organization_id",
      "team_id",
      "target_principal_id",
      "target_role",
    ]) ||
    typeof targetPrincipalId !== "string" ||
    !PRINCIPAL_ID_PATTERN.test(targetPrincipalId) ||
    (targetRole !== undefined &&
      (typeof targetRole !== "string" || !HUB_ROLES.has(targetRole as HubRole))) ||
    (organizationId === undefined) !== (teamId === undefined) ||
    (organizationId !== undefined &&
      (typeof organizationId !== "string" || !SCOPE_ID_PATTERN.test(organizationId))) ||
    (teamId !== undefined && (typeof teamId !== "string" || !SCOPE_ID_PATTERN.test(teamId)))
  ) {
    throw new DataError("integrity_error", "The Hub returned invalid permission activity details.");
  }
  return {
    target_principal_id: targetPrincipalId,
    ...(targetRole === undefined ? {} : { target_role: targetRole }),
    ...(organizationId === undefined ? {} : { organization_id: organizationId }),
    ...(teamId === undefined ? {} : { team_id: teamId }),
  };
}

function isCapabilities(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === "string" && CAPABILITY_PATTERN.test(item))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

function validateImportResult(raw: Buffer, validator: ProtocolValidator): ImportPackResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new DataError("integrity_error", "The Hub returned an invalid import report.");
  }
  const report = asRecord(parsed);
  const mode = report?.["mode"];
  const importedCommitIds = validateReportStringArray(
    report?.["imported_commit_ids"],
    COMMIT_ID_PATTERN,
  );
  const existingCommitIds = validateReportStringArray(
    report?.["existing_commit_ids"],
    COMMIT_ID_PATTERN,
  );
  const importedObjectHashes = validateReportStringArray(
    report?.["imported_object_hashes"],
    OBJECT_HASH_PATTERN,
  );
  const existingObjectHashes = validateReportStringArray(
    report?.["existing_object_hashes"],
    OBJECT_HASH_PATTERN,
  );
  const unchangedRefNames = validateReportStringArray(
    report?.["unchanged_ref_names"],
    REF_NAME_PATTERN,
  );
  const createdRefValues = report?.["created_refs"];
  const conflictValues = report?.["conflicting_refs"];
  if (
    report === undefined ||
    !hasOnlyKeys(report, [
      "mode",
      "imported_commit_ids",
      "existing_commit_ids",
      "imported_object_hashes",
      "existing_object_hashes",
      "created_refs",
      "unchanged_ref_names",
      "conflicting_refs",
    ]) ||
    (mode !== "full" && mode !== "thin") ||
    importedCommitIds === undefined ||
    existingCommitIds === undefined ||
    importedObjectHashes === undefined ||
    existingObjectHashes === undefined ||
    unchangedRefNames === undefined ||
    !Array.isArray(createdRefValues) ||
    createdRefValues.length > 50_000 ||
    !Array.isArray(conflictValues) ||
    conflictValues.length > 50_000
  ) {
    throw new DataError("integrity_error", "The Hub returned an invalid import report.");
  }
  const createdRefs = createdRefValues.map((value) => {
    try {
      validator.assert(PROTOCOL_SCHEMA_IDS.ref, value);
    } catch {
      throw new DataError("integrity_error", "The Hub returned an invalid import report.");
    }
    return value as Ref;
  });
  const conflicts = conflictValues.map((value) => {
    const conflict = asRecord(value);
    const name = conflict?.["name"];
    const packCommitId = conflict?.["pack_commit_id"];
    const localCommitId = conflict?.["local_commit_id"];
    if (
      conflict === undefined ||
      !hasOnlyKeys(conflict, ["name", "pack_commit_id", "local_commit_id"]) ||
      typeof name !== "string" ||
      !REF_NAME_PATTERN.test(name) ||
      typeof packCommitId !== "string" ||
      !COMMIT_ID_PATTERN.test(packCommitId) ||
      typeof localCommitId !== "string" ||
      !COMMIT_ID_PATTERN.test(localCommitId)
    ) {
      throw new DataError("integrity_error", "The Hub returned an invalid import report.");
    }
    return { name, pack_commit_id: packCommitId, local_commit_id: localCommitId };
  });
  return {
    mode,
    imported_commit_ids: importedCommitIds,
    existing_commit_ids: existingCommitIds,
    imported_object_hashes: importedObjectHashes,
    existing_object_hashes: existingObjectHashes,
    created_refs: createdRefs,
    unchanged_ref_names: unchangedRefNames,
    conflicting_refs: conflicts,
  };
}

function validateReportStringArray(
  value: unknown,
  pattern: RegExp,
): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length <= 50_000 &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === "string" && pattern.test(item))
    ? (value as readonly string[])
    : undefined;
}

/** Streams the response body so the transfer limit bounds memory, not just the result. */
async function readResponseWithLimit(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new DataError("resource_exhausted", "The Hub response exceeds the transfer limit.");
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new DataError("resource_exhausted", "The Hub response exceeds the transfer limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
