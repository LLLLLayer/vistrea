#!/bin/bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: package-studio-macos.sh --version <x.y.z> --build-number <numeric-version> --output-dir <path> [options]

Builds a Universal Vistrea Studio application, embeds the production Host and
Sparkle, signs nested code in dependency order, and produces ZIP and DMG
distribution archives. Run `pnpm build:host` before packaging.

Options:
  --sparkle-feed-url <https-url>  Enable updates with this appcast URL.
  --sparkle-public-key <base64>   Ed25519 public key paired with the feed URL.
  --require-distribution          Require Developer ID signing, notarization,
                                  and enabled Sparkle updates.
  -h, --help                      Show this help.

Environment:
  VISTREA_CODESIGN_IDENTITY       Developer ID identity; defaults to ad hoc '-'.
  VISTREA_NOTARY_KEY_FILE         App Store Connect API .p8 key path.
  VISTREA_NOTARY_KEY_ID           App Store Connect API key ID.
  VISTREA_NOTARY_ISSUER_ID        App Store Connect issuer ID.
EOF
}

fail() {
    echo "error: $*" >&2
    exit 1
}

VERSION=""
BUILD_NUMBER=""
OUTPUT_DIR=""
SPARKLE_FEED_URL=""
SPARKLE_PUBLIC_KEY=""
REQUIRE_DISTRIBUTION=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            [[ $# -ge 2 ]] || fail "--version requires a value"
            VERSION="$2"
            shift 2
            ;;
        --build-number)
            [[ $# -ge 2 ]] || fail "--build-number requires a value"
            BUILD_NUMBER="$2"
            shift 2
            ;;
        --output-dir)
            [[ $# -ge 2 ]] || fail "--output-dir requires a value"
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --sparkle-feed-url)
            [[ $# -ge 2 ]] || fail "--sparkle-feed-url requires a value"
            SPARKLE_FEED_URL="$2"
            shift 2
            ;;
        --sparkle-public-key)
            [[ $# -ge 2 ]] || fail "--sparkle-public-key requires a value"
            SPARKLE_PUBLIC_KEY="$2"
            shift 2
            ;;
        --require-distribution)
            REQUIRE_DISTRIBUTION=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || fail "version must be canonical x.y.z without leading zeroes"
[[ "$BUILD_NUMBER" =~ ^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,2}$ ]] \
    || fail "build number must contain one to three canonical numeric components"
[[ -n "$OUTPUT_DIR" ]] || fail "--output-dir is required"

if [[ -n "$SPARKLE_FEED_URL" || -n "$SPARKLE_PUBLIC_KEY" ]]; then
    [[ -n "$SPARKLE_FEED_URL" && -n "$SPARKLE_PUBLIC_KEY" ]] \
        || fail "Sparkle feed URL and public key must be provided together"
    if ! /usr/bin/ruby -ruri -e '
        value = URI.parse(ARGV.fetch(0))
        exit(value.is_a?(URI::HTTPS) && value.host && !value.host.empty? && !value.userinfo ? 0 : 1)
    ' "$SPARKLE_FEED_URL" 2>/dev/null; then
        fail "Sparkle feed URL must be an absolute HTTPS URL with a host and no credentials"
    fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGE_PATH="$REPO_ROOT/apps/studio-macos"
INFO_TEMPLATE="$PACKAGE_PATH/Resources/Info.plist"
NODE_ENTITLEMENTS="$SCRIPT_DIR/host-runtime/Node.entitlements"
SIGN_IDENTITY="${VISTREA_CODESIGN_IDENTITY:--}"
NOTARY_KEY_FILE="${VISTREA_NOTARY_KEY_FILE:-}"
NOTARY_KEY_ID="${VISTREA_NOTARY_KEY_ID:-}"
NOTARY_ISSUER_ID="${VISTREA_NOTARY_ISSUER_ID:-}"

[[ -f "$INFO_TEMPLATE" ]] || fail "missing Info.plist template: $INFO_TEMPLATE"
[[ -f "$NODE_ENTITLEMENTS" ]] || fail "missing embedded Node.js entitlements: $NODE_ENTITLEMENTS"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vistrea-studio-release.XXXXXX")"
cleanup() {
    rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

NODE_SIGNING_ENTITLEMENTS="$NODE_ENTITLEMENTS"
APP_SIGNING_ENTITLEMENTS=""
if [[ "$SIGN_IDENTITY" == "-" ]]; then
    # Hardened Runtime library validation compares Team IDs. Ad hoc signatures
    # have no stable Team ID, so a locally packaged app cannot load its ad hoc
    # Sparkle framework or better-sqlite3 addon without this local-only escape
    # hatch. Developer ID builds never receive either entitlement file.
    NODE_SIGNING_ENTITLEMENTS="$TEMP_ROOT/node-ad-hoc.entitlements"
    APP_SIGNING_ENTITLEMENTS="$TEMP_ROOT/app-ad-hoc.entitlements"
    /usr/bin/ditto "$NODE_ENTITLEMENTS" "$NODE_SIGNING_ENTITLEMENTS"
    /usr/bin/plutil -insert 'com\.apple\.security\.cs\.disable-library-validation' \
        -bool true "$NODE_SIGNING_ENTITLEMENTS"
    /usr/bin/plutil -create xml1 "$APP_SIGNING_ENTITLEMENTS"
    /usr/bin/plutil -insert 'com\.apple\.security\.cs\.disable-library-validation' \
        -bool true "$APP_SIGNING_ENTITLEMENTS"
fi

if [[ -n "$SPARKLE_PUBLIC_KEY" ]]; then
    [[ "$SPARKLE_PUBLIC_KEY" != *[[:space:]]* ]] \
        || fail "Sparkle public key must be canonical base64 without whitespace"
    PUBLIC_KEY_BYTES="$TEMP_ROOT/sparkle-public-key.bin"
    if ! printf '%s' "$SPARKLE_PUBLIC_KEY" | /usr/bin/base64 -D > "$PUBLIC_KEY_BYTES" 2>/dev/null; then
        fail "Sparkle public key is not valid base64"
    fi
    [[ "$(wc -c < "$PUBLIC_KEY_BYTES" | tr -d ' ')" == "32" ]] \
        || fail "Sparkle public key must decode to 32 bytes"
    CANONICAL_PUBLIC_KEY="$(/usr/bin/base64 < "$PUBLIC_KEY_BYTES" | tr -d '\n')"
    [[ "$CANONICAL_PUBLIC_KEY" == "$SPARKLE_PUBLIC_KEY" ]] \
        || fail "Sparkle public key must use canonical padded base64"
fi

notary_values=0
[[ -n "$NOTARY_KEY_FILE" ]] && notary_values=$((notary_values + 1))
[[ -n "$NOTARY_KEY_ID" ]] && notary_values=$((notary_values + 1))
[[ -n "$NOTARY_ISSUER_ID" ]] && notary_values=$((notary_values + 1))
[[ "$notary_values" == "0" || "$notary_values" == "3" ]] \
    || fail "all three VISTREA_NOTARY_* values must be provided together"
if [[ "$notary_values" == "3" ]]; then
    [[ -f "$NOTARY_KEY_FILE" ]] || fail "notary key file does not exist: $NOTARY_KEY_FILE"
    [[ "$SIGN_IDENTITY" != "-" ]] || fail "notarization requires Developer ID signing"
fi

if [[ "$REQUIRE_DISTRIBUTION" == "1" ]]; then
    [[ "$SIGN_IDENTITY" != "-" ]] || fail "distribution requires VISTREA_CODESIGN_IDENTITY"
    [[ "$notary_values" == "3" ]] || fail "distribution requires App Store Connect notarization credentials"
    [[ -n "$SPARKLE_FEED_URL" ]] || fail "distribution requires an enabled Sparkle feed"
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
APP_NAME="Vistrea Studio.app"
ARCHIVE_STEM="Vistrea-Studio-$VERSION"
OUTPUT_APP="$OUTPUT_DIR/$APP_NAME"
OUTPUT_ZIP="$OUTPUT_DIR/$ARCHIVE_STEM.zip"
OUTPUT_DMG="$OUTPUT_DIR/$ARCHIVE_STEM.dmg"
OUTPUT_CHECKSUMS="$OUTPUT_DIR/SHA256SUMS"
PUBLISH_ROOT="$OUTPUT_DIR/.vistrea-studio-publish.$$"

for output in "$OUTPUT_APP" "$OUTPUT_ZIP" "$OUTPUT_DMG" "$OUTPUT_CHECKSUMS"; do
    [[ ! -e "$output" ]] || fail "output already exists: $output"
done
[[ ! -e "$PUBLISH_ROOT" ]] || fail "temporary publication path already exists: $PUBLISH_ROOT"
mkdir "$PUBLISH_ROOT"
STAGED_APP="$PUBLISH_ROOT/$APP_NAME"
STAGED_ZIP="$PUBLISH_ROOT/$ARCHIVE_STEM.zip"
STAGED_DMG="$PUBLISH_ROOT/$ARCHIVE_STEM.dmg"
STAGED_CHECKSUMS="$PUBLISH_ROOT/SHA256SUMS"
PUBLISH_COMMITTED=0

cleanup_outputs() {
    if [[ "$PUBLISH_COMMITTED" != "1" ]]; then
        rm -rf "$PUBLISH_ROOT" "$OUTPUT_APP" "$OUTPUT_ZIP" "$OUTPUT_DMG" "$OUTPUT_CHECKSUMS"
    fi
}
trap 'cleanup_outputs; cleanup' EXIT

ARM_SCRATCH="$TEMP_ROOT/build-arm64"
X86_SCRATCH="$TEMP_ROOT/build-x86_64"

build_architecture() {
    local scratch_path="$1"
    local triple="$2"
    swift build \
        --package-path "$PACKAGE_PATH" \
        --scratch-path "$scratch_path" \
        --triple "$triple" \
        --configuration release \
        --product VistreaStudio \
        -Xlinker -rpath \
        -Xlinker @executable_path/../Frameworks
}

echo "Building Vistrea Studio $VERSION ($BUILD_NUMBER) for arm64..."
build_architecture "$ARM_SCRATCH" "arm64-apple-macosx14.0"
echo "Building Vistrea Studio $VERSION ($BUILD_NUMBER) for x86_64..."
build_architecture "$X86_SCRATCH" "x86_64-apple-macosx14.0"

ARM_BIN_DIR="$(swift build --package-path "$PACKAGE_PATH" --scratch-path "$ARM_SCRATCH" --triple arm64-apple-macosx14.0 --configuration release --show-bin-path)"
X86_BIN_DIR="$(swift build --package-path "$PACKAGE_PATH" --scratch-path "$X86_SCRATCH" --triple x86_64-apple-macosx14.0 --configuration release --show-bin-path)"
ARM_BINARY="$ARM_BIN_DIR/VistreaStudio"
X86_BINARY="$X86_BIN_DIR/VistreaStudio"
[[ -x "$ARM_BINARY" ]] || fail "missing arm64 Studio executable"
[[ -x "$X86_BINARY" ]] || fail "missing x86_64 Studio executable"

SPARKLE_ARTIFACT_ROOT="$ARM_SCRATCH/artifacts/sparkle/Sparkle"
SPARKLE_FRAMEWORK_SOURCE="$SPARKLE_ARTIFACT_ROOT/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
[[ -d "$SPARKLE_FRAMEWORK_SOURCE" ]] || fail "missing resolved Sparkle framework"

APP_PATH="$TEMP_ROOT/$APP_NAME"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Frameworks" "$APP_PATH/Contents/Resources/ThirdPartyLicenses"
/usr/bin/lipo -create "$ARM_BINARY" "$X86_BINARY" -output "$APP_PATH/Contents/MacOS/VistreaStudio"
/usr/bin/ditto "$SPARKLE_FRAMEWORK_SOURCE" "$APP_PATH/Contents/Frameworks/Sparkle.framework"
/usr/bin/ditto "$INFO_TEMPLATE" "$APP_PATH/Contents/Info.plist"
/usr/bin/ditto "$SPARKLE_ARTIFACT_ROOT/LICENSE" "$APP_PATH/Contents/Resources/ThirdPartyLicenses/Sparkle.txt"

HOST_RUNTIME="$TEMP_ROOT/HostRuntime"
"$SCRIPT_DIR/prepare-studio-host-runtime.sh" --output-dir "$HOST_RUNTIME"
"$SCRIPT_DIR/verify-studio-host-runtime.sh" --runtime-root "$HOST_RUNTIME"
/usr/bin/ditto "$HOST_RUNTIME" "$APP_PATH/Contents/Resources/HostRuntime"

# SwiftPM may record the selected Xcode toolchain as a fallback rpath. System
# Swift libraries are available through /usr/lib/swift on the supported macOS
# versions, so a distributable binary must not retain a build-machine path.
while IFS= read -r rpath; do
    case "$rpath" in
        */Contents/Developer/Toolchains/*/usr/lib/swift-*/macosx)
            /usr/bin/install_name_tool -delete_rpath "$rpath" "$APP_PATH/Contents/MacOS/VistreaStudio"
            ;;
    esac
done < <(/usr/bin/otool -l "$APP_PATH/Contents/MacOS/VistreaStudio" \
    | /usr/bin/awk '/cmd LC_RPATH/ { getline; getline; print $2 }' \
    | /usr/bin/sort -u)

/usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_PATH/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$APP_PATH/Contents/Info.plist"
/usr/bin/plutil -insert VistreaEmbeddedHostRuntime -bool true "$APP_PATH/Contents/Info.plist"
if [[ -n "$SPARKLE_FEED_URL" ]]; then
    /usr/bin/plutil -insert SUFeedURL -string "$SPARKLE_FEED_URL" "$APP_PATH/Contents/Info.plist"
    /usr/bin/plutil -insert SUPublicEDKey -string "$SPARKLE_PUBLIC_KEY" "$APP_PATH/Contents/Info.plist"
    /usr/bin/plutil -insert SURequireSignedFeed -bool true "$APP_PATH/Contents/Info.plist"
    /usr/bin/plutil -insert SUVerifyUpdateBeforeExtraction -bool true "$APP_PATH/Contents/Info.plist"
fi

sign_code() {
    local path="$1"
    local preserve_entitlements="${2:-0}"
    local entitlements="${3:-}"
    local arguments=(--force --sign "$SIGN_IDENTITY" --options runtime)
    if [[ "$SIGN_IDENTITY" != "-" ]]; then
        arguments+=(--timestamp)
    fi
    if [[ "$preserve_entitlements" == "1" ]]; then
        arguments+=(--preserve-metadata=entitlements)
    fi
    if [[ -n "$entitlements" ]]; then
        arguments+=(--entitlements "$entitlements")
    fi
    /usr/bin/codesign "${arguments[@]}" "$path"
}

SPARKLE_FRAMEWORK="$APP_PATH/Contents/Frameworks/Sparkle.framework"
while IFS= read -r -d '' native_addon; do
    sign_code "$native_addon"
done < <(/usr/bin/find "$APP_PATH/Contents/Resources/HostRuntime" -type f -name '*.node' -print0)
while IFS= read -r -d '' node_runtime; do
    sign_code "$node_runtime" 0 "$NODE_SIGNING_ENTITLEMENTS"
done < <(/usr/bin/find "$APP_PATH/Contents/Resources/HostRuntime" -type f -name node -print0)
sign_code "$SPARKLE_FRAMEWORK/Versions/B/XPCServices/Installer.xpc"
sign_code "$SPARKLE_FRAMEWORK/Versions/B/XPCServices/Downloader.xpc" 1
sign_code "$SPARKLE_FRAMEWORK/Versions/B/Autoupdate"
sign_code "$SPARKLE_FRAMEWORK/Versions/B/Updater.app"
sign_code "$SPARKLE_FRAMEWORK"
sign_code "$APP_PATH" 0 "$APP_SIGNING_ENTITLEMENTS"

/usr/bin/lipo "$APP_PATH/Contents/MacOS/VistreaStudio" -verify_arch arm64 x86_64
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
"$SCRIPT_DIR/verify-studio-host-runtime.sh" \
    --runtime-root "$APP_PATH/Contents/Resources/HostRuntime"
if ! /usr/bin/otool -L "$APP_PATH/Contents/MacOS/VistreaStudio" | /usr/bin/grep -Fq "@rpath/Sparkle.framework/"; then
    fail "packaged executable does not link the embedded Sparkle framework"
fi
if /usr/bin/otool -l "$APP_PATH/Contents/MacOS/VistreaStudio" | /usr/bin/grep -Fq "/Contents/Developer/Toolchains/"; then
    fail "packaged executable retains a build-machine toolchain rpath"
fi

if [[ "$notary_values" == "3" ]]; then
    NOTARY_ZIP="$TEMP_ROOT/notarization.zip"
    /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARY_ZIP"
    /usr/bin/xcrun notarytool submit "$NOTARY_ZIP" \
        --key "$NOTARY_KEY_FILE" \
        --key-id "$NOTARY_KEY_ID" \
        --issuer "$NOTARY_ISSUER_ID" \
        --wait
    /usr/bin/xcrun stapler staple "$APP_PATH"
    /usr/bin/xcrun stapler validate "$APP_PATH"
fi

/usr/bin/ditto "$APP_PATH" "$STAGED_APP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$STAGED_ZIP"

DMG_SOURCE="$TEMP_ROOT/dmg"
mkdir -p "$DMG_SOURCE"
/usr/bin/ditto "$APP_PATH" "$DMG_SOURCE/$APP_NAME"
ln -s /Applications "$DMG_SOURCE/Applications"
/usr/bin/hdiutil create \
    -volname "Vistrea Studio" \
    -srcfolder "$DMG_SOURCE" \
    -format UDZO \
    -ov \
    "$STAGED_DMG"

if [[ "$SIGN_IDENTITY" != "-" ]]; then
    /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --timestamp "$STAGED_DMG"
fi
if [[ "$notary_values" == "3" ]]; then
    /usr/bin/xcrun notarytool submit "$STAGED_DMG" \
        --key "$NOTARY_KEY_FILE" \
        --key-id "$NOTARY_KEY_ID" \
        --issuer "$NOTARY_ISSUER_ID" \
        --wait
    /usr/bin/xcrun stapler staple "$STAGED_DMG"
    /usr/bin/xcrun stapler validate "$STAGED_DMG"
    /usr/sbin/spctl --assess --type execute --verbose=2 "$STAGED_APP"
    /usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "$STAGED_DMG"
fi
/usr/bin/hdiutil imageinfo "$STAGED_DMG" >/dev/null

(
    cd "$PUBLISH_ROOT"
    /usr/bin/shasum -a 256 "$(basename "$STAGED_ZIP")" "$(basename "$STAGED_DMG")" > "$STAGED_CHECKSUMS"
)

# Final names become visible only after every build, signing, notarization,
# archive, and checksum step has succeeded. The EXIT trap removes any partial
# final publication if an unexpected same-filesystem rename fails.
/bin/mv "$STAGED_APP" "$OUTPUT_APP"
/bin/mv "$STAGED_ZIP" "$OUTPUT_ZIP"
/bin/mv "$STAGED_DMG" "$OUTPUT_DMG"
/bin/mv "$STAGED_CHECKSUMS" "$OUTPUT_CHECKSUMS"
/bin/rmdir "$PUBLISH_ROOT"
PUBLISH_COMMITTED=1

echo "Packaged Vistrea Studio:"
echo "  App: $OUTPUT_APP"
echo "  ZIP: $OUTPUT_ZIP"
echo "  DMG: $OUTPUT_DMG"
echo "  Checksums: $OUTPUT_CHECKSUMS"
