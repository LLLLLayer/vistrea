import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

import { DataError } from "../api/errors.js";
import type { JsonObject, ProtocolValidator } from "../api/models.js";

export interface RepositoryProtocolValidatorOptions {
  readonly repositoryRoot?: string;
}

interface SchemaError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly message?: string;
}

interface SchemaValidator {
  (value: unknown): boolean;
  readonly errors?: readonly SchemaError[] | null;
}

interface SchemaRegistry {
  addSchema(schema: JsonObject): void;
  getSchema(schemaId: string): SchemaValidator | undefined;
}

interface SemanticIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface SemanticChecksModule {
  runSemanticChecks(
    kind: string,
    value: unknown,
    context: {
      validateSchema(
        schemaId: string,
        candidate: unknown,
      ): { registered: boolean; valid: boolean; errors: readonly JsonObject[] };
    },
  ): readonly SemanticIssue[];
}

const Ajv2020 = Ajv2020Import as unknown as new (options: {
  allErrors: boolean;
  strict: boolean;
  validateFormats: boolean;
}) => SchemaRegistry;
const addFormats = addFormatsImport as unknown as (registry: SchemaRegistry) => void;

const semanticKindBySchemaId = new Map<string, string>([
  ["https://vistrea.dev/schema/v1/runtime-snapshot.schema.json", "runtime-snapshot"],
  ["https://vistrea.dev/schema/v1/runtime-event.schema.json", "runtime-event"],
  ["https://vistrea.dev/schema/v1/runtime-event-batch.schema.json", "runtime-event-batch"],
  ["https://vistrea.dev/schema/v1/graph.schema.json", "screen-graph"],
  [
    "https://vistrea.dev/schema/v1/knowledge.schema.json#/$defs/KnowledgeGraph",
    "knowledge-graph",
  ],
  [
    "https://vistrea.dev/schema/v1/design.schema.json#/$defs/DesignReviewBundle",
    "design-review-bundle",
  ],
  ["https://vistrea.dev/schema/v1/design.schema.json#/$defs/TuningPatch", "tuning-patch"],
  ["https://vistrea.dev/schema/v1/validation.schema.json", "validation-run"],
  [
    "https://vistrea.dev/schema/v1/validation.schema.json#/$defs/ValidationFinding",
    "validation-finding",
  ],
  [
    "https://vistrea.dev/schema/v1/validation.schema.json#/$defs/ValidationSuppression",
    "validation-suppression",
  ],
  [
    "https://vistrea.dev/schema/v1/validation.schema.json#/$defs/ValidationBundle",
    "validation-bundle",
  ],
  ["https://vistrea.dev/schema/v1/validation.schema.json#/$defs/BuildDiff", "build-diff"],
  ["https://vistrea.dev/schema/v1/operation.schema.json", "operation-record"],
  ["https://vistrea.dev/schema/v1/commit.schema.json", "commit"],
  ["https://vistrea.dev/schema/v1/commit.schema.json#/$defs/WorkingSet", "working-set"],
  ["https://vistrea.dev/schema/v1/workspace.schema.json", "workspace"],
]);

/**
 * Builds a closed local schema registry. Network schema loading is deliberately
 * unsupported so Data behavior cannot change according to remote state.
 */
export async function createRepositoryProtocolValidator(
  options: RepositoryProtocolValidatorOptions = {},
): Promise<ProtocolValidator> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const schemaDirectory = path.join(repositoryRoot, "protocol/schema/v1");
  const entries = (await fs.readdir(schemaDirectory))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);

  for (const entry of entries) {
    const source = await fs.readFile(path.join(schemaDirectory, entry), "utf8");
    ajv.addSchema(JSON.parse(source) as JsonObject);
  }

  const semanticModuleUrl = pathToFileURL(
    path.join(repositoryRoot, "tools/protocol/semantic-checks.mjs"),
  ).href;
  const semanticModule = (await import(semanticModuleUrl)) as SemanticChecksModule;

  const validateSchema = (
    schemaId: string,
    candidate: unknown,
  ): { registered: boolean; valid: boolean; errors: readonly JsonObject[] } => {
    const validate = ajv.getSchema(schemaId);
    if (validate === undefined) {
      return { registered: false, valid: false, errors: [] };
    }
    const valid = validate(candidate);
    const errors = (validate.errors ?? []).map((error) => ({
      keyword: error.keyword,
      instance_path: error.instancePath,
      message: error.message ?? "Schema validation failed.",
    }));
    return { registered: true, valid, errors };
  };

  return {
    assert(schemaId: string, value: unknown): void {
      const validate = ajv.getSchema(schemaId);
      if (validate === undefined) {
        throw new DataError("unsupported", "The protocol schema is not registered locally.", {
          details: { schema_id: schemaId },
        });
      }
      if (!validate(value)) {
        const errors = (validate.errors ?? []).map((error) => ({
          keyword: error.keyword,
          instance_path: error.instancePath,
          message: error.message ?? "Schema validation failed.",
        }));
        throw new DataError("invalid_argument", "The value does not satisfy its protocol schema.", {
          details: {
            schema_id: schemaId,
            errors,
          },
        });
      }
      const semanticKind = semanticKindBySchemaId.get(schemaId);
      if (semanticKind !== undefined) {
        const issues = semanticModule.runSemanticChecks(semanticKind, value, { validateSchema });
        if (issues.length > 0) {
          throw new DataError(
            "invalid_argument",
            "The value violates protocol semantic invariants.",
            {
              details: {
                schema_id: schemaId,
                issues: issues.map((issue) => ({
                  code: issue.code,
                  path: issue.path,
                  message: issue.message,
                })),
              },
            },
          );
        }
      }
    },
  };
}
