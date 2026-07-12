# ADR 0006: `.vistrea-pack` version 1 container format

- Status: Accepted
- Date: 2026-07-12
- Owners: Protocol and Data owners
- Related contracts: `docs/architecture/DATA_LAYER.md`, ADR-0003, `DATA_API.md`

## Context

ADR-0003 fixed object, commit, ref, and pack identity semantics, but the
physical `.vistrea-pack` byte layout was still unspecified. The container must
be portable across future Swift, Kotlin, and Hub implementations, verifiable
without loading everything into memory, and byte-deterministic so equal logical
content produces one content-addressed pack object.

## Decision

A version 1 pack is one byte stream with four regions:

```text
<PackHeader canonical JSON>\n
<PackManifest canonical JSON, exactly manifest_byte_size bytes>\n
<object payloads, concatenated in manifest order>
<PackTrailer canonical JSON>\n
```

- The header, manifest, and trailer documents are protocol models in
  `protocol/schema/v1/exchange-pack.schema.json` and must round-trip through
  the ADR-0003 canonical JSON encoding byte for byte.
- The header carries only `format`, `format_version`, and
  `manifest_byte_size`, so a reader can frame the manifest without scanning.
- The manifest reuses the canonical `Commit`, `ObjectRef`, and ref-name models.
  Commits are listed parent-first; included objects are sorted by hash and
  their encoded payload bytes follow in exactly that order with no separators.
  Ref revisions are local Workspace state and never travel in a pack.
- Thin packs list omitted objects and the boundary prerequisite commits; full
  packs must not declare either.
- `pack_sha256` covers every byte before the trailer line. Included objects are
  additionally verified against their own `ObjectRef.hash` during import, and
  canonical commit identity is verified before any ref may advance.
- The pack itself is stored as a content-addressed object with
  `media_type: application/vnd.vistrea-pack` and `compression: none`.

## Alternatives considered

### tar or zip containers

Standard archives would allow external tooling but leave ordering, duplicate
entries, metadata, and canonical bytes underspecified, breaking deterministic
content addressing. Rejected for version 1.

### JSON-only pack with base64 payloads

One JSON document is simple but inflates payload bytes by one third and forces
whole-pack buffering. Rejected.

## Consequences

- Equal logical exports produce byte-identical packs and one object hash.
- Readers stream with bounded memory: two JSON lines plus per-object framing.
- A future format change requires a new `format_version`; the closed version 1
  manifest evolves only through its `extensions` field.

## Validation

- `pnpm protocol:validate` covers the schema and its canonical fixtures.
- `tests/contract/pack-exchange.test.ts` proves round trip, determinism, thin
  prerequisites, tamper rejection, ref-conflict reporting, and command errors.
- `tests/integration/local-data-workspace.test.ts` proves the cross-Workspace
  product path through `LocalDataWorkspace.exchange`.
