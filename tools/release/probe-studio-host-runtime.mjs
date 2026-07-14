#!/usr/bin/env node

import fs from "node:fs/promises";

const descriptorPath = process.argv[2];
if (descriptorPath === undefined) {
  throw new Error("connection descriptor path is required");
}

const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
const baseUrl = new URL(descriptor?.api?.base_url);
const token = descriptor?.api?.bearer_token;
if (
  baseUrl.protocol !== "http:" ||
  !["127.0.0.1", "[::1]", "::1"].includes(baseUrl.hostname) ||
  typeof token !== "string" ||
  token.length < 32
) {
  throw new Error("embedded Host descriptor is not a valid private loopback connection");
}

const response = await fetch(new URL("/v1/status", baseUrl), {
  headers: { authorization: `Bearer ${token}` },
});
if (!response.ok) {
  throw new Error(`embedded Host status returned HTTP ${response.status}`);
}
const status = await response.json();
if (
  status === null ||
  typeof status !== "object" ||
  !["ready", "degraded"].includes(status.status) ||
  typeof status.runtime_connected !== "boolean"
) {
  throw new Error("embedded Host status response is invalid");
}

process.stdout.write("Embedded Host accepted an authenticated Studio status request.\n");
