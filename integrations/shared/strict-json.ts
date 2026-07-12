import { TextDecoder } from "node:util";

const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const MAXIMUM_NESTING_DEPTH = 256;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export class StrictJsonError extends Error {
  constructor() {
    super("The JSON value failed strict decoding.");
    this.name = "StrictJsonError";
  }
}

/** Parses fatal UTF-8 JSON without duplicate keys or non-portable numeric values. */
export function parseStrictJson(bytes: Uint8Array): JsonValue {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError();
  }
  new JsonScanner(source).scan();
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new StrictJsonError();
  }
  assertPortableJson(value, new Set<object>());
  return value;
}

class JsonScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail();
    }
  }

  private scanValue(depth: number): void {
    if (depth > MAXIMUM_NESTING_DEPTH) {
      this.fail();
    }
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") {
      this.scanObject(depth + 1);
    } else if (character === "[") {
      this.scanArray(depth + 1);
    } else if (character === '"') {
      this.scanString();
    } else if (character === "t") {
      this.scanLiteral("true");
    } else if (character === "f") {
      this.scanLiteral("false");
    } else if (character === "n") {
      this.scanLiteral("null");
    } else if (character === "-" || isAsciiDigit(character)) {
      this.scanNumber();
    } else {
      this.fail();
    }
  }

  private scanObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("}")) {
      return;
    }
    const keys = new Set<string>();
    while (true) {
      if (this.source[this.index] !== '"') {
        this.fail();
      }
      const key = this.scanString();
      if (keys.has(key)) {
        this.fail();
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume("}")) {
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) {
      return;
    }
    while (true) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume("]")) {
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index] as string;
      if (character === '"') {
        this.index += 1;
        try {
          const value = JSON.parse(this.source.slice(start, this.index)) as unknown;
          if (typeof value === "string") {
            return value;
          }
        } catch {
          this.fail();
        }
        this.fail();
      }
      if (character === "\\") {
        this.index += 1;
        if (this.index >= this.source.length) {
          this.fail();
        }
        this.index += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        this.fail();
      }
      this.index += 1;
    }
    this.fail();
  }

  private scanLiteral(literal: string): void {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.fail();
    }
    this.index += literal.length;
  }

  private scanNumber(): void {
    const match = JSON_NUMBER_PATTERN.exec(this.source.slice(this.index));
    if (match === null) {
      this.fail();
    }
    this.index += (match[0] as string).length;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) {
      this.fail();
    }
  }

  private fail(): never {
    throw new StrictJsonError();
  }
}

function assertPortableJson(value: unknown, ancestors: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new StrictJsonError();
    }
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new StrictJsonError();
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      assertPortableJson(child, ancestors);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertUnicodeScalarString(key);
      assertPortableJson(child, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new StrictJsonError();
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new StrictJsonError();
    }
  }
}

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}
