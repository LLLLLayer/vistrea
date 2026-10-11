#!/bin/bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: package-studio-macos.sh --version <x.y.z> --build-number <numeric-version> --output-dir <path>

Builds a Universal Vistrea Studio application, embeds the production Host and
Sparkle, ad-hoc signs nested code in dependency order, and produces local ZIP
and DMG archives with updates disabled. Run `pnpm build:host` before packaging.

Options:
  -h, --help                      Show this help.
EOF
}

fail() {
    echo "error: $*" >&2
    exit 1
}

VERSION=""
BUILD_NUMBER=""
OUTPUT_DIR=""

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGE_PATH="$REPO_ROOT/apps/studio-macos"
INFO_TEMPLATE="$PACKAGE_PATH/Resources/Info.plist"
NODE_ENTITLEMENTS="$SCRIPT_DIR/host-runtime/Node.entitlements"

[[ -f "$INFO_TEMPLATE" ]] || fail "missing Info.plist template: $INFO_TEMPLATE"
[[ -f "$NODE_ENTITLEMENTS" ]] || fail "missing embedded Node.js entitlements: $NODE_ENTITLEMENTS"
for update_key in SUFeedURL SUPublicEDKey SURequireSignedFeed SUVerifyUpdateBeforeExtraction; do
    if /usr/bin/plutil -extract "$update_key" raw "$INFO_TEMPLATE" >/dev/null 2>&1; then
        fail "local packaging refuses automatic-update metadata: $update_key"
    fi
done

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vistrea-studio-release.XXXXXX")"
cleanup() {
    rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

# Hardened Runtime library validation compares Team IDs. Ad hoc signatures
# have no stable Team ID, so a locally packaged app cannot load its ad hoc
# Sparkle framework or better-sqlite3 addon without this local-only exemption.
NODE_SIGNING_ENTITLEMENTS="$TEMP_ROOT/node-ad-hoc.entitlements"
APP_SIGNING_ENTITLEMENTS="$TEMP_ROOT/app-ad-hoc.entitlements"
/usr/bin/ditto "$NODE_ENTITLEMENTS" "$NODE_SIGNING_ENTITLEMENTS"
/usr/bin/plutil -insert 'com\.apple\.security\.cs\.disable-library-validation' \
    -bool true "$NODE_SIGNING_ENTITLEMENTS"
/usr/bin/plutil -create xml1 "$APP_SIGNING_ENTITLEMENTS"
/usr/bin/plutil -insert 'com\.apple\.security\.cs\.disable-library-validation' \
    -bool true "$APP_SIGNING_ENTITLEMENTS"

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

sign_code() {
    local path="$1"
    local preserve_entitlements="${2:-0}"
    local entitlements="${3:-}"
    local arguments=(--force --sign - --options runtime)
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
"$SCRIPT_DIR/verify-packaged-studio-local-beta.sh" --app "$APP_PATH"
if ! /usr/bin/otool -L "$APP_PATH/Contents/MacOS/VistreaStudio" | /usr/bin/grep -Fq "@rpath/Sparkle.framework/"; then
    fail "packaged executable does not link the embedded Sparkle framework"
fi
if /usr/bin/otool -l "$APP_PATH/Contents/MacOS/VistreaStudio" | /usr/bin/grep -Fq "/Contents/Developer/Toolchains/"; then
    fail "packaged executable retains a build-machine toolchain rpath"
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

/usr/bin/hdiutil imageinfo "$STAGED_DMG" >/dev/null

(
    cd "$PUBLISH_ROOT"
    /usr/bin/shasum -a 256 "$(basename "$STAGED_ZIP")" "$(basename "$STAGED_DMG")" > "$STAGED_CHECKSUMS"
)

# Final names become visible only after every build, ad-hoc signing, archive,
# and checksum step has succeeded. The EXIT trap removes any partial final
# publication if an unexpected same-filesystem rename fails.
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
