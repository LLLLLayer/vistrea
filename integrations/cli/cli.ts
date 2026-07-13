import fs from "node:fs/promises";

import { runIosDriverCommand } from "./ios-driver.js";
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

/**
 * Named command surfaces a composition may expose, keyed by the first command
 * word. `workspace` is always on because status is how an agent checks
 * connectivity before anything else. The default exposes every surface; a
 * deployment focused on exploration and asset recording sets
 * `VISTREA_CLI_TOOLSETS=assets,exploration` and the verification surface
 * (design review, review issues, tuning, validators, build diffs) disappears
 * from help and fails closed at dispatch — masked by configuration, not
 * removed from the Host.
 */
export const VISTREA_CLI_TOOLSETS = {
  workspace: ["workspace"],
  assets: ["snapshot", "events", "object", "pack"],
  exploration: ["explore", "graph", "screen", "driver"],
  knowledge: ["wiki"],
  verification: ["design", "issue", "tuning", "validate"],
} as const;

export type VistreaCliToolset = keyof typeof VISTREA_CLI_TOOLSETS;

const ALL_COMMAND_GROUPS: ReadonlySet<string> = new Set(
  Object.values(VISTREA_CLI_TOOLSETS).flat(),
);

/**
 * Parses the `VISTREA_CLI_TOOLSETS` environment value into the set of enabled
 * first command words. Undefined or empty means every surface; anything it
 * cannot understand fails closed rather than exposing more than the operator
 * intended. Toolset names are configuration, not secrets.
 */
