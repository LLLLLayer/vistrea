const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER);

export class StrictJsonError extends SyntaxError {
  constructor(code, message, { source, path, location, ...details }) {
    const prefix = source ? `${source}:` : "";
    super(`${prefix}${location.line}:${location.column}: ${message}`);
    this.name = "StrictJsonError";
    this.code = code;
    this.source = source;
    this.path = path || "/";
    this.location = location;
    Object.assign(this, details);
  }
}

export function parseJsonStrict(text, source) {
  if (ArrayBuffer.isView(text) || text instanceof ArrayBuffer) {
    text = decodeUtf8Strict(text, source);
  }
  if (typeof text !== "string") {
    throw new TypeError("Strict JSON input must be a string or byte buffer.");
  }

  const scanner = new StrictJsonScanner(text, source);
  scanner.scan();
  return JSON.parse(text);
}

function decodeUtf8Strict(bytes, source) {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    throw new StrictJsonError("invalid_utf8", "JSON bytes are not valid UTF-8.", {
      source,
      path: "/",
      location: { offset: 0, line: 1, column: 1 },
    });
  }
}

class StrictJsonScanner {
  constructor(text, source) {
    this.text = text;
    this.source = source;
    this.index = 0;
  }

  scan() {
    this.skipWhitespace();
    this.scanValue("");
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail("invalid_json", "Unexpected content after the JSON value.", "", this.index);
    }
  }

  scanValue(path) {
    this.skipWhitespace();
    const character = this.text[this.index];

    if (character === "{") {
      this.scanObject(path);
    } else if (character === "[") {
      this.scanArray(path);
    } else if (character === '"') {
      this.scanString(path);
    } else if (character === "t") {
      this.scanLiteral("true", path);
    } else if (character === "f") {
      this.scanLiteral("false", path);
    } else if (character === "n") {
      this.scanLiteral("null", path);
    } else if (character === "-" || isDigit(character)) {
      this.scanNumber(path);
    } else {
      this.fail("invalid_json", "Expected a JSON value.", path, this.index);
    }
  }

  scanObject(path) {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("}")) {
      return;
    }

    const keys = new Map();
    while (true) {
      if (this.text[this.index] !== '"') {
        this.fail("invalid_json", "Expected an object property name.", path, this.index);
      }

      const keyOffset = this.index;
      const key = this.scanString(path);
      const propertyPath = appendJsonPointer(path, key);
      if (keys.has(key)) {
        this.fail(
          "duplicate_json_key",
          `Object property ${JSON.stringify(key)} is duplicated.`,
          propertyPath,
          keyOffset,
          { key, firstLocation: locationAt(this.text, keys.get(key)) },
        );
      }
      keys.set(key, keyOffset);

      this.skipWhitespace();
      this.expect(":", "Expected ':' after the object property name.", propertyPath);
      this.scanValue(propertyPath);
      this.skipWhitespace();

      if (this.consume("}")) {
        return;
      }
      this.expect(",", "Expected ',' or '}' after the object property value.", path);
      this.skipWhitespace();
    }
  }

  scanArray(path) {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) {
      return;
    }

    let itemIndex = 0;
    while (true) {
      this.scanValue(appendJsonPointer(path, String(itemIndex)));
      itemIndex += 1;
      this.skipWhitespace();

      if (this.consume("]")) {
        return;
      }
      this.expect(",", "Expected ',' or ']' after the array item.", path);
      this.skipWhitespace();
    }
  }

  scanString(path) {
    const start = this.index;
    this.index += 1;

    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index));
      }

      if (character === "\\") {
        const escapeOffset = this.index;
        this.index += 1;
        const escape = this.text[this.index];
        if ('"\\/bfnrt'.includes(escape)) {
          this.index += 1;
          continue;
        }
        if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 1, this.index + 5))) {
          const codeUnit = Number.parseInt(this.text.slice(this.index + 1, this.index + 5), 16);
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const lowEscape = this.text.slice(this.index + 5, this.index + 11);
            if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(lowEscape)) {
              this.fail(
                "invalid_unicode_scalar",
                "A high-surrogate escape must be followed by a low-surrogate escape.",
                path,
                escapeOffset,
              );
            }
            this.index += 11;
            continue;
          }
          if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            this.fail(
              "invalid_unicode_scalar",
              "A low-surrogate escape cannot appear without a high surrogate.",
              path,
              escapeOffset,
            );
          }
          this.index += 5;
          continue;
        }
        this.fail("invalid_json", "Invalid escape sequence in JSON string.", path, escapeOffset);
      }

      if (character.charCodeAt(0) <= 0x1f) {
        this.fail("invalid_json", "Unescaped control character in JSON string.", path, this.index);
      }
      const codeUnit = character.charCodeAt(0);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const lowCodeUnit = this.text.charCodeAt(this.index + 1);
        if (lowCodeUnit < 0xdc00 || lowCodeUnit > 0xdfff) {
          this.fail(
            "invalid_unicode_scalar",
            "A high surrogate must be followed by a low surrogate.",
            path,
            this.index,
          );
        }
        this.index += 2;
        continue;
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        this.fail(
          "invalid_unicode_scalar",
          "A low surrogate cannot appear without a high surrogate.",
          path,
          this.index,
        );
      }
      this.index += 1;
    }

    this.fail("invalid_json", "Unterminated JSON string.", path, start);
  }

  scanLiteral(literal, path) {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      this.fail("invalid_json", `Expected ${literal}.`, path, this.index);
    }
    this.index += literal.length;
  }

  scanNumber(path) {
    const start = this.index;
    const match = JSON_NUMBER.exec(this.text.slice(start));
    if (!match) {
      this.fail("invalid_json", "Invalid JSON number.", path, start);
    }

    const literal = match[0];
    this.index += literal.length;
    if (isUnsafeIntegerLiteral(literal)) {
      this.fail(
        "unsafe_json_integer",
        `JSON integer ${literal} is outside the safe integer range.`,
        path,
        start,
        { literal },
      );
    }
  }

  skipWhitespace() {
    while (
      this.text[this.index] === " " ||
      this.text[this.index] === "\t" ||
      this.text[this.index] === "\n" ||
      this.text[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  consume(character) {
    if (this.text[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }

  expect(character, message, path) {
    if (!this.consume(character)) {
      this.fail("invalid_json", message, path, this.index);
    }
  }

  fail(code, message, path, offset, details = {}) {
    throw new StrictJsonError(code, message, {
      source: this.source,
      path,
      location: locationAt(this.text, offset),
      ...details,
    });
  }
}

function appendJsonPointer(path, segment) {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function locationAt(text, offset) {
  let line = 1;
  let column = 1;
  let index = 0;

  while (index < offset) {
    const codePoint = text.codePointAt(index);
    if (codePoint === 0x0d) {
      index += text.codePointAt(index + 1) === 0x0a ? 2 : 1;
      line += 1;
      column = 1;
    } else if (codePoint === 0x0a) {
      index += 1;
      line += 1;
      column = 1;
    } else {
      index += codePoint > 0xffff ? 2 : 1;
      column += 1;
    }
  }

  return { offset, line, column };
}

function isDigit(character) {
  return character >= "0" && character <= "9";
}

function isUnsafeIntegerLiteral(literal) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  const fraction = match[3] ?? "";
  const exponent = BigInt(match[4] ?? "0");
  const coefficient = `${match[2]}${fraction}`.replace(/^0+/, "");

  if (coefficient.length === 0) {
    return false;
  }

  const scale = exponent - BigInt(fraction.length);
  let integerDigits;

  if (scale >= 0n) {
    const length = BigInt(coefficient.length) + scale;
    if (length > BigInt(MAX_SAFE_INTEGER_DIGITS.length)) {
      return true;
    }
    integerDigits = coefficient + "0".repeat(Number(scale));
  } else {
    const fractionalDigitCount = -scale;
    if (fractionalDigitCount > BigInt(coefficient.length)) {
      return Number.isInteger(Number(literal)) && !Number.isSafeInteger(Number(literal));
    }

    const splitIndex = coefficient.length - Number(fractionalDigitCount);
    if (!/^0*$/.test(coefficient.slice(splitIndex))) {
      return Number.isInteger(Number(literal)) && !Number.isSafeInteger(Number(literal));
    }
    integerDigits = coefficient.slice(0, splitIndex).replace(/^0+/, "") || "0";
  }

  if (integerDigits.length !== MAX_SAFE_INTEGER_DIGITS.length) {
    return integerDigits.length > MAX_SAFE_INTEGER_DIGITS.length;
  }
  return integerDigits > MAX_SAFE_INTEGER_DIGITS;
}
