#!/usr/bin/env node

import fs from "node:fs";

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (
    value === undefined ||
    !["--candidate", "--published-tags-file"].includes(name) ||
    values.has(name)
  ) {
    fail("usage: validate-studio-release-version.mjs --candidate <x.y.z> --published-tags-file <path>");
  }
  values.set(name, value);
}

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function parseVersion(source, label) {
  const match = versionPattern.exec(source);
  if (match === null) {
    fail(`${label} must be a canonical x.y.z version without leading zeroes`);
  }
  return match.slice(1).map((part) => BigInt(part));
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

const candidateSource = values.get("--candidate");
const tagsFile = values.get("--published-tags-file");
if (candidateSource === undefined || tagsFile === undefined) {
  fail("both --candidate and --published-tags-file are required");
}

const candidate = parseVersion(candidateSource, "candidate");
let source;
try {
  source = fs.readFileSync(tagsFile, "utf8");
} catch {
  fail("published tags file is unavailable");
}

const published = source
  .split(/\r?\n/u)
  .filter((tag) => tag.length > 0 && tag.startsWith("studio-v"))
  .map((tag) => ({ tag, version: parseVersion(tag.slice("studio-v".length), `published tag ${tag}`) }));

const blocking = published
  .filter(({ version }) => compareVersions(version, candidate) >= 0)
  .sort((left, right) => compareVersions(right.version, left.version))[0];
if (blocking !== undefined) {
  fail(`studio-v${candidateSource} must be newer than published release ${blocking.tag}`);
}

process.stdout.write(`studio-v${candidateSource} is newer than ${published.length} published Studio release(s).\n`);
