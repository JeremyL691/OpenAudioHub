#!/usr/bin/env bash
# Builds the LGPL static ffmpeg and ffprobe used by the desktop app (PLAN T12.5, D-308).
#
# Components (versions and sha256 come from scripts/lib/pins.mjs):
#   libopus (BSD-3-Clause), LAME (LGPL-2.0), ffmpeg (LGPL-2.1+; --disable-gpl, --disable-nonfree, --disable-version3)
# Output: desktop/build/ffmpeg/bin/{ffmpeg,ffprobe}. The build is cached under desktop/.cache/ffmpeg by a key
# that covers the pins and this script, so a rebuild happens only when either changes.
# Homebrew is kept off PATH and out of pkg-config, so nothing links against /opt/homebrew.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$DESKTOP/.cache"
DOWNLOADS="$CACHE/downloads"
WORK="$CACHE/work/ffmpeg"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"

pin() { # pin <component> <field>
    node --input-type=module -e "import { PINS } from '$DESKTOP/scripts/lib/pins.mjs'; process.stdout.write(String(PINS['$1']['$2']));"
}

FFMPEG_FILE="$(pin ffmpeg file)"; FFMPEG_SHA="$(pin ffmpeg sha256)"; FFMPEG_URL="$(pin ffmpeg url)"
OPUS_FILE="$(pin opus file)"; OPUS_SHA="$(pin opus sha256)"; OPUS_URL="$(pin opus url)"
LAME_FILE="$(pin lame file)"; LAME_SHA="$(pin lame sha256)"; LAME_URL="$(pin lame url)"
FFMPEG_VERSION="$(pin ffmpeg version)"; OPUS_VERSION="$(pin opus version)"; LAME_VERSION="$(pin lame version)"

fetch() { # <url> <file> <sha256>
    local url="$1" file="$2" sha="$3"
    mkdir -p "$DOWNLOADS"
    if [ ! -f "$DOWNLOADS/$file" ] || [ "$(shasum -a 256 "$DOWNLOADS/$file" | cut -d' ' -f1)" != "$sha" ]; then
        rm -f "$DOWNLOADS/$file"
        curl -fsSL --retry 3 -o "$DOWNLOADS/$file.partial" "$url"
        mv "$DOWNLOADS/$file.partial" "$DOWNLOADS/$file"
    fi
    local got
    got="$(shasum -a 256 "$DOWNLOADS/$file" | cut -d' ' -f1)"
    if [ "$got" != "$sha" ]; then echo "sha256 mismatch for $file: $got" >&2; exit 1; fi
}

fetch "$OPUS_URL" "$OPUS_FILE" "$OPUS_SHA"
fetch "$LAME_URL" "$LAME_FILE" "$LAME_SHA"
fetch "$FFMPEG_URL" "$FFMPEG_FILE" "$FFMPEG_SHA"

KEY="$( { echo "$FFMPEG_SHA $OPUS_SHA $LAME_SHA"; cat "$0"; } | shasum -a 256 | cut -c1-16)"
CACHED="$CACHE/ffmpeg/$KEY"
OUT="$DESKTOP/build/ffmpeg"
if [ -x "$CACHED/bin/ffmpeg" ] && [ -x "$CACHED/bin/ffprobe" ]; then
    echo "using cached build $KEY"
else
    rm -rf "$WORK" "$CACHED"
    mkdir -p "$WORK" "$CACHED"
    PREFIX="$CACHED"
    # Only the system PATH: no Homebrew, no MacPorts. pkg-config only sees our prefix.
    export PATH=/usr/bin:/bin:/usr/sbin:/sbin
    export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
    export CFLAGS="-O2 -I$PREFIX/include"
    export LDFLAGS="-L$PREFIX/lib"
    cd "$WORK"
    tar -xzf "$DOWNLOADS/$OPUS_FILE"
    tar -xzf "$DOWNLOADS/$LAME_FILE"
    tar -xJf "$DOWNLOADS/$FFMPEG_FILE"

    echo "== libopus $OPUS_VERSION"
    (cd "opus-$OPUS_VERSION" && ./configure --prefix="$PREFIX" --disable-shared --enable-static \
        --disable-doc --disable-extra-programs > ../opus-configure.log 2>&1 \
        && make -j"$JOBS" > ../opus-make.log 2>&1 && make install > ../opus-install.log 2>&1)

    # LAME 4.0 requires a pkg-config that reports a version, even though its optional frontends are disabled.
    # The shim finds no packages, so nothing from the host can be linked.
    mkdir -p "$CACHE/tools"
    PKG_CONFIG_SHIM="$CACHE/tools/pkg-config"
    cp "$DESKTOP/scripts/lib/pkg-config-shim.sh" "$PKG_CONFIG_SHIM"
    chmod +x "$PKG_CONFIG_SHIM"

    echo "== LAME $LAME_VERSION"
    (cd "lame-$LAME_VERSION" && PKG_CONFIG="$PKG_CONFIG_SHIM" ./configure --prefix="$PREFIX" --disable-shared --enable-static \
        --disable-frontend --disable-decoder --disable-gtktest > ../lame-configure.log 2>&1 \
        && make -j"$JOBS" > ../lame-make.log 2>&1 && make install > ../lame-install.log 2>&1)

    # pkg-config is a build tool only. PKG_CONFIG_LIBDIR limits it to the prefix, so nothing outside is found.
    PKG_CONFIG_REAL="${PKG_CONFIG_REAL:-/opt/homebrew/bin/pkg-config}"
    [ -x "$PKG_CONFIG_REAL" ] || { echo "pkg-config not found at $PKG_CONFIG_REAL (set PKG_CONFIG_REAL)" >&2; exit 1; }

    echo "== ffmpeg $FFMPEG_VERSION (LGPL: no --enable-gpl, no --enable-nonfree, no --enable-version3)"
    (cd "ffmpeg-$FFMPEG_VERSION" && ./configure \
        --prefix="$PREFIX" \
        --enable-static --disable-shared \
        --disable-gpl --disable-nonfree --disable-version3 \
        --enable-libopus --enable-libmp3lame \
        --disable-doc --disable-ffplay --disable-sdl2 --disable-debug \
        --disable-lzma --disable-bzlib --disable-iconv \
        --pkg-config="$PKG_CONFIG_REAL" --pkg-config-flags="--static" \
        --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" \
        > ../ffmpeg-configure.log 2>&1 \
        && make -j"$JOBS" > ../ffmpeg-make.log 2>&1 && make install > ../ffmpeg-install.log 2>&1)
    cd "$DESKTOP"
fi

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/source"
cp "$CACHED/bin/ffmpeg" "$CACHED/bin/ffprobe" "$OUT/bin/"
# Corresponding source for the LGPL and BSD components, shipped with the release (PLAN D-308).
cp "$DOWNLOADS/$FFMPEG_FILE" "$DOWNLOADS/$OPUS_FILE" "$DOWNLOADS/$LAME_FILE" "$OUT/source/"

"$OUT/bin/ffmpeg" -hide_banner -buildconf | sed -n '1,3p'
echo "ffmpeg staged at $OUT (cache key $KEY)"
