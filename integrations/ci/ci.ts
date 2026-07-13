import {
  createHostLocalApiClientFromEnvironment,
  isHostClientError,
  type HostLocalApiClient,
  type JsonObject,
} from "../shared/index.js";

const SEVERITY_ORDER = ["info", "warning", "error", "critical"] as const;
type FailOnSeverity = (typeof SEVERITY_ORDER)[number];

export interface CiRuntime {
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: { write(value: string): unknown };
}

interface CiGateOptions {
  readonly snapshotId?: string;
  readonly projectId?: string;
  readonly applicationId?: string;
  readonly leftBuildId?: string;
  readonly rightBuildId?: string;
  readonly baselineTag?: string;
  readonly failOn: FailOnSeverity;
}

/**
 * The headless CI gate over the authenticated Host Local API: it validates
 * the newest (or one named) Snapshot, optionally validates the Screen Graph
 * and diffs two builds, and emits one machine-readable JSON report.
 *
 * Exit codes: 0 gate passed, 1 findings at or above the threshold, 2 usage
 * error, 3 the Host was unavailable or an operation failed.
 */
export async function runVistreaCiGate(
  arguments_: readonly string[],
  runtime: CiRuntime = { environment: process.env, stdout: process.stdout },
): Promise<number> {
  let options: CiGateOptions;
  try {
    options = parseArguments(arguments_);
  } catch {
    runtime.stdout.write(
      `${JSON.stringify({
        status: "usage_error",
        usage:
          "vistrea-ci [--snapshot <snapshot_id>] [--project <project_id> --application <application_id>] " +
          "[--left-build <build_id> --right-build <build_id> [--baseline-tag <tag>]] " +
          "[--fail-on info|warning|error|critical]",
      })}\n`,
    );
    return 2;
  }

  const report: Record<string, unknown> = {
    status: "passed",
    fail_on: options.failOn,
    runs: [] as JsonObject[],
  };
  try {
    const client = createHostLocalApiClientFromEnvironment(runtime.environment);
    const status = (await client.execute("GetWorkspaceStatus", {})) as JsonObject;
    report["workspace_status"] = status;

    const snapshotId = options.snapshotId ?? (await newestSnapshotId(client));
    const runs: JsonObject[] = [];
    let worst: FailOnSeverity | undefined;
    let buildRegressions = 0;
    if (snapshotId !== undefined) {
      const outcome = (await client.execute("ValidateSnapshot", {
        snapshot_id: snapshotId,
      })) as JsonObject;
      runs.push(summarizeRun("snapshot", snapshotId, outcome));
      worst = worstSeverity(worst, outcome);
    } else {
      report["snapshot_validation"] = "skipped_no_snapshots";
    }
    if (options.projectId !== undefined && options.applicationId !== undefined) {
      const outcome = (await client.execute("ValidateScreenGraph", {
        project_id: options.projectId,
        application_id: options.applicationId,
      })) as JsonObject;
      runs.push(summarizeRun("screen_graph", options.applicationId, outcome));
      worst = worstSeverity(worst, outcome);
    }
    if (
      options.leftBuildId !== undefined &&
      options.rightBuildId !== undefined &&
      options.projectId !== undefined &&
      options.applicationId !== undefined
    ) {
      const diff = (await client.execute("CompareBuilds", {
        project_id: options.projectId,
        application_id: options.applicationId,
        left_build_id: options.leftBuildId,
        right_build_id: options.rightBuildId,
        ...(options.baselineTag === undefined ? {} : { baseline_tag: options.baselineTag }),
      })) as JsonObject;
      const summary = diff["summary"] as JsonObject;
      report["build_diff"] = {
        build_diff_id: diff["build_diff_id"],
        summary,
      };
      if (options.baselineTag !== undefined) {
        const regressions = (diff["entries"] as readonly JsonObject[]).filter(
          (entry) =>
            ((entry["extensions"] as JsonObject)["vistrea.baseline"] as JsonObject | undefined)?.[
              "classification"
            ] === "regression",
        );
        report["build_regressions"] = regressions.map((entry) => ({
          entry_id: entry["entry_id"],
          summary: entry["summary"],
          left_subject: entry["left_subject"] ?? null,
        }));
        buildRegressions = regressions.length;
      }
    }
    report["runs"] = runs;

    const failed =
      (worst !== undefined &&
        SEVERITY_ORDER.indexOf(worst) >= SEVERITY_ORDER.indexOf(options.failOn)) ||
      buildRegressions > 0;
    report["status"] = failed ? "failed" : "passed";
    if (worst !== undefined) {
      report["worst_open_severity"] = worst;
    }
    runtime.stdout.write(`${JSON.stringify(report)}\n`);
    return failed ? 1 : 0;
  } catch (error) {
    report["status"] = "unavailable";
    report["error"] = isHostClientError(error)
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : { code: "internal", message: "The CI gate could not complete.", retryable: false };
    runtime.stdout.write(`${JSON.stringify(report)}\n`);
    return 3;
  }
}

