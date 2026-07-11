import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { runSemanticChecks } from "./semantic-checks.mjs";
import { parseJsonStrict, StrictJsonError } from "./strict-json.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const schemaDirectory = path.join(repositoryRoot, "protocol/schema/v1");
const fixtureDirectory = path.join(repositoryRoot, "protocol/fixtures/v1");

async function readJson(filePath) {
  return parseJsonStrict(await fs.readFile(filePath), path.relative(repositoryRoot, filePath));
}

async function loadSchemas() {
  const entries = (await fs.readdir(schemaDirectory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(entries.map((name) => readJson(path.join(schemaDirectory, name))));
}

function formatSchemaErrors(errors = []) {
  return (errors ?? []).map((error) => {
    const formatted = {
      keyword: error.keyword,
      instance_path: error.instancePath,
      message: error.message ?? "Schema validation failed.",
    };
    if (error.params.missingProperty !== undefined) {
      formatted.missing_property = error.params.missingProperty;
    }
    if (error.params.additionalProperty !== undefined) {
      formatted.additional_property = error.params.additionalProperty;
    }
    return formatted;
  });
}

function formatJsonError(error) {
  if (error instanceof StrictJsonError) {
    return {
      code: error.code,
      path: error.path,
      line: error.location.line,
      column: error.location.column,
      message: error.message,
    };
  }
  return { code: "invalid_json", path: "/", message: error.message };
}

function matchesExpectedSchemaError(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function collectJsonFixturePaths(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await collectJsonFixturePaths(path.join(directory, entry.name), relativePath)));
    } else if (entry.isFile() && entry.name.endsWith(".json") && relativePath !== "manifest.json") {
      paths.push(relativePath);
    }
  }
  return paths.sort();
}

const semanticKindBySchemaId = new Map([
  ["https://vistrea.dev/schema/v1/runtime-snapshot.schema.json", "runtime-snapshot"],
  ["https://vistrea.dev/schema/v1/runtime-event.schema.json", "runtime-event"],
  ["https://vistrea.dev/schema/v1/runtime-event-batch.schema.json", "runtime-event-batch"],
  [
    "https://vistrea.dev/schema/v1/runtime-event.schema.json#/$defs/RuntimeEventBatch",
    "runtime-event-batch",
  ],
  ["https://vistrea.dev/schema/v1/object-fixture.schema.json", "object-fixture"],
  ["https://vistrea.dev/schema/v1/workspace.schema.json", "workspace"],
  ["https://vistrea.dev/schema/v1/commit.schema.json", "commit"],
]);

