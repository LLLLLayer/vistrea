import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HOST_OPERATION_MANIFEST,
  IMPLEMENTED_HOST_OPERATIONS,
  type HostOperationDescriptor,
} from "../../integrations/shared/index.js";

test("the machine-readable Host operation manifest is unique and complete", () => {
  assert.equal(HOST_OPERATION_MANIFEST.length, 69);
  assert.deepEqual(
    IMPLEMENTED_HOST_OPERATIONS,
    HOST_OPERATION_MANIFEST.map(({ operation }) => operation),
  );
  assert.equal(new Set(IMPLEMENTED_HOST_OPERATIONS).size, IMPLEMENTED_HOST_OPERATIONS.length);
  assert.equal(
    new Set(HOST_OPERATION_MANIFEST.map(({ method, route }) => `${method} ${route}`)).size,
    HOST_OPERATION_MANIFEST.length,
  );
  assert.equal(
    new Set(HOST_OPERATION_MANIFEST.map(({ cli }) => cli)).size,
    HOST_OPERATION_MANIFEST.length,
  );
});

test("the Host client and CLI dispatch every implemented operation", async () => {
  const [clientSource, cliSource] = await Promise.all([
    readFile("integrations/shared/host-local-client.ts", "utf8"),
    readFile("integrations/cli/cli.ts", "utf8"),
  ]);
  const clientOperations = new Set(
    [...clientSource.matchAll(/case "([A-Z][A-Za-z0-9]+)":/g)].map((match) => match[1]),
  );
  const cliOperations = new Set([
    ...[...cliSource.matchAll(/invocation\(\s*"([A-Z][A-Za-z0-9]+)"/g)].map(
      (match) => match[1],
    ),
    ...[...cliSource.matchAll(/operation:\s*"([A-Z][A-Za-z0-9]+)"/g)].map(
      (match) => match[1],
    ),
  ]);
  const expected = [...IMPLEMENTED_HOST_OPERATIONS].sort();
  assert.deepEqual([...clientOperations].sort(), expected);
  assert.deepEqual([...cliOperations].sort(), expected);
});

test("the implemented operation catalog matches the executable manifest", async () => {
  const markdown = await readFile("docs/interfaces/OPERATION_CATALOG.md", "utf8");
  const implementedSection = markdown
    .split("## 1. Implemented operations\n", 2)[1]
    ?.split("### Renamed or superseded draft names\n", 1)[0];
  assert.ok(implementedSection, "the implemented operation section must exist");

  const descriptors: HostOperationDescriptor[] = [];
  const row = /^\| `([^`]+)` \| ([CQ]) \| `(GET|POST) ([^`]+)` \| `([^`]+)` \|$/gm;
  for (const match of implementedSection.matchAll(row)) {
    descriptors.push({
      operation: match[1] as string,
      kind: match[2] as "C" | "Q",
      method: match[3] as "GET" | "POST",
      route: match[4] as string,
      cli: match[5] as string,
    });
  }
  assert.deepEqual(descriptors, HOST_OPERATION_MANIFEST);
});