export function enabledCommandGroups(value: string | undefined): ReadonlySet<string> | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const known = Object.keys(VISTREA_CLI_TOOLSETS);
  const requested = value.split(",").map((entry) => entry.trim());
  const invalid = requested.filter((entry) => !known.includes(entry));
  if (invalid.length > 0) {
    throw new HostClientError(
      "invalid_argument",
      `Unknown VISTREA_CLI_TOOLSETS entries: ${invalid.join(", ")}. ` +
        `Valid toolsets: ${known.join(", ")}.`,
    );
  }
  return new Set(
    [...new Set([...(requested as VistreaCliToolset[]), "workspace" as const])].flatMap(
      (toolset) => VISTREA_CLI_TOOLSETS[toolset],
    ),
  );
}

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
  /** Deferred input construction for commands that read local files. */
  readonly loadInput?: () => Promise<JsonObject>;
  /** Post-processing for commands that write local files; returns the envelope data. */
  readonly saveOutput?: (result: JsonObject) => Promise<JsonObject>;
  readonly timeoutMilliseconds?: number;
  readonly help?: true;
  /** Local toolchain command handled without a Host connection. */
  readonly driver?: readonly string[];
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
    const enabledGroups = enabledCommandGroups(runtime.environment["VISTREA_CLI_TOOLSETS"]);
    const invocation = parseArguments(arguments_, context, enabledGroups);
    if (invocation.help === true) {
      writeEnvelope(runtime, context, {
        commands: [
          "workspace status",
          "snapshot capture",
          "snapshot list",
          "snapshot get <snapshot_id>",
          "events list",
          "design upload-asset --file <path> --media-type <type> [--name <logical>]",
          "design add-reference --json <command>",
          "design get-reference <design_reference_id>",
          "design map --json <command>",
          "design compare --reference <id> --snapshot <id> [--actor <id>] [--pixel true|false]",
          "design get-comparison <comparison_id>",
          "design list-references [--limit n] [--cursor c]",
          "design list-comparisons [--reference <id>] [--snapshot <id>] [--limit n] [--cursor c]",
          "issue create --json <command>",
          "issue list [--states a,b] [--reference <id>] [--limit n] [--cursor c]",
          "issue get <issue_id>",
          "issue transition <issue_id> --revision <n> --to <state> [--reason <text>] [--actor <id>]",
          "issue verify <issue_id> --revision <n> --basis <basis> --result <result> --snapshot <id> --build <id> [--rationale <text>] [--actor <id>]",
          "tuning create-patch --json <command>",
          "tuning get-patch <patch_id>",
          "tuning apply --patch <patch_id> [--ttl <ms>]",
          "tuning revert <tuning_application_id>",
          "tuning get-application <tuning_application_id>",
          "tuning list-active",
          "graph observe-state --snapshot <snapshot_id> [--title <text>] [--kind <state_kind>] [--entry true|false] [--source <capture_source>] [--session <session_id>]",
          "graph observe-transition --before <snapshot_id> --after <snapshot_id> --action <json> [--source <capture_source>] [--session <session_id>]",
          "graph show --project <project_id> --application <application_id>",
          "graph get-state <screen_state_id>",
          "graph find-path --from <screen_state_id> --to <screen_state_id> [--graph <screen_graph_id>] [--max-depth <n>] [--max-paths <n>]",
          "graph tag --project <project_id> --application <application_id> --tag <tag_name>",
          "wiki create --json <command>",
          "wiki update <wiki_node_id> --json <command>",
          "wiki get <wiki_node_id>",
          "wiki search [--text <phrase>] [--kinds a,b] [--labels a,b] [--statuses a,b] [--limit n] [--cursor c]",
          "wiki link --json <command>",
          "wiki unlink <wiki_link_id> --revision <n>",
          "wiki backlinks <wiki_node_id> [--limit n] [--cursor c]",
          "wiki related --kind <resource_kind> --id <resource_id> [--limit n] [--cursor c]",
          "validate snapshot --snapshot <snapshot_id> [--categories structural,accessibility,visual] [--disable-rules a,b] [--min-touch-target <points>]",
          "validate graph --project <project_id> --application <application_id> [--disable-rules a,b] [--min-touch-target <points>]",
          "validate get-run <validation_run_id>",
          "validate findings [--run <id>] [--statuses a,b] [--severities a,b] [--limit n] [--cursor c]",
          "validate get-finding <finding_id>",
          "validate suppress <finding_id> --json <command>",
          "validate build-diff --project <project_id> --application <application_id> --left <build_id> --right <build_id> [--baseline <tag>]",
          "validate get-build-diff <build_diff_id>",
          "pack export --json <command>",
          "pack import --file <path>",
          "object get --hash <sha256:...> --output <path>",
          "screen merge --project <id> --application <id> --states a,b [--into <state_id>] --revision <n> [--actor <id>] [--justification <text>]",
          "screen split --project <id> --application <id> --state <state_id> --observations a,b [--title <text>] --revision <n> [--actor <id>] [--justification <text>]",
          "explore run --max-actions <n> [--max-depth <n>] [--settle <ms>] [--exclude id1,id2] [--actor <id>]",
          "explore get <operation_id>",
          "explore cancel <operation_id>",
          "driver ios doctor",
          "driver ios prepare",
          "driver ios up [--device <udid>] [--simulator <udid>] [--port <n>] [--team <id>] [--app-project <path>]",
        ].filter(
          (line) => enabledGroups === undefined || enabledGroups.has(line.split(" ")[0] as string),
        ),
        format: "json",
      });
      return 0;
    }
    if (invocation.driver !== undefined) {
      const result = await runIosDriverCommand(invocation.driver);
      writeEnvelope(runtime, context, result.data);
      await result.untilShutdown;
      return 0;
    }
    const input =
      invocation.loadInput === undefined ? invocation.input : await invocation.loadInput();
    const client = createHostLocalApiClientFromEnvironment(runtime.environment, {
      ...(invocation.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: invocation.timeoutMilliseconds }),
    });
    const result = await client.execute(invocation.operation as ImplementedHostOperation, input, {
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const data =
      invocation.saveOutput === undefined
        ? result
        : await invocation.saveOutput(result as JsonObject);
    writeEnvelope(runtime, context, data);
    return 0;
  } catch (error) {
    const safeError = isHostClientError(error)
      ? error
      : new HostClientError("internal", "The CLI could not complete the request.");
    writeErrorEnvelope(runtime, context, safeError);
    return exitCodeFor(safeError.code);
  }
}

