# ADR 0009: Direct macOS distribution uses Developer ID and Sparkle

- Status: Accepted
- Date: 2026-07-14
- Owners: Studio and release infrastructure owners
- Related contracts: `apps/studio-macos/README.md`, `docs/release/STUDIO_MACOS_RELEASE.md`

## Context

Vistrea Studio is a native SwiftPM executable, but users need a normal macOS
application that can be downloaded from GitHub and updated without rebuilding
the repository. The product also needs a release path that preserves the
current SwiftPM development loop and does not introduce a second Studio source
tree or an independent Xcode project.

Direct distribution executes privileged local development workflows and is not
currently sandboxed. A release therefore needs explicit provenance, Gatekeeper
compatibility, update-archive authenticity, and a stable HTTPS update feed.

## Decision

1. Vistrea Studio is distributed directly from GitHub Releases as a Universal
   macOS application supporting `arm64` and `x86_64`; the Mac App Store is not
   the initial channel.
2. `tools/release/package-studio-macos.sh` remains the single composition path
   from the SwiftPM executable to the `.app`, ZIP, and DMG. It embeds pinned
   architecture-specific Node.js 22.14.0 runtimes, the emitted production Host
   with exact protocol and migration resources, and the pinned Sparkle
   framework. It signs nested code in dependency order without using
   `codesign --deep` as a signing shortcut. Developer ID-signed Node.js keeps
   only the JIT and unsigned-executable-memory entitlements required by V8; it
   does not inherit the upstream development signature's `get-task-allow`,
   dynamic linker environment, executable-page-protection, or
   library-validation exemptions. Local ad-hoc packages add a narrowly scoped
   library-validation exemption to Studio and Node because ad-hoc signatures
   have no shared Team ID; the distribution branch never receives it.
3. Public releases use a Developer ID Application certificate, Hardened
   Runtime, a secure timestamp, Apple notarization through `notarytool`, and
   stapled tickets. Missing credentials fail a tag release before publication.
4. Sparkle 2 is the in-app updater. Updates use an HTTPS appcast, an embedded
   Ed25519 public key, signed archives, and a signed feed with verification
   before extraction. The private key is available only as a GitHub Actions
   secret and is passed to Sparkle tooling through standard input.
5. A canonical `studio-vX.Y.Z` tag supplies both
   `CFBundleShortVersionString` and `CFBundleVersion`. A release must be
   semantically greater than every published Studio release; tags do not
   accept prerelease syntax until a channel policy exists.
6. The workflow creates a draft GitHub Release, publishes it so immutable tag
   assets are publicly downloadable, and only then switches the signed appcast
   on GitHub Pages. All tags share one non-cancelling concurrency group because
   they update one feed. Manual workflow runs create an ad-hoc-signed package
   without update metadata and cannot publish a Release.
7. SwiftPM remains the source development and test boundary. The release
   bundle is generated output and must not be committed.
8. A packaged Studio owns the embedded Host process and its private descriptor.
   It opens the last selected Workspace or a default Application Support
   Workspace and exposes explicit open/reveal Workspace actions. Source-built
   Studio retains fixture and external-Host development modes.

## Alternatives considered

### Mac App Store distribution

The App Store would own update delivery, but the current non-sandboxed local
tooling and development-device workflows require a separate entitlement and
product review. It may become an additional channel later.

### Custom updater

A custom updater would duplicate signature verification, installation,
rollback, permission, and relaunch behavior. Sparkle provides those mature
security boundaries and supports the existing SwiftPM package.

### Migrate Studio to a generated Xcode project

Xcode archive/export is a strong distribution path, but introducing a second
generated project now would add build ownership and synchronization cost
without changing application behavior. The packaging script keeps that option
open if Studio later needs extensions or App Sandbox entitlements.

## Consequences

### Positive

- One tag can produce downloadable, notarized, self-updating artifacts.
- Local SwiftPM development remains unchanged.
- Manual packaging remains useful before Apple and Sparkle credentials exist.
- Release-first feed switching prevents the public feed from referencing draft
  assets that unauthenticated clients cannot download.

### Negative

- Release owners must protect two independent trust roots: Developer ID and the
  Sparkle Ed25519 key.
- GitHub Pages must be enabled with GitHub Actions as its publishing source.
- The manual bundle composition path needs explicit verification whenever the
  embedded framework layout changes.

### Risks and mitigations

- A stolen Sparkle key could sign a malicious archive. Store it only as an
  Actions secret, require Developer ID signing as the second trust boundary,
  and rotate one key boundary at a time.
- A changed Sparkle framework layout could invalidate nested signing. The
  packaging script uses pinned Sparkle 2.9.4 paths and fails if expected code
  is absent or does not verify.
- A release feed could point to unavailable assets. Publication remains draft
  while assets are assembled; the Release becomes public before Pages changes,
  and every enclosure uses its tag-scoped asset URL plus a Sparkle signature.

## Compatibility and migration

This decision changes no Runtime Snapshot, Engine, Data, or Host contract.
Packaged builds add an application-owned Host composition and Workspace
selection boundary; `swift run` launches contain neither embedded Host nor
release metadata, so they retain fixture/external-Host mode and disable the
updater. The first installed GitHub build establishes the initial Sparkle trust
root; earlier source-built executables are not automatically migrated.

## Validation

- `swift test --package-path apps/studio-macos`
- an ad-hoc local packaging run with both architecture slices and explicit
  inspection of the distribution entitlement source;
- embedded Host startup, authenticated status, clean descriptor removal, and
  Workspace-lock release;
- packaged-app launch and graceful quit using the default Application Support
  Workspace;
- nested `codesign --verify --deep --strict` verification;
- Info.plist version and update-key inspection;
- signed appcast generation with an archive signature and signed-feed trailer;
- first credentialed `studio-vX.Y.Z` tag: Developer ID, notarization, stapling,
  Gatekeeper assessment, Pages deployment, GitHub Release publication, and an
  installed old-to-new update acceptance.
