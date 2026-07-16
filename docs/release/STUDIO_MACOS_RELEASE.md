# Vistrea Studio macOS Local Packaging

Vistrea Studio currently supports credential-free local packaging for
development and product acceptance. Formal macOS distribution is deferred:
there is no active tag-triggered release workflow, public update feed,
notarized download, or automated GitHub Release publication.

Do not create a `studio-vX.Y.Z` tag expecting release automation. ADR-0009 is
deferred and must be reconsidered before a public distribution channel is
activated.

## Local outputs

The local packaging helper produces:

- `Vistrea Studio.app`: a Universal `arm64` and `x86_64` application bundle;
- `Vistrea-Studio-X.Y.Z.zip`: a local archive of the application;
- `Vistrea-Studio-X.Y.Z.dmg`: a local disk image with an Applications link;
- `SHA256SUMS`: SHA-256 digests for the ZIP and DMG.

Generated output belongs outside the repository and must not be committed.

## Build a local package

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build:host
tools/release/package-studio-macos.sh \
  --version 0.1.0 \
  --build-number 0.1.0 \
  --output-dir /tmp/vistrea-studio-package
```

Use a new or empty output directory for each run. The version must be a
canonical `X.Y.Z` value, and the build number must contain one to three
canonical numeric components.

This path requires no release credentials. It uses local ad-hoc code signing
only so macOS can load the assembled application and its nested code during
development acceptance.

## What the local package verifies

The helper:

1. builds both supported macOS architecture slices from the SwiftPM package;
2. embeds architecture-matched pinned Node.js and production Host runtimes;
3. copies the exact protocol schemas, SQLite migrations, and application
   resources required by the embedded Host;
4. includes the pinned Sparkle dependency while leaving updates disabled
   because no feed metadata is configured;
5. signs nested code in dependency order with a local ad-hoc identity;
6. starts the embedded Host against a temporary Workspace before and after
   signing, performs an authenticated status request, and verifies descriptor
   and Workspace-lock cleanup;
7. creates the app bundle, ZIP, DMG, and checksums without publishing them.

The packaged application owns its embedded Host and can open, create, switch,
and restore local Workspace locations without shell-provided Host credentials.

## Current limitations

Local packages are development artifacts. They are not evidence of public
distribution acceptance, Gatekeeper acceptance, notarization, or installed
old-to-new updates. The repository does not currently publish an appcast or
provide an automated release lane.

The guarded distribution and updater implementation remains in the packaging
code so it can be reviewed when formal release work resumes, but it is not an
active product or CI capability.

## Resuming formal distribution

Before formal distribution resumes, the project must review ADR-0009 again,
define the supported channel and trust boundaries, restore a fail-closed CI
workflow, document operational ownership, and complete installed old-to-new
acceptance on supported macOS hardware. That future work is intentionally
separate from the credential-free local packaging loop above.
