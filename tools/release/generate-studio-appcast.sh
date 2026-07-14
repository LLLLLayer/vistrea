#!/bin/bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: generate-studio-appcast.sh --archive <zip> --tag <studio-vx.y.z> --output <appcast.xml>

Generates and signs the single-channel Vistrea Studio Sparkle feed. Set
VISTREA_SPARKLE_PRIVATE_KEY to the exported Sparkle Ed25519 private key. The
key is passed to Sparkle through standard input and never appears in argv.
EOF
}

fail() {
    echo "error: $*" >&2
    exit 1
}

ARCHIVE=""
TAG=""
OUTPUT=""
REPOSITORY="${GITHUB_REPOSITORY:-LLLLLayer/vistrea}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --archive)
            [[ $# -ge 2 ]] || fail "--archive requires a value"
            ARCHIVE="$2"
            shift 2
            ;;
        --tag)
            [[ $# -ge 2 ]] || fail "--tag requires a value"
            TAG="$2"
            shift 2
            ;;
        --output)
            [[ $# -ge 2 ]] || fail "--output requires a value"
            OUTPUT="$2"
            shift 2
            ;;
        --repository)
            [[ $# -ge 2 ]] || fail "--repository requires a value"
            REPOSITORY="$2"
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

[[ -f "$ARCHIVE" ]] || fail "archive does not exist: $ARCHIVE"
[[ "$TAG" =~ ^studio-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || fail "tag must be canonical studio-vx.y.z without leading zeroes"
[[ -n "$OUTPUT" ]] || fail "--output is required"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "repository must be owner/name"
[[ -n "${VISTREA_SPARKLE_PRIVATE_KEY:-}" ]] || fail "VISTREA_SPARKLE_PRIVATE_KEY is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SPARKLE_TOOLS="$REPO_ROOT/apps/studio-macos/.build/artifacts/sparkle/Sparkle/bin"
GENERATE_APPCAST="$SPARKLE_TOOLS/generate_appcast"
[[ -x "$GENERATE_APPCAST" ]] || fail "resolve the Studio Swift package before generating an appcast"

OUTPUT_PARENT="$(dirname "$OUTPUT")"
mkdir -p "$OUTPUT_PARENT"
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd)"
OUTPUT="$OUTPUT_PARENT/$(basename "$OUTPUT")"
[[ ! -e "$OUTPUT" ]] || fail "output already exists: $OUTPUT"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vistrea-studio-appcast.XXXXXX")"
cleanup() {
    rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

ARCHIVE_COPY="$TEMP_ROOT/$(basename "$ARCHIVE")"
/usr/bin/ditto "$ARCHIVE" "$ARCHIVE_COPY"
ARCHIVE_APP="$TEMP_ROOT/archive-app"
mkdir "$ARCHIVE_APP"
if ! /usr/bin/ditto -x -k "$ARCHIVE_COPY" "$ARCHIVE_APP"; then
    fail "archive is not a readable ZIP"
fi
INFO_PLIST="$ARCHIVE_APP/Vistrea Studio.app/Contents/Info.plist"
[[ -f "$INFO_PLIST" ]] || fail "archive does not contain Vistrea Studio.app at its root"
TAG_VERSION="${TAG#studio-v}"
ARCHIVE_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw "$INFO_PLIST")"
ARCHIVE_BUILD="$(/usr/bin/plutil -extract CFBundleVersion raw "$INFO_PLIST")"
[[ "$ARCHIVE_VERSION" == "$TAG_VERSION" ]] \
    || fail "archive version $ARCHIVE_VERSION does not match tag version $TAG_VERSION"
[[ "$ARCHIVE_BUILD" == "$TAG_VERSION" ]] \
    || fail "archive build $ARCHIVE_BUILD must equal the monotonic semantic release version $TAG_VERSION"
DOWNLOAD_PREFIX="https://github.com/$REPOSITORY/releases/download/$TAG/"
PRODUCT_LINK="https://github.com/$REPOSITORY/releases/tag/$TAG"

GENERATION_LOG="$TEMP_ROOT/generate-appcast.log"
if ! printf '%s' "$VISTREA_SPARKLE_PRIVATE_KEY" | "$GENERATE_APPCAST" \
    --ed-key-file - \
    --download-url-prefix "$DOWNLOAD_PREFIX" \
    --link "$PRODUCT_LINK" \
    --maximum-versions 1 \
    --maximum-deltas 0 \
    -o "$TEMP_ROOT/appcast.xml" \
    "$TEMP_ROOT" > "$GENERATION_LOG" 2>&1; then
    cat "$GENERATION_LOG" >&2
    fail "Sparkle appcast generation failed"
fi
cat "$GENERATION_LOG"

if /usr/bin/grep -F "SUPublicEDKey" "$GENERATION_LOG" | /usr/bin/grep -Fq "does not match key EdDSA"; then
    fail "Sparkle private key does not match the public key embedded in the app"
fi

[[ -f "$TEMP_ROOT/appcast.xml" ]] || fail "Sparkle did not generate appcast.xml"
/usr/bin/xmllint --noout "$TEMP_ROOT/appcast.xml"
if ! /usr/bin/grep -Fq "sparkle:edSignature=" "$TEMP_ROOT/appcast.xml"; then
    fail "generated appcast does not contain a signed update enclosure"
fi
if ! /usr/bin/grep -Fq "<!-- sparkle-signatures:" "$TEMP_ROOT/appcast.xml"; then
    fail "generated appcast is not itself signed"
fi
/usr/bin/ditto "$TEMP_ROOT/appcast.xml" "$OUTPUT"
echo "Generated signed appcast: $OUTPUT"
