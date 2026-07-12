import {
  HostClientError,
  createCorrelationId,
  createHostLocalApiClientFromEnvironment,
  isHostClientError,
  type HostClientErrorCode,
  type ImplementedHostOperation,
  type JsonObject,
} from "../shared/index.js";

const MAXIMUM_DEADLINE_MILLISECONDS = 300_000;
const CONTEXT_ID_PATTERN = /^(?:request|trace)_[A-Za-z0-9._:-]{1,240}$/;

export interface CliRuntime {
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: { write(value: string): unknown };
}

interface CliContext {
  requestId: string;
  traceId: string;
}

interface ParsedInvocation {
  readonly operation?: ImplementedHostOperation;
  readonly input: JsonObject;
  readonly timeoutMilliseconds?: number;
  readonly help?: true;
}

interface CliEnvelope {
  readonly request_id: string;
  readonly trace_id: string;
  readonly data: JsonObject | null;
  readonly warnings: readonly JsonObject[];
  readonly error: null | {
    readonly code: HostClientErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export async function runVistreaCli(
  arguments_: readonly string[],
  runtime: CliRuntime = { environment: process.env, stdout: process.stdout },
): Promise<number> {
  const context: CliContext = {
    requestId: createCorrelationId("request"),
    traceId: createCorrelationId("trace"),
  };
  try {
    const invocation = parseArguments(arguments_, context);
    if (invocation.help === true) {
      writeEnvelope(runtime, context, {
        commands: [
          "workspace status",
          "snapshot capture",
          "snapshot list",
          "snapshot get <snapshot_id>",
        ],
        format: "json",
      });
      return 0;
    }
    const client = createHostLocalApiClientFromEnvironment(runtime.environment, {
      ...(invocation.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: invocation.timeoutMilliseconds }),
    });
    const result = await client.execute(invocation.operation as ImplementedHostOperation, invocation.input, {
      requestId: context.requestId,
      traceId: context.traceId,
    });
    writeEnvelope(runtime, context, result);
    return 0;
  } catch (error) {
    const safeError = isHostClientError(error)
      ? error
      : new HostClientError("internal", "The CLI could not complete the request.");
    writeErrorEnvelope(runtime, context, safeError);
    return exitCodeFor(safeError.code);
  }
}

function parseArguments(arguments_: readonly string[], context: CliContext): ParsedInvocation {
  const command: string[] = [];
  let timeoutMilliseconds: number | undefined;
  const seenGlobals = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (
      argument === "--format" ||
      argument === "--request-id" ||
      argument === "--trace-id" ||
      argument === "--deadline"
    ) {
      if (seenGlobals.has(argument)) {
        throw invalidArguments();
      }
      seenGlobals.add(argument);
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw invalidArguments();
      }
      index += 1;
      if (argument === "--format") {
        if (value !== "json") {
          throw new HostClientError(
            "unsupported",
            "Only JSON CLI output is implemented in this phase.",
          );
        }
      } else if (argument === "--request-id") {
        context.requestId = parseContextId(value, "request");
      } else if (argument === "--trace-id") {
        context.traceId = parseContextId(value, "trace");
      } else {
        timeoutMilliseconds = parseDeadline(value);
      }
      continue;
    }
    if (argument === "--non-interactive") {
      if (seenGlobals.has(argument)) {
        throw invalidArguments();
      }
      seenGlobals.add(argument);
      continue;
    }
    command.push(argument);
  }

  if (command.length === 1 && (command[0] === "help" || command[0] === "--help")) {
    return {
      input: {},
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
      help: true,
    };
  }
  if (command[0] === "workspace" && command[1] === "status" && command.length === 2) {
    return invocation("GetWorkspaceStatus", {}, timeoutMilliseconds);
  }
  if (command[0] === "snapshot" && command[1] === "capture") {
    return invocation("CaptureSnapshot", parseCaptureOptions(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "snapshot" && command[1] === "list") {
    return invocation("ListSnapshots", parseListOptions(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "snapshot" && command[1] === "get" && command.length === 3) {
    return invocation("GetSnapshot", { snapshot_id: command[2] as string }, timeoutMilliseconds);
  }
  throw invalidArguments();
}

function invocation(
  operation: ImplementedHostOperation,
  input: JsonObject,
  timeoutMilliseconds: number | undefined,
): ParsedInvocation {
  return {
    operation,
    input,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  };
}

function parseCaptureOptions(arguments_: readonly string[]): JsonObject {
  const include: string[] = [];
  let screenshot: string | undefined;
  let reason: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index] as string;
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw invalidArguments();
    }
    index += 1;
    if (option === "--include") {
      include.push(value);
    } else if (option === "--screenshot" && screenshot === undefined) {
      screenshot = value;
    } else if (option === "--reason" && reason === undefined) {
      reason = value;
    } else {
      throw invalidArguments();
    }
  }
  return {
    ...(include.length === 0 ? {} : { include: { paths: include } }),
    ...(screenshot === undefined ? {} : { screenshot }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseListOptions(arguments_: readonly string[]): JsonObject {
  let limit: number | undefined;
  let cursor: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index] as string;
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw invalidArguments();
    }
    index += 1;
    if (option === "--limit" && limit === undefined) {
      if (!/^[1-9][0-9]{0,2}$/.test(value)) {
        throw invalidArguments();
      }
      limit = Number(value);
      if (limit > 500) {
        throw invalidArguments();
      }
    } else if (option === "--cursor" && cursor === undefined) {
      cursor = value;
    } else {
      throw invalidArguments();
    }
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function parseContextId(value: string, prefix: "request" | "trace"): string {
  if (!CONTEXT_ID_PATTERN.test(value) || !value.startsWith(`${prefix}_`)) {
    throw invalidArguments();
  }
  return value;
}

function parseDeadline(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value);
  if (match === null) {
    throw invalidArguments();
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAXIMUM_DEADLINE_MILLISECONDS) {
    throw invalidArguments();
  }
  return milliseconds;
}

function invalidArguments(): HostClientError {
  return new HostClientError("invalid_argument", "The CLI arguments are invalid.");
}

function writeEnvelope(runtime: CliRuntime, context: CliContext, data: JsonObject): void {
  const envelope: CliEnvelope = {
    request_id: context.requestId,
    trace_id: context.traceId,
    data,
    warnings: [],
    error: null,
  };
  runtime.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeErrorEnvelope(
  runtime: CliRuntime,
  context: CliContext,
  error: HostClientError,
): void {
  const envelope: CliEnvelope = {
    request_id: context.requestId,
    trace_id: context.traceId,
    data: null,
    warnings: [],
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
  runtime.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export function exitCodeFor(code: HostClientErrorCode): number {
  switch (code) {
    case "invalid_argument":
      return 2;
    case "not_found":
      return 3;
    case "already_exists":
    case "conflict":
      return 4;
    case "unauthenticated":
    case "forbidden":
      return 5;
    case "unsupported":
      return 6;
    case "unavailable":
    case "timeout":
    case "cancelled":
    case "resource_exhausted":
      return 7;
    case "policy_blocked":
      return 8;
    case "integrity_error":
      return 9;
    case "internal":
      return 10;
  }
}
