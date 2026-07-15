import {
  DataError,
  type ImportPackResult,
  type JsonObject,
  type Ref,
  type WorkspaceDataSource,
} from "../../data/api/index.js";

export interface WorkspaceSyncRemote {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly projectId: string;
}

export interface WorkspaceSyncIdentity extends JsonObject {
  readonly principal_id: string;
  readonly role: "viewer" | "contributor" | "reviewer" | "maintainer" | "admin";
  readonly capabilities: readonly string[];
  readonly credential_scope: "project" | "team";
  readonly permission_sources: readonly JsonObject[];
  readonly organization_id?: string;
  readonly team_id?: string;
}

export interface WorkspaceSyncProject extends JsonObject {
  readonly project_id: string;
  readonly organization_id?: string;
  readonly team_id?: string;
  readonly role: WorkspaceSyncIdentity["role"];
  readonly capabilities: readonly string[];
}

export interface WorkspaceSyncActivityEvent extends JsonObject {
  readonly event_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly kind: "RefUpdated" | "HubPackImported" | "HubPackExported" | "PermissionChanged";
  readonly actor: JsonObject;
  readonly resource: string;
  readonly details: JsonObject;
}

export interface WorkspaceSyncActivityPage extends JsonObject {
  readonly items: readonly WorkspaceSyncActivityEvent[];
  readonly next_cursor: string;
}

export interface WorkspaceSyncPushResult {
  readonly import: ImportPackResult;
  readonly advanced_refs: readonly Ref[];
  readonly remaining_conflicts: ImportPackResult["conflicting_refs"];
}

export interface WorkspaceSyncFetchResult {
  readonly import: ImportPackResult;
  readonly advanced_refs: readonly Ref[];
  readonly remaining_conflicts: ImportPackResult["conflicting_refs"];
}

/** Low-level remote transport supplied by `data/sync` at the composition root. */
export interface WorkspaceSyncPort {
  listRemoteRefs(remote: WorkspaceSyncRemote): Promise<{ readonly remote_refs: readonly Ref[] }>;
  getIdentity(remote: WorkspaceSyncRemote): Promise<WorkspaceSyncIdentity>;
  listAccessibleProjects(
    remote: WorkspaceSyncRemote,
    identity?: WorkspaceSyncIdentity,
  ): Promise<readonly WorkspaceSyncProject[]>;
  listActivity(
    remote: WorkspaceSyncRemote,
    options?: { readonly after_sequence?: number; readonly limit?: number },
  ): Promise<WorkspaceSyncActivityPage>;
  fetch(command: {
    readonly remote: WorkspaceSyncRemote;
    readonly ref_names: readonly string[];
    readonly created_by: JsonObject;
  }): Promise<ImportPackResult>;
  push(command: {
    readonly remote: WorkspaceSyncRemote;
    readonly ref_names: readonly string[];
    readonly created_by: JsonObject;
    readonly message?: string;
  }): Promise<WorkspaceSyncPushResult>;
}

export type SyncRefRelation =
  | "synced"
  | "local_only"
  | "remote_only"
  | "local_ahead"
  | "remote_ahead"
  | "diverged"
  | "unknown";

export interface SyncRefStatus extends JsonObject {
  readonly name: string;
  readonly local_commit_id?: string;
  readonly remote_commit_id?: string;
  readonly relation: SyncRefRelation;
}

export interface WorkspaceSyncStatus extends JsonObject {
  readonly remote: JsonObject & { readonly base_url: string; readonly project_id: string };
  readonly identity: WorkspaceSyncIdentity;
  readonly accessible_projects: readonly WorkspaceSyncProject[];
  readonly refs: readonly SyncRefStatus[];
}

export interface WorkspaceSyncStatusCommand {
  readonly remote: WorkspaceSyncRemote;
  readonly ref_names?: readonly string[];
}

export interface WorkspaceSyncFetchCommand {
  readonly remote: WorkspaceSyncRemote;
  readonly ref_names: readonly string[];
  readonly created_by: JsonObject;
}

export interface WorkspaceSyncPushCommand extends WorkspaceSyncFetchCommand {
  readonly message?: string;
}

