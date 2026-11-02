#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v pnpm >/dev/null || { echo "pnpm not found on PATH" >&2; exit 1; }
command -v adb >/dev/null || { echo "adb not found on PATH" >&2; exit 1; }

pnpm cap:sync
(cd android && ./gradlew installDebug)
adb shell monkey -p vihko.app -c android.intent.category.LAUNCHER 1 >/dev/null
