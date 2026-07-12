import type { Socket } from "node:net";
import { TextDecoder } from "node:util";

export type JsonLineFailureKind =
  | "line_too_large"
  | "malformed_utf8"
  | "malformed_json"
  | "invalid_envelope"
  | "socket_error";

export class JsonLineFailure extends Error {
  constructor(readonly kind: JsonLineFailureKind) {
    super("The loopback JSON-lines channel failed.");
    this.name = "JsonLineFailure";
  }
}

export interface BoundedJsonLineChannelOptions {
  readonly socket: Socket;
  readonly maximumLineBytes: number;
  readonly onMessage: (message: Readonly<Record<string, unknown>>) => void;
  readonly onFailure: (failure: JsonLineFailure) => void;
  readonly onClosed: () => void;
}

/** Strict UTF-8, newline-delimited JSON object framing with a per-line byte bound. */
export class BoundedJsonLineChannel {
  readonly #socket: Socket;
  readonly #maximumLineBytes: number;
  readonly #onMessage: (message: Readonly<Record<string, unknown>>) => void;
  readonly #onFailure: (failure: JsonLineFailure) => void;
  readonly #onClosed: () => void;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = Buffer.alloc(0);
  #failed = false;
  #closed = false;

  constructor(options: BoundedJsonLineChannelOptions) {
    this.#socket = options.socket;
    this.#maximumLineBytes = options.maximumLineBytes;
    this.#onMessage = options.onMessage;
    this.#onFailure = options.onFailure;
    this.#onClosed = options.onClosed;

    this.#socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#socket.on("error", () => this.#fail(new JsonLineFailure("socket_error")));
    this.#socket.on("close", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#onClosed();
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (this.#closed || this.#socket.destroyed) {
      throw new JsonLineFailure("socket_error");
    }
    let source: string;
    try {
      source = JSON.stringify(message);
    } catch {
      throw new JsonLineFailure("invalid_envelope");
    }
    const bytes = Buffer.from(source, "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > this.#maximumLineBytes) {
      throw new JsonLineFailure("line_too_large");
    }
    this.#socket.write(bytes);
    this.#socket.write("\n");
  }

  end(): void {
    if (!this.#socket.destroyed) {
      this.#socket.end();
    }
  }

  destroy(): void {
    if (!this.#socket.destroyed) {
      this.#socket.destroy();
    }
  }

  #receive(chunk: Buffer): void {
    if (this.#failed || this.#closed) {
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (!this.#failed) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        break;
      }
      let line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) {
        line = line.subarray(0, line.byteLength - 1);
      }
      if (line.byteLength === 0) {
        this.#fail(new JsonLineFailure("invalid_envelope"));
        return;
      }
      if (line.byteLength > this.#maximumLineBytes) {
        this.#fail(new JsonLineFailure("line_too_large"));
        return;
      }
      this.#decodeLine(line);
    }

    if (!this.#failed && this.#buffer.byteLength > this.#maximumLineBytes) {
      this.#fail(new JsonLineFailure("line_too_large"));
    }
  }

  #decodeLine(line: Buffer): void {
    let source: string;
    try {
      source = this.#decoder.decode(line);
    } catch {
      this.#fail(new JsonLineFailure("malformed_utf8"));
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      this.#fail(new JsonLineFailure("malformed_json"));
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.#fail(new JsonLineFailure("invalid_envelope"));
      return;
    }
    try {
      this.#onMessage(value as Readonly<Record<string, unknown>>);
    } catch {
      this.#fail(new JsonLineFailure("invalid_envelope"));
    }
  }

  #fail(failure: JsonLineFailure): void {
    if (this.#failed || this.#closed) {
      return;
    }
    this.#failed = true;
    this.#onFailure(failure);
  }
}
