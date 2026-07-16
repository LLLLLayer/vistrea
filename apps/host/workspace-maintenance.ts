import path from "node:path";
import { TextDecoder } from "node:util";

import { DataError } from "../../data/api/index.js";
import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { FileObjectStore } from "../../data/objects/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";

const MAXIMUM_INPUT_BYTES = 64 * 1024;
const MAXIMUM_JSON_NESTING_DEPTH = 128;
const OBJECT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const MAXIMUM_GARBAGE_AGE_SECONDS = 365 * 24 * 60 * 60;

type WorkspaceMaintenanceOperation =
  | "restore"
  | "collect_garbage"
  | "recover_interrupted_restore"
  | "recover_stale_lock";

type ReportedOperation = WorkspaceMaintenanceOperation | "unknown";

type WorkspaceMaintenanceRequest =
  | {
      readonly operation: "restore";
      readonly backupHash: string;
    }
  | {
      readonly operation: "collect_garbage";
      readonly dryRun: boolean;
      readonly minimumAgeSeconds?: number;
      readonly expectedPlanDigest?: string;
    }
  | {
      readonly operation: "recover_interrupted_restore" | "recover_stale_lock";
    };

interface MaintenanceArguments {
  readonly workspaceRoot: string;
}

interface PublicMaintenanceError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

class MaintenanceInputError extends Error {}

async function main(): Promise<void> {
  let operation: ReportedOperation = "unknown";
  try {
    const argumentsValue = parseArguments(process.argv.slice(2));
    const source = await readBoundedStdin();
    const input = parseStrictJson(source);
    operation = recognizedOperation(input);
    const request = parseRequest(input);
    operation = request.operation;
    const validator = await createRepositoryProtocolValidator({
      repositoryRoot: process.cwd(),
    });
    const result = await executeRequest(argumentsValue, request, validator);
    writeEnvelope({
      format_version: 1,
      status: "succeeded",
      operation,
      result,
    });
  } catch (error) {
    writeEnvelope({
      format_version: 1,
      status: "failed",
      operation,
      error: publicError(error),
    });
    process.exitCode = 1;
  }
}

function parseArguments(source: readonly string[]): MaintenanceArguments {
  if (
    source.length !== 2 ||
    source[0] !== "--workspace" ||
    source[1] === undefined ||
    !path.isAbsolute(source[1]) ||
    source[1].length > 4_096 ||
    source[1].includes("\u0000")
  ) {
    throw new MaintenanceInputError();
  }
  return { workspaceRoot: source[1] };
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunkValue of process.stdin) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue as Uint8Array);
    if (chunk.byteLength > MAXIMUM_INPUT_BYTES - byteLength) {
      process.stdin.resume();
      throw new MaintenanceInputError();
    }
    byteLength += chunk.byteLength;
    chunks.push(Buffer.from(chunk));
  }
  if (byteLength === 0) {
    throw new MaintenanceInputError();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, byteLength),
    );
  } catch {
    throw new MaintenanceInputError();
  }
}

function parseStrictJson(source: string): unknown {
  new UniqueJsonKeyScanner(source).scan();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new MaintenanceInputError();
  }
}

function recognizedOperation(input: unknown): ReportedOperation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "unknown";
  }
  const value = (input as Readonly<Record<string, unknown>>)["operation"];
  return value === "restore" ||
    value === "collect_garbage" ||
    value === "recover_interrupted_restore" ||
    value === "recover_stale_lock"
    ? value
    : "unknown";
}

function parseRequest(input: unknown): WorkspaceMaintenanceRequest {
  const value = requireRecord(input);
  if (value["format_version"] !== 1) {
    throw new MaintenanceInputError();
  }
  const operation = recognizedOperation(value);
  if (operation === "unknown") {
    throw new MaintenanceInputError();
  }

  if (operation === "restore") {
    assertExactKeys(value, ["format_version", "operation", "backup_hash"]);
    const backupHash = value["backup_hash"];
    if (typeof backupHash !== "string" || !OBJECT_HASH_PATTERN.test(backupHash)) {
      throw new MaintenanceInputError();
    }
    return { operation, backupHash };
  }

  if (operation === "collect_garbage") {
    assertAllowedAndRequiredKeys(
      value,
      [
        "format_version",
        "operation",
        "dry_run",
        "minimum_age_seconds",
        "expected_plan_digest",
      ],
      ["format_version", "operation", "dry_run"],
    );
    const dryRun = value["dry_run"];
    const minimumAgeSeconds = value["minimum_age_seconds"];
    const expectedPlanDigest = value["expected_plan_digest"];
    if (typeof dryRun !== "boolean") {
      throw new MaintenanceInputError();
    }
    if (
      minimumAgeSeconds !== undefined &&
      (!Number.isSafeInteger(minimumAgeSeconds) ||
        (minimumAgeSeconds as number) < 0 ||
        (minimumAgeSeconds as number) > MAXIMUM_GARBAGE_AGE_SECONDS)
    ) {
      throw new MaintenanceInputError();
    }
    if (
      expectedPlanDigest !== undefined &&
      (typeof expectedPlanDigest !== "string" ||
        !OBJECT_HASH_PATTERN.test(expectedPlanDigest))
    ) {
      throw new MaintenanceInputError();
    }
    if ((dryRun && expectedPlanDigest !== undefined) || (!dryRun && expectedPlanDigest === undefined)) {
      throw new MaintenanceInputError();
    }
    return {
      operation,
      dryRun,
      ...(minimumAgeSeconds === undefined
        ? {}
        : { minimumAgeSeconds: minimumAgeSeconds as number }),
      ...(expectedPlanDigest === undefined ? {} : { expectedPlanDigest }),
    };
  }

  assertExactKeys(value, ["format_version", "operation"]);
  return { operation };
}

