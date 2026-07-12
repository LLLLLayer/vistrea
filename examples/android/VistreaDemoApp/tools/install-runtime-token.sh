#!/bin/sh
set -eu

package_name="${VISTREA_ANDROID_PACKAGE:-dev.vistrea.demo.debug}"
case "$package_name" in
    *[!A-Za-z0-9._]*)
        echo "Invalid Android package name." >&2
        exit 2
        ;;
esac

token_source="${1:-/dev/stdin}"
adb_command="${ADB:-adb}"
remote_command="run-as $package_name sh -c 'cd \"\$HOME\"; umask 077; mkdir -p files/vistrea; cat > files/vistrea/runtime-token.tmp; chmod 600 files/vistrea/runtime-token.tmp; mv files/vistrea/runtime-token.tmp files/vistrea/runtime-token'"

"$adb_command" shell "$remote_command" < "$token_source"
