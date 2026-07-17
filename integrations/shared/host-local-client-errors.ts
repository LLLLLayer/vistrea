export type HostClientErrorCode =
  | "invalid_argument"
  | "not_found"
  | "already_exists"
  | "conflict"
  | "unauthenticated"
  | "forbidden"
  | "unsupported"
  | "policy_blocked"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "integrity_error"
  | "resource_exhausted"
  | "internal";

/** Canonical wire error codes accepted from the Host error envelope. */
export const HOST_ERROR_CODES = new Set<HostClientErrorCode>([
  "invalid_argument",
  "not_found",
  "already_exists",
  "conflict",
  "unauthenticated",
  "forbidden",
  "unsupported",
  "policy_blocked",
  "unavailable",
  "timeout",
  "cancelled",
  "integrity_error",
  "resource_exhausted",
  "internal",
]);

export class HostClientError extends Error {
  readonly code: HostClientErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly requestId?: string;

  constructor(
    code: HostClientErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly httpStatus?: number;
      readonly requestId?: string;
    } = {},
  ) {
    super(message);
    this.name = "HostClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
    if (options.requestId !== undefined) {
      this.requestId = options.requestId;
    }
  }
}

export function isHostClientError(value: unknown): value is HostClientError {
  return value instanceof HostClientError;
}
