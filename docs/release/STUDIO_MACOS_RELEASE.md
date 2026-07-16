# Vistrea Studio macOS Local Packaging

Vistrea Studio supports credential-free local packaging for development and
product acceptance. Public distribution and automatic update publication are
deferred. The repository has no tag-triggered release workflow and the local
packager accepts no formal-distribution credentials.

Do not create a `studio-vX.Y.Z` tag expecting release automation. ADR-0009 is
deferred and must be superseded before a public distribution channel is added.

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

This path uses local ad-hoc signing only so macOS can load the assembled
application and its nested code during development acceptance. It accepts no
release identity, account, or publication credentials.

## What the local package verifies

The helper:

1. builds both supported macOS architecture slices from the SwiftPM package;
2. embeds architecture-matched pinned Node.js and production Host runtimes;
3. copies the exact protocol schemas, SQLite migrations, offline maintenance
   runner, and application resources required by the embedded Host;
4. includes the pinned Sparkle dependency while leaving updater creation
   disabled because the bundle contains no feed metadata;
5. ad-hoc signs nested code in dependency order;
6. starts the embedded Host against a temporary Workspace before and after
   signing, performs an authenticated status request, and verifies descriptor
   and Workspace-lock cleanup;
7. creates the app bundle, ZIP, DMG, and checksums without publishing them.

The packaged application owns its embedded Host and can open, create, switch,
restore, and repair local Workspace locations without shell-provided Host
credentials.

## Current limitations

Local packages are development artifacts. They are not evidence of a public
distribution channel or an installed old-to-new update. The repository does
not currently publish an update feed or provide automated release publication.

The canonical packager contains only the local ad-hoc path. Future public
distribution work must introduce a newly reviewed trust model and
implementation instead of enabling a dormant credential branch.