export async function validateFixtureSet({ silent = false } = {}) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);

  for (const schema of await loadSchemas()) {
    ajv.addSchema(schema);
  }

  const manifestPath = path.join(fixtureDirectory, "manifest.json");
  const manifest = await readJson(manifestPath);
  const validateManifest = ajv.getSchema("https://vistrea.dev/schema/v1/fixture-manifest.schema.json");
  if (!validateManifest) {
    throw new Error("Fixture manifest schema was not registered.");
  }
  if (!validateManifest(manifest)) {
    throw new Error(`Invalid fixture manifest:\n${JSON.stringify(formatSchemaErrors(validateManifest.errors), null, 2)}`);
  }

  const failures = [];
  const results = [];
  const declaredPaths = manifest.fixtures.map((fixture) => fixture.path);
  const declaredPathSet = new Set(declaredPaths);
  const actualPaths = await collectJsonFixturePaths(fixtureDirectory);
  const actualPathSet = new Set(actualPaths);

  if (declaredPathSet.size !== declaredPaths.length) {
    failures.push("Fixture manifest contains duplicate paths.");
  }
  for (const actualPath of actualPaths) {
    if (!declaredPathSet.has(actualPath)) {
      failures.push(`${actualPath}: fixture file is not declared in the manifest.`);
    }
  }
  for (const declaredPath of declaredPathSet) {
    if (!actualPathSet.has(declaredPath)) {
      failures.push(`${declaredPath}: manifest entry does not have a fixture file.`);
    }
  }

  for (const fixture of manifest.fixtures) {
    const fixturePath = path.join(fixtureDirectory, fixture.path);
    if (!fixturePath.startsWith(`${fixtureDirectory}${path.sep}`)) {
      failures.push(`${fixture.path}: fixture path escapes the versioned fixture directory.`);
      continue;
    }
    let value;
    const jsonErrors = [];
    try {
      value = await readJson(fixturePath);
    } catch (error) {
      jsonErrors.push(formatJsonError(error));
    }

    if (fixture.expectation === "json-invalid") {
      const actualCodes = new Set(jsonErrors.map((error) => error.code));
      const passed =
        jsonErrors.length > 0 &&
        fixture.expected_json_codes.every((code) => actualCodes.has(code));
      results.push({
        path: fixture.path,
        expectation: fixture.expectation,
        passed,
        jsonErrors,
        schemaErrors: [],
        semanticErrors: [],
      });
      if (!passed) {
        failures.push(
          `${fixture.path}: expected ${fixture.expectation}\n` +
            `JSON errors: ${JSON.stringify(jsonErrors)}`,
        );
      }
      continue;
    }

    if (jsonErrors.length > 0) {
      results.push({
        path: fixture.path,
        expectation: fixture.expectation,
        passed: false,
        jsonErrors,
        schemaErrors: [],
        semanticErrors: [],
      });
      failures.push(
        `${fixture.path}: expected ${fixture.expectation}\n` +
          `JSON errors: ${JSON.stringify(jsonErrors)}`,
      );
      continue;
    }

    const validate = ajv.getSchema(fixture.schema_id);

    if (!validate) {
      failures.push(`${fixture.path}: schema ${fixture.schema_id} was not registered.`);
      continue;
    }

    const schemaValid = validate(value);
    const schemaErrors = formatSchemaErrors(validate.errors);
    const expectedSemanticKind = semanticKindBySchemaId.get(fixture.schema_id);
    const semanticKindValid = expectedSemanticKind
      ? fixture.semantic_kind === expectedSemanticKind
      : fixture.semantic_kind === undefined;
    const semanticErrors = schemaValid && semanticKindValid && expectedSemanticKind
      ? runSemanticChecks(expectedSemanticKind, value)
      : [];

    let passed = false;
    if (fixture.expectation === "schema-invalid") {
      passed =
        !schemaValid &&
        semanticKindValid &&
        fixture.expected_schema_errors.every((expected) =>
          schemaErrors.some((actual) => matchesExpectedSchemaError(actual, expected)),
        );
    } else if (fixture.expectation === "semantic-invalid") {
      const actualCodes = new Set(semanticErrors.map((error) => error.code));
      passed =
        schemaValid &&
        semanticKindValid &&
        semanticErrors.length > 0 &&
        fixture.expected_semantic_codes.every((code) => actualCodes.has(code));
    } else {
      passed = schemaValid && semanticKindValid && semanticErrors.length === 0;
    }

    results.push({
      path: fixture.path,
      expectation: fixture.expectation,
      passed,
      jsonErrors,
      schemaErrors,
      semanticErrors,
    });

    if (!passed) {
      failures.push(
        `${fixture.path}: expected ${fixture.expectation}\n` +
          `JSON errors: ${JSON.stringify(jsonErrors)}\n` +
          `schema errors: ${JSON.stringify(schemaErrors)}\n` +
          `semantic errors: ${JSON.stringify(semanticErrors)}`,
      );
    }
  }

  if (!silent) {
    for (const result of results) {
      const mark = result.passed ? "PASS" : "FAIL";
      console.log(`${mark} ${result.expectation.padEnd(19)} ${result.path}`);
    }
    const passedCount = results.filter((result) => result.passed).length;
    console.log(`\n${passedCount}/${manifest.fixtures.length} fixtures passed.`);
  }

  return { manifest, results, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const report = await validateFixtureSet();
  if (report.failures.length > 0) {
    console.error(`\n${report.failures.join("\n\n")}`);
    process.exitCode = 1;
  }
}
