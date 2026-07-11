import type { JsonObject } from "./models.js";

export const DATA_ERROR_CODES = [
  "invalid_argument",
  "not_found",
  "already_exists",
  "conflict",
  "unsupported",
  "integrity_error",
  "resource_exhausted",
  "internal",
] as const;

export type DataErrorCode = (typeof DATA_ERROR_CODES)[number];

export class DataError extends Error {
  readonly code: DataErrorCode;
  readonly retryable: boolean;
  readonly details: JsonObject;

  constructor(
    code: DataErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly details?: JsonObject } = {},
  ) {
    super(message);
    this.name = "DataError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function isDataError(value: unknown, code?: DataErrorCode): value is DataError {
  return value instanceof DataError && (code === undefined || value.code === code);
}
