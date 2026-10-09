#!/usr/bin/env bash
# The desktop build as CI runs it, and as a local check (PLAN T14.3). It runs the desktop checks, packages the
# app (dist.mjs), verifies the .app in the output folder and the .app inside the mounted DMG (verify-bundle.mjs),
# and writes the DMG's sha256 next to it.
#
# Requires the dependencies installed (`pnpm install --frozen-lockfile` at the root and in desktop/), uv 0.12.23,
# and Homebrew pkg-config for the ffmpeg build. Output: desktop/dist/OpenAudioHub-<version>-arm64.dmg and .sha256.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
CACHE_ROOT="$HOME/Library/Caches/OpenAudioHub"

cd "$DESKTOP"

echo "== desktop checks"
pnpm lint
pnpm type-check
pnpm test

echo "== package"
pnpm dist

APP="$CACHE_ROOT/dist/mac-arm64/OpenAudioHub.app"
DMG="$(find "$DESKTOP/dist" -maxdepth 1 -name 'OpenAudioHub-*-arm64.dmg' | sort | tail -n 1)"
if [ -z "$DMG" ]; then
    echo "no DMG under desktop/dist" >&2
    exit 1
fi

echo "== verify the app"
node scripts/verify-bundle.mjs "$APP" --report "$CACHE_ROOT/dist/verify-app.json"

echo "== verify the app inside the DMG"
MOUNT="$(mktemp -d "$CACHE_ROOT/dmg-mount.XXXXXX")"
cleanup() {
    hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
    rmdir "$MOUNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG" >/dev/null
node scripts/verify-bundle.mjs "$MOUNT/OpenAudioHub.app" --report "$CACHE_ROOT/dist/verify-dmg.json"

echo "== checksum"
(cd "$(dirname "$DMG")" && shasum -a 256 "$(basename "$DMG")") > "$DMG.sha256"
cat "$DMG.sha256"
