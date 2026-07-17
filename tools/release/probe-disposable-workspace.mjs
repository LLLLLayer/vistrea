#!/usr/bin/env node

import fs from "node:fs/promises";

const [descriptorPath, manifestPath, expectedMarkerState] = process.argv.slice(2);
if (
  descriptorPath === undefined ||
  manifestPath === undefined ||
  !["present", "absent"].includes(expectedMarkerState)
) {
  throw new Error(
    "usage: probe-disposable-workspace.mjs <descriptor> <manifest> <present|absent>",
  );
}

const [descriptor, manifest] = await Promise.all([
  readJson(descriptorPath),
  readJson(manifestPath),
]);
const baseUrl = new URL(descriptor?.api?.base_url);
const token = descriptor?.api?.bearer_token;
const markerID = manifest?.post_recovery_marker_node_id;
if (
  baseUrl.protocol !== "http:" ||
  !["127.0.0.1", "[::1]", "::1"].includes(baseUrl.hostname) ||
  typeof token !== "string" ||
  token.length < 32 ||
  typeof markerID !== "string"
) {
  throw new Error("the disposable Workspace probe input is invalid");
}

const response = await fetch(
  new URL(`/v1/wiki/nodes/${encodeURIComponent(markerID)}`, baseUrl),
  { headers: { authorization: `Bearer ${token}` } },
);
if (expectedMarkerState === "present") {
  if (!response.ok) {
    throw new Error(`the post-recovery marker returned HTTP ${response.status}`);
  }
  const node = await response.json();
  if (node?.wiki_node_id !== markerID) {
    throw new Error("the post-recovery marker response has the wrong identity");
  }
} else {
  if (response.status !== 404) {
    throw new Error(`the restored post-recovery marker returned HTTP ${response.status}`);
  }
  const envelope = await response.json();
  if (envelope?.error?.code !== "not_found") {
    throw new Error("the restored marker did not use the not_found error contract");
  }
}

process.stdout.write(`Verified disposable Workspace marker is ${expectedMarkerState}.\n`);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