async function executeRequest(
  argumentsValue: MaintenanceArguments,
  request: WorkspaceMaintenanceRequest,
  validator: Awaited<ReturnType<typeof createRepositoryProtocolValidator>>,
): Promise<unknown> {
  switch (request.operation) {
    case "restore": {
      const objects = await FileObjectStore.open({
        workspaceRoot: argumentsValue.workspaceRoot,
      });
      const backup = await objects.stat(request.backupHash);
      return await LocalDataWorkspace.restore({
        workspaceRoot: argumentsValue.workspaceRoot,
        validator,
        backup,
      });
    }
    case "collect_garbage":
      return await LocalDataWorkspace.collectGarbage({
        workspaceRoot: argumentsValue.workspaceRoot,
        validator,
        command: {
          dry_run: request.dryRun,
          ...(request.minimumAgeSeconds === undefined
            ? {}
            : { minimum_age_seconds: request.minimumAgeSeconds }),
          ...(request.expectedPlanDigest === undefined
            ? {}
            : { expected_plan_digest: request.expectedPlanDigest }),
        },
      });
    case "recover_interrupted_restore":
      return await LocalDataWorkspace.recoverInterruptedRestore({
        workspaceRoot: argumentsValue.workspaceRoot,
      });
    case "recover_stale_lock":
      return await LocalDataWorkspace.recoverStaleLock({
        workspaceRoot: argumentsValue.workspaceRoot,
      });
  }
}

function requireRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new MaintenanceInputError();
  }
  return input as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  assertAllowedAndRequiredKeys(value, keys, keys);
}

function assertAllowedAndRequiredKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new MaintenanceInputError();
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new MaintenanceInputError();
  }
}

function publicError(error: unknown): PublicMaintenanceError {
  if (error instanceof MaintenanceInputError) {
    return {
      code: "invalid_argument",
      message: "The Workspace maintenance request is invalid.",
      retryable: false,
    };
  }
  if (error instanceof DataError) {
    switch (error.code) {
      case "invalid_argument":
        return {
          code: error.code,
          message: "The Workspace maintenance request was rejected as invalid.",
          retryable: error.retryable,
        };
      case "not_found":
        return {
          code: error.code,
          message: "The requested Workspace maintenance resource does not exist.",
          retryable: error.retryable,
        };
      case "already_exists":
      case "conflict":
        return {
          code: error.code,
          message: "The request conflicts with the current Workspace state.",
          retryable: error.retryable,
        };
      case "unsupported":
        return {
          code: error.code,
          message: "The requested Workspace maintenance operation is not supported.",
          retryable: error.retryable,
        };
      case "resource_exhausted":
        return {
          code: error.code,
          message: "The Workspace does not have enough resources for maintenance.",
          retryable: error.retryable,
        };
      case "integrity_error":
        return {
          code: error.code,
          message: "Workspace data failed integrity verification.",
          retryable: false,
        };
      case "internal":
        break;
    }
  }
  return {
    code: "internal",
    message: "Workspace maintenance could not be completed.",
    retryable: false,
  };
}

function writeEnvelope(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Rejects duplicate decoded keys before JSON.parse can overwrite them. */
class UniqueJsonKeyScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.invalid();
    }
  }

  private scanValue(depth: number): void {
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") {
      this.assertCanEnterContainer(depth);
      this.scanObject(depth + 1);
    } else if (character === "[") {
      this.assertCanEnterContainer(depth);
      this.scanArray(depth + 1);
    } else if (character === '"') {
      this.scanString();
    } else if (character === "t") {
      this.scanLiteral("true");
    } else if (character === "f") {
      this.scanLiteral("false");
    } else if (character === "n") {
      this.scanLiteral("null");
    } else if (character === "-" || isAsciiDigit(character)) {
      this.scanNumber();
    } else {
      this.invalid();
    }
  }

  private assertCanEnterContainer(depth: number): void {
    if (depth >= MAXIMUM_JSON_NESTING_DEPTH) {
      throw new MaintenanceInputError();
    }
  }

  private scanObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("}")) {
      return;
    }
    const keys = new Set<string>();
    while (true) {
      if (this.source[this.index] !== '"') {
        this.invalid();
      }
      const key = this.scanString();
      if (keys.has(key)) {
        throw new MaintenanceInputError();
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume("}")) {
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) {
      return;
    }
    while (true) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume("]")) {
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index] as string;
      if (character === '"') {
        this.index += 1;
        try {
          const value = JSON.parse(this.source.slice(start, this.index)) as unknown;
          if (typeof value === "string") {
            return value;
          }
        } catch {
          this.invalid();
        }
        this.invalid();
      }
      if (character === "\\") {
        this.index += 1;
        if (this.index >= this.source.length) {
          this.invalid();
        }
        this.index += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        this.invalid();
      }
      this.index += 1;
    }
    this.invalid();
  }

  private scanLiteral(literal: string): void {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.invalid();
    }
    this.index += literal.length;
  }

  private scanNumber(): void {
    const match = JSON_NUMBER_PATTERN.exec(this.source.slice(this.index));
    if (match === null) {
      this.invalid();
    }
    this.index += (match[0] as string).length;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) {
      this.invalid();
    }
  }

  private invalid(): never {
    throw new MaintenanceInputError();
  }
}

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

void main();
