import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonStrict, StrictJsonError } from "../../tools/protocol/strict-json.mjs";

test("strict JSON parsing preserves ordinary JSON values", () => {
  const text = '{"name":"Vistrea","items":[1,true,null],"nested":{"value":-0}}';
  assert.deepEqual(parseJsonStrict(text, "ordinary.json"), JSON.parse(text));
});

test("duplicate decoded object keys report their path and both locations", () => {
  const text = `{
  "outer": {
    "id": 1,
    "\\u0069d": 2
  }
}`;

  assert.throws(
    () => parseJsonStrict(text, "duplicate.json"),
    (error) => {
      assert.ok(error instanceof StrictJsonError);
      assert.equal(error.code, "duplicate_json_key");
      assert.equal(error.source, "duplicate.json");
      assert.equal(error.path, "/outer/id");
      assert.deepEqual(error.location, { offset: 32, line: 4, column: 5 });
      assert.deepEqual(error.firstLocation, { offset: 19, line: 3, column: 5 });
      return true;
    },
  );
});

test("duplicate-key scope and array indexes are represented by JSON Pointer paths", () => {
  assert.deepEqual(parseJsonStrict('{"left":{"id":1},"right":{"id":2}}'), {
    left: { id: 1 },
    right: { id: 2 },
  });

  assert.throws(
    () => parseJsonStrict('{"items":[{"a/b~c":1,"a/b~c":2}]}'),
    (error) => error.code === "duplicate_json_key" && error.path === "/items/0/a~1b~0c",
  );
});

test("unsafe integer literals are rejected before JSON number conversion", () => {
  assert.throws(
    () => parseJsonStrict('{"commit":{"sequence":9007199254740992}}', "commit.json"),
    (error) => {
      assert.equal(error.code, "unsafe_json_integer");
      assert.equal(error.path, "/commit/sequence");
      assert.equal(error.literal, "9007199254740992");
      assert.deepEqual(error.location, { offset: 22, line: 1, column: 23 });
      return true;
    },
  );
});

test("unsafe negative, decimal, and exponent integer forms are rejected", () => {
  for (const literal of ["-9007199254740992", "90071992547409920.0e-1", "1e20"]) {
    assert.throws(
      () => parseJsonStrict(`{"value":${literal}}`),
      (error) => error.code === "unsafe_json_integer" && error.literal === literal,
    );
  }
});

test("safe integer boundaries and non-integer numbers remain valid JSON", () => {
  const value = parseJsonStrict(
    '{"maximum":9007199254740991,"minimum":-9007199254740991,"fraction":1.25,"small":1e-20}',
  );

  assert.equal(value.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(value.minimum, Number.MIN_SAFE_INTEGER);
  assert.equal(value.fraction, 1.25);
  assert.equal(value.small, 1e-20);
});

test("invalid JSON still reports a structured source location", () => {
  assert.throws(
    () => parseJsonStrict('{"value":}', "invalid.json"),
    (error) => {
      assert.equal(error.code, "invalid_json");
      assert.equal(error.source, "invalid.json");
      assert.equal(error.path, "/value");
      assert.deepEqual(error.location, { offset: 9, line: 1, column: 10 });
      return true;
    },
  );
});

test("strict JSON rejects invalid UTF-8 before replacement decoding", () => {
  const bytes = Buffer.from([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  assert.throws(
    () => parseJsonStrict(bytes, "invalid-utf8.json"),
    (error) => error.code === "invalid_utf8" && error.source === "invalid-utf8.json",
  );
});

test("strict JSON accepts scalar pairs and rejects lone surrogate escapes", () => {
  assert.deepEqual(parseJsonStrict('{"value":"\\ud83d\\ude00"}'), { value: "😀" });
  for (const escaped of ["\\ud800", "\\udc00", "\\ud800x"]) {
    assert.throws(
      () => parseJsonStrict(`{"value":"${escaped}"}`),
      (error) => error.code === "invalid_unicode_scalar",
    );
  }
});