async function newestSnapshotId(client: HostLocalApiClient): Promise<string | undefined> {
  // The Host lists snapshots in ascending snapshot_id order (UUIDv7, so
  // capture order), so the newest snapshot is the last item of the last page.
  let newest: string | undefined;
  let cursor: string | undefined;
  do {
    const page = (await client.execute("ListSnapshots", {
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    })) as {
      items?: readonly { snapshot_id?: unknown }[];
      next_cursor?: unknown;
    };
    const last = page.items?.at(-1)?.snapshot_id;
    if (typeof last === "string") {
      newest = last;
    }
    cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
  } while (cursor !== undefined);
  return newest;
}

function summarizeRun(kind: string, target: string, outcome: JsonObject): JsonObject {
  const run = outcome["run"] as JsonObject;
  const findings = (outcome["findings"] ?? []) as readonly JsonObject[];
  return {
    kind,
    target,
    validation_run_id: run["validation_run_id"] ?? null,
    state: run["state"] ?? null,
    finding_counts: run["finding_counts"] ?? null,
    findings: findings.map((finding) => ({
      finding_id: finding["finding_id"] ?? null,
      rule_id: finding["rule_id"] ?? null,
      severity: finding["severity"] ?? null,
      message: finding["message"] ?? null,
      subject: finding["subject"] ?? null,
    })),
  };
}

function worstSeverity(
  current: FailOnSeverity | undefined,
  outcome: JsonObject,
): FailOnSeverity | undefined {
  let worst = current;
  for (const finding of (outcome["findings"] ?? []) as readonly JsonObject[]) {
    if (finding["status"] !== "open") {
      continue;
    }
    const severity = finding["severity"] as FailOnSeverity;
    if (
      SEVERITY_ORDER.includes(severity) &&
      (worst === undefined || SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(worst))
    ) {
      worst = severity;
    }
  }
  return worst;
}

function parseArguments(arguments_: readonly string[]): CiGateOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index] as string;
    const value = arguments_[index + 1];
    if (
      ![
        "--snapshot",
        "--project",
        "--application",
        "--left-build",
        "--right-build",
        "--baseline-tag",
        "--fail-on",
      ].includes(option) ||
      value === undefined ||
      values.has(option)
    ) {
      throw new Error("invalid arguments");
    }
    values.set(option, value);
    index += 1;
  }
  const failOn = (values.get("--fail-on") ?? "error") as FailOnSeverity;
  if (!SEVERITY_ORDER.includes(failOn)) {
    throw new Error("invalid arguments");
  }
  const projectId = values.get("--project");
  const applicationId = values.get("--application");
  if ((projectId === undefined) !== (applicationId === undefined)) {
    throw new Error("invalid arguments");
  }
  const leftBuildId = values.get("--left-build");
  const rightBuildId = values.get("--right-build");
  if ((leftBuildId === undefined) !== (rightBuildId === undefined)) {
    throw new Error("invalid arguments");
  }
  if (leftBuildId !== undefined && projectId === undefined) {
    throw new Error("invalid arguments");
  }
  const baselineTag = values.get("--baseline-tag");
  if (baselineTag !== undefined && leftBuildId === undefined) {
    throw new Error("invalid arguments");
  }
  const snapshotId = values.get("--snapshot");
  return {
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(leftBuildId === undefined ? {} : { leftBuildId }),
    ...(rightBuildId === undefined ? {} : { rightBuildId }),
    ...(baselineTag === undefined ? {} : { baselineTag }),
    failOn,
  };
}
