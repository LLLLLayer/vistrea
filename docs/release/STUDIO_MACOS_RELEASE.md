# Vistrea Studio macOS Release

Vistrea Studio is packaged as a Universal macOS application and published from
the `Vistrea Studio macOS release` GitHub Actions workflow. Public releases are
Developer ID signed, notarized, distributed as ZIP and DMG assets, and exposed
to the in-app Sparkle updater through a signed GitHub Pages appcast.

The release boundary is intentionally fail closed: a `studio-vX.Y.Z` tag cannot
publish an ad-hoc-signed build, an unnotarized build, or an unsigned update.

## Release outputs

- `Vistrea Studio.app`: Universal `arm64` and `x86_64` application bundle with
  architecture-matched pinned Node.js and production Host runtimes;
- `Vistrea-Studio-X.Y.Z.zip`: Sparkle update archive and direct download;
- `Vistrea-Studio-X.Y.Z.dmg`: user-facing disk image with an Applications link;
- `SHA256SUMS`: SHA-256 digests for the ZIP and DMG;
- `appcast.xml`: signed Sparkle update feed deployed to GitHub Pages and also
  attached to the Release.

Generated release output belongs outside the repository and is never committed.

## One-time GitHub configuration

Enable GitHub Pages with **GitHub Actions** as the publishing source. The
workflow deploys the feed to:

```text
https://lllllayer.github.io/vistrea/appcast.xml
```

Create these Actions variables:

| Variable | Value |
|---|---|
| `MACOS_SIGNING_IDENTITY` | Full `Developer ID Application: ... (TEAMID)` identity |
| `VISTREA_SPARKLE_PUBLIC_KEY` | Base64 Ed25519 public key printed by Sparkle `generate_keys` |

Create these Actions secrets:

| Secret | Value |
|---|---|
| `MACOS_DEVELOPER_ID_CERTIFICATE_BASE64` | Base64-encoded Developer ID `.p12` |
| `MACOS_DEVELOPER_ID_CERTIFICATE_PASSWORD` | Password protecting the `.p12` |
| `MACOS_KEYCHAIN_PASSWORD` | Ephemeral CI keychain password |
| `APPLE_NOTARY_KEY_BASE64` | Base64-encoded App Store Connect `.p8` API key |
| `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID |
| `APPLE_NOTARY_ISSUER_ID` | App Store Connect issuer ID |
| `VISTREA_SPARKLE_PRIVATE_KEY` | Contents of the private key exported by Sparkle `generate_keys -x` |

Keep the Developer ID certificate and Sparkle private key in separately
controlled backups. Do not place either key in repository variables, workflow
arguments, logs, release assets, or the application bundle.

## Generate the Sparkle key once

Resolve the pinned package and use the bundled Sparkle tool:

```bash
swift package --package-path apps/studio-macos resolve
apps/studio-macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys \
  --account dev.vistrea.studio
apps/studio-macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys \
  --account dev.vistrea.studio \
  -x /secure/location/vistrea-studio-sparkle-private-key
```

The first command prints the public key for `VISTREA_SPARKLE_PUBLIC_KEY`; the
exported file content becomes `VISTREA_SPARKLE_PRIVATE_KEY`.

## Test packaging without release credentials

A manual workflow dispatch builds an ad-hoc-signed package, uploads it as a
workflow artifact, omits Sparkle feed metadata, and never creates a GitHub
Release. The same boundary can be tested locally:

```bash
pnpm install --frozen-lockfile
pnpm build:host
tools/release/package-studio-macos.sh \
  --version 0.1.0 \
  --build-number 0.1.0 \
  --output-dir /tmp/vistrea-studio-release
```

This path validates bundle composition, both architectures, nested Host and
Sparkle code signatures, ZIP, DMG, and checksums. It also starts the embedded
Host against a temporary Workspace, performs an authenticated status request,
and verifies clean descriptor and Workspace-lock removal. A packaged-app smoke
launch additionally proves that a normal app launch creates the default
Application Support Workspace and closes its owned Host cleanly. Local ad-hoc
signing uses a local-only library-validation exemption because its components
have no shared Team ID; Developer ID builds do not receive that exemption.
This path does not claim Gatekeeper or update acceptance.

## Publish a release

Use a clean, reviewed commit on the intended release branch, then create and
push an annotated tag:

```bash
git tag -a studio-v0.1.0 -m "Vistrea Studio 0.1.0"
git push origin studio-v0.1.0
```

The workflow then:

1. validates the canonical tag, proves it is newer than every published Studio
   release, and checks all required credentials;
2. resolves the exact Node, Host, and SwiftPM dependency locks and runs Studio
   tests;
3. builds the Host plus both macOS architectures and assembles the application
   bundle with both embedded Host runtimes;
4. signs the embedded Node.js and SQLite code, Sparkle helpers, Sparkle, the
   application, and the DMG;
5. submits the application and DMG to Apple, waits, and staples their tickets;
6. generates the signed Sparkle appcast with tag-scoped asset URLs, rejecting
   any archive whose short version or build version differs from the tag;
7. creates or refreshes a draft GitHub Release;
8. publishes that Release so every update enclosure is publicly downloadable;
9. deploys the signed appcast to GitHub Pages as the last public state change.

A rerun may replace assets on an existing draft. It refuses to overwrite an
already published release.

Every Studio release uses its canonical `X.Y.Z` value for both
`CFBundleShortVersionString` and `CFBundleVersion`. The global release
concurrency group serializes all tags that update the one public appcast.

## Required first-release acceptance

Before calling public updates verified:

1. install the DMG on both Apple silicon and Intel macOS 14 or later;
2. verify `spctl` accepts the application and DMG;
3. launch the installed app twice and confirm the update permission behavior;
4. publish a second strictly higher semantic version;
5. use **Vistrea Studio > Check for Updates…** on the older installed build;
6. install, relaunch, and confirm the new short version and build number;
7. verify the Workspace remains unchanged across the update.

That credentialed old-to-new loop is intentionally distinct from the local
ad-hoc packaging verification recorded in development progress.