export interface WorkspaceSyncFetchOutcome {
  readonly result: WorkspaceSyncFetchResult;
  readonly status: WorkspaceSyncStatus;
}

export interface WorkspaceSyncPushOutcome {
  readonly result: WorkspaceSyncPushResult;
  readonly status: WorkspaceSyncStatus;
}

/**
 * Product-level Hub synchronization. It combines remote identity/discovery,
 * immutable pack transfer, local/remote ref comparison, conflict surfacing,
 * and the safe activity feed without exposing transport details to Studio.
 */
export class WorkspaceSyncEngine {
  readonly #workspace: WorkspaceDataSource;
  readonly #remote: WorkspaceSyncPort;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly workspace: WorkspaceDataSource; readonly remote: WorkspaceSyncPort }) {
    this.#workspace = options.workspace;
    this.#remote = options.remote;
  }

  async getStatus(command: WorkspaceSyncStatusCommand): Promise<WorkspaceSyncStatus> {
    const identity = await this.#remote.getIdentity(command.remote);
    const [remoteRefs, projects] = await Promise.all([
      this.#remote.listRemoteRefs(command.remote),
      this.#remote.listAccessibleProjects(command.remote, identity),
    ]);
    const localRefs = this.#listLocalRefs();
    const selectedNames = normalizeSelectedRefNames(command.ref_names, localRefs, remoteRefs.remote_refs);
    const localByName = new Map(localRefs.map((ref) => [ref.name, ref]));
    const remoteByName = new Map(remoteRefs.remote_refs.map((ref) => [ref.name, ref]));
    return {
      remote: { base_url: command.remote.baseUrl, project_id: command.remote.projectId },
      identity,
      accessible_projects: projects,
      refs: selectedNames.map((name) =>
        this.#compareRefs(name, localByName.get(name), remoteByName.get(name)),
      ),
    };
  }

  async fetch(command: WorkspaceSyncFetchCommand): Promise<WorkspaceSyncFetchOutcome> {
    assertRefNames(command.ref_names);
    return await this.#serializeMutation(async () => {
      const imported = await this.#remote.fetch(command);
      const reconciled = this.#advanceFetchedRefs(imported.conflicting_refs);
      const result: WorkspaceSyncFetchResult = {
        import: imported,
        advanced_refs: reconciled.advanced,
        remaining_conflicts: reconciled.remaining,
      };
      const status = this.#applyProvenConflicts(
        await this.getStatus({ remote: command.remote, ref_names: command.ref_names }),
        result.remaining_conflicts,
      );
      return { result, status };
    });
  }

  async push(command: WorkspaceSyncPushCommand): Promise<WorkspaceSyncPushOutcome> {
    assertRefNames(command.ref_names);
    return await this.#serializeMutation(async () => {
      const result = await this.#remote.push(command);
      const status = this.#applyProvenConflicts(
        await this.getStatus({ remote: command.remote, ref_names: command.ref_names }),
        result.remaining_conflicts,
      );
      return { result, status };
    });
  }

  async listActivity(
    command: WorkspaceSyncStatusCommand & {
      readonly after_sequence?: number;
      readonly limit?: number;
    },
  ): Promise<WorkspaceSyncActivityPage> {
    return await this.#remote.listActivity(command.remote, {
      ...(command.after_sequence === undefined ? {} : { after_sequence: command.after_sequence }),
      ...(command.limit === undefined ? {} : { limit: command.limit }),
    });
  }

  #listLocalRefs(): readonly Ref[] {
    const unit = this.#workspace.beginUnitOfWork("read");
    try {
      return unit.versions.listRefs().items;
    } finally {
      unit.rollback();
    }
  }

  /** Explicit fetch advances only refs whose current target is an ancestor. */
  #advanceFetchedRefs(
    conflicts: ImportPackResult["conflicting_refs"],
  ): {
    readonly advanced: readonly Ref[];
    readonly remaining: ImportPackResult["conflicting_refs"];
  } {
    const advanced: Ref[] = [];
    const remaining: ImportPackResult["conflicting_refs"][number][] = [];
    for (const conflict of conflicts) {
      const unit = this.#workspace.beginUnitOfWork("write");
      try {
        if (!isAncestorInUnit(unit.versions, conflict.local_commit_id, conflict.pack_commit_id)) {
          unit.rollback();
          remaining.push(conflict);
          continue;
        }
        const ref = unit.versions.updateRef(conflict.name, conflict.pack_commit_id, {
          mode: "must_match",
          expected_commit_id: conflict.local_commit_id,
        } as never);
        unit.commit();
        advanced.push(ref);
      } catch (error) {
        unit.rollback();
        if (error instanceof DataError && error.code === "conflict") {
          remaining.push(conflict);
          continue;
        }
        throw error;
      }
    }
    return { advanced, remaining };
  }

  /** A transfer conflict is stronger evidence than a status-only history miss. */
  #applyProvenConflicts(
    status: WorkspaceSyncStatus,
    conflicts: ImportPackResult["conflicting_refs"],
  ): WorkspaceSyncStatus {
    const byName = new Map(conflicts.map((conflict) => [conflict.name, conflict]));
    if (byName.size === 0) {
      return status;
    }
    return {
      ...status,
      refs: status.refs.map((ref) => {
        const conflict = byName.get(ref.name);
        return conflict === undefined
          ? ref
          : {
              name: ref.name,
              local_commit_id: conflict.local_commit_id,
              remote_commit_id: conflict.pack_commit_id,
              relation: "diverged" as const,
            };
      }),
    };
  }

  #compareRefs(name: string, local: Ref | undefined, remote: Ref | undefined): SyncRefStatus {
    if (local === undefined) {
      return {
        name,
        ...(remote === undefined ? {} : { remote_commit_id: remote.commit_id }),
        relation: remote === undefined ? "unknown" : "remote_only",
      };
    }
    if (remote === undefined) {
      return { name, local_commit_id: local.commit_id, relation: "local_only" };
    }
    if (local.commit_id === remote.commit_id) {
      return {
        name,
        local_commit_id: local.commit_id,
        remote_commit_id: remote.commit_id,
        relation: "synced",
      };
    }
    const remoteBehindLocal = this.#isAncestor(remote.commit_id, local.commit_id);
    const localBehindRemote = this.#isAncestor(local.commit_id, remote.commit_id);
    const relation =
      remoteBehindLocal === true
        ? "local_ahead"
        : localBehindRemote === true
          ? "remote_ahead"
          : remoteBehindLocal === false && localBehindRemote === false
            ? "diverged"
            : "unknown";
    return {
      name,
      local_commit_id: local.commit_id,
      remote_commit_id: remote.commit_id,
      relation,
    };
  }

  /** `undefined` means history is not present locally yet, not divergence. */
  #isAncestor(ancestorId: string, commitId: string): boolean | undefined {
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
        let commit;
        try {
          commit = unit.versions.getCommit(current);
        } catch (error) {
          if (error instanceof DataError && error.code === "not_found") {
            return undefined;
          }
          throw error;
        }
        queue.push(...commit.manifest.parents);
      }
      return false;
    } finally {
      unit.rollback();
    }
  }

  async #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

function isAncestorInUnit(
  versions: ReturnType<WorkspaceDataSource["beginUnitOfWork"]>["versions"],
  ancestorId: string,
  commitId: string,
): boolean {
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
      queue.push(...versions.getCommit(current).manifest.parents);
    } catch (error) {
      if (error instanceof DataError && error.code === "not_found") {
        return false;
      }
      throw error;
    }
  }
  return false;
}

function normalizeSelectedRefNames(
  requested: readonly string[] | undefined,
  local: readonly Ref[],
  remote: readonly Ref[],
): readonly string[] {
  if (requested !== undefined) {
    assertRefNames(requested);
    return [...requested].sort();
  }
  return [...new Set([...local, ...remote].map((ref) => ref.name))].sort();
}

function assertRefNames(values: readonly string[]): void {
  if (
    values.length === 0 ||
    values.length > 64 ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        !/^(?:users|teams|builds|baselines|releases)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/.test(
          value,
        ),
    )
  ) {
    throw new DataError("invalid_argument", "Sync ref names must be unique canonical ref names.");
  }
}
