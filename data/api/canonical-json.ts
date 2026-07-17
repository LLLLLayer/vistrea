import { DataError } from "./errors.js";
import type { JsonObject, JsonValue } from "./models.js";

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

/** Canonical JSON used by content-addressed protocol and Commit identity. */
export function canonicalizeIdentityJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new DataError(
        "invalid_argument",
        "Identity JSON numbers must be JSON-safe integers.",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeIdentityJson).join(",")}]`;
  }
  const objectValue = value as JsonObject;
  const entries = Object.keys(objectValue)
    .sort(compareCodePoints)
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalizeIdentityJson(objectValue[key] as JsonValue)}`,
    );
  return `{${entries.join(",")}}`;
}
