#!/bin/bash

set -euo pipefail

fail() {
    echo "error: $*" >&2
    exit 1
}

[[ "${1:-}" == "--runtime-root" && $# == 2 ]] \
    || fail "usage: verify-studio-host-runtime.sh --runtime-root <HostRuntime>"
RUNTIME_ROOT="$2"

case "$(uname -m)" in
    arm64) architecture="arm64" ;;
    x86_64) architecture="x86_64" ;;
    *) fail "unsupported verification architecture: $(uname -m)" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$RUNTIME_ROOT/$architecture"
NODE="$RUNTIME/node"
APP_ROOT="$RUNTIME/app"
SERVE="$APP_ROOT/.build/typescript/apps/host/serve.js"
[[ -x "$NODE" && -f "$SERVE" ]] || fail "embedded Host runtime is incomplete for $architecture"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vistrea-studio-host-probe.XXXXXX")"
WORKSPACE="$TEMP_ROOT/workspace"
DESCRIPTOR="$TEMP_ROOT/connection.json"
mkdir "$WORKSPACE"
host_pid=""
cleanup() {
    if [[ -n "$host_pid" ]] && kill -0 "$host_pid" 2>/dev/null; then
        kill -TERM "$host_pid" 2>/dev/null || true
        wait "$host_pid" 2>/dev/null || true
    fi
    rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

(
    cd "$APP_ROOT"
    exec "$NODE" "$SERVE" \
        --workspace "$WORKSPACE" \
        --connection-file "$DESCRIPTOR"
) > "$TEMP_ROOT/host.stdout" 2> "$TEMP_ROOT/host.stderr" &
host_pid=$!

for _ in {1..150}; do
    [[ -f "$DESCRIPTOR" ]] && break
    if ! kill -0 "$host_pid" 2>/dev/null; then
        /bin/cat "$TEMP_ROOT/host.stderr" >&2
        fail "embedded Host exited before writing its connection descriptor"
    fi
    sleep 0.1
done
[[ -f "$DESCRIPTOR" ]] || fail "embedded Host did not become ready within 15 seconds"

"$NODE" "$SCRIPT_DIR/probe-studio-host-runtime.mjs" "$DESCRIPTOR"
kill -TERM "$host_pid"
wait "$host_pid"
host_pid=""
[[ ! -e "$DESCRIPTOR" ]] || fail "embedded Host did not remove its connection descriptor"
[[ ! -e "$WORKSPACE/.host.lock" ]] || fail "embedded Host did not release its Workspace lock"

echo "Verified embedded Studio Host runtime: $RUNTIME"
