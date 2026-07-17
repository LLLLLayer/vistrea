import assert from "node:assert/strict";
import { test } from "node:test";

import { HOST_LOCAL_API_REQUEST_SHAPES } from "../../apps/host/local-api-request-contracts.js";
import { HOST_OPERATION_MANIFEST } from "../../integrations/shared/index.js";

test("all 72 Host Local API operations have one audited request shape", () => {
  assert.equal(HOST_OPERATION_MANIFEST.length, 72);
  assert.deepEqual(
    Object.keys(HOST_LOCAL_API_REQUEST_SHAPES).sort(),
    HOST_OPERATION_MANIFEST.map(({ operation }) => operation).sort(),
  );

  for (const descriptor of HOST_OPERATION_MANIFEST) {
    const shape = HOST_LOCAL_API_REQUEST_SHAPES[descriptor.operation];
    if (descriptor.method === "GET") {
      assert.ok(
        shape === "none" || shape === "query",
        `${descriptor.operation} cannot use a request body over GET.`,
      );
    }
    if (shape === "binary") {
      assert.equal(descriptor.method, "POST", `${descriptor.operation} must stream over POST.`);
    }
  }

  assert.equal(
    Object.values(HOST_LOCAL_API_REQUEST_SHAPES).filter((shape) => shape === "json").length,
    38,
  );
  assert.equal(
    Object.values(HOST_LOCAL_API_REQUEST_SHAPES).filter((shape) => shape === "binary").length,
    2,
  );
});
