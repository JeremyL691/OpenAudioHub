#!/usr/bin/env bash
# Builds the LGPL static ffmpeg and ffprobe bundled with the desktop app, as Tauri sidecars
# named binaries/<tool>-<target triple>.
#   libopus (BSD-3-Clause), LAME (LGPL-2.0), ffmpeg (LGPL-2.1+; no --enable-gpl, --enable-nonfree or --enable-version3)
# Sources are pinned by sha256. The build is cached under .cache/ by a key over the pins and this script.
# Only the system PATH is used, so nothing links against Homebrew or MacPorts libraries.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$HERE/.cache"
DOWNLOADS="$CACHE/downloads"
WORK="$CACHE/work"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"

# shellcheck source=./fetch-source.sh
. "$HERE/scripts/fetch-source.sh"

FFMPEG_VERSION=9.0.2
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
FFMPEG_SHA=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
OPUS_VERSION=1.6.1
OPUS_URL="https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz"
OPUS_SHA=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
LAME_VERSION=4.0
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"
LAME_SHA=3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb

# fetch_source retries a transient failure and reports a download apart from a checksum
# mismatch, so a flaky host does not read as a corrupted archive.
OPUS_TAR="$(fetch_source "$OPUS_URL" "$OPUS_SHA" "$DOWNLOADS")"
LAME_TAR="$(fetch_source "$LAME_URL" "$LAME_SHA" "$DOWNLOADS")"
FFMPEG_TAR="$(fetch_source "$FFMPEG_URL" "$FFMPEG_SHA" "$DOWNLOADS")"

KEY="$( { echo "$FFMPEG_SHA $OPUS_SHA $LAME_SHA $TRIPLE"; cat "$0"; } | shasum -a 256 | cut -c1-16)"
PREFIX="$CACHE/ffmpeg-$KEY"
if [ ! -x "$PREFIX/bin/ffmpeg" ] || [ ! -x "$PREFIX/bin/ffprobe" ]; then
    rm -rf "$WORK" "$PREFIX"
    mkdir -p "$WORK" "$PREFIX"
    PKG_CONFIG_REAL="${PKG_CONFIG_REAL:-$(command -v pkg-config || true)}"
    [ -x "$PKG_CONFIG_REAL" ] || { echo "pkg-config is needed as a build tool (set PKG_CONFIG_REAL)" >&2; exit 1; }
    export PATH=/usr/bin:/bin:/usr/sbin:/sbin
    export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
    export CFLAGS="-O2 -I$PREFIX/include" LDFLAGS="-L$PREFIX/lib"
    cd "$WORK"
    tar -xzf "$OPUS_TAR" && tar -xzf "$LAME_TAR" && tar -xJf "$FFMPEG_TAR"
    (cd "opus-$OPUS_VERSION" && ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-doc --disable-extra-programs \
        && make -j"$JOBS" && make install) > opus.log 2>&1
    # LAME's configure wants a pkg-config that answers version queries; the shim finds no packages.
    (cd "lame-$LAME_VERSION" && PKG_CONFIG="$HERE/scripts/pkg-config-shim.sh" ./configure --prefix="$PREFIX" --disable-shared --enable-static \
        --disable-frontend --disable-decoder --disable-gtktest && make -j"$JOBS" && make install) > lame.log 2>&1
    (cd "ffmpeg-$FFMPEG_VERSION" && ./configure --prefix="$PREFIX" --enable-static --disable-shared \
        --disable-gpl --disable-nonfree --disable-version3 --enable-libopus --enable-libmp3lame \
        --disable-doc --disable-ffplay --disable-sdl2 --disable-debug --disable-lzma --disable-bzlib --disable-iconv \
        --pkg-config="$PKG_CONFIG_REAL" --pkg-config-flags="--static" \
        --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" && make -j"$JOBS" && make install) > ffmpeg.log 2>&1
fi

mkdir -p "$HERE/binaries" "$HERE/binaries/source"
cp "$PREFIX/bin/ffmpeg" "$HERE/binaries/ffmpeg-$TRIPLE"
cp "$PREFIX/bin/ffprobe" "$HERE/binaries/ffprobe-$TRIPLE"
# Corresponding source of the LGPL and BSD components, shipped with each release.
cp "$OPUS_TAR" "$LAME_TAR" "$FFMPEG_TAR" "$HERE/binaries/source/"
"$HERE/binaries/ffmpeg-$TRIPLE" -hide_banner -buildconf | sed -n '1,3p'
echo "ffmpeg sidecars ready for $TRIPLE (cache $KEY)"