function parseArguments(
  arguments_: readonly string[],
  context: CliContext,
  enabledGroups?: ReadonlySet<string>,
): ParsedInvocation {
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
  if (
    enabledGroups !== undefined &&
    command.length > 0 &&
    ALL_COMMAND_GROUPS.has(command[0] as string) &&
    !enabledGroups.has(command[0] as string)
  ) {
    throw new HostClientError(
      "unsupported",
      `The ${command[0]} commands are not exposed by this toolset configuration.`,
    );
  }
  if (command[0] === "driver" && command[1] === "ios") {
    return { input: {}, driver: command.slice(2) };
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
  if (command[0] === "events" && command[1] === "list") {
    return invocation("GetEventTimeline", parseEventOptions(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "design" && command[1] === "upload-asset") {
    return uploadAssetInvocation(command.slice(2), timeoutMilliseconds);
  }
  if (command[0] === "design" && command[1] === "add-reference") {
    return invocation("AddDesignReference", parseJsonOption(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "design" && command[1] === "get-reference" && command.length === 3) {
    return invocation(
      "GetDesignReference",
      { design_reference_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "design" && command[1] === "map") {
    return invocation("MapDesignRegion", parseJsonOption(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "design" && command[1] === "compare") {
    return invocation("RunDesignComparison", parseCompareOptions(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "design" && command[1] === "list-references") {
    return invocation("ListDesignReferences", parseListOptions(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "design" && command[1] === "list-comparisons") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--reference", "--snapshot", "--limit", "--cursor"].includes(key)) {
        throw invalidArguments();
      }
    }
    const limit = values.get("--limit");
    if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) {
      throw invalidArguments();
    }
    const reference = values.get("--reference");
    const snapshot = values.get("--snapshot");
    const cursor = values.get("--cursor");
    return invocation(
      "ListDesignComparisons",
      {
        ...(reference === undefined ? {} : { design_reference_id: reference }),
        ...(snapshot === undefined ? {} : { target_snapshot_id: snapshot }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "design" && command[1] === "get-comparison" && command.length === 3) {
    return invocation(
      "GetDesignComparison",
      { comparison_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "issue" && command[1] === "create") {
    return invocation("CreateReviewIssue", parseJsonOption(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "issue" && command[1] === "list") {
    return invocation("ListReviewIssues", parseIssueListOptions(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "issue" && command[1] === "get" && command.length === 3) {
    return invocation("GetReviewIssue", { issue_id: command[2] as string }, timeoutMilliseconds);
  }
  if (command[0] === "issue" && command[1] === "transition" && command.length >= 3) {
    return invocation(
      "TransitionReviewIssue",
      parseIssueTransitionOptions(command[2] as string, command.slice(3)),
      timeoutMilliseconds,
    );
  }
  if (command[0] === "issue" && command[1] === "verify" && command.length >= 3) {
    return invocation(
      "VerifyReviewIssue",
      parseIssueVerifyOptions(command[2] as string, command.slice(3)),
      timeoutMilliseconds,
    );
  }
  if (command[0] === "tuning" && command[1] === "create-patch") {
    return invocation("CreateTuningPatch", parseJsonOption(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "tuning" && command[1] === "get-patch" && command.length === 3) {
    return invocation("GetTuningPatch", { patch_id: command[2] as string }, timeoutMilliseconds);
  }
  if (command[0] === "tuning" && command[1] === "apply") {
    return invocation("ApplyTuningPatch", parseTuningApplyOptions(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "tuning" && command[1] === "revert" && command.length === 3) {
    return invocation(
      "RevertTuningApplication",
      { tuning_application_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "tuning" && command[1] === "get-application" && command.length === 3) {
    return invocation(
      "GetTuningApplication",
      { tuning_application_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "tuning" && command[1] === "list-active" && command.length === 2) {
    return invocation("ListActiveTuning", {}, timeoutMilliseconds);
  }
  if (command[0] === "graph" && command[1] === "observe-state") {
    return invocation(
      "RecordStateObservation",
      parseStateObservationOptions(command.slice(2)),
      timeoutMilliseconds,
    );
  }
  if (command[0] === "graph" && command[1] === "observe-transition") {
    return invocation(
      "RecordTransitionObservation",
      parseTransitionObservationOptions(command.slice(2)),
      timeoutMilliseconds,
    );
  }
  if (command[0] === "graph" && command[1] === "show") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--project", "--application"].includes(key)) {
        throw invalidArguments();
      }
    }
    return invocation(
      "GetScreenGraph",
      {
        project_id: requireOption(values, "--project"),
        application_id: requireOption(values, "--application"),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "graph" && command[1] === "get-state" && command.length === 3) {
    return invocation(
      "GetScreenState",
      { screen_state_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "wiki" && command[1] === "create") {
    return invocation("CreateWikiNode", parseJsonOption(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "wiki" && command[1] === "update" && command.length >= 3) {
    const input = parseJsonOption(command.slice(3));
    return invocation(
      "UpdateWikiNode",
      { ...input, wiki_node_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "wiki" && command[1] === "get" && command.length === 3) {
    return invocation("GetWikiNode", { wiki_node_id: command[2] as string }, timeoutMilliseconds);
  }
  if (command[0] === "wiki" && command[1] === "search") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--text", "--kinds", "--labels", "--statuses", "--limit", "--cursor"].includes(key)) {
        throw invalidArguments();
      }
    }
    const limit = values.get("--limit");
    if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) {
      throw invalidArguments();
    }
    const text = values.get("--text");
    const kinds = values.get("--kinds");
    const labels = values.get("--labels");
    const statuses = values.get("--statuses");
    const cursor = values.get("--cursor");
    return invocation(
      "ListWikiNodes",
      {
        ...(text === undefined ? {} : { text }),
        ...(kinds === undefined ? {} : { kinds: kinds.split(",") }),
        ...(labels === undefined ? {} : { labels: labels.split(",") }),
        ...(statuses === undefined ? {} : { statuses: statuses.split(",") }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "wiki" && command[1] === "link") {
    return invocation("LinkWikiNode", parseJsonOption(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "wiki" && command[1] === "unlink" && command.length >= 3) {
    const values = parseOptionPairs(command.slice(3));
    for (const key of values.keys()) {
      if (!["--revision"].includes(key)) {
        throw invalidArguments();
      }
    }
    const revision = requireOption(values, "--revision");
    if (!/^[1-9][0-9]{0,8}$/.test(revision)) {
      throw invalidArguments();
    }
    return invocation(
      "UnlinkWikiNode",
      { wiki_link_id: command[2] as string, expected_revision: Number(revision) },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "wiki" && command[1] === "backlinks" && command.length >= 3) {
    const values = parseOptionPairs(command.slice(3));
    for (const key of values.keys()) {
      if (!["--limit", "--cursor"].includes(key)) {
        throw invalidArguments();
      }
    }
    const limit = values.get("--limit");
    if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) {
      throw invalidArguments();
    }
    const cursor = values.get("--cursor");
    return invocation(
      "GetWikiBacklinks",
      {
        wiki_node_id: command[2] as string,
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "wiki" && command[1] === "related") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--kind", "--id", "--limit", "--cursor"].includes(key)) {
        throw invalidArguments();
      }
    }
    const limit = values.get("--limit");
    if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) {
      throw invalidArguments();
    }
    const cursor = values.get("--cursor");
    return invocation(
      "GetRelatedWikiNodes",
      {
        kind: requireOption(values, "--kind"),
        id: requireOption(values, "--id"),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "snapshot") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--snapshot", "--categories", "--disable-rules", "--min-touch-target"].includes(key)) {
        throw invalidArguments();
      }
    }
    const categories = values.get("--categories");
    return invocation(
      "ValidateSnapshot",
      {
        snapshot_id: requireOption(values, "--snapshot"),
        ...(categories === undefined ? {} : { categories: categories.split(",") }),
        ...parseValidationConfiguration(values),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "graph") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (
        !["--project", "--application", "--disable-rules", "--min-touch-target"].includes(key)
      ) {
        throw invalidArguments();
      }
    }
    return invocation(
      "ValidateScreenGraph",
      {
        project_id: requireOption(values, "--project"),
        application_id: requireOption(values, "--application"),
        ...parseValidationConfiguration(values),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "get-run" && command.length === 3) {
    return invocation(
      "GetValidationRun",
      { validation_run_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "findings") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--run", "--statuses", "--severities", "--limit", "--cursor"].includes(key)) {
        throw invalidArguments();
      }
    }
    const limit = values.get("--limit");
    if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) {
      throw invalidArguments();
    }
    const run = values.get("--run");
    const statuses = values.get("--statuses");
    const severities = values.get("--severities");
    const cursor = values.get("--cursor");
    return invocation(
      "ListValidationFindings",
      {
        ...(run === undefined ? {} : { validation_run_id: run }),
        ...(statuses === undefined ? {} : { statuses: statuses.split(",") }),
        ...(severities === undefined ? {} : { severities: severities.split(",") }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "get-finding" && command.length === 3) {
    return invocation(
      "GetValidationFinding",
      { finding_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "suppress" && command.length >= 3) {
    const input = parseJsonOption(command.slice(3));
    return invocation(
      "SuppressValidationFinding",
      { ...input, finding_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "build-diff") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--project", "--application", "--left", "--right", "--baseline"].includes(key)) {
        throw invalidArguments();
      }
    }
    return invocation(
      "CompareBuilds",
      {
        project_id: requireOption(values, "--project"),
        application_id: requireOption(values, "--application"),
        left_build_id: requireOption(values, "--left"),
        right_build_id: requireOption(values, "--right"),
        ...(values.get("--baseline") === undefined
          ? {}
          : { baseline_tag: values.get("--baseline") as string }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "validate" && command[1] === "get-build-diff" && command.length === 3) {
    return invocation(
      "GetBuildDiff",
      { build_diff_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "pack" && command[1] === "export") {
    return invocation("ExportPack", parseJsonOption(command.slice(2)), timeoutMilliseconds);
  }
  if (command[0] === "pack" && command[1] === "import") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--file"].includes(key)) {
        throw invalidArguments();
      }
    }
    const filePath = requireOption(values, "--file");
    return {
      operation: "ImportPack",
      input: {},
      loadInput: async () => {
        const bytes = await fs.readFile(filePath);
        return { pack_base64: bytes.toString("base64") };
      },
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    };
  }
  if (command[0] === "graph" && command[1] === "find-path") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--from", "--to", "--graph", "--max-depth", "--max-paths"].includes(key)) {
        throw invalidArguments();
      }
    }
    const graphId = values.get("--graph");
    const depth = values.get("--max-depth");
    if (depth !== undefined && !/^[0-9]{1,4}$/.test(depth)) {
      throw invalidArguments();
    }
    const maxPaths = values.get("--max-paths");
    if (maxPaths !== undefined && !/^[1-9][0-9]{0,2}$/.test(maxPaths)) {
      throw invalidArguments();
    }
    return invocation(
      "FindScreenPath",
      {
        source_state_id: requireOption(values, "--from"),
        target_state_id: requireOption(values, "--to"),
        ...(graphId === undefined ? {} : { graph_id: graphId }),
        ...(depth === undefined ? {} : { maximum_depth: Number(depth) }),
        ...(maxPaths === undefined ? {} : { maximum_paths: Number(maxPaths) }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "graph" && command[1] === "tag") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--project", "--application", "--tag"].includes(key)) {
        throw invalidArguments();
      }
    }
    return invocation(
      "TagGraphVersion",
      {
        project_id: requireOption(values, "--project"),
        application_id: requireOption(values, "--application"),
        tag_name: requireOption(values, "--tag"),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "screen" && command[1] === "merge") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (
        !["--project", "--application", "--states", "--into", "--revision", "--actor", "--justification"].includes(key)
      ) {
        throw invalidArguments();
      }
    }
    const revision = requireOption(values, "--revision");
    if (!/^[1-9][0-9]{0,8}$/.test(revision)) {
      throw invalidArguments();
    }
    const into = values.get("--into");
    const justification = values.get("--justification");
    return invocation(
      "MergeScreenStates",
      {
        project_id: requireOption(values, "--project"),
        application_id: requireOption(values, "--application"),
        state_ids: requireOption(values, "--states").split(","),
        ...(into === undefined ? {} : { into_state_id: into }),
        expected_graph_revision: Number(revision),
        merged_by: cliActor(values.get("--actor")),
        ...(justification === undefined ? {} : { justification }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "screen" && command[1] === "split") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (
        !["--project", "--application", "--state", "--observations", "--title", "--revision", "--actor", "--justification"].includes(key)
      ) {
        throw invalidArguments();
      }
    }
    const revision = requireOption(values, "--revision");
    if (!/^[1-9][0-9]{0,8}$/.test(revision)) {
      throw invalidArguments();
    }
    const title = values.get("--title");
    const justification = values.get("--justification");
    return invocation(
      "SplitScreenState",
      {
        project_id: requireOption(values, "--project"),
        application_id: requireOption(values, "--application"),
        state_id: requireOption(values, "--state"),
        observation_ids: requireOption(values, "--observations").split(","),
        ...(title === undefined ? {} : { title }),
        expected_graph_revision: Number(revision),
        split_by: cliActor(values.get("--actor")),
        ...(justification === undefined ? {} : { justification }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "explore" && command[1] === "run") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--max-actions", "--max-depth", "--settle", "--exclude", "--actor"].includes(key)) {
        throw invalidArguments();
      }
    }
    const maxActions = requireOption(values, "--max-actions");
    const maxDepth = values.get("--max-depth");
    const settle = values.get("--settle");
    if (
      !/^[1-9][0-9]{0,2}$/.test(maxActions) ||
      (maxDepth !== undefined && !/^[1-9][0-9]?$/.test(maxDepth)) ||
      (settle !== undefined && !/^(?:0|[1-9][0-9]{0,4})$/.test(settle))
    ) {
      throw invalidArguments();
    }
    const exclude = values.get("--exclude");
    const actor = values.get("--actor");
    return invocation(
      "RunExploration",
      {
        maximum_actions: Number(maxActions),
        ...(maxDepth === undefined ? {} : { maximum_depth: Number(maxDepth) }),
        ...(settle === undefined ? {} : { settle_milliseconds: Number(settle) }),
        ...(exclude === undefined ? {} : { excluded_stable_ids: exclude.split(",") }),
        ...(actor === undefined ? {} : { actor_id: actor }),
      },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "explore" && command[1] === "get" && command.length === 3) {
    return invocation(
      "GetExplorationOperation",
      { operation_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "explore" && command[1] === "cancel" && command.length === 3) {
    return invocation(
      "CancelExploration",
      { operation_id: command[2] as string },
      timeoutMilliseconds,
    );
  }
  if (command[0] === "object" && command[1] === "get") {
    const values = parseOptionPairs(command.slice(2));
    for (const key of values.keys()) {
      if (!["--hash", "--output"].includes(key)) {
        throw invalidArguments();
      }
    }
    const outputPath = requireOption(values, "--output");
    return {
      operation: "GetObject",
      input: { hash: requireOption(values, "--hash") },
      saveOutput: async (result) => {
        const encoded = result["bytes_base64"];
        if (typeof encoded !== "string") {
          throw new HostClientError("integrity_error", "The Host returned an invalid object body.");
        }
        // "wx" refuses to overwrite whatever already lives at the target.
        await fs.writeFile(outputPath, Buffer.from(encoded, "base64"), { flag: "wx" });
        const { bytes_base64: _encoded, ...summary } = result;
        return { ...summary, output: outputPath };
      },
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    };
  }
  throw invalidArguments();
}

function parseStateObservationOptions(arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  for (const key of values.keys()) {
    if (!["--snapshot", "--title", "--kind", "--entry", "--source", "--session"].includes(key)) {
      throw invalidArguments();
    }
  }
  const entry = values.get("--entry");
  if (entry !== undefined && entry !== "true" && entry !== "false") {
    throw invalidArguments();
  }
  const title = values.get("--title");
  const kind = values.get("--kind");
  const source = values.get("--source");
  const session = values.get("--session");
  return {
    snapshot_id: requireOption(values, "--snapshot"),
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { state_kind: kind }),
    ...(entry === undefined ? {} : { entry: entry === "true" }),
    ...(source === undefined ? {} : { capture_source: source }),
    ...(session === undefined ? {} : { session_id: session }),
  };
}

function parseTransitionObservationOptions(arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  for (const key of values.keys()) {
    if (!["--before", "--after", "--action", "--source", "--session"].includes(key)) {
      throw invalidArguments();
    }
  }
  const actionSource = requireOption(values, "--action");
  let action: unknown;
  try {
    action = JSON.parse(actionSource);
  } catch {
    throw invalidArguments();
  }
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    throw invalidArguments();
  }
  const source = values.get("--source");
  const session = values.get("--session");
  return {
    before_snapshot_id: requireOption(values, "--before"),
    after_snapshot_id: requireOption(values, "--after"),
    action: action as JsonObject,
    ...(source === undefined ? {} : { capture_source: source }),
    ...(session === undefined ? {} : { session_id: session }),
  };
}

function parseTuningApplyOptions(arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  for (const key of values.keys()) {
    if (!["--patch", "--ttl"].includes(key)) {
      throw invalidArguments();
    }
  }
  const ttl = values.get("--ttl");
  if (ttl !== undefined && !/^[1-9][0-9]{0,6}$/.test(ttl)) {
    throw invalidArguments();
  }
  return {
    patch_id: requireOption(values, "--patch"),
    ...(ttl === undefined ? {} : { preview_ttl_ms: Number(ttl) }),
  };
}

function cliActor(id: string | undefined): JsonObject {
  return { kind: "agent", id: id ?? "vistrea-cli", extensions: {} };
}

function parseOptionPairs(arguments_: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index] as string;
    const value = arguments_[index + 1];
    if (!option.startsWith("--") || value === undefined || values.has(option)) {
      throw invalidArguments();
    }
    values.set(option, value);
    index += 1;
  }
  return values;
}

function requireOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) {
    throw invalidArguments();
  }
  return value;
}

function parseJsonOption(arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  if (values.size !== 1) {
    throw invalidArguments();
  }
  const source = requireOption(values, "--json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw invalidArguments();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidArguments();
  }
  return parsed as JsonObject;
}

function uploadAssetInvocation(
  arguments_: readonly string[],
  timeoutMilliseconds: number | undefined,
): ParsedInvocation {
  const values = parseOptionPairs(arguments_);
  const file = requireOption(values, "--file");
  const mediaType = requireOption(values, "--media-type");
  const logicalName = values.get("--name");
  for (const key of values.keys()) {
    if (!["--file", "--media-type", "--name"].includes(key)) {
      throw invalidArguments();
    }
  }
  return {
    operation: "AddDesignAsset",
    input: {},
    loadInput: async () => {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(file);
      } catch {
        throw new HostClientError("invalid_argument", "The design asset file could not be read.");
      }
      return {
        asset_base64: bytes.toString("base64"),
        media_type: mediaType,
        ...(logicalName === undefined ? {} : { logical_name: logicalName }),
      };
    },
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  };
}

function parseCompareOptions(arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  for (const key of values.keys()) {
    if (!["--reference", "--snapshot", "--actor", "--pixel"].includes(key)) {
      throw invalidArguments();
    }
  }
  const pixel = values.get("--pixel");
  if (pixel !== undefined && pixel !== "true" && pixel !== "false") {
    throw invalidArguments();
  }
  return {
    design_reference_id: requireOption(values, "--reference"),
    target_snapshot_id: requireOption(values, "--snapshot"),
    completed_by: cliActor(values.get("--actor")),
    ...(pixel === undefined ? {} : { include_pixel: pixel === "true" }),
  };
}

function parseValidationConfiguration(values: Map<string, string>): JsonObject {
  const disable = values.get("--disable-rules");
  const threshold = values.get("--min-touch-target");
  if (threshold !== undefined && !/^[1-9][0-9]{0,2}$/.test(threshold)) {
    throw invalidArguments();
  }
  const configuration = {
    ...(disable === undefined ? {} : { disabled_rules: disable.split(",") }),
    ...(threshold === undefined ? {} : { minimum_touch_target_points: Number(threshold) }),
  };
  return Object.keys(configuration).length === 0 ? {} : { configuration };
}

function parseIssueListOptions(arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  for (const key of values.keys()) {
    if (!["--states", "--reference", "--limit", "--cursor"].includes(key)) {
      throw invalidArguments();
    }
  }
  const limitSource = values.get("--limit");
  if (limitSource !== undefined && !/^[1-9][0-9]{0,2}$/.test(limitSource)) {
    throw invalidArguments();
  }
  const states = values.get("--states");
  const reference = values.get("--reference");
  const cursor = values.get("--cursor");
  return {
    ...(states === undefined ? {} : { states: states.split(",") }),
    ...(reference === undefined ? {} : { design_reference_id: reference }),
    ...(limitSource === undefined ? {} : { limit: Number(limitSource) }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function parseIssueTransitionOptions(issueId: string, arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  for (const key of values.keys()) {
    if (!["--revision", "--to", "--reason", "--actor"].includes(key)) {
      throw invalidArguments();
    }
  }
  const revision = requireOption(values, "--revision");
  if (!/^[1-9][0-9]{0,14}$/.test(revision)) {
    throw invalidArguments();
  }
  const reason = values.get("--reason");
  return {
    issue_id: issueId,
    expected_revision: Number(revision),
    to_state: requireOption(values, "--to"),
    ...(reason === undefined ? {} : { reason }),
    changed_by: cliActor(values.get("--actor")),
  };
}

function parseIssueVerifyOptions(issueId: string, arguments_: readonly string[]): JsonObject {
  const values = parseOptionPairs(arguments_);
  for (const key of values.keys()) {
    if (
      !["--revision", "--basis", "--result", "--snapshot", "--build", "--rationale", "--actor"]
        .includes(key)
    ) {
      throw invalidArguments();
    }
  }
  const revision = requireOption(values, "--revision");
  if (!/^[1-9][0-9]{0,14}$/.test(revision)) {
    throw invalidArguments();
  }
  const rationale = values.get("--rationale");
  return {
    issue_id: issueId,
    expected_revision: Number(revision),
    basis: requireOption(values, "--basis"),
    result: requireOption(values, "--result"),
    verified_snapshot_id: requireOption(values, "--snapshot"),
    verified_build_id: requireOption(values, "--build"),
    ...(rationale === undefined ? {} : { rationale }),
    verified_by: cliActor(values.get("--actor")),
  };
}

function parseEventOptions(arguments_: readonly string[]): JsonObject {
  let eventEpochId: string | undefined;
  let kinds: string[] | undefined;
  let firstSequence: number | undefined;
  let lastSequence: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index] as string;
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw invalidArguments();
    }
    index += 1;
    if (option === "--epoch" && eventEpochId === undefined) {
      eventEpochId = value;
    } else if (option === "--kinds" && kinds === undefined) {
      kinds = value.split(",");
    } else if (option === "--first-sequence" && firstSequence === undefined) {
      firstSequence = parseSequenceOption(value);
    } else if (option === "--last-sequence" && lastSequence === undefined) {
      lastSequence = parseSequenceOption(value);
    } else {
      throw invalidArguments();
    }
  }
  return {
    ...(eventEpochId === undefined ? {} : { event_epoch_id: eventEpochId }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(firstSequence === undefined ? {} : { first_sequence: firstSequence }),
    ...(lastSequence === undefined ? {} : { last_sequence: lastSequence }),
  };
}

function parseSequenceOption(value: string): number {
  if (!/^(?:0|[1-9][0-9]{0,14})$/.test(value)) {
    throw invalidArguments();
  }
  return Number(value);
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
