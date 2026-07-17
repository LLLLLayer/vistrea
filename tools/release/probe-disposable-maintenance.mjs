#!/usr/bin/env node

import fs from "node:fs/promises";

const [operation, manifestPath, resultPath] = process.argv.slice(2);
if (!operation || !manifestPath || !resultPath) {
  throw new Error(
    "usage: probe-disposable-maintenance.mjs <gc-plan|gc-apply|restore> <manifest> <result>",
  );
}
const [manifest, envelope] = await Promise.all([
  readJson(manifestPath),
  readJson(resultPath),
]);
if (envelope?.status !== "succeeded" || typeof envelope.result !== "object") {
  throw new Error(`Workspace maintenance ${operation} did not succeed`);
}

switch (operation) {
  case "gc-plan": {
    const result = envelope.result;
    if (
      result.dry_run !== true ||
      result.candidate_objects !== 1 ||
      result.deleted_objects !== 0 ||
      !Array.isArray(result.candidate_hashes) ||
      result.candidate_hashes.length !== 1 ||
      result.candidate_hashes[0] !== manifest.gc_candidate_hash ||
      typeof result.plan_digest !== "string"
    ) {
      throw new Error("the disposable GC plan was not exact");
    }
    process.stdout.write(result.plan_digest);
    break;
  }
  case "gc-apply": {
    const result = envelope.result;
    if (
      result.dry_run !== false ||
      result.candidate_objects !== 1 ||
      result.deleted_objects !== 1 ||
      !Array.isArray(result.candidate_hashes) ||
      result.candidate_hashes[0] !== manifest.gc_candidate_hash
    ) {
      throw new Error("the disposable GC apply result was not exact");
    }
    process.stdout.write("Verified exact disposable Workspace garbage collection.\n");
    break;
  }
  case "restore": {
    const result = envelope.result;
    if (
      result?.backup?.hash !== manifest.recovery_point_id ||
      typeof result.recovery_id !== "string" ||
      !result.recovery_id.startsWith("restore-")
    ) {
      throw new Error("the disposable restore result did not match its recovery point");
    }
    process.stdout.write("Verified disposable Workspace recovery point restore.\n");
    break;
  }
  default:
    throw new Error(`unknown maintenance probe operation: ${operation}`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
