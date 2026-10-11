import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTOCOL_SCHEMA_IDS,
  type JsonObject,
  type ObjectRef,
  type RuntimeSnapshot,
} from "../../data/api/index.js";
import {
  SequenceClock,
  SequenceIdGenerator,
  createRepositoryProtocolValidator,
} from "../../data/memory/index.js";
import { LocalDataWorkspace } from "../../data/workspace/index.js";
import { TuningEngine } from "../../engine/design/index.js";
import { ScreenGraphEngine } from "../../engine/exploration/index.js";
import { KnowledgeEngine } from "../../engine/knowledge/index.js";

const LEFT_BUILD_ID = "build_019f0000-0000-7000-8000-000000000001";
const RIGHT_BUILD_ID = "build_019f0000-0000-7000-8000-000000000002";
const LEFT_SNAPSHOT_ID = "snapshot_019f0000-0000-7000-8000-00000000a001";
const RIGHT_SNAPSHOT_ID = "snapshot_019f0000-0000-7000-8000-00000000a002";
const ACTOR = { kind: "agent", id: "vistrea-disposable-fixture", extensions: {} } as const;
const RECOVERY_POLICY_ID = "workspace-recovery:disposable-acceptance";

export interface DisposableWorkspaceManifest {
  readonly format_version: 1;
  readonly fixture_kind: "vistrea_disposable_workspace";
  readonly workspace_path: string;
  readonly project_id: string;
  readonly application_id: string;
  readonly left_build_id: string;
  readonly right_build_id: string;
  readonly left_snapshot_id: string;
  readonly right_snapshot_id: string;
  readonly collection_id: string;
  readonly wiki_node_id: string;
  readonly tuning_patch_id: string;
  readonly recovery_point_id: string;
  readonly recovery_policy_id: string;
  readonly gc_candidate_hash: string;
  readonly post_recovery_marker_node_id: string;
}

export interface CreateDisposableWorkspaceOptions {
  readonly repositoryRoot: string;
  readonly workspacePath: string;
}

/**
 * Builds an isolated persisted Workspace using only public Data and Engine
 * contracts. The caller owns and may recursively delete the resulting path.
 */
