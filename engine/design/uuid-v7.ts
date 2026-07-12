import { randomBytes } from "node:crypto";

import { DataError, type IdGenerator } from "../../data/api/index.js";

const PREFIX_PATTERN = /^[a-z][a-z0-9]*$/;

/** Mints canonical typed UUIDv7 identifiers for Engine-produced protocol values. */
export class SecureUuidV7IdGenerator implements IdGenerator {
  next(prefix: string): string {
    if (!PREFIX_PATTERN.test(prefix)) {
      throw new DataError(
        "invalid_argument",
        "ID prefixes must contain lowercase ASCII letters and digits.",
        { details: { prefix } },
      );
    }
    const bytes = randomBytes(16);
    const milliseconds = BigInt(Math.max(0, Date.now()));
    for (let index = 0; index < 6; index += 1) {
      bytes[5 - index] = Number((milliseconds >> BigInt(index * 8)) & 0xffn);
    }
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return (
      `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    );
  }
}
