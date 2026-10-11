#!/bin/bash

set -euo pipefail

fail() {
    echo "error: $*" >&2
    exit 1
}

[[ "${1:-}" == "--app" && $# == 2 ]] \
    || fail "usage: verify-packaged-studio-local-beta.sh --app <VistreaStudio.app>"

APP_PATH="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EMITTED_ROOT="$REPO_ROOT/.build/typescript"
PACKAGE_PATH="$REPO_ROOT/apps/studio-macos"

case "$(uname -m)" in
    arm64) architecture="arm64" ;;
    x86_64) architecture="x86_64" ;;
    *) fail "unsupported verification architecture: $(uname -m)" ;;
esac

RUNTIME="$APP_PATH/Contents/Resources/HostRuntime/$architecture"
NODE="$RUNTIME/node"
APP_ROOT="$RUNTIME/app"
SERVE="$APP_ROOT/.build/typescript/apps/host/serve.js"
MAINTENANCE="$APP_ROOT/.build/typescript/apps/host/workspace-maintenance.js"
GENERATOR_SOURCE="$EMITTED_ROOT/tools/acceptance/disposable-workspace.js"
[[ -x "$NODE" && -f "$SERVE" && -f "$MAINTENANCE" ]] \
    || fail "packaged Host runtime is incomplete for $architecture"
[[ -f "$GENERATOR_SOURCE" ]] \
    || fail "disposable fixture is not built; run pnpm build:host first"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vistrea-packaged-local-beta.XXXXXX")"
