import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  checkBuildDiff,
  checkDesignReviewBundle,
  checkKnowledgeGraph,
  checkOperationRecord,
  checkScreenGraph,
  checkTuningPatch,
  checkValidationBundle,
  checkValidationFinding,
  checkValidationRun,
  checkValidationSuppression,
  checkWorkingSet,
} from "./phase0a2-semantic-checks.mjs";

export function canonicalizeIdentityJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Identity JSON numbers must be safe integers.");
    }
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeIdentityJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort(compareUnicodeCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalizeIdentityJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Unsupported identity JSON value: ${typeof value}`);
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function issue(code, path, message) {
  return { code, path, message };
}

function checkRuntimeSnapshot(snapshot, context) {
  const issues = [];
  const { display } = snapshot;
  const expectedPixelWidth = display.logical_size.width * display.pixel_scale_x;
  const expectedPixelHeight = display.logical_size.height * display.pixel_scale_y;

  if (
    Math.abs(expectedPixelWidth - display.pixel_size.width) > 0.5 ||
    Math.abs(expectedPixelHeight - display.pixel_size.height) > 0.5
  ) {
    issues.push(
      issue(
        "display_scale_mismatch",
        "/display",
        "Logical display size multiplied by pixel scale must match display pixel size.",
      ),
    );
  }

  if (snapshot.screenshot) {
    const { coverage, pixel_size: screenshotPixelSize } = snapshot.screenshot;
    if (
      coverage.x < 0 ||
      coverage.y < 0 ||
      coverage.x + coverage.width > display.logical_size.width ||
      coverage.y + coverage.height > display.logical_size.height
    ) {
      issues.push(
        issue(
          "screenshot_coverage_out_of_bounds",
          "/screenshot/coverage",
          "Screenshot coverage must remain inside the logical display bounds.",
        ),
      );
    }

    const expectedScreenshotWidth = coverage.width * display.pixel_scale_x;
    const expectedScreenshotHeight = coverage.height * display.pixel_scale_y;
    if (
      Math.abs(expectedScreenshotWidth - screenshotPixelSize.width) > 0.5 ||
      Math.abs(expectedScreenshotHeight - screenshotPixelSize.height) > 0.5
    ) {
      issues.push(
        issue(
          "screenshot_pixel_size_mismatch",
          "/screenshot/pixel_size",
          "Screenshot coverage multiplied by display pixel scale must match screenshot pixel size.",
        ),
      );
    }

    const pixelEdges = [
      coverage.x * display.pixel_scale_x,
      coverage.y * display.pixel_scale_y,
      (coverage.x + coverage.width) * display.pixel_scale_x,
      (coverage.y + coverage.height) * display.pixel_scale_y,
    ];
    if (pixelEdges.some((edge) => Math.abs(edge - Math.round(edge)) > 1e-6)) {
      issues.push(
        issue(
          "screenshot_coverage_not_pixel_aligned",
          "/screenshot/coverage",
          "Screenshot coverage edges must align to the display pixel grid.",
        ),
      );
    }
  }

  if (
    snapshot.event_window?.first_sequence !== undefined &&
    snapshot.event_window?.last_sequence !== undefined &&
    snapshot.event_window.first_sequence > snapshot.event_window.last_sequence
  ) {
    issues.push(issue("event_range_invalid", "/event_window", "Event sequence range is reversed."));
  }

  const treeById = new Map();
  for (const [treeIndex, tree] of snapshot.trees.entries()) {
    if (treeById.has(tree.tree_id)) {
      issues.push(issue("duplicate_tree_id", `/trees/${treeIndex}/tree_id`, "Tree ID is duplicated."));
    }
    treeById.set(tree.tree_id, tree);
  }

  const nodesByTree = new Map();
  const snapshotNodeIds = new Set();
  for (const [treeIndex, tree] of snapshot.trees.entries()) {
    let nodes = tree.payload.inline_nodes;
    if (!nodes) {
      if (typeof context.resolveUiNodes !== "function") {
        nodesByTree.set(tree.tree_id, null);
        issues.push(
          issue(
            "tree_payload_unresolved",
            `/trees/${treeIndex}/payload/nodes_object`,
            "Object-backed UI nodes must be resolved and schema-validated before semantic validation can succeed.",
          ),
        );
        continue;
      }
      try {
        nodes = context.resolveUiNodes(tree.payload.nodes_object, tree.payload.encoding);
      } catch (error) {
        nodesByTree.set(tree.tree_id, null);
        issues.push(
          issue(
            "tree_payload_resolution_failed",
            `/trees/${treeIndex}/payload/nodes_object`,
            `UI-node resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        continue;
      }
      if (!Array.isArray(nodes)) {
        nodesByTree.set(tree.tree_id, null);
        issues.push(
          issue(
            "tree_payload_resolution_invalid",
            `/trees/${treeIndex}/payload/nodes_object`,
            "The UI-node resolver must return a schema-valid node array.",
          ),
        );
        continue;
      }
      if (nodes.length !== tree.payload.node_count) {
        issues.push(
          issue(
            "tree_payload_node_count_mismatch",
            `/trees/${treeIndex}/payload/node_count`,
            `Resolved ${nodes.length} nodes.`,
          ),
        );
      }
    }

    const nodeMap = new Map();
    nodesByTree.set(tree.tree_id, nodeMap);

    for (const [nodeIndex, node] of nodes.entries()) {
      if (snapshotNodeIds.has(node.node_id)) {
        issues.push(
          issue(
            "duplicate_node_id",
            `/trees/${treeIndex}/payload/inline_nodes/${nodeIndex}/node_id`,
            "Node ID is duplicated within the Snapshot.",
          ),
        );
      }
      snapshotNodeIds.add(node.node_id);
      if (!nodeMap.has(node.node_id)) {
        nodeMap.set(node.node_id, node);
      }
    }

    for (const [rootIndex, rootId] of tree.root_node_ids.entries()) {
      const root = nodeMap.get(rootId);
      if (!root) {
        issues.push(
          issue(
            "dangling_root_reference",
            `/trees/${treeIndex}/root_node_ids/${rootIndex}`,
            "Root node does not exist in the tree.",
          ),
        );
      } else if (root.parent_id !== undefined) {
        issues.push(
          issue(
            "root_has_parent",
            `/trees/${treeIndex}/root_node_ids/${rootIndex}`,
            "A root node cannot declare a parent.",
          ),
        );
      }
    }

    for (const [nodeIndex, node] of nodes.entries()) {
      if (node.parent_id !== undefined) {
        const parent = nodeMap.get(node.parent_id);
        if (!parent) {
          issues.push(
            issue(
              "dangling_parent_reference",
              `/trees/${treeIndex}/payload/inline_nodes/${nodeIndex}/parent_id`,
              "Parent node does not exist in the tree.",
            ),
          );
        } else if (!parent.child_ids.includes(node.node_id)) {
          issues.push(
            issue(
              "parent_child_mismatch",
              `/trees/${treeIndex}/payload/inline_nodes/${nodeIndex}/parent_id`,
              "Parent does not list the node as a child.",
            ),
          );
        }
      }

      for (const [childIndex, childId] of node.child_ids.entries()) {
        const child = nodeMap.get(childId);
        if (!child) {
          issues.push(
            issue(
              "dangling_child_reference",
              `/trees/${treeIndex}/payload/inline_nodes/${nodeIndex}/child_ids/${childIndex}`,
              "Child node does not exist in the tree.",
            ),
          );
        } else if (child.parent_id !== node.node_id) {
          issues.push(
            issue(
              "parent_child_mismatch",
              `/trees/${treeIndex}/payload/inline_nodes/${nodeIndex}/child_ids/${childIndex}`,
              "Child does not point back to the parent.",
            ),
          );
        }
      }
    }

    const colors = new Map();
    for (const startId of nodeMap.keys()) {
      if ((colors.get(startId) ?? 0) !== 0) {
        continue;
      }
      const stack = [{ nodeId: startId, childIndex: 0 }];
      colors.set(startId, 1);

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const node = nodeMap.get(frame.nodeId);
        const children = node?.child_ids ?? [];

        if (frame.childIndex >= children.length) {
          colors.set(frame.nodeId, 2);
          stack.pop();
          continue;
        }

        const childId = children[frame.childIndex];
        frame.childIndex += 1;
        if (!nodeMap.has(childId)) {
          continue;
        }

        const childColor = colors.get(childId) ?? 0;
        if (childColor === 1) {
          issues.push(
            issue("tree_cycle", `/trees/${treeIndex}`, `Tree contains a cycle at ${childId}.`),
          );
        } else if (childColor === 0) {
          colors.set(childId, 1);
          stack.push({ nodeId: childId, childIndex: 0 });
        }
      }
    }

    const reachable = new Set();
    const reachabilityStack = [...tree.root_node_ids];
    while (reachabilityStack.length > 0) {
      const nodeId = reachabilityStack.pop();
      if (reachable.has(nodeId)) {
        continue;
      }
      reachable.add(nodeId);
      const node = nodeMap.get(nodeId);
      if (node) {
        reachabilityStack.push(...node.child_ids);
      }
    }
    const allowsDisconnected = tree.capture_limitations.some(
      (limitation) => limitation.code === "runtime.tree.disconnected_nodes",
    );
    if (!allowsDisconnected) {
      for (const nodeId of nodeMap.keys()) {
        if (!reachable.has(nodeId)) {
          issues.push(
            issue(
              "disconnected_node",
              `/trees/${treeIndex}`,
              `Node ${nodeId} is not reachable from a declared root.`,
            ),
          );
        }
      }
    }
  }

  for (const [treeIndex, tree] of snapshot.trees.entries()) {
    const sourceTree = nodesByTree.get(tree.tree_id);
    const nodes = sourceTree instanceof Map ? [...sourceTree.values()] : [];
    for (const [nodeIndex, node] of nodes.entries()) {
      for (const [relatedIndex, related] of node.related_nodes.entries()) {
        if (!treeById.has(related.tree_id)) {
          issues.push(
            issue(
              "dangling_related_tree_reference",
              `/trees/${treeIndex}/payload/inline_nodes/${nodeIndex}/related_nodes/${relatedIndex}/tree_id`,
              "Related tree does not exist in the Snapshot.",
            ),
          );
          continue;
        }
        const relatedTree = nodesByTree.get(related.tree_id);
        if (relatedTree instanceof Map && !relatedTree.has(related.node_id)) {
          issues.push(
            issue(
              "dangling_related_node_reference",
              `/trees/${treeIndex}/payload/inline_nodes/${nodeIndex}/related_nodes/${relatedIndex}`,
              "Related node does not exist in the referenced inline tree.",
            ),
          );
        }
      }
    }
  }

  return issues;
}