export async function createDisposableWorkspace(
  options: CreateDisposableWorkspaceOptions,
): Promise<DisposableWorkspaceManifest> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const workspacePath = path.resolve(options.workspacePath);
  await assertDisposableDestination(workspacePath);

  const validator = await createRepositoryProtocolValidator({ repositoryRoot });
  const clock = new SequenceClock("2026-07-01T00:00:00.000Z", 1_000);
  const workspace = await LocalDataWorkspace.open({
    workspaceRoot: workspacePath,
    validator,
    clock,
    ids: new SequenceIdGenerator(80_000),
  });

  try {
    const screenshotObject = await persistScreenshotObject(repositoryRoot, workspace);
    const baseSnapshot = await readJson(
      repositoryRoot,
      "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json",
    );
    const leftSnapshot = makeSnapshot({
      source: baseSnapshot,
      screenshotObject,
      snapshotId: LEFT_SNAPSHOT_ID,
      buildId: LEFT_BUILD_ID,
      applicationVersion: "1.0.0",
      sourceGitSha: "1111111111111111111111111111111111111111",
    });
    const rightSnapshot = makeSnapshot({
      source: baseSnapshot,
      screenshotObject,
      snapshotId: RIGHT_SNAPSHOT_ID,
      buildId: RIGHT_BUILD_ID,
      applicationVersion: "2.0.0",
      sourceGitSha: "2222222222222222222222222222222222222222",
      addedStableId: "demo.home.acceptance_marker",
    });
    validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, leftSnapshot);
    validator.assert(PROTOCOL_SCHEMA_IDS.runtimeSnapshot, rightSnapshot);

    const snapshots = workspace.data.beginUnitOfWork("write");
    try {
      snapshots.snapshots.put(leftSnapshot as unknown as RuntimeSnapshot, [screenshotObject]);
      snapshots.snapshots.put(rightSnapshot as unknown as RuntimeSnapshot, [screenshotObject]);
      snapshots.commit();
    } catch (error) {
      snapshots.rollback();
      throw error;
    }

    const graph = new ScreenGraphEngine({
      workspace: workspace.data,
      validator,
      ids: new SequenceIdGenerator(81_000),
    });
    graph.recordStateObservation({
      snapshot_id: LEFT_SNAPSHOT_ID,
      title: "Home baseline",
      entry: true,
    });
    graph.recordStateObservation({
      snapshot_id: RIGHT_SNAPSHOT_ID,
      title: "Home candidate",
    });

    const knowledge = new KnowledgeEngine({
      workspace: workspace.data,
      validator,
      objects: workspace.objects,
      ids: new SequenceIdGenerator(82_000),
    });
    const wikiNode = knowledge.createNode({
      kind: "screen",
      title: "Disposable Home acceptance fixture",
      slug: "disposable-home-acceptance",
      summary: "Persisted local data used by packaged Studio and UI automation acceptance.",
      markdown:
        "# Disposable Home acceptance fixture\n\nThis content is generated for local acceptance and may be deleted in full.\n",
      labels: ["acceptance", "disposable", "home"],
      related_resources: [
        { kind: "runtime_snapshot", id: LEFT_SNAPSHOT_ID },
        { kind: "runtime_snapshot", id: RIGHT_SNAPSHOT_ID },
      ],
      created_by: ACTOR,
    });
    const collection = knowledge.createCollection({
      name: "Disposable Studio acceptance",
      summary: "One deterministic Collection shared by packaged and UI acceptance workflows.",
      node_ids: [wikiNode.wiki_node_id],
      entry_node_ids: [wikiNode.wiki_node_id],
      created_by: ACTOR,
    });

    const tuning = new TuningEngine({
      workspace: workspace.data,
      validator,
      ids: new SequenceIdGenerator(83_000),
    });
    const patch = tuning.createTuningPatch({
      title: "Disposable catalog button source handoff",
      description: "Proves that persisted Runtime provenance becomes actionable source guidance.",
      target_snapshot_id: LEFT_SNAPSHOT_ID,
      status: "approved",
      changes: [
        {
          runtime_target: {
            snapshot_id: LEFT_SNAPSHOT_ID,
            tree_id: "tree_019f0000-0000-7000-8000-000000000002",
            node_id: "node_019f0000-0000-7000-8000-000000000011",
            stable_id: "demo.home.open_catalog",
          },
          property: "alpha",
          original_value: { kind: "number", value: 1, unit: "ratio", extensions: {} },
          preview_value: { kind: "number", value: 0.8, unit: "ratio", extensions: {} },
        },
      ],
      created_by: ACTOR,
    });
    const suggestions = tuning.generateSourceSuggestions(patch.patch_id);
    if (suggestions.suggestions.length !== 1 || suggestions.suggestions[0]?.status !== "actionable") {
      throw new Error("The disposable fixture did not produce an actionable source handoff.");
    }

    const recoveryPoint = await workspace.createRecoveryPoint({
      reason: "Checkpoint before disposable acceptance mutates the Workspace.",
      retention: {
        policy_id: RECOVERY_POLICY_ID,
        reason: "Retain until packaged restore acceptance completes.",
      },
    });

    const marker = knowledge.createNode({
      kind: "note",
      title: "Post-recovery disposable marker",
      markdown:
        "This node is intentionally created after the recovery point and must disappear after restore.\n",
      labels: ["acceptance", "restore-marker"],
      created_by: ACTOR,
    });
    const garbageObject = await workspace.objects.put(
      bytesOf(Buffer.from("Vistrea disposable garbage collection candidate\n", "utf8")),
      {
        media_type: "application/octet-stream",
        compression: "none",
        logical_name: "disposable-gc-candidate.bin",
      },
    );
    workspace.data.registerVerifiedObjects([garbageObject]);

    const runtimeContext = leftSnapshot["runtime_context"] as JsonObject;
    return {
      format_version: 1,
      fixture_kind: "vistrea_disposable_workspace",
      workspace_path: workspacePath,
      project_id: String(runtimeContext["project_id"]),
      application_id: String(runtimeContext["application_id"]),
      left_build_id: LEFT_BUILD_ID,
      right_build_id: RIGHT_BUILD_ID,
      left_snapshot_id: LEFT_SNAPSHOT_ID,
      right_snapshot_id: RIGHT_SNAPSHOT_ID,
      collection_id: collection.collection_id,
      wiki_node_id: wikiNode.wiki_node_id,
      tuning_patch_id: patch.patch_id,
      recovery_point_id: recoveryPoint.recovery_point_id,
      recovery_policy_id: RECOVERY_POLICY_ID,
      gc_candidate_hash: garbageObject.hash,
      post_recovery_marker_node_id: marker.wiki_node_id,
    };
  } finally {
    await workspace.close();
  }
}

