#!/usr/bin/env bash

set -euo pipefail

XCODEGEN_VERSION="2.45.4"
XCODEGEN_SHA256="090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef"
XCODEGEN_URL="https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/xcodegen.zip"

fail() {
    echo "error: $*" >&2
    exit 1
}

[[ $# -eq 1 ]] || fail "usage: $0 <installation-directory>"

destination="$1"
parent="$(dirname "$destination")"
mkdir -p "$parent"

if [[ -x "$destination/bin/xcodegen" ]]; then
    installed_version="$($destination/bin/xcodegen --version)"
    [[ "$installed_version" == "Version: $XCODEGEN_VERSION" ]] \
        || fail "existing XcodeGen has an unexpected version: $installed_version"
    exit 0
fi

[[ ! -e "$destination" ]] \
    || fail "installation destination already exists and is incomplete: $destination"

archive="$(mktemp "$parent/.xcodegen-${XCODEGEN_VERSION}.XXXXXX.zip")"
staging="$(mktemp -d "$parent/.xcodegen-${XCODEGEN_VERSION}.XXXXXX")"
cleanup() {
    rm -f "$archive"
    rm -rf "$staging"
}
trap cleanup EXIT

curl \
    --fail \
    --location \
    --proto '=https' \
    --proto-redir '=https' \
    --show-error \
    --silent \
    --tlsv1.2 \
    "$XCODEGEN_URL" \
    --output "$archive"

actual_sha256="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
[[ "$actual_sha256" == "$XCODEGEN_SHA256" ]] \
    || fail "downloaded XcodeGen archive checksum does not match the pinned release"

unzip -q "$archive" -d "$staging"
[[ -x "$staging/xcodegen/bin/xcodegen" ]] \
    || fail "downloaded XcodeGen archive does not contain the expected executable"

mv "$staging/xcodegen" "$destination"
"$destination/bin/xcodegen" --version