function checkRuntimeEvent() {
  return [];
}

function checkRuntimeEventBatch(batch) {
  const issues = [];
  if (batch.first_sequence > batch.last_sequence) {
    issues.push(
      issue("event_batch_range_invalid", "/first_sequence", "Batch sequence range is reversed."),
    );
    return issues;
  }

  let previousSequence;
  const sequences = new Set();
  const eventIds = new Set();
  for (const [eventIndex, event] of batch.events.entries()) {
    const eventPath = `/events/${eventIndex}`;
    if (event.event_epoch_id !== batch.event_epoch_id) {
      issues.push(
        issue(
          "event_batch_epoch_mismatch",
          `${eventPath}/event_epoch_id`,
          "Event epoch must match the enclosing batch epoch.",
        ),
      );
    }
    if (
      event.protocol_version.major !== batch.protocol_version.major ||
      event.protocol_version.minor !== batch.protocol_version.minor
    ) {
      issues.push(
        issue(
          "event_batch_version_mismatch",
          `${eventPath}/protocol_version`,
          "Event protocol version must match the enclosing batch version.",
        ),
      );
    }
    if (eventIds.has(event.event_id)) {
      issues.push(
        issue(
          "event_batch_duplicate_event_id",
          `${eventPath}/event_id`,
          "Event ID is duplicated within the batch.",
        ),
      );
    }
    if (event.sequence < batch.first_sequence || event.sequence > batch.last_sequence) {
      issues.push(
        issue(
          "event_batch_sequence_out_of_range",
          `${eventPath}/sequence`,
          "Event sequence must be inside the batch range.",
        ),
      );
    }
    if (sequences.has(event.sequence)) {
      issues.push(
        issue(
          "event_batch_duplicate_sequence",
          `${eventPath}/sequence`,
          "Event sequence is duplicated within the batch.",
        ),
      );
    }
    if (previousSequence !== undefined && event.sequence <= previousSequence) {
      issues.push(
        issue(
          "event_batch_order_invalid",
          `${eventPath}/sequence`,
          "Events must be strictly ordered by sequence.",
        ),
      );
    }
    sequences.add(event.sequence);
    eventIds.add(event.event_id);
    previousSequence = event.sequence;
  }

  const rangeSize = BigInt(batch.last_sequence) - BigInt(batch.first_sequence) + 1n;
  const accountedCount = BigInt(sequences.size) + BigInt(batch.dropped_event_count);
  if (accountedCount > rangeSize) {
    issues.push(
      issue(
        "event_batch_drop_count_exceeds_range",
        "/dropped_event_count",
        "Retained events plus dropped events cannot exceed the inclusive batch range.",
      ),
    );
  }
  return issues;
}

