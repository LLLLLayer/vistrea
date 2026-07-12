import {
  DataError,
  type ImportPackResult,
  type JsonObject,
  type ObjectStore,
  type ProtocolValidator,
  type Ref,
  type WorkspaceDataSource,
} from "../api/index.js";
import { PACK_MEDIA_TYPE, PackExchangeService } from "../exchange/index.js";

const LOOPBACK_URL_PATTERN = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):[0-9]{1,5}$/;
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
  readonly #timeoutMilliseconds: number;

  constructor(options: HubPackSyncOptions) {
    this.#workspace = options.workspace;
    this.#objects = options.objects;
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
    const items = (value as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      throw new DataError("integrity_error", "The Hub returned an invalid ref listing.");
    }
    return { remote_refs: items as readonly Ref[] };
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
    const imported = JSON.parse(value.toString("utf8")) as ImportPackResult;

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
        advanced.push(updated as Ref);
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
      { media_type: PACK_MEDIA_TYPE, compression: "none" },
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

  async #request(
    remote: HubRemote,
    method: "GET" | "POST",
    resource: string,
    body: Buffer | undefined,
    contentType: string,
  ): Promise<Buffer> {
    if (!LOOPBACK_URL_PATTERN.test(remote.baseUrl)) {
      throw new DataError(
        "invalid_argument",
        "The Hub remote must be an explicit loopback HTTP origin in this slice.",
      );
    }
    const route = `${remote.baseUrl}/v1/projects/${encodeURIComponent(remote.projectId)}/${resource}`;
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
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.byteLength > MAXIMUM_PACK_BYTES) {
      throw new DataError("resource_exhausted", "The Hub response exceeds the transfer limit.");
    }
    if (!response.ok) {
      let code = `http_${response.status}`;
      let message = "The Hub rejected the request.";
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as {
          error?: { code?: string; message?: string };
        };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // The generic message stands when the error body is not JSON.
      }
      throw new DataError(
        code === "not_found" ? "not_found" : code === "conflict" ? "conflict" : "internal",
        message,
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
}