async function persistScreenshotObject(
  repositoryRoot: string,
  workspace: LocalDataWorkspace,
): Promise<ObjectRef> {
  const objectFixture = await readJson(
    repositoryRoot,
    "protocol/fixtures/v1/object/valid/plain-text.json",
  );
  const payloadBase64 = (objectFixture as JsonObject)["payload_base64"];
  if (typeof payloadBase64 !== "string") {
    throw new Error("The canonical Object fixture does not contain payload_base64.");
  }
  const bytes = Buffer.from(payloadBase64, "base64");
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const object = await workspace.objects.put(bytesOf(bytes), {
    expected_hash: hash,
    media_type: "image/png",
    compression: "none",
    logical_name: "disposable-home.png",
  });
  workspace.data.registerVerifiedObjects([object]);
  return object;
}

interface SnapshotOptions {
  readonly source: unknown;
  readonly screenshotObject: ObjectRef;
  readonly snapshotId: string;
  readonly buildId: string;
  readonly applicationVersion: string;
  readonly sourceGitSha: string;
  readonly addedStableId?: string;
}

function makeSnapshot(options: SnapshotOptions): Record<string, unknown> {
  const snapshot = structuredClone(options.source) as Record<string, unknown>;
  snapshot["snapshot_id"] = options.snapshotId;
  const runtimeContext = snapshot["runtime_context"] as Record<string, unknown>;
  runtimeContext["build_id"] = options.buildId;
  runtimeContext["application_version"] = options.applicationVersion;
  runtimeContext["source_git_sha"] = options.sourceGitSha;
  const screenshot = snapshot["screenshot"] as Record<string, unknown>;
  screenshot["object"] = options.screenshotObject;
  if (options.addedStableId !== undefined) {
    addMarkerNode(snapshot, options.addedStableId);
  }
  return snapshot;
}

function addMarkerNode(snapshot: Record<string, unknown>, stableId: string): void {
  const tree = (snapshot["trees"] as Record<string, unknown>[])[0];
  const payload = tree?.["payload"] as Record<string, unknown> | undefined;
  const nodes = payload?.["inline_nodes"] as Record<string, unknown>[] | undefined;
  const root = nodes?.[0];
  if (nodes === undefined || root === undefined) {
    throw new Error("The canonical Snapshot fixture does not contain an inline root node.");
  }
  const nodeId = "node_019f0000-0000-7000-8000-00000000a099";
  root["child_ids"] = [...((root["child_ids"] as readonly string[]) ?? []), nodeId];
  nodes.push({
    node_id: nodeId,
    parent_id: String(root["node_id"]),
    stable_id: stableId,
    child_ids: [],
    native_type: "UILabel",
    role: "text",
    frame: { x: 24, y: 220, width: 342, height: 44 },
    visible_rect: { x: 24, y: 220, width: 342, height: 44 },
    content: { text: "Candidate build marker" },
    state: { visible: true, enabled: true },
    actions: [],
    accessibility: { label: "Candidate build marker", role: "text", hidden: false },
    source_context: {
      route: "demo/home",
      controller: "DemoHomeViewController",
      component: "AcceptanceMarker",
    },
    capture_limitations: [],
    related_nodes: [],
    extensions: {},
  });
}

async function assertDisposableDestination(workspacePath: string): Promise<void> {
  if (!path.isAbsolute(workspacePath) || workspacePath === path.parse(workspacePath).root) {
    throw new Error("The disposable Workspace path must be an absolute non-root path.");
  }
  let entries: readonly string[];
  try {
    entries = await fs.readdir(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });
      return;
    }
    throw error;
  }
  if (entries.length !== 0) {
    throw new Error("The disposable Workspace destination must be empty.");
  }
}

async function readJson(repositoryRoot: string, relativePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")) as unknown;
}

async function* bytesOf(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}

interface Arguments {
  readonly workspacePath: string;
  readonly manifestPath: string;
}

function parseArguments(source: readonly string[]): Arguments {
  if (source.length !== 4 || source[0] !== "--workspace" || source[2] !== "--manifest") {
    throw new Error(
      "Usage: disposable-workspace --workspace <absolute-empty-path> --manifest <absolute-json-path>",
    );
  }
  const workspacePath = source[1];
  const manifestPath = source[3];
  if (
    workspacePath === undefined ||
    manifestPath === undefined ||
    !path.isAbsolute(workspacePath) ||
    !path.isAbsolute(manifestPath)
  ) {
    throw new Error("Workspace and manifest paths must be absolute.");
  }
  return { workspacePath, manifestPath };
}

async function main(): Promise<void> {
  const argumentsValue = parseArguments(process.argv.slice(2));
  const repositoryRoot = process.cwd();
  const manifest = await createDisposableWorkspace({
    repositoryRoot,
    workspacePath: argumentsValue.workspacePath,
  });
  await fs.mkdir(path.dirname(argumentsValue.manifestPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(argumentsValue.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
