#!/bin/bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: prepare-studio-host-runtime.sh --output-dir <path>

Builds the architecture-specific, self-contained Node.js Host runtimes embedded
in Vistrea Studio. The repository Host must already have been built with
`pnpm build:host`.
EOF
}

fail() {
    echo "error: $*" >&2
    exit 1
}

OUTPUT_DIR=""
while [[ $# -gt 0 ]]; do
    case "$1" in
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

[[ -n "$OUTPUT_DIR" ]] || fail "--output-dir is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EMITTED_ROOT="$REPO_ROOT/.build/typescript"
RUNTIME_PACKAGE="$SCRIPT_DIR/host-runtime/package.json"
RUNTIME_LOCK="$SCRIPT_DIR/host-runtime/package-lock.json"
NODE_VERSION="22.14.0"
CACHE_ROOT="${VISTREA_RELEASE_CACHE_DIR:-$REPO_ROOT/.build/release-cache}/node-$NODE_VERSION"

[[ -f "$EMITTED_ROOT/apps/host/serve.js" ]] \
    || fail "embedded Host is not built; run pnpm build:host first"
[[ -f "$EMITTED_ROOT/data/metadata/migrations/manifest.json" ]] \
    || fail "built Host is missing exact-byte SQLite migrations"
[[ -f "$RUNTIME_PACKAGE" && -f "$RUNTIME_LOCK" ]] \
    || fail "embedded Host runtime package lock is missing"
[[ ! -e "$OUTPUT_DIR" ]] || fail "output already exists: $OUTPUT_DIR"

case "$(uname -m)" in
    arm64) host_arch="arm64" ;;
    x86_64) host_arch="x64" ;;
    *) fail "unsupported build host architecture: $(uname -m)" ;;
esac

mkdir -p "$CACHE_ROOT"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vistrea-studio-host-runtime.XXXXXX")"
cleanup() {
    rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

node_hash() {
    case "$1" in
        arm64) echo "e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42" ;;
        x64) echo "6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250" ;;
        *) return 1 ;;
    esac
}

prepare_node_distribution() {
    local architecture="$1"
    local archive_name="node-v$NODE_VERSION-darwin-$architecture.tar.gz"
    local archive="$CACHE_ROOT/$archive_name"
    local download="$CACHE_ROOT/.$archive_name.$$"
    local extracted="$CACHE_ROOT/node-v$NODE_VERSION-darwin-$architecture"
    local extraction="$CACHE_ROOT/.node-v$NODE_VERSION-darwin-$architecture.$$"
    local expected_hash
    expected_hash="$(node_hash "$architecture")"

    if [[ ! -f "$archive" ]] || \
        [[ "$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{ print $1 }')" != "$expected_hash" ]]; then
        rm -f "$download"
        /usr/bin/curl --fail --location --silent --show-error \
            "https://nodejs.org/dist/v$NODE_VERSION/$archive_name" \
            --output "$download"
        [[ "$(/usr/bin/shasum -a 256 "$download" | /usr/bin/awk '{ print $1 }')" == "$expected_hash" ]] \
            || fail "downloaded Node.js $architecture archive checksum does not match the pinned release"
        /bin/mv -f "$download" "$archive"
    fi
    [[ "$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{ print $1 }')" == "$expected_hash" ]] \
        || fail "Node.js $architecture archive checksum does not match the pinned release"

    if [[ ! -x "$extracted/bin/node" ]]; then
        rm -rf "$extraction"
        mkdir "$extraction"
        /usr/bin/tar -xzf "$archive" -C "$extraction" --strip-components 1
        if ! /bin/mv "$extraction" "$extracted" 2>/dev/null; then
            rm -rf "$extraction"
            [[ -x "$extracted/bin/node" ]] \
                || fail "Node.js $architecture cache could not be installed atomically"
        fi
    fi
    /usr/bin/lipo "$extracted/bin/node" -verify_arch "${architecture/x64/x86_64}" \
        || fail "Node.js executable architecture does not match $architecture"
}

prepare_node_distribution arm64
prepare_node_distribution x64

HOST_NODE_ROOT="$CACHE_ROOT/node-v$NODE_VERSION-darwin-$host_arch"
HOST_NODE="$HOST_NODE_ROOT/bin/node"
HOST_NPM="$HOST_NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js"
[[ -x "$HOST_NODE" && -f "$HOST_NPM" ]] || fail "pinned Node.js npm toolchain is incomplete"
export PATH="$HOST_NODE_ROOT/bin:$PATH"

mkdir "$OUTPUT_DIR"
for architecture in arm64 x64; do
    runtime_root="$OUTPUT_DIR/${architecture/x64/x86_64}"
    application_root="$runtime_root/app"
    node_root="$CACHE_ROOT/node-v$NODE_VERSION-darwin-$architecture"
    mkdir -p "$application_root/.build/typescript" "$application_root/protocol/schema" "$application_root/tools/protocol"

    /usr/bin/ditto "$node_root/bin/node" "$runtime_root/node"
    /usr/bin/ditto "$node_root/LICENSE" "$runtime_root/NODE_LICENSE"
    /usr/bin/ditto "$RUNTIME_PACKAGE" "$application_root/package.json"
    /usr/bin/ditto "$RUNTIME_LOCK" "$application_root/package-lock.json"

    npm_arch="$architecture"
    npm_config_arch="$npm_arch" \
    npm_config_platform=darwin \
    npm_config_audit=false \
    npm_config_fund=false \
        "$HOST_NODE" "$HOST_NPM" ci \
            --prefix "$application_root" \
            --omit=dev \
            --foreground-scripts=false

    for module in apps data engine; do
        /usr/bin/ditto "$EMITTED_ROOT/$module" "$application_root/.build/typescript/$module"
    done
    /usr/bin/ditto "$REPO_ROOT/protocol/schema/v1" "$application_root/protocol/schema/v1"
    /usr/bin/ditto "$REPO_ROOT/tools/protocol/semantic-checks.mjs" "$application_root/tools/protocol/semantic-checks.mjs"
    /usr/bin/ditto "$REPO_ROOT/tools/protocol/phase0a2-semantic-checks.mjs" "$application_root/tools/protocol/phase0a2-semantic-checks.mjs"

    native_addon="$application_root/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    [[ -f "$native_addon" ]] || fail "better-sqlite3 native module was not installed for $architecture"
    /usr/bin/lipo "$runtime_root/node" -verify_arch "${architecture/x64/x86_64}" \
        || fail "embedded Node.js executable is not $architecture"
    /usr/bin/lipo "$native_addon" -verify_arch "${architecture/x64/x86_64}" \
        || fail "embedded better-sqlite3 module is not $architecture"
done

echo "Prepared embedded Studio Host runtimes: $OUTPUT_DIR"
