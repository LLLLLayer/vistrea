# ADR 0009: Direct macOS distribution is deferred

- Status: Deferred
- Date: 2026-07-14
- Owners: Studio and release infrastructure owners
- Related contracts: `apps/studio-macos/README.md`, `docs/release/STUDIO_MACOS_RELEASE.md`

## Context

Vistrea Studio needs a normal double-clickable application for local product
acceptance before the project chooses and operates a public distribution
channel. The application must include its production Host runtime and remain
usable without shell-provided credentials.

Public distribution and automatic update publication introduce a separate
operational trust boundary. That boundary is intentionally outside the active
development scope.

## Decision

1. The repository supports credential-free local packaging only.
2. `tools/release/package-studio-macos.sh` assembles a Universal application,
   embeds the pinned Host runtime and required resources, applies local ad-hoc
   signatures, and produces local ZIP, DMG, and checksum artifacts.
3. The local packager has no formal-distribution credential inputs and does
   not publish tags, releases, feeds, or update metadata.
4. The pinned Sparkle dependency may remain linked behind its fail-closed
   runtime guard, but the canonical package never instantiates an updater.
5. A future public channel requires a new or superseding ADR, a newly reviewed
   implementation, explicit operational ownership, and installed-update
   acceptance. No dormant credential branch is treated as an accepted design.

## Consequences

- Local product acceptance remains reproducible and independent of release
  accounts.
- A local package is not evidence that public distribution or updating works.
- Embedded Host and Workspace behavior can continue to evolve independently
  of a future release channel.
- Future distribution work must be designed from the then-current product and
  platform requirements rather than reactivating stale automation.

## Validation

- `bash -n tools/release/package-studio-macos.sh`
- `pnpm build:host`
- `swift test --package-path apps/studio-macos`
- a credential-free local packaging run with both architecture slices;
- embedded Host startup, authenticated status, descriptor cleanup, and
  Workspace-lock release;
- local ad-hoc signature, archive, disk-image, and checksum verification.