WORKSPACE="$TEMP_ROOT/workspace"
MANIFEST="$TEMP_ROOT/fixture.json"
DESCRIPTOR="$TEMP_ROOT/connection.json"
host_pid=""
cleanup() {
    stop_host || true
    rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

stop_host() {
    if [[ -n "$host_pid" ]] && kill -0 "$host_pid" 2>/dev/null; then
        kill -TERM "$host_pid" 2>/dev/null || true
        wait "$host_pid" 2>/dev/null || true
    fi
    host_pid=""
}

start_host() {
    rm -f "$DESCRIPTOR"
    (
        cd "$APP_ROOT"
        exec "$NODE" "$SERVE" \
            --workspace "$WORKSPACE" \
            --connection-file "$DESCRIPTOR"
    ) > "$TEMP_ROOT/host.stdout" 2> "$TEMP_ROOT/host.stderr" &
    host_pid=$!
    for _ in {1..150}; do
        [[ -f "$DESCRIPTOR" ]] && return
        if ! kill -0 "$host_pid" 2>/dev/null; then
            /bin/cat "$TEMP_ROOT/host.stderr" >&2
            fail "packaged Host exited before writing its connection descriptor"
        fi
        sleep 0.1
    done
    fail "packaged Host did not become ready within 15 seconds"
}

json_value() {
    local file_path="$1"
    shift
    "$NODE" -e '
        const fs = require("node:fs");
        const args = process.argv.slice(1);
        let value = JSON.parse(fs.readFileSync(args.shift(), "utf8"));
        for (const key of args) value = value?.[key];
        if (typeof value !== "string" || value.length === 0) process.exit(2);
        process.stdout.write(value);
    ' "$file_path" "$@"
}

# Construct the fixture with an isolated copy of the packaged dependency
# runtime. The signed application remains read-only; every subsequent Host and
# maintenance operation uses the exact runtime embedded in the application.
GENERATOR_APP="$TEMP_ROOT/generator-app"
/usr/bin/ditto "$APP_ROOT" "$GENERATOR_APP"
mkdir -p \
    "$GENERATOR_APP/.build/typescript/tools/acceptance" \
    "$GENERATOR_APP/protocol/fixtures/v1/runtime-snapshot/valid" \
    "$GENERATOR_APP/protocol/fixtures/v1/object/valid"
/usr/bin/ditto "$GENERATOR_SOURCE" \
    "$GENERATOR_APP/.build/typescript/tools/acceptance/disposable-workspace.js"
/usr/bin/ditto \
    "$REPO_ROOT/protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json" \
    "$GENERATOR_APP/protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
/usr/bin/ditto \
    "$REPO_ROOT/protocol/fixtures/v1/object/valid/plain-text.json" \
    "$GENERATOR_APP/protocol/fixtures/v1/object/valid/plain-text.json"
(
    cd "$GENERATOR_APP"
    "$NODE" .build/typescript/tools/acceptance/disposable-workspace.js \
        --workspace "$WORKSPACE" \
        --manifest "$MANIFEST"
) > "$TEMP_ROOT/fixture.stdout"

swift build \
    --package-path "$PACKAGE_PATH" \
    --configuration release \
    --product VistreaStudioAcceptanceProbe >/dev/null
PROBE_BIN_DIR="$(swift build \
    --package-path "$PACKAGE_PATH" \
    --configuration release \
    --show-bin-path)"
PROBE="$PROBE_BIN_DIR/VistreaStudioAcceptanceProbe"
[[ -x "$PROBE" ]] || fail "Studio acceptance probe did not build"

run_studio_probe() {
    local host_url host_token
    host_url="$(json_value "$DESCRIPTOR" api base_url)"
    host_token="$(json_value "$DESCRIPTOR" api bearer_token)"
    VISTREA_HOST_URL="$host_url" \
    VISTREA_HOST_TOKEN="$host_token" \
    VISTREA_SNAPSHOT_ID="$(json_value "$MANIFEST" left_snapshot_id)" \
    VISTREA_COLLECTION_ID="$(json_value "$MANIFEST" collection_id)" \
    VISTREA_TUNING_PATCH_ID="$(json_value "$MANIFEST" tuning_patch_id)" \
    VISTREA_LEFT_BUILD_ID="$(json_value "$MANIFEST" left_build_id)" \
    VISTREA_RIGHT_BUILD_ID="$(json_value "$MANIFEST" right_build_id)" \
        "$PROBE"
}

start_host
run_studio_probe > "$TEMP_ROOT/studio-before-restore.json"
"$NODE" "$SCRIPT_DIR/probe-disposable-workspace.mjs" \
    "$DESCRIPTOR" "$MANIFEST" present
stop_host

GC_PLAN="$TEMP_ROOT/gc-plan.json"
(
    cd "$APP_ROOT"
    printf '%s\n' \
        '{"format_version":1,"operation":"collect_garbage","dry_run":true,"minimum_age_seconds":0}' \
        | "$NODE" "$MAINTENANCE" --workspace "$WORKSPACE"
) > "$GC_PLAN"
PLAN_DIGEST="$("$NODE" "$SCRIPT_DIR/probe-disposable-maintenance.mjs" \
    gc-plan "$MANIFEST" "$GC_PLAN")"

GC_APPLY="$TEMP_ROOT/gc-apply.json"
(
    cd "$APP_ROOT"
    printf '{"format_version":1,"operation":"collect_garbage","dry_run":false,"minimum_age_seconds":0,"expected_plan_digest":"%s"}\n' \
        "$PLAN_DIGEST" \
        | "$NODE" "$MAINTENANCE" --workspace "$WORKSPACE"
) > "$GC_APPLY"
"$NODE" "$SCRIPT_DIR/probe-disposable-maintenance.mjs" \
    gc-apply "$MANIFEST" "$GC_APPLY"

RESTORE_RESULT="$TEMP_ROOT/restore.json"
(
    cd "$APP_ROOT"
    printf '{"format_version":1,"operation":"restore","backup_hash":"%s"}\n' \
        "$(json_value "$MANIFEST" recovery_point_id)" \
        | "$NODE" "$MAINTENANCE" --workspace "$WORKSPACE"
) > "$RESTORE_RESULT"
"$NODE" "$SCRIPT_DIR/probe-disposable-maintenance.mjs" \
    restore "$MANIFEST" "$RESTORE_RESULT"

start_host
run_studio_probe > "$TEMP_ROOT/studio-after-restore.json"
"$NODE" "$SCRIPT_DIR/probe-disposable-workspace.mjs" \
    "$DESCRIPTOR" "$MANIFEST" absent
stop_host

[[ ! -e "$DESCRIPTOR" ]] || fail "packaged Host did not remove its connection descriptor"
[[ ! -e "$WORKSPACE/.host.lock" ]] || fail "packaged Host did not release its Workspace lock"

echo "Verified packaged Studio local Beta workflow: restore, GC, Collection, source handoff, Validation, and Build Diff."
