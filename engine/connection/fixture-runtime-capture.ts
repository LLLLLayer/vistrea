import { DataError, type ByteStream } from "../../data/api/index.js";
import type {
  CaptureSnapshotCommand,
  RuntimeCapturedObject,
  RuntimeCapturePort,
  RuntimeCaptureResult,
} from "./snapshot-engine.js";

export interface FixtureRuntimeObject {
  readonly ref: unknown;
  readonly chunks: readonly Uint8Array[];
}

export interface FixtureRuntimeCapture {
  readonly snapshot: unknown;
  readonly objects?: readonly FixtureRuntimeObject[];
}

/** Deterministic RuntimeCapturePort backed by canonical repository fixture values. */
export class FixtureRuntimeCapturePort implements RuntimeCapturePort {
  readonly #snapshot: unknown;
  readonly #objects: readonly FixtureRuntimeObject[];
  #captureCount = 0;

  constructor(fixture: FixtureRuntimeCapture) {
    this.#snapshot = cloneFixtureValue(fixture.snapshot);
    this.#objects = (fixture.objects ?? []).map((object, index) => {
      if (!Array.isArray(object.chunks)) {
        throw new DataError("invalid_argument", "Fixture object chunks must be an array.", {
          details: { object_index: index },
        });
      }
      const chunks = object.chunks.map((chunk) => {
        if (!(chunk instanceof Uint8Array)) {
          throw new DataError("invalid_argument", "Fixture chunks must be Uint8Array values.", {
            details: { object_index: index },
          });
        }
        return new Uint8Array(chunk);
      });
      return {
        ref: cloneFixtureValue(object.ref),
        chunks,
      };
    });
  }

  get captureCount(): number {
    return this.#captureCount;
  }

  async captureSnapshot(_command: CaptureSnapshotCommand): Promise<RuntimeCaptureResult> {
    this.#captureCount += 1;
    return {
      snapshot: cloneFixtureValue(this.#snapshot),
      objects: this.#objects.map(
        (object): RuntimeCapturedObject => ({
          ref: cloneFixtureValue(object.ref),
          stream: streamChunks(object.chunks),
        }),
      ),
    };
  }
}

async function* streamChunks(chunks: readonly Uint8Array[]): ByteStream {
  for (const chunk of chunks) {
    yield new Uint8Array(chunk);
  }
}

function cloneFixtureValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new DataError("invalid_argument", "Fixture values must be structured-cloneable.");
  }
}
