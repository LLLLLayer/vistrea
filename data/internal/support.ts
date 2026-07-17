import { createHash, randomBytes } from "node:crypto";

import { DataError } from "../api/errors.js";
import { canonicalizeIdentityJson } from "../api/canonical-json.js";
import type {
  Clock,
  IdGenerator,
  JsonObject,
  JsonValue,
  Page,
  PageRequest,
  RevisionPrecondition,
} from "../api/models.js";

const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function cloneFrozen<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function assertSafePositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DataError("invalid_argument", `${field} must be a positive JSON-safe integer.`, {
      details: { field, value },
    });
  }
}

export function assertCreateRevision(revision: number, resourceId: string): void {
  if (revision !== 1) {
    throw new DataError("conflict", "A revisioned resource must be created at revision 1.", {
      details: { resource_id: resourceId, submitted_revision: revision, expected_revision: 1 },
    });
  }
}

export function assertRevisionUpdate(
  currentRevision: number,
  submittedRevision: number,
  precondition: RevisionPrecondition,
  resourceId: string,
): void {
  assertSafePositive(precondition.expected_revision, "expected_revision");
  if (precondition.expected_revision !== currentRevision) {
    throw new DataError("conflict", "The revision precondition is stale.", {
      retryable: true,
      details: {
        resource_id: resourceId,
        expected_revision: precondition.expected_revision,
        current_revision: currentRevision,
      },
    });
  }
  if (currentRevision === MAX_SAFE_REVISION) {
    throw new DataError("resource_exhausted", "The resource revision cannot be incremented.", {
      details: { resource_id: resourceId, current_revision: currentRevision },
    });
  }
  if (submittedRevision !== currentRevision + 1) {
    throw new DataError("conflict", "The submitted resource revision must be N + 1.", {
      details: {
        resource_id: resourceId,
        current_revision: currentRevision,
        submitted_revision: submittedRevision,
        required_revision: currentRevision + 1,
      },
    });
  }
}

export function paginate<T>(
  values: readonly T[],
  page: PageRequest | undefined,
  snapshotVersion: string,
): Page<T> {
  const limit = page?.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new DataError("invalid_argument", "Page limit must be between 1 and 500.", {
      details: { limit },
    });
  }

  let offset = 0;
  if (page?.cursor !== undefined) {
    const match = /^offset:([0-9]+)$/.exec(page.cursor);
    if (!match) {
      throw new DataError("invalid_argument", "The page cursor is invalid.", {
        details: { cursor: page.cursor },
      });
    }
    offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset > values.length) {
      throw new DataError("invalid_argument", "The page cursor is outside this result set.", {
        details: { cursor: page.cursor },
      });
    }
  }

  const items = values.slice(offset, offset + limit).map(cloneFrozen);
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < values.length ? { next_cursor: `offset:${nextOffset}` } : {}),
    snapshot_version: snapshotVersion,
  };
}

export { canonicalizeIdentityJson } from "../api/canonical-json.js";

export function commitIdForManifest(manifest: JsonObject): string {
  const bytes = Buffer.from(canonicalizeIdentityJson(manifest), "utf8");
  return `commit:sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class SequenceClock implements Clock {
  readonly #stepMilliseconds: number;
  #nextMilliseconds: number;

  constructor(start = "2026-07-12T00:00:00.000Z", stepMilliseconds = 1) {
    const parsed = Date.parse(start);
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(stepMilliseconds) || stepMilliseconds < 0) {
      throw new DataError("invalid_argument", "Invalid deterministic clock configuration.");
    }
    this.#nextMilliseconds = parsed;
    this.#stepMilliseconds = stepMilliseconds;
  }

  now(): string {
    const value = new Date(this.#nextMilliseconds).toISOString();
    this.#nextMilliseconds += this.#stepMilliseconds;
    return value;
  }
}

export class SequenceIdGenerator implements IdGenerator {
  #counter: number;

  constructor(firstSequence = 1) {
    assertSafePositive(firstSequence, "firstSequence");
    this.#counter = firstSequence;
  }

  next(prefix: string): string {
    assertIdPrefix(prefix);
    if (this.#counter > 999_999_999_999) {
      throw new DataError("resource_exhausted", "The deterministic ID sequence is exhausted.");
    }
    const suffix = String(this.#counter).padStart(12, "0");
    this.#counter += 1;
    return `${prefix}_019f0000-0000-7000-8000-${suffix}`;
  }
}

/** Real wall-clock time for durable production Workspaces. */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * Real UUIDv7 identities for durable production Workspaces: millisecond
 * wall-clock prefix plus a per-process monotonic sequence in the version
 * group, so identifiers created by one process sort in creation order and
 * never collide across restarts.
 */
export class SystemIdGenerator implements IdGenerator {
  #lastMilliseconds = 0;
  #sequence = 0;

  next(prefix: string): string {
    assertIdPrefix(prefix);
    let milliseconds = Date.now();
    if (milliseconds <= this.#lastMilliseconds) {
      milliseconds = this.#lastMilliseconds;
      this.#sequence += 1;
      if (this.#sequence > 0x0fff) {
        milliseconds += 1;
        this.#sequence = 0;
      }
    } else {
      this.#sequence = 0;
    }
    this.#lastMilliseconds = milliseconds;
    const time = milliseconds.toString(16).padStart(12, "0");
    const versionGroup = (0x7000 | this.#sequence).toString(16);
    const random = randomBytes(8);
    random[0] = ((random[0] as number) & 0x3f) | 0x80;
    const randomHex = random.toString("hex");
    return `${prefix}_${time.slice(0, 8)}-${time.slice(8)}-${versionGroup}-${randomHex.slice(0, 4)}-${randomHex.slice(4)}`;
  }
}

function assertIdPrefix(prefix: string): void {
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) {
    throw new DataError("invalid_argument", "ID prefixes must contain lowercase ASCII letters and digits.", {
      details: { prefix },
    });
  }
}
