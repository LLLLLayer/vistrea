# Object Store

`FileObjectStore` is the production local content-addressed adapter for screenshots, videos, complete Snapshots, design references, logs, and other artifacts.

## Layout and identity

The constructor receives a Workspace root. Callers provide hashes, never paths. Encoded payload bytes are streamed through a same-filesystem temporary file and published without replacement at:

```text
objects/sha256/ab/cdef...
```

The SHA-256 hash and `ObjectRef.byte_size` cover the exact encoded bytes. Compression is descriptive metadata; byte ranges address the encoded stream. An optional `encryption` reference preserves the storage or transport algorithm and key identifier as immutable `ObjectRef` metadata without changing byte identity or the canonical path. Internal sidecars under `objects/.metadata/` retain the complete `ObjectRef` and retention pins across process restart. `objects/.tmp/` contains only unpublished files and recoverable delete tombstones.

`ObjectPutMetadata.expected_hash` is the current caller integrity precondition. The adapter always computes the authoritative encoded `byte_size`; it does not reinterpret `decoded_byte_size` as an encoded-size precondition. If callers later require an expected encoded size, that must be an additive Data API field with contract tests.

## Publication and lifecycle

- Payloads and immutable sidecars use exclusive hard-link publication, so deduplication never overwrites existing bytes or conflicting metadata.
- An object is visible only when its payload and valid sidecar are both present. A later identical `put` repairs an incomplete publication after a crash.
- Startup removes abandoned put/pin temporary files and completes interrupted physical deletes.
- `open({ offset, length })` reads the half-open encoded-byte interval `[offset, offset + length)`. Omitted length reads to EOF; zero length is empty; ranges beyond EOF are rejected.
- Inventory is ordered by canonical hash. `has` accepts batches and returns only complete objects.
- Retention policies are persisted and enforced by physical deletion. `unpin`
  idempotently releases only one named policy; it never deletes the object.
  `inspectLifecycle` is a concrete local-maintenance view of payload age and
  active policies. Commit/Ref/Working-Set and live-metadata reachability remains
  outside this adapter and is combined by `LocalDataWorkspace.collectGarbage`.
- Every payload and metadata shard must be a real directory at its canonical Workspace path. Symlinked or redirected shard parents fail closed before reads, publication, recovery, or deletion.
- Physical deletion accepts only canonical hashes, removes metadata before bytes through a recoverable tombstone, and never derives a path from caller-controlled names.
