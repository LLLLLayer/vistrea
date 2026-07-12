#!/bin/sh
set -eu

sdk_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repository_root=$(CDPATH= cd -- "$sdk_root/../.." && pwd)
demo_root="$repository_root/examples/android/VistreaDemoApp"
android_home=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/vistrea-android-boundary.XXXXXX")
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

ANDROID_HOME="$android_home" "$sdk_root/gradlew" \
    -p "$sdk_root" \
    :runtime-connection:assembleDebug \
    :runtime-connection:assembleRelease \
    :runtime-android:assembleDebug \
    :runtime-android:assembleRelease
ANDROID_HOME="$android_home" "$demo_root/gradlew" \
    -p "$demo_root" \
    :app:assembleDebug \
    :app:assembleRelease

connection_debug="$sdk_root/runtime-connection/build/outputs/aar/runtime-connection-debug.aar"
connection_release="$sdk_root/runtime-connection/build/outputs/aar/runtime-connection-release.aar"
adapter_debug="$sdk_root/runtime-android/build/outputs/aar/runtime-android-debug.aar"
adapter_release="$sdk_root/runtime-android/build/outputs/aar/runtime-android-release.aar"
demo_debug="$demo_root/app/build/outputs/apk/debug/app-debug.apk"
demo_release="$demo_root/app/build/outputs/apk/release/app-release-unsigned.apk"

extract_classes() {
    archive=$1
    destination=$2
    unzip -p "$archive" classes.jar > "$destination"
}

extract_classes "$connection_debug" "$temporary_root/connection-debug.jar"
extract_classes "$connection_release" "$temporary_root/connection-release.jar"
extract_classes "$adapter_debug" "$temporary_root/adapter-debug.jar"
extract_classes "$adapter_release" "$temporary_root/adapter-release.jar"

jar tf "$temporary_root/connection-debug.jar" | grep -q \
    'dev/vistrea/runtime/connection/LoopbackRuntimeClient.class'
if jar tf "$temporary_root/connection-release.jar" | grep -q \
    'dev/vistrea/runtime/connection/'; then
    echo "Release Runtime connection AAR contains protected transport classes." >&2
    exit 1
fi
jar tf "$temporary_root/adapter-debug.jar" | grep -q \
    'dev/vistrea/runtime/android/AndroidViewRuntimeSnapshotCaptureProvider.class'
if jar tf "$temporary_root/adapter-release.jar" | grep -q \
    'AndroidViewRuntimeSnapshotCaptureProvider'; then
    echo "Release Android adapter AAR contains the protected transport bridge." >&2
    exit 1
fi

unzip -p "$demo_debug" 'classes*.dex' | strings > "$temporary_root/debug-strings.txt"
unzip -p "$demo_release" 'classes*.dex' | strings > "$temporary_root/release-strings.txt"
for marker in \
    'VISTREA_RUNTIME_HOST' \
    'vistrea/runtime-token' \
    'vistrea-runtime-client-v1' \
    'LoopbackRuntimeClient'; do
    grep -q "$marker" "$temporary_root/debug-strings.txt"
    if grep -q "$marker" "$temporary_root/release-strings.txt"; then
        echo "Release Demo APK contains protected Runtime marker: $marker" >&2
        exit 1
    fi
done

aapt_path=$(find "$android_home/build-tools" -maxdepth 2 -name aapt -type f | sort -V | tail -1)
test -n "$aapt_path"
"$aapt_path" dump permissions "$demo_debug" > "$temporary_root/debug-permissions.txt"
"$aapt_path" dump permissions "$demo_release" > "$temporary_root/release-permissions.txt"
grep -q 'android.permission.INTERNET' "$temporary_root/debug-permissions.txt"
if grep -q 'android.permission.INTERNET' "$temporary_root/release-permissions.txt"; then
    echo "Release Demo APK contains the Debug-only Internet permission." >&2
    exit 1
fi

echo "Android Runtime Release boundary verified."
