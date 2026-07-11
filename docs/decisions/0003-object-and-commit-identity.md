# ADR-0003: Object, commit, ref, and working-set identity

- Status: Accepted
- Date: 2026-07-12
- Owners: Protocol and Data owners
- Related contracts: `COMMON_CONTRACTS.md`, `DATA_API.md`, `HUB_API.md`

## Context

SQLite metadata, the local Object Store, `.vistrea-pack`, Hub synchronization, retention, and build history all require identical byte and identity semantics. Undefined compression, encryption, manifest serialization, and ref rules would make local and remote implementations incompatible.

## Decision

### Object identity

- `ObjectRef.hash` is SHA-256 over the exact encoded payload bytes after declared compression and before storage- or transport-layer encryption.
- `ObjectRef.byte_size` is the size of that same encoded byte stream.
- `ObjectRef.decoded_byte_size` is optional and describes content after declared decompression.
- Byte-range reads address the encoded byte stream.
- Encryption is transparent storage/transport metadata and does not change the logical ObjectRef hash.
- Version 1 canonical fixtures use `compression: none`. Compressed producers must declare the algorithm and produce the exact bytes they hash.
- Two encodings of the same logical content may have different ObjectRefs. Semantic deduplication is separate from byte identity.

### Canonical JSON

Identity-bearing JSON manifests use a restricted deterministic encoding:

- UTF-8;
- object keys sorted lexicographically by Unicode code point;
- no insignificant whitespace;
- arrays preserve declared order;
- strings, booleans, null, and base-10 integers only in identity-bearing manifests;
- floating-point values are forbidden in commit manifests;
- duplicate object keys are rejected.

The protocol validator owns the canonical serializer and test vectors.

### Commit identity

- Commit ID is `commit:sha256:<hex>` over canonical Commit Manifest bytes.
- Parent order is significant; the first parent is the primary history line.
- Commit Manifest references content roots and ObjectRefs but does not embed large objects.
- A Commit is immutable and may exist unreachable until garbage collection.

### Ref names

Version 1 ref names are ASCII path-like names:

```text
users/<name>/<topic>
teams/<team>/<name>
builds/<build>
baselines/<name>
releases/<name>
```

Each segment matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Empty, `.`, and `..` segments are forbidden. Maximum total length is 255 bytes. Ref names are carried in structured request fields rather than raw URL path segments.

### Working Sets and atomic commit

- Creating an empty Workspace atomically creates its Workspace Manifest, one genesis Commit with no parents, and its configured default ref. The manifest records `genesis_commit_id` and `default_ref_name`; a partially bootstrapped Workspace is never visible.
- The first Working Set uses that genesis Commit as its required base. Pack import may instead bootstrap from a verified parentless imported root Commit and ref in the same atomic initialization transaction. A thin pack cannot initialize a standalone Workspace until every prerequisite needed to resolve that root is available.
- Mutable uncommitted changes live in a `WorkingSet` rooted at one base Commit.
- Working Sets are local versioned metadata, not immutable Commits.
- Referenced objects are fully written and verified before metadata commit.
- `CommitWorkingSetAndUpdateRef` creates the canonical Commit and compare-and-set updates the target ref in one metadata transaction.
- A ref conflict preserves the Working Set for rebase or retry.
- Object writes left unreachable after rollback are safe and reclaimed by Workspace GC.

### Pack behavior

- Full packs include every object reachable from included commits unless retention policy forbids export.
- Thin packs explicitly list omitted objects and the remote or prerequisite commits required to resolve them.
- Import verifies canonical commit identity and included object hashes before refs may advance.

## Alternatives considered

### Hash decoded content before compression

This deduplicates multiple encodings but makes direct integrity checks and range semantics ambiguous for compressed payloads. It was rejected for version 1.

### UUID commit identity

UUIDs do not prove manifest equality across local pack and Hub synchronization. They were rejected for immutable Commit identity.

### Store runtime assets in Git or Git LFS

High-volume generated binary history, retention, and partial synchronization do not match the product access pattern. It was rejected.

## Consequences

### Positive

- Local, pack, and Hub integrity use the same bytes and identifiers.
- Commit equality is independently verifiable.
- Ref updates have explicit conflict behavior.
- Uncommitted Studio work has a defined location and lifecycle.

### Negative

- Different compression encodings do not byte-deduplicate.
- A canonical serializer and test vectors must be maintained.
- Working Sets and GC require explicit SQLite metadata.

## Compatibility and migration

Changing object hash bytes, canonical JSON, Commit ID, or ref grammar is a protocol-major change. Additional compression algorithms are additive capabilities when their encoded-byte semantics are deterministic and declared.

## Validation

- canonical JSON test vectors;
- object hash, byte-size, compression, and range fixtures;
- Commit Manifest digest fixtures;
- valid and invalid ref-name fixtures;
- Working Set commit/ref atomicity tests;
- full/thin pack integrity tests.