function checkObjectFixture(fixture) {
  const issues = [];
  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (
    /\s/.test(fixture.payload_base64) ||
    fixture.payload_base64.length % 4 !== 0 ||
    !canonicalBase64.test(fixture.payload_base64)
  ) {
    issues.push(issue("object_payload_invalid_base64", "/payload_base64", "Payload is not canonical base64."));
    return issues;
  }
  const bytes = Buffer.from(fixture.payload_base64, "base64");
  if (bytes.toString("base64") !== fixture.payload_base64) {
    issues.push(issue("object_payload_invalid_base64", "/payload_base64", "Payload is not canonical base64."));
    return issues;
  }
  const actualHash = `sha256:${sha256(bytes)}`;

  if (actualHash !== fixture.object.hash) {
    issues.push(issue("object_hash_mismatch", "/object/hash", `Expected ${actualHash}.`));
  }
  if (bytes.byteLength !== fixture.object.byte_size) {
    issues.push(
      issue("object_byte_size_mismatch", "/object/byte_size", `Expected ${bytes.byteLength} bytes.`),
    );
  }

  let decodedBytes = bytes;
  if (fixture.object.compression === "gzip") {
    try {
      decodedBytes = gunzipSync(bytes);
    } catch {
      issues.push(
        issue("object_payload_invalid_compression", "/payload_base64", "Payload is not valid gzip data."),
      );
      return issues;
    }
  }

  if (
    fixture.object.decoded_byte_size !== undefined &&
    decodedBytes.byteLength !== fixture.object.decoded_byte_size
  ) {
    issues.push(
      issue(
        "object_decoded_byte_size_mismatch",
        "/object/decoded_byte_size",
        `Expected ${decodedBytes.byteLength} decoded bytes.`,
      ),
    );
  }
  return issues;
}

