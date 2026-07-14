# Data Exchange

Imports and exports `.vistrea-pack`, human-readable Markdown/HTML, and machine-readable manifests.

Pack exchange and Hub sync must use the same commit manifest and object-reference format so Vistrea does not develop two incompatible sharing protocols.

## Implemented surface

`PackExchangeService` implements the `ExchangeService` port over the public `WorkspaceDataSource` and `ObjectStore` ports. It never touches SQLite rows or physical object paths, so it composes with any Data implementation pair. `LocalDataWorkspace` wires it as `workspace.exchange`.

- `exportPack` resolves the requested refs and head commits, walks the parent closure, and writes one `.vistrea-pack` object into the local Object Store. A non-empty `prerequisite_commit_ids` list produces a thin pack: commits and objects reachable from those prerequisites are omitted and listed instead.
- `importPack` reads a verified pack object from the local Object Store, verifies every framed byte, stores and registers the included objects, then creates commits and refs in one metadata Unit of Work. Ref conflicts are reported in the result and never forced.
- `exportReadable` accepts a published Knowledge Collection and a unique subset of `markdown` and `html`. It resolves the Collection's immutable Commit `wiki` root, verifies ObjectRef metadata, byte count, SHA-256, strict UTF-8, canonical JSON, and Knowledge Graph semantics, then writes content-addressed readable objects. Draft state is never exported as published truth.

The Markdown export preserves each inline source document and adds deterministic Collection, Commit, Ref, contents, resource, and link metadata. The self-contained HTML export safely escapes all source content and renders a conservative subset of headings, paragraphs, lists, blockquotes, and fenced code; unsupported Markdown remains readable text rather than executable markup.

## `.vistrea-pack` version 1 container

The manifest, header, and trailer documents are protocol models
(`protocol/schema/v1/exchange-pack.schema.json`); the byte framing is fixed by
ADR-0006:

```text
<PackHeader canonical JSON>\n
<PackManifest canonical JSON, exactly header.manifest_byte_size bytes>\n
<encoded payload bytes of manifest.objects[0]>
...
<encoded payload bytes of manifest.objects[n]>
<PackTrailer canonical JSON>\n
```

- Canonical JSON follows ADR-0003: UTF-8, code-point-sorted keys, no
  insignificant whitespace, integers only.
- `manifest.commits` are listed parent-first; `manifest.objects` are sorted by
  hash and their payloads follow in exactly that order with no separators.
- `trailer.pack_sha256` is the SHA-256 over every byte before the trailer line.
- The pack object itself uses `media_type: application/vnd.vistrea-pack` and
  `compression: none`; equal logical content exports to byte-identical packs.

## Import ordering guarantees

Per ADR-0003, included object hashes and canonical commit identity are verified
before any ref may advance:

1. Header, manifest, and trailer must round-trip through canonical JSON.
2. Thin-pack prerequisite commits must already exist locally (`conflict` with
   the missing IDs otherwise), and omitted objects must already be stored with
   identical immutable metadata.
3. Every included payload is streamed into the Object Store with its declared
   `expected_hash`; a byte mismatch aborts before any metadata changes.
4. Commits, then refs, apply inside one write Unit of Work: commits are
   idempotent by identity, missing refs are created with `must_not_exist`, and
   diverged refs are reported as conflicts while the rest of the import
   completes.

Contract coverage lives in `tests/contract/pack-exchange.test.ts`; cross-Workspace pack transfer is proven in `tests/integration/local-data-workspace.test.ts`, and immutable Collection publication plus both readable formats are proven in `tests/integration/knowledge-engine.test.ts` and the Host/CLI integration suites.