function checkCommit(commit) {
  const issues = [];
  let canonical;
  try {
    canonical = canonicalizeIdentityJson(commit.manifest);
  } catch (error) {
    return [issue("commit_manifest_not_canonicalizable", "/manifest", error.message)];
  }

  const expectedCommitId = `commit:sha256:${sha256(Buffer.from(canonical, "utf8"))}`;
  if (commit.commit_id !== expectedCommitId) {
    issues.push(issue("commit_id_mismatch", "/commit_id", `Expected ${expectedCommitId}.`));
  }

  const rootHashes = Object.values(commit.manifest.roots).map((root) => root.hash);
  for (const rootHash of rootHashes) {
    if (!commit.manifest.object_hashes.includes(rootHash)) {
      issues.push(
        issue("commit_root_not_listed", "/manifest/object_hashes", `Missing root object ${rootHash}.`),
      );
    }
  }
  return issues;
}

export function runSemanticChecks(kind, value, context = {}) {
  switch (kind) {
    case "runtime-snapshot":
      return checkRuntimeSnapshot(value, context);
    case "runtime-event":
      return checkRuntimeEvent(value);
    case "runtime-event-batch":
      return checkRuntimeEventBatch(value);
    case "object-fixture":
      return checkObjectFixture(value);
    case "commit":
      return checkCommit(value);
    case "working-set":
      return checkWorkingSet(value);
    case "workspace":
      return [];
    case "screen-graph":
      return checkScreenGraph(value);
    case "knowledge-graph":
      return checkKnowledgeGraph(value);
    case "design-review-bundle":
      return checkDesignReviewBundle(value);
    case "tuning-patch":
      return checkTuningPatch(value);
    case "operation-record":
      return checkOperationRecord(value, context);
    case "validation-run":
      return checkValidationRun(value);
    case "validation-finding":
      return checkValidationFinding(value);
    case "validation-suppression":
      return checkValidationSuppression(value);
    case "validation-bundle":
      return checkValidationBundle(value);
    case "build-diff":
      return checkBuildDiff(value);
    default:
      throw new TypeError(`Unknown semantic check kind: ${String(kind)}`);
  }
}
